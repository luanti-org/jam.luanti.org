import { accessSync, constants, statfsSync } from "node:fs";
import sharp from "sharp";
import jamData from "../content/jam.json";
import type { Snapshot } from "../shared/schemas";
import { InspectionLimitError } from "./inspection-errors";

export type Git = (args: string[], limit?: number) => Buffer;

export type InspectionOptions = {
    commit?: string;

    /** The API may stop a duplicate after resolution, before any presentation reads. */
    onCommit?: (commit: string) => void | Promise<void>;
};

export const maxPngBytes = 8 * 1024 ** 2;
export const maxWebpBytes = 512 * 1024;

// Start with an allowlisted environment: inherited proxy, credential and Git settings are unsafe.
export const gitEnvironment = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    TMPDIR: "/tmp",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_LFS_SKIP_SMUDGE: "1",
};

export const gitFlags = [
    "protocol.allow=never",
    "protocol.https.allow=always",
    "http.followRedirects=false",
    "http.proxy=",
    "credential.helper=",
    "core.hooksPath=/dev/null",
    "core.attributesFile=/dev/null",
    "init.templateDir=",
    "gc.auto=0",
    "pack.threads=1",
].flatMap((setting) => ["-c", setting]);

// Cap each Git process and its helpers at 192 MiB of virtual address space. Bun and
// Sharp stay outside RLIMIT_AS; this is not an aggregate physical-memory quota.
export const gitCommand = ["prlimit", `--as=${192 * 1024 ** 2}`, "--", "git", ...gitFlags];

/** Hosts may ignore blob filtering; tmpfs capacity and the deadline remain enforced. */
export function cloneArguments(repository: string) {
    return [
        "clone",
        "--bare",
        "--depth=1",
        "--single-branch",
        "--no-tags",
        "--filter=blob:none",
        "--no-recurse-submodules",
        "--",
        repository,
        "/tmp/repository",
    ];
}

/**
 * Extracts bounded single-line presentation metadata, ignoring unrelated Luanti settings.
 * Skip unrelated multiline values so text inside them cannot masquerade as root metadata.
 */
export function parseGameConf(source: string) {
    const metadata = new Map<string, string>();
    let inMultilineValue = false;

    for (const line of source.split(/\r?\n/)) {
        if (inMultilineValue) {
            if (line.trim() === '"""') {
                inMultilineValue = false;
            }

            continue;
        }

        const separator = line.indexOf("=");

        if (separator < 0) {
            continue;
        }

        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().normalize("NFC");

        if (name.startsWith("#")) {
            continue;
        }

        if (name !== "title" && name !== "description") {
            inMultilineValue = value === '"""';
            continue;
        }

        if (metadata.has(name) || value === '"""') {
            throw new Error("Use one single-line title and description in game.conf");
        }

        metadata.set(name, value);
    }

    const title = metadata.get("title") ?? "";
    const description = metadata.get("description") ?? "";

    // Preserve ZWJ/ZWNJ and emoji sequences, but disallow bidi controls, hidden
    // separators and control characters in single-line presentation.
    const hasControls = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}\u00ad\u180e\u200b\u2060\ufeff]/u.test(title + description);

    if (!title || title.length > 200 || !description || description.length > 2000 || hasControls) {
        throw new Error("game.conf requires a title (1-200 characters) and description (1-2000 characters)");
    }

    return { title, description };
}

/** Bound both encoded input and decoded pixels before producing a non-upscaled WebP. */
export async function convertScreenshot(png: Uint8Array) {
    if (png.length > maxPngBytes) {
        throw new Error("screenshot.png exceeds 8 MiB");
    }

    // Do not let format autodetection invoke other image loaders for a renamed file.
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];

    if (png.length < signature.length || !signature.every((byte, index) => png[index] === byte)) {
        throw new Error("screenshot.png must start with the PNG signature");
    }

    let output: Buffer;

    try {
        const image = sharp(png, { limitInputPixels: 16000000, failOn: "warning", animated: false });
        const metadata = await image.metadata();

        if (metadata.format !== "png" || (metadata.pages ?? 1) !== 1) {
            throw new Error("screenshot.png must decode as a single PNG image");
        }

        output = await image
            .resize({ width: 640, height: 480, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 75 })
            .toBuffer();
    } catch {
        throw new Error("screenshot.png must be a valid, single PNG image of at most 16 megapixels");
    }

    if (output.length > maxWebpBytes) {
        throw new Error("Processed screenshot exceeds 512 KiB");
    }

    return output;
}

