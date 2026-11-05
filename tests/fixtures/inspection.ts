import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, openSync, readFileSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { createDeflate, deflateSync } from "node:zlib";

// The test mounts this driver beside the production worker, preserving its real subprocess limits.
const workerPath = "/app/inspection-worker.ts";
const { gitCommand, gitEnvironment, inspectHead, cloneArguments, checkGitResult } = await import(workerPath) as typeof import("../../server/inspection-worker");
const mode = process.argv[2];

if (mode === "fresh") {
    writeFileSync("/tmp/marker", "x");
    const space = statfsSync("/tmp");
    console.log(space.blocks * space.bsize);
} else if (mode === "check-fresh") {
    if (await Bun.file("/tmp/marker").exists()) {
        throw new Error("Sandbox retained a previous inspection's filesystem");
    }

    console.log("fresh");
} else if (mode === "full") {
    const file = openSync("/tmp/full", "w");
    const buffer = Buffer.alloc(1024 * 1024);
    let bounded = false;

    try {
        for (let index = 0; index < 140; index++) {
            writeSync(file, buffer);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOSPC") {
            throw error;
        }

        bounded = true;
    } finally {
        closeSync(file);
    }

    if (!bounded) {
        throw new Error("Sandbox storage exceeded its bound");
    }

    try {
        checkGitResult({ success: false, stdout: Buffer.alloc(0), stderr: Buffer.from("Write failed") }, 4096, Infinity);
        throw new Error("Expected a full-tmpfs resource classification");
    } catch (error) {
        if ((error as { kind?: string }).kind !== "resource") {
            throw error;
        }
    }

    console.log("bounded");
} else if (mode === "descendant") {
    const child = Bun.spawn(["/bin/sh", "-c", "sleep 60"], { stdout: "inherit", stderr: "inherit" });
    console.log("ready");
    await child.exited;
} else if (mode === "head") {
    const git = (args: string[], limit = 65536) => {
        const result = Bun.spawnSync([...gitCommand, "-c", "protocol.file.allow=always", ...args], {
            cwd: args[0] === "clone" ? "/tmp" : "/tmp/repository",
            timeout: 5000,
            maxBuffer: limit,
            killSignal: "SIGKILL",

            // Only this controlled local fixture enables file transport.
            env: { ...gitEnvironment, GIT_ALLOW_PROTOCOL: "file" },
        });

        if (!result.success) {
            throw new Error(result.stderr.toString());
        }

        return result.stdout;
    };

    const commit = process.argv[3];
    git(cloneArguments("file:///fixture"));
    git(["fetch", "--depth=1", "--no-tags", "--filter=blob:none", "--no-recurse-submodules", "origin", commit]);
    const snapshot = await inspectHead(git, 0, { commit });
    console.log(JSON.stringify({ title: snapshot.title, commit: snapshot.commit, image: snapshot.screenshot.length }));
} else if (mode === "memory") {
    const git = (args: string[], stdin?: Uint8Array) => Bun.spawnSync([...gitCommand, ...args], {
        env: gitEnvironment,
        stdin: stdin ?? "ignore",
        timeout: 5000,
        stdout: "pipe",
        stderr: "pipe",
        maxBuffer: 65536,
        killSignal: "SIGKILL",
    });
    const limits = git(["-c", "alias.limits=!cat /proc/self/limits", "limits"]);

    if (!limits.success) {
        throw new Error(limits.stderr.toString());
    }

    const addressSpace = (source: string) => source.split("\n").find((line) => line.startsWith("Max address space"));
    console.log(JSON.stringify({
        workerLimit: addressSpace(readFileSync("/proc/self/limits", "utf8")),
        helperLimit: addressSpace(limits.stdout.toString()),
    }));

    for (const [type, payloadBytes] of [[3, 64 * 1024 ** 2], [1, 192 * 1024 ** 2]]) {
        // Stream the repeated payload so constructing the bomb does not allocate its expanded size.
        const compressor = createDeflate();
        const compressed: Buffer[] = [];
        compressor.on("data", (chunk: Buffer) => compressed.push(chunk));
        const finished = once(compressor, "end");
        const commitHeader = type === 1 ? Buffer.from(
            "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"
            + "author Test <test@example.org> 1 +0000\ncommitter Test <test@example.org> 1 +0000\n\n",
        ) : Buffer.alloc(0);
        compressor.write(commitHeader);
        const chunk = Buffer.alloc(1024 * 1024, "x");

        for (let remaining = payloadBytes; remaining > 0; remaining -= chunk.length) {
            if (!compressor.write(chunk)) {
                await once(compressor, "drain");
            }
        }

        compressor.end();
        await finished;
        let size = payloadBytes + commitHeader.length;
        const objectHeader = [(type << 4) | (size & 15)];
        size = Math.floor(size / 16);

        while (size) {
            objectHeader[objectHeader.length - 1] |= 128;
            objectHeader.push(size & 127);
            size = Math.floor(size / 128);
        }

        // Two valid Git objects: an empty tree and either a large asset or a huge commit message.
        const pack = Buffer.concat([
            Buffer.from("5041434b0000000200000002", "hex"),
            Buffer.from([0x20]), deflateSync(Buffer.alloc(0)),
            Buffer.from(objectHeader), ...compressed,
        ]);
        const input = Buffer.concat([pack, createHash("sha1").update(pack).digest()]);
        const directory = `/tmp/fixture-${type}`;
        const initialized = git(["init", "--bare", directory]);

        if (!initialized.success) {
            throw new Error(initialized.stderr.toString());
        }

        const result = git([`--git-dir=${directory}`, "index-pack", "--stdin"], input);
        let kind: string | undefined;

        try {
            checkGitResult(result, 65536, Infinity);
        } catch (error) {
            kind = (error as { kind?: string }).kind;
        }

        console.log(JSON.stringify({ type, packBytes: input.length, code: result.exitCode, error: result.stderr.toString(), kind }));
    }
} else {
    throw new Error(`Unknown inspection fixture: ${mode}`);
}
