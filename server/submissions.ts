import { lookup } from "node:dns/promises";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HTTPException } from "hono/http-exception";
import ipaddr from "ipaddr.js";
import type { ModerationDecision, Snapshot } from "../shared/schemas";
import type { Config } from "./config";
import type { InspectionOptions } from "./inspection-worker";
import { InspectionLimitError } from "./inspection-errors";
import { readHosts, repositoryInfo } from "./repositories";
import type { Store } from "./storage";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimePath = "/usr/local/bin:/usr/bin:/bin";
const inspectionMs = 120000;
const maxWorkerOutput = 512 * 1024 + 16384;

/** Short-circuits inspection while still reaping the worker before releasing its queue slot. */
class ExistingSubmission extends Error {
    constructor(readonly receipt: NonNullable<ReturnType<Store["submissionReceipt"]>>) {
        super("Repository commit already has a receipt");
    }
}

/** Accepts only routable IPv4 addresses, matching the family used for Git DNS pinning. */
export function isPublicAddress(address: string) {
    try {
        const ip = ipaddr.parse(address);

        return ip.kind() === "ipv4" && ip.range() === "unicast";
    } catch {
        return false;
    }
}

/** Pins public IPv4 destinations for all Git requests, including lazy blob fetches. */
async function pin(host: string, timeout: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const addresses = await Promise.race([
        lookup(host, { all: true, family: 4 }),
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("DNS resolution timed out")), Math.max(1, timeout));
            cancel = () => reject(signal?.reason);
            signal?.addEventListener("abort", cancel, { once: true });
        }),
    ]).finally(() => {
        clearTimeout(timer);

        if (cancel) {
            signal?.removeEventListener("abort", cancel);
        }
    });

    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new Error("Repository host must resolve to public IPv4 addresses");
    }

    return `${host}:443:${addresses[0].address}`;
}

/**
 * Constructs one fresh PID namespace and 128 MiB tmpfs with read-only runtime mounts.
 * The tmpfs bounds temporary storage, not aggregate process RAM. prlimit adds inherited
 * per-process limits; the outer deadline and namespace teardown bound the full operation.
 */
export function sandboxArguments() {
    const prlimit = Bun.which("prlimit", { PATH: runtimePath });

    if (!prlimit) {
        throw new Error("Install util-linux prlimit in /usr/local/bin, /usr/bin or /bin");
    }

    const args = [
        Bun.which("bwrap") ?? "bwrap",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
    ];

    for (const path of [
        "/usr",
        "/bin",
        "/lib",
        "/lib64",
        "/etc/ssl",
        "/etc/resolv.conf",
        "/etc/hosts",
        "/etc/nsswitch.conf",
    ]) {
        if (existsSync(path)) {
            args.push("--ro-bind", path, path);
        }
    }

    args.push(
        "--ro-bind",
        realpathSync(process.execPath),
        "/bun",
        "--ro-bind",
        `${projectRoot}node_modules`,
        "/app/node_modules",
        "--ro-bind",
        `${import.meta.dir}/inspection-worker.ts`,
        "/app/inspection-worker.ts",
        "--ro-bind",
        `${import.meta.dir}/inspection-errors.ts`,
        "/app/inspection-errors.ts",

        // The worker's relative JSON import receives only the operator's jam configuration.
        "--ro-bind",
        `${projectRoot}content/jam.json`,
        "/content/jam.json",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--size",
        "134217728",
        "--tmpfs",
        "/tmp",
        "--chdir",
        "/tmp",
        "--clearenv",
        "--remount-ro",
        "/",
    );

    for (const [key, value] of Object.entries({
        PATH: runtimePath,
        HOME: "/tmp",
        TMPDIR: "/tmp",
        LC_ALL: "C",
    })) {
        args.push("--setenv", key, value);
    }

    // Per-process CPU and file-size limits; tmpfs bounds aggregate temporary storage.
    args.push(
        "--",
        prlimit,
        "--cpu=120",
        "--fsize=134217728",
        "--nofile=128",
        "--",
        "/bun",
        "/app/inspection-worker.ts",
    );

    return args;
}

/** Fails closed at startup by exercising the actual worker mounts, executables, limits and codecs. */
export function checkRuntime() {
    if (!Bun.semver.satisfies(Bun.version, ">=1.4.4")) {
        throw new Error("Bun 1.4.4 or newer is required");
    }

    if (process.platform !== "linux") {
        throw new Error("Inspection requires Linux, Git 2.37+, Bubblewrap and prlimit");
    }

    readHosts();
    const probe = Bun.spawnSync([...sandboxArguments(), "--check-runtime"], {
        env: { PATH: runtimePath },
        timeout: 10000,
        maxBuffer: 65536,
        killSignal: "SIGKILL",
    });

    if (!probe.success) {
        throw new Error(
            `Inspection runtime unavailable: Linux user/PID namespaces, Bubblewrap --size, prlimit, Git HTTPS and Sharp are required. ${probe.stderr.toString().slice(0, 1000)}`,
        );
    }
}

