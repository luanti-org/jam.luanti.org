import * as dns from "node:dns/promises";
import { beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import jamData from "../content/jam.json";
import { gitEnvironment, gitFlags } from "../server/inspection-worker";
import { repositoryInfo } from "../server/repositories";
import { checkRuntime, inspectRepository, sandboxArguments } from "../server/submissions";

const enabled = process.env.TEST_SANDBOX === "1" || ["1", "true"].includes(process.env.CI ?? "");
const sandboxTest = test.skipIf(!enabled);
const fixturePath = fileURLToPath(new URL("./fixtures/inspection.ts", import.meta.url));
const protocolFixture = fileURLToPath(new URL("./fixtures/worker-protocol.ts", import.meta.url));

beforeAll(() => {
    // Opting in (or running in CI) makes every probe failure fatal, including worker regressions.
    if (enabled) {
        checkRuntime();
    }
});

function fixtureArguments(mode: string, commit = "", directory?: string) {
    const args = sandboxArguments();
    const mounts = ["--ro-bind", fixturePath, "/app/inspection-fixture.ts"];

    if (directory) {
        mounts.push("--ro-bind", directory, "/fixture");
    }

    args.splice(args.indexOf("--remount-ro"), 0, ...mounts);
    args.splice(-1, 1, "/app/inspection-fixture.ts", mode, commit);

    return args;
}

sandboxTest("sandbox mounts the configured jam declaration read-only", () => {
    const args = sandboxArguments();
    const mount = args.indexOf("/content/jam.json");
    expect(args.slice(mount - 2, mount + 1)).toEqual([
        "--ro-bind", fileURLToPath(new URL("../content/jam.json", import.meta.url)), "/content/jam.json",
    ]);
});

sandboxTest("real Bubblewrap gives fresh limited tmpfs", () => {
    for (const [mode, expected] of [["fresh", "134217728"], ["check-fresh", "fresh"], ["full", "bounded"]]) {
        const result = Bun.spawnSync(fixtureArguments(mode), {
            env: { PATH: gitEnvironment.PATH }, timeout: 10000, maxBuffer: 4096, killSignal: "SIGKILL",
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString().trim()).toBe(expected);
    }
}, 15000);

sandboxTest.each(["deadline", "abort"])("sandbox teardown reaps a ready descendant after %s", async (operation) => {
    const controller = new AbortController();
    const child = Bun.spawn(fixtureArguments("descendant"), {
        env: { PATH: gitEnvironment.PATH }, timeout: 10000, signal: controller.signal,
        maxBuffer: 4096, killSignal: "SIGKILL", stdout: "pipe", stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const stderr = new Response(child.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        let ready = "";

        while (!ready.endsWith("\n") && ready.length < 64) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            ready += Buffer.from(value).toString();
        }

        expect(ready).toBe("ready\n");
        const start = Date.now();

        if (operation === "deadline") {
            timer = setTimeout(() => child.kill("SIGKILL"), 100);
        } else {
            controller.abort();
        }

        // A live descendant holding stdout open would prevent EOF even after its parent exits.
        expect(await reader.read()).toMatchObject({ done: true });
        expect(await child.exited).not.toBe(0);
        expect(await stderr).toBe("");
        expect(Date.now() - start).toBeLessThan(3000);
    } finally {
        clearTimeout(timer);

        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
        }

        await Promise.all([child.exited, stderr]);
        reader.releaseLock();
    }
}, 15000);

sandboxTest("real Bubblewrap and Git inspect the fixture together in one disposable filesystem", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jam-isolated-git-"));
    const git = (args: string[]) => {
        const result = Bun.spawnSync(["git", ...gitFlags, "-c", "commit.gpgSign=false", ...args], {
            cwd: directory, timeout: 5000, maxBuffer: 65536,
            env: { ...gitEnvironment, PATH: process.env.PATH ?? gitEnvironment.PATH, HOME: directory },
        });

        if (!result.success) {
            throw new Error(result.stderr.toString());
        }

        return result.stdout.toString().trim();
    };

    try {
        git(["init", "--initial-branch=main"]);
        writeFileSync(join(directory, jamData.participationFile), "Participation");
        writeFileSync(join(directory, "game.conf"), "title=Isolated game\ndescription=Small fixture");
        writeFileSync(join(directory, "screenshot.png"), await sharp({
            create: { width: 64, height: 32, channels: 3, background: "red" },
        }).png().toBuffer());
        git(["add", "."]);
        git(["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-m", "Fixture"]);
        const original = git(["rev-parse", "HEAD"]);
        writeFileSync(join(directory, "game.conf"), "title=New HEAD\ndescription=Later commit");
        git(["add", "game.conf"]);
        git(["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-m", "New HEAD"]);
        git(["config", "uploadpack.allowFilter", "true"]);
        const result = Bun.spawnSync(fixtureArguments("head", original, directory), {
            env: { PATH: gitEnvironment.PATH }, timeout: 10000, maxBuffer: 65536, killSignal: "SIGKILL",
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const snapshot = JSON.parse(result.stdout.toString());
        expect(snapshot.title).toBe("Isolated game");
        expect(snapshot.commit).toBe(original);
        expect(snapshot.image).toBeGreaterThan(0);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}, 15000);

sandboxTest("Git address-space limits accept large assets and reject compressed commit bombs", () => {
    const result = Bun.spawnSync(fixtureArguments("memory"), {
        env: { PATH: gitEnvironment.PATH }, timeout: 15000, maxBuffer: 65536, killSignal: "SIGKILL",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const [limits, asset, bomb] = result.stdout.toString().trim().split("\n").map((line) => JSON.parse(line));
    expect(limits.workerLimit).not.toContain("201326592");
    expect(limits.helperLimit).toMatch(/201326592\s+201326592\s+bytes/);
    expect(asset.code, asset.error).toBe(0);
    expect(asset.kind).toBeUndefined();
    expect(bomb.packBytes).toBeLessThan(256 * 1024);
    expect(bomb.code).toBe(128);
    expect(bomb.kind).toBe("resource");
    expect(bomb.error).toMatch(/out of memory|cannot allocate memory/i);
}, 20000);

sandboxTest("inspection rejects an expired deadline before launching Git", async () => {
    const info = repositoryInfo("https://github.com/luanti-org/luanti");
    await expect(inspectRepository(info, Date.now() - 1, Date.now() + 1000)).rejects.toThrow();
});

sandboxTest("the API gates worker presentation, preserves early failures and reaps a duplicate worker", async () => {
    // Trusted synthetic children exercise the pipe protocol without Git or a sandbox substitute.
    const spawn = Bun.spawn;
    const lookup = spyOn(dns, "lookup").mockImplementation((async (_host, options) => {
        const address = { address: "8.8.8.8", family: 4 };

        return typeof options === "object" && options.all ? [address] : address;
    }) as typeof dns.lookup);
    let mode = "gated";
    let child: ReturnType<typeof spawn> | undefined;
    const launch = spyOn(Bun, "spawn").mockImplementation(((args, options) => {
        expect(args).toContain("check-duplicate");
        child = spawn([process.execPath, protocolFixture, mode], options);

        return child;
    }) as typeof spawn);
    const info = repositoryInfo("https://github.com/o/game");
    const commit = "a".repeat(40);

    try {
        mode = "gated";
        let admitted = false;
        const snapshot = await inspectRepository(info, Date.now() + 5000, Infinity, undefined, {
            onCommit: (resolved) => {
                expect(resolved).toBe(commit);
                admitted = true;
            },
        });
        expect(admitted).toBe(true);
        expect(snapshot).toEqual({ commit, title: "Game", description: "Small", screenshot: Buffer.from("image") });
        expect(child!.exitCode).toBe(0);

        mode = "early-error";
        await expect(inspectRepository(info, Date.now() + 5000, Infinity, undefined, {
            onCommit: () => {
                throw new Error("Must not admit an unresolved commit");
            },
        })).rejects.toMatchObject({ status: 422, message: "Cannot resolve HEAD" });

        for (const [failure, kind] of [["resource-error", "resource"], ["timeout-error", "timeout"]]) {
            mode = failure;
            await expect(inspectRepository(info, Date.now() + 5000, Infinity, undefined, {
                onCommit: () => { throw new Error("No commit should be resolved"); },
            })).rejects.toMatchObject({ kind });
        }

        for (const failure of ["hang", "gated-hang"]) {
            mode = failure;
            await expect(inspectRepository(info, Date.now() + 100, Infinity, undefined, {
                onCommit: () => {},
            })).rejects.toMatchObject({ kind: "timeout" });
            expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
        }

        mode = "huge-output";
        await expect(inspectRepository(info, Date.now() + 5000, Infinity, undefined, {
            onCommit: () => {},
        })).rejects.toMatchObject({ kind: "resource" });
        expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);

        mode = "gated";
        const duplicate = new Error("Existing receipt");
        await expect(inspectRepository(info, Date.now() + 5000, Infinity, undefined, {
            onCommit: () => {
                throw duplicate;
            },
        })).rejects.toBe(duplicate);
        expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
        expect(child!.exitCode).not.toBe(0);
    } finally {
        launch.mockRestore();
        lookup.mockRestore();
    }
});