/**
 * Resolves HEAD before jam close, or verifies the exact recorded SHA for reinspection.
 * Every read is pinned to that SHA; a reinspection never substitutes the repository's HEAD.
 * The supplied Git runner must enforce output bounds and the whole-inspection deadline.
 */
export async function inspectHead(git: Git, endsAt: number, options: InspectionOptions = {}): Promise<Snapshot> {
    const commit = git(["rev-parse", "--verify", `${options.commit ?? "HEAD"}^{commit}`]).toString().trim();

    if (!/^[0-9a-f]{40}$/.test(commit) || (options.commit && commit !== options.commit)) {
        throw new Error("Git did not resolve the requested commit");
    }

    // Arrival time cannot prove which commit existed before the deadline.
    if (!options.commit && Date.now() >= endsAt) {
        throw new Error("HEAD was resolved after the submission deadline; submit earlier");
    }

    await options.onCommit?.(commit);

    const participation = jamData.participationFile;
    const tree = git(["ls-tree", "-z", commit, "--", participation, "game.conf", "screenshot.png"])
        .toString()
        .split("\0");
    const regularFiles = tree.flatMap((entry) => {
        const match = /^100(?:644|755) blob [0-9a-f]{40}\t(.+)$/.exec(entry);

        return match ? [match[1]] : [];
    });

    const hasScreenshot = tree.some((entry) => entry.endsWith("\tscreenshot.png"));

    // An omitted screenshot is allowed; a supplied symlink, directory or submodule is not an image.
    for (const name of [participation, "game.conf", ...(hasScreenshot ? ["screenshot.png"] : [])]) {
        if (!regularFiles.includes(name)) {
            throw new Error(`Commit a regular root ${name}`);
        }
    }

    // A size lookup can itself lazily fetch a blob. The sandbox storage limit and shared
    // deadline still apply before the byte limit can be checked; this is not a network quota.
    const read = (name: string, limit: number) => {
        const size = Number(git(["cat-file", "-s", `${commit}:${name}`], 1024).toString());

        if (!Number.isSafeInteger(size) || size < 1 || size > limit) {
            throw new Error(`${name} exceeds its size limit or is empty`);
        }

        return git(["cat-file", "blob", `${commit}:${name}`], limit);
    };

    const metadata = parseGameConf(
        new TextDecoder("utf-8", { fatal: true }).decode(read("game.conf", 16384)),
    );
    const screenshot = hasScreenshot
        ? await convertScreenshot(read("screenshot.png", maxPngBytes))
        : Buffer.alloc(0);

    return { commit, ...metadata, screenshot };
}

/** Classify local, bounded process evidence; remote/network diagnostics never authorize a penalty. */
export function checkGitResult(
    result: { success: boolean; stdout: Buffer; stderr: Buffer; signalCode?: string | number | null },
    limit: number,
    deadline: number,
) {
    if (result.stdout.length > limit || result.stderr.length > limit
        || ["SIGXCPU", "SIGXFSZ", 24, 25].includes(result.signalCode ?? "")) {
        throw new InspectionLimitError("resource");
    }

    if (!result.success) {
        // LC_ALL=C fixes these local Git allocation diagnostics. Do not match remote: messages
        // or arbitrary occurrences of resource-related words in server/repository errors.
        const diagnostics = result.stderr.toString();
        const memory = /^(?:fatal|error): (?:[Oo]ut of memory(?:[,. :]|$)|(?:mmap|malloc|realloc|calloc) failed: Cannot allocate memory)/m;
        const helperSignal = /^error: [a-z-]+ died of signal (?:24|25)\b/m;
        const space = statfsSync("/tmp");

        if (memory.test(diagnostics) || helperSignal.test(diagnostics)
            || space.bavail === 0 || space.ffree === 0) {
            throw new InspectionLimitError("resource");
        }

        if (Date.now() >= deadline) {
            throw new InspectionLimitError("timeout");
        }

        throw new Error("Git inspection failed; check that the HTTPS repository is public and available");
    }
}