/**
 * Returns presentation for HEAD or an explicit recorded SHA without retaining a repository on the host.
 * DNS, clone, lazy object fetches and conversion share one absolute deadline. Cancellation
 * kills the process group and namespace; this promise settles only after the worker is reaped.
 */
export async function inspectRepository(
    info: ReturnType<typeof repositoryInfo>,
    deadline: number,
    endsAt: number,
    signal?: AbortSignal,
    options: InspectionOptions = {},
): Promise<Snapshot> {
    signal?.throwIfAborted();

    if (deadline <= Date.now()) {
        throw new InspectionLimitError("timeout");
    }

    let resolution: string;

    try {
        resolution = await pin(info.host, deadline - Date.now(), signal);
    } catch {
        signal?.throwIfAborted();

        if (Date.now() >= deadline) {
            throw new InspectionLimitError("timeout");
        }

        throw new HTTPException(422, {
            message: "Repository host did not resolve to public IPv4 addresses before the deadline",
        });
    }

    signal?.throwIfAborted();
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
        throw new InspectionLimitError("timeout");
    }

    const child = Bun.spawn(
        [...sandboxArguments(), info.clone, resolution, String(deadline), String(endsAt),
            options.commit ?? "", options.onCommit ? "check-duplicate" : ""],
        {
            env: { PATH: runtimePath },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            timeout: remaining,
            signal,
            maxBuffer: maxWorkerOutput,
            killSignal: "SIGKILL",
            detached: true,
        },
    );

    const cancel = () => {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch {
            child.kill("SIGKILL");
        }
    };

    // Signal the launched process group too; PID namespace teardown catches descendants
    // even when a Git helper has moved into another group.
    const timer = setTimeout(cancel, remaining);
    signal?.addEventListener("abort", cancel, { once: true });

    if (signal?.aborted) {
        cancel();
    }

    const stderrResult = new Response(child.stderr).text();

    try {
        if (options.onCommit) {
            const reader = child.stdout.getReader();
            let header = Buffer.alloc(0);

            try {
                // The worker waits for permission after exactly one SHA line. Keep this
                // framing bounded even if the child fails or produces unexpected output.
                while (header.length < 41) {
                    const { done, value } = await reader.read();

                    if (done) {
                        break;
                    }

                    header = Buffer.concat([header, value]);

                    if (header.length > 41) {
                        throw new Error("Invalid inspection commit header");
                    }
                }
            } finally {
                reader.releaseLock();
            }

            if (header.length === 41 && /^[0-9a-f]{40}\n$/.test(header.toString())) {
                signal?.throwIfAborted();
                await options.onCommit(header.toString().trim());
                child.stdin.write("inspect\n");
                child.stdin.end();
            } else if (header.length) {
                throw new Error("Invalid inspection commit header");
            }
        } else {
            child.stdin.end();
        }

        const [stdout, stderr, code] = await Promise.all([
            (async () => {
                // A Response body cannot reuse the stream after its commit header was read.
                const chunks: Uint8Array[] = [];
                let length = 0;

                for await (const chunk of child.stdout) {
                    length += chunk.length;

                    if (length > maxWorkerOutput) {
                        throw new InspectionLimitError("resource");
                    }

                    chunks.push(chunk);
                }

                return Buffer.concat(chunks);
            })(),
            stderrResult,
            child.exited,
        ]);

        const markedRejection = stderr.startsWith("Submission rejected: ");

        // A measured overflow or marked local resource failure takes priority over a coincident deadline.
        if (Buffer.byteLength(stderr) > maxWorkerOutput || ["SIGXCPU", "SIGXFSZ", 24, 25].includes(child.signalCode ?? "")
            || (markedRejection && code === 2)) {
            throw new InspectionLimitError("resource");
        }

        if (Date.now() >= deadline || (markedRejection && code === 3)) {
            throw new InspectionLimitError("timeout");
        }

        signal?.throwIfAborted();

        // Exit codes are assigned only by our mounted worker, never inferred from Git's text.
        // An unexplained SIGKILL may be an operator/host failure; it is not proof of abuse.
        if (markedRejection && code === 1) {
            throw new HTTPException(422, {
                message: stderr.slice("Submission rejected: ".length).trim().slice(0, 500),
            });
        }

        if (code !== 0) {
            throw new Error(`Inspection worker failed (${code}): ${stderr.slice(0, 1000)}`);
        }

        const boundary = stdout.indexOf(10);

        if (boundary < 0 || boundary > 16384) {
            throw new Error("Invalid inspection output");
        }

        const metadata = JSON.parse(stdout.subarray(0, boundary).toString());

        return { ...metadata, screenshot: stdout.subarray(boundary + 1) };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);

        if (child.exitCode === null && child.signalCode === null) {
            cancel();
        }

        await Promise.all([child.exited, stderrResult]);
    }
}