async function runInspection() {
    const [repository, resolution, deadlineText, endsAtText, commit, checkDuplicate] = process.argv.slice(2);
    const deadline = Number(deadlineText);

    if (commit && !/^[0-9a-f]{40}$/.test(commit)) {
        throw new Error("Invalid recorded commit");
    }

    const git = (args: string[], limit = 65536) => {
        const remaining = deadline - Date.now();

        if (remaining <= 0) {
            throw new InspectionLimitError("timeout");
        }

        const result = Bun.spawnSync(
            [...gitCommand, "-c", `http.curloptResolve=${resolution}`, ...args],
            {
                cwd: args[0] === "clone" ? "/tmp" : "/tmp/repository",
                env: gitEnvironment,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                timeout: remaining,
                maxBuffer: limit,
                killSignal: "SIGKILL",
            },
        );

        checkGitResult(result, limit, deadline);

        return result.stdout;
    };

    git(cloneArguments(repository));

    if (commit) {
        // Reuse the same disposable clone. Hosts may refuse an unreachable SHA; that failure
        // is final rather than falling back to HEAD, a mirror, or history synchronization.
        git(["fetch", "--depth=1", "--no-tags", "--filter=blob:none", "--no-recurse-submodules", "origin", commit]);
    }

    const { screenshot, ...metadata } = await inspectHead(git, Number(endsAtText), {
        commit: commit || undefined,
        ...(checkDuplicate ? {
            onCommit: async (resolved: string) => {
                // The parent checks SQLite before allowing presentation inspection to continue.
                // EOF or parent cancellation must never authorize more repository reads.
                await Bun.write(Bun.stdout, `${resolved}\n`);

                if (await Bun.stdin.text() !== "inspect\n") {
                    throw new Error("Inspection was not authorized to continue");
                }
            },
        } : {}),
    });

    // A bounded JSON line frames metadata; remaining bytes are the WebP, or empty when omitted.
    await Bun.write(Bun.stdout, Buffer.concat([Buffer.from(`${JSON.stringify(metadata)}\n`), screenshot]));
}

async function checkWorkerRuntime() {
    const git = Bun.spawnSync([...gitCommand, "--version"], { env: gitEnvironment, timeout: 5000, maxBuffer: 4096 });
    const version = /^git version (\d+)\.(\d+)/.exec(git.stdout.toString());

    if (
        !git.success
        || !version
        || Number(version[1]) < 2
        || (Number(version[1]) === 2 && Number(version[2]) < 37)
    ) {
        throw new Error("Install Git 2.37+ inside the sandbox PATH");
    }

    const path = Bun.spawnSync([...gitCommand, "--exec-path"], {
        env: gitEnvironment,
        timeout: 5000,
        maxBuffer: 4096,
    });
    accessSync(`${path.stdout.toString().trim()}/git-remote-https`, constants.X_OK);

    const space = statfsSync("/tmp");

    if (space.blocks * space.bsize !== 134217728) {
        throw new Error("Bubblewrap must provide a fresh 128 MiB tmpfs");
    }

    await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
        .webp()
        .toBuffer();
}

if (import.meta.main) {
    try {
        if (process.argv[2] === "--check-runtime") {
            await checkWorkerRuntime();
        } else {
            await runInspection();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Inspection failed";

        // Mark worker rejections so the API never exposes Bubblewrap/Bun startup diagnostics.
        console.error(process.argv[2] === "--check-runtime" ? message : `Submission rejected: ${message}`);
        process.exitCode = error instanceof InspectionLimitError ? (error.kind === "resource" ? 2 : 3) : 1;
    }
}