/**
 * Shares one active inspection and four FIFO waiters between participants and reinspection.
 * Queue ownership is process-local: run one API process even though SQLite budgets are atomic.
 * Only a granted owner advances the queue, after worker cleanup and its SQLite transition.
 * Cancelled waiters cost no inspection budget; all started Git work remains charged.
 */
export function createSubmissions(
    config: Config,
    store: Store,
    options: { clock?: () => number; inspect?: typeof inspectRepository } = {},
) {
    const { clock = Date.now, inspect = inspectRepository } = options;
    let active = false;
    const waiting: Array<() => void> = [];

    // This local reservation covers both real workflows, including their final database write.
    // Keeping active=true during handoff prevents new arrivals from stealing a granted slot.
    async function inSlot<T>(ip: string, repository: string, signal: AbortSignal | undefined, operation: () => Promise<T>) {
        signal?.throwIfAborted();
        store.checkSubmissionBudget(ip, repository, clock());

        if (active && waiting.length >= 4) {
            store.incident("inspection-queue-full", ip, clock(), repository);
            throw new HTTPException(429, { message: "Inspection queue is full; try again shortly" });
        }

        if (active) {
            await new Promise<void>((resolve, reject) => {
                const grant = () => {
                    signal?.removeEventListener("abort", cancel);
                    resolve();
                };

                const cancel = () => {
                    // Grant removes this listener before resolving, so this waiter still owns
                    // a queue entry. An abort here must never release the active inspection.
                    waiting.splice(waiting.indexOf(grant), 1);
                    signal?.removeEventListener("abort", cancel);
                    reject(signal?.reason);
                };

                waiting.push(grant);
                signal?.addEventListener("abort", cancel, { once: true });
            });
        } else {
            active = true;
        }

        try {
            signal?.throwIfAborted();

            return await operation();
        } finally {
            const next = waiting.shift();

            if (next) {
                next();
            } else {
                active = false;
            }
        }
    }

    async function inspectCommit(repository: string, ip: string, signal?: AbortSignal, commit?: string) {
        // Queue waiting reserves neither an earlier host policy nor a historical HEAD.
        const info = repositoryInfo(repository);
        store.admitSubmission(ip, info.repository, clock());
        const deadline = Date.now() + inspectionMs;

        try {
            const snapshot = await inspect(info, deadline, config.endsAt, signal, {
                commit,
                ...(!commit ? {
                    onCommit: (resolved: string) => {
                        const receipt = store.submissionReceipt(config.jamId, info.repository, resolved);

                        if (receipt) {
                            throw new ExistingSubmission(receipt);
                        }
                    },
                } : {}),
            });
            signal?.throwIfAborted();

            if (Date.now() >= deadline) {
                throw new InspectionLimitError("timeout");
            }

            return { info, snapshot };
        } catch (error) {
            // Measure the whole attempt, including DNS and cleanup, even if the client abandoned it.
            const limit = error instanceof InspectionLimitError ? error.kind
                : !(error instanceof ExistingSubmission) && Date.now() >= deadline ? "timeout" : undefined;

            if (limit) {
                store.recordInspectionLimit(ip, info.repository, limit, clock());
                signal?.throwIfAborted();
                throw error instanceof InspectionLimitError ? error : new InspectionLimitError(limit);
            }

            signal?.throwIfAborted();

            if (!(error instanceof HTTPException) && !(error instanceof ExistingSubmission)) {
                store.incident("inspection-worker-failure", ip, clock(), info.repository);
            }

            throw error;
        }
    }

    return {
        async submit(input: string, ip: string, signal?: AbortSignal) {
            signal?.throwIfAborted();
            const { repository } = repositoryInfo(input);
            const received = clock();

            if (received < config.startsAt || received >= config.endsAt) {
                throw new HTTPException(403, { message: "Submissions are outside the jam window" });
            }

            return inSlot(ip, repository, signal, async () => {
                if (clock() >= config.endsAt) {
                    throw new HTTPException(403, { message: "Jam closed while queued; no commit was resolved" });
                }

                try {
                    const { info, snapshot } = await inspectCommit(input, ip, signal);

                    return store.recordSubmission(config.jamId, info.repository, snapshot, received, info.commitPath);
                } catch (error) {
                    signal?.throwIfAborted();

                    if (error instanceof ExistingSubmission) {
                        return error.receipt;
                    }

                    throw error;
                }
            });
        },

        async reinspect(decision: ModerationDecision, moderator: string, ip: string, signal?: AbortSignal) {
            const target = store.reinspectionTarget(decision, config.jamId);
            const { repository } = repositoryInfo(target.repository);

            return inSlot(ip, repository, signal, async () => {
                // Authorization and revision are checked again after waiting and before saving.
                // Revocation or a new pending review must not be undone by an in-flight result.
                store.authorize(moderator);
                const target = store.reinspectionTarget(decision, config.jamId);
                const { snapshot } = await inspectCommit(target.repository, ip, signal, target.commit);
                store.authorize(moderator);

                return store.restore(decision, snapshot, moderator, clock(), config.jamId);
            });
        },
    };
}
