import { randomFillSync } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import jamData from "../content/jam.json";
import {
    checkGitResult,
    cloneArguments,
    convertScreenshot,
    type Git,
    gitEnvironment,
    gitFlags,
    inspectHead,
    maxPngBytes,
    maxWebpBytes,
    parseGameConf,
} from "../server/inspection-worker";
import { readHosts, repositoryInfo } from "../server/repositories";
import { isPublicAddress } from "../server/submissions";
import { rateLimits, rateLimitsSchema } from "../server/config";
import { InspectionLimitError } from "../server/inspection-errors";
import { jamSchema } from "../shared/schemas";

const png = () =>
    sharp({ create: { width: 64, height: 32, channels: 3, background: "red" } })
        .png()
        .toBuffer();

test("participation configuration permits only a plain root Markdown filename", () => {
    expect(jamSchema.parse({ ...jamData, participationFile: "MY-JAM_2026.md" }).participationFile)
        .toBe("MY-JAM_2026.md");
    expect(jamSchema.parse({ ...jamData, participationFile: "README.md" }).participationFile).toBe("README.md");

    for (const participationFile of ["../JAM.md", "docs/JAM.md", "/JAM.md", "--JAM.md", ".md", "game.conf", "JAM.md\n"]) {
        expect(jamSchema.safeParse({ ...jamData, participationFile }).success).toBe(false);
    }
});

test("allowed URLs canonicalize; namespaces and URL parser normalizations cannot widen the policy", () => {
    expect(repositoryInfo("https://GitHub.com/OWNER/GAME.git/").repository).toBe(
        "https://github.com/owner/game",
    );
    expect(repositoryInfo("https://gitlab.com/Group/Sub/Game").repository).toBe(
        "https://gitlab.com/group/sub/game",
    );

    for (const host of readHosts()) {
        for (const scheme of ["http", "https", "HTTP"]) {
            for (const prefix of ["", "www."]) {
                for (const suffix of ["", "/", ".git", ".git/"]) {
                    const info = repositoryInfo(`${scheme}://${prefix}${host.host}/Owner/Game${suffix}`);
                    expect(info.repository).toBe(`https://${host.host}/owner/game`);
                    expect(info.host).toBe(host.host);
                    expect(info.clone).toBe(`https://${host.host}/owner/game.git`);
                }
            }
        }
    }

    expect(readHosts().map(({ host, commit }) => [host, commit])).toEqual([
        ["github.com", "/tree/{sha}"],
        ["gitlab.com", "/-/tree/{sha}"],
        ["codeberg.org", "/src/commit/{sha}"],
        ["git.minetest.land", "/src/commit/{sha}"],
        ["bitbucket.org", "/src/{sha}"],
    ]);

    for (const url of [
        "ftp://github.com/o/g",
        "ssh://github.com/o/g",
        "git://github.com/o/g",
        "http://www.github.com:80/o/g",
        "http://www.github.com:443/o/g",
        "https://www.github.com:/o/g",
        "http://user:secret@www.github.com/o/g",
        "http://@www.github.com/o/g",
        "http://www.github.com.evil.test/o/g",
        "https://www.www.github.com/o/g",
        "https://github.com/o/g?x",
        "https://github.com/o/g#x",
        "https://user@github.com/o/g",
        "https://github.com:443/o/g",
        "https://github.com:0443/o/g",
        "https://github.com:444/o/g",
        "https://github.com.evil.test/o/g",
        "https://git.sr.ht/~o/g",
        "https://notabug.org/o/g",
        "https://git.disroot.org/o/g",
        "https://sourceforge.net/p/o/g",
        "https://github.com/o/g/commit/abc",
        "https://github.com/o/../g",
        "https://github.com/o/%67",
        "https://github.com/o\\g",
        "https://github.com/-o/g",
        "https://github.com/o/g//",
        " https://github.com/o/g",
    ]) {
        expect(() => repositoryInfo(url)).toThrow();
    }

    for (const address of [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "192.168.0.1",
        "::1",
        "::ffff:8.8.8.8",
        "0.0.0.0",
        "224.0.0.1",
    ]) {
        expect(isPublicAddress(address)).toBe(false);
    }

    expect(isPublicAddress("8.8.8.8")).toBe(true);
});

test("host policy is dynamically read and malformed policy fails closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "jam-policy-"));
    const path = `${directory}/hosts.json`;

    try {
        writeFileSync(path, "{}");
        expect(() => readHosts(path)).toThrow("policy is unavailable");
        writeFileSync(
            path,
            JSON.stringify([{ host: "github.com", nested: false, lowercase: true, commit: "/tree/{sha}" }]),
        );
        expect(() => repositoryInfo("https://codeberg.org/o/g", readHosts(path))).toThrow();
        expect(repositoryInfo("https://github.com/o/g", readHosts(path)).repository).toBe(
            "https://github.com/o/g",
        );
        writeFileSync(
            path,
            JSON.stringify([
                { host: "codeberg.org", nested: false, lowercase: false, commit: "/src/commit/{sha}" },
            ]),
        );
        expect(repositoryInfo("https://codeberg.org/Owner/Game", readHosts(path)).repository).toBe(
            "https://codeberg.org/Owner/Game",
        );

        for (const commit of ["/commit/{sha}", "/commits/{sha}", "/tree/HEAD", "/tree/{sha}?x=1"]) {
            writeFileSync(path, JSON.stringify([{ host: "github.com", nested: false, lowercase: true, commit }]));
            expect(() => readHosts(path)).toThrow("policy is unavailable");
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("Git construction restricts transport and does not inherit credentials/configuration/proxies", () => {
    expect(cloneArguments("https://github.com/o/g.git")).toEqual([
        "clone",
        "--bare",
        "--depth=1",
        "--single-branch",
        "--no-tags",
        "--filter=blob:none",
        "--no-recurse-submodules",
        "--",
        "https://github.com/o/g.git",
        "/tmp/repository",
    ]);

    for (const setting of [
        "protocol.allow=never",
        "protocol.https.allow=always",
        "http.followRedirects=false",
        "http.proxy=",
        "credential.helper=",
        "core.hooksPath=/dev/null",
    ]) {
        expect(gitFlags).toContain(setting);
    }

    expect(gitEnvironment.GIT_ALLOW_PROTOCOL).toBe("https");
    expect(gitEnvironment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(Object.keys(gitEnvironment).some((key) => /proxy|token|password/i.test(key))).toBe(false);
});

test("game.conf metadata is bounded and malformed or ambiguous settings are rejected", () => {
    expect(
        parseGameConf("# Comment\ntitle = A game\ndescription = A small experiment\nauthor = Someone"),
    ).toEqual({ title: "A game", description: "A small experiment" });
    expect(
        parseGameConf(
            'unrelated = """\ntitle=ignored\n"""\n[extra]\nunrelated syntax\ntitle = Real\ndescription = Valid',
        ),
    ).toEqual({ title: "Real", description: "Valid" });

    for (const value of [
        "",
        "title = Title",
        "title=T\ntitle=T\ndescription=D",
        `title=${"x".repeat(201)}\ndescription=D`,
        `title=T\ndescription=${"x".repeat(2001)}`,
        "title=T\ndescription=Bad\u0000",
    ]) {
        expect(() => parseGameConf(value)).toThrow();
    }
});

test("game.conf parses maximum-size whitespace lines within a bounded worker deadline", () => {
    // A subprocess deadline can terminate a synchronous parser regression without hanging the suite.
    const result = Bun.spawnSync([process.execPath, "--eval", `
        import { parseGameConf } from "./server/inspection-worker.ts";
        console.log(JSON.stringify(parseGameConf(" ".repeat(16300) + "\\ntitle = Game = One\\ndescription = Small")));
    `], { cwd: `${import.meta.dir}/..`, timeout: 2000, maxBuffer: 4096, killSignal: "SIGKILL" });
    expect(result.success, result.stderr.toString()).toBe(true);
    expect(JSON.parse(result.stdout.toString())).toEqual({ title: "Game = One", description: "Small" });
});

test("game.conf rejects hidden controls while preserving international text and normalizing NFC", () => {
    for (const char of ["\u0000", "\u0009", "\u007f", "\u0085", "\u009f", "\u061c", "\u200b",
        "\u200e", "\u200f", "\u2028", "\u2029", "\u202a", "\u202e", "\u2066", "\u2069",
        "\u00ad", "\u180e", "\u2060", "\ufeff"]) {
        expect(() => parseGameConf(`title=A${char}B\ndescription=Valid`)).toThrow();
        expect(() => parseGameConf(`title=Valid\ndescription=A${char}B`)).toThrow();
    }

    expect(parseGameConf("title=Cafe\u0301\ndescription=لعبة می\u200cروم 👩\u200d💻"))
        .toEqual({ title: "Café", description: "لعبة می\u200cروم 👩\u200d💻" });
    expect(parseGameConf(`title=${"e\u0301".repeat(200)}\ndescription=Valid`).title).toBe("é".repeat(200));
});

test("screenshots reject other formats before metadata decoding and still validate PNG contents", async () => {
    const images = [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
        await sharp(await png()).tiff().toBuffer(),
        await sharp(await png()).jpeg().toBuffer(),
        Buffer.alloc(0),
        (await png()).subarray(0, 7),
    ];

    for (const image of images) {
        await expect(convertScreenshot(image)).rejects.toThrow("must start with the PNG signature");
    }

    await expect(convertScreenshot((await png()).subarray(0, 8))).rejects.toThrow("must be a valid, single PNG");
});

test("screenshot must decode as PNG within input and decoded limits and becomes bounded WebP", async () => {
    const result = await convertScreenshot(await png());
    const metadata = await sharp(result).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(64);
    expect(metadata.height).toBe(32);
    const large = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: "white" } })
        .png()
        .toBuffer();
    const resized = await sharp(await convertScreenshot(large)).metadata();
    expect(resized.width).toBe(480);
    expect(resized.height).toBe(480);
    await expect(convertScreenshot(Buffer.alloc(maxPngBytes + 1))).rejects.toThrow("8 MiB");
    await expect(convertScreenshot(Buffer.from("not png"))).rejects.toThrow();
    const jpeg = await sharp(await png())
        .jpeg()
        .toBuffer();
    await expect(convertScreenshot(jpeg)).rejects.toThrow("PNG");
    const huge = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "white" } })
        .png()
        .toBuffer();
    await expect(convertScreenshot(huge)).rejects.toThrow("16 megapixels");
    const truncated = (await png()).subarray(0, 50);
    await expect(convertScreenshot(truncated)).rejects.toThrow();
});

async function fakeGit(
    mode = "100644",
    missing = "",
    conf = "title=Game\ndescription=Small",
    oversize = false,
) {
    const screenshot = await png();
    const calls: string[][] = [];
    const commit = "a".repeat(40);
    const git: Git = (args) => {
        calls.push(args);

        if (args[0] === "rev-parse") {
            return Buffer.from(commit);
        }

        if (args[0] === "ls-tree") {
            return Buffer.from(
                [jamData.participationFile, "game.conf", "screenshot.png"]
                    .filter((name) => name !== missing)
                    .map((name) => `${mode} blob ${"b".repeat(40)}\t${name}\0`)
                    .join(""),
            );
        }

        const name = args[2].split(":")[1];

        if (name === jamData.participationFile) {
            throw new Error("Participation content must never be read");
        }

        const data = name === "game.conf" ? Buffer.from(conf) : screenshot;

        return args[1] === "-s" ? Buffer.from(String(oversize ? maxPngBytes + 1 : data.length)) : data;
    };

    return { git, calls };
}

test("resolved commit admission precedes presentation reads and cannot bypass the submission deadline", async () => {
    const f = await fakeGit();
    const duplicate = new Error("Existing receipt");
    const onCommit = (commit: string) => {
        expect(commit).toBe("a".repeat(40));
        expect(f.calls.map((call) => call[0])).toEqual(["rev-parse"]);
        throw duplicate;
    };

    await expect(inspectHead(f.git, Infinity, { onCommit })).rejects.toBe(duplicate);
    expect(f.calls.map((call) => call[0])).toEqual(["rev-parse"]);
    let admitted = false;
    await expect(inspectHead(f.git, 0, {
        onCommit: () => {
            admitted = true;
        },
    })).rejects.toThrow("deadline");
    expect(admitted).toBe(false);

    const fresh = await fakeGit();
    const snapshot = await inspectHead(fresh.git, Infinity, {
        onCommit: async (commit) => {
            expect(commit).toBe("a".repeat(40));
            expect(fresh.calls).toHaveLength(1);
        },
    });
    expect(snapshot.title).toBe("Game");
    expect(fresh.calls.some((call) => call[0] === "cat-file")).toBe(true);
});

test("participation and game.conf require regular root entries; participation content is never fetched", async () => {
    const f = await fakeGit();
    const result = await inspectHead(f.git, Date.now() + 10000);
    expect(f.calls.find((call) => call[0] === "ls-tree"))
        .toEqual(["ls-tree", "-z", result.commit, "--", jamData.participationFile, "game.conf", "screenshot.png"]);
    expect(result.title).toBe("Game");
    expect(result.commit).toBe("a".repeat(40));
    expect(
        f.calls.filter((call) => call[0] === "cat-file").some((call) => call[2].endsWith(`:${jamData.participationFile}`)),
    ).toBe(false);

    for (const mode of ["120000", "160000", "040000"]) {
        await expect(inspectHead((await fakeGit(mode)).git, Date.now() + 10000)).rejects.toThrow(
            "regular root",
        );
    }

    for (const missing of [jamData.participationFile, "game.conf"]) {
        await expect(inspectHead((await fakeGit("100644", missing)).git, Date.now() + 10000)).rejects.toThrow(
            missing,
        );
    }

    await expect(
        inspectHead((await fakeGit("100644", "", "title=Game")).git, Date.now() + 10000),
    ).rejects.toThrow();
    await expect(
        inspectHead((await fakeGit("100644", "", undefined, true)).git, Date.now() + 10000),
    ).rejects.toThrow("size limit");
    await expect(inspectHead(f.git, Date.now() - 1)).rejects.toThrow("deadline");
    expect((await inspectHead(f.git, Date.now() - 1, { commit: "a".repeat(40) })).commit).toBe("a".repeat(40));
    await expect(inspectHead(f.git, Infinity, { commit: "b".repeat(40) })).rejects.toThrow("requested commit");
});

test("omitted screenshots are accepted without blob reads; supplied screenshots must be regular, nonempty PNG files", async () => {
    const missing = await fakeGit("100644", "screenshot.png");
    const result = await inspectHead(missing.git, Infinity);
    expect(result.screenshot.length).toBe(0);
    expect(missing.calls.filter((call) => call[0] === "cat-file").some((call) => call[2].endsWith(":screenshot.png")))
        .toBe(false);

    const present = await fakeGit();
    expect((await inspectHead(present.git, Infinity)).screenshot.length).toBeGreaterThan(0);

    for (const mode of ["120000", "160000", "040000"]) {
        const git: Git = (args, limit) => args[0] === "ls-tree"
            ? Buffer.from(present.git(args, limit).toString().replace(/100644 blob ([0-9a-f]+)\tscreenshot.png/, `${mode} blob $1\tscreenshot.png`))
            : present.git(args, limit);
        await expect(inspectHead(git, Infinity)).rejects.toThrow("regular root screenshot.png");
    }

    for (const image of [Buffer.alloc(0), Buffer.from("not png")]) {
        const git: Git = (args, limit) => args[0] === "cat-file" && args[2].endsWith(":screenshot.png")
            ? args[1] === "-s" ? Buffer.from(String(image.length)) : image
            : present.git(args, limit);
        await expect(inspectHead(git, Infinity)).rejects.toThrow();
    }
});

test("the configured declaration is required even when other Markdown files exist", async () => {
    const f = await fakeGit("100644", jamData.participationFile);
    const git: Git = (args, limit) => args[0] === "ls-tree"
        ? Buffer.concat([f.git(args, limit), Buffer.from(`100644 blob ${"b".repeat(40)}\tOTHER.md\0`)])
        : f.git(args, limit);
    await expect(inspectHead(git, Infinity)).rejects.toThrow(jamData.participationFile);
});

test("native Git reads a shallow bare partial clone, leaves no checkout, and pins the inspected commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jam-git-"));
    const run = (args: string[], cwd = directory) => {
        const result = Bun.spawnSync(["git", ...gitFlags, "-c", "protocol.file.allow=always", "-c", "commit.gpgSign=false", ...args], {
            cwd, timeout: 5000, maxBuffer: 65536,
            env: { ...gitEnvironment, PATH: process.env.PATH ?? gitEnvironment.PATH, HOME: directory, GIT_ALLOW_PROTOCOL: "file" },
        });

        if (!result.success) {
            throw new Error(result.stderr.toString());
        }

        return result.stdout;
    };

    try {
        run(["init", "--initial-branch=main"]);
        writeFileSync(`${directory}/${jamData.participationFile}`, "Participation");
        writeFileSync(`${directory}/game.conf`, "title=Game\ndescription=Small");
        writeFileSync(`${directory}/screenshot.png`, await png());
        run(["add", "."]);
        run(["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-m", "Fixture"]);
        run(["config", "uploadpack.allowFilter", "true"]);
        const clone = `${directory}/clone.git`;
        run([
            "clone",
            "--bare",
            "--depth=1",
            "--single-branch",
            "--no-tags",
            "--filter=blob:none",
            `file://${directory}`,
            clone,
        ]);
        const before = run(["rev-parse", "HEAD"], clone).toString().trim();
        writeFileSync(`${directory}/game.conf`, "title=Changed\ndescription=Later");
        run(["add", "game.conf"]);
        run(["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-m", "Later"]);
        const result = await inspectHead((args) => run(args, clone), Date.now() + 10000);
        expect(result.commit).toBe(before);
        expect(result.title).toBe("Game");
        expect(run(["rev-parse", "--is-bare-repository"], clone).toString().trim()).toBe("true");
        expect(run(["rev-list", "--count", "HEAD"], clone).toString().trim()).toBe("1");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("native Bun output limits terminate asynchronous and synchronous subprocesses", async () => {
    const args = [process.execPath, "-e", "console.log(\"x\".repeat(1024 * 1024))"];
    const child = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2000,
        maxBuffer: 1024,
        killSignal: "SIGKILL",
    });
    const [stdout, , exit] = await Promise.all([
        new Response(child.stdout).bytes(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    expect(exit).not.toBe(0);

    // Native maxBuffer may include the single read that crosses the limit.
    expect(stdout.length).toBeLessThan(128 * 1024);
    const result = Bun.spawnSync(args, { timeout: 2000, maxBuffer: 1024, killSignal: "SIGKILL" });
    expect(result.success).toBe(false);
    expect(result.stdout.length).toBeLessThan(128 * 1024);
});

test("detailed RGB and alpha thumbnails fit the 512 KiB budget at 640×480", async () => {
    for (const channels of [3, 4] as const) {
        const pixels = randomFillSync(Buffer.alloc(640 * 480 * channels));
        const source = await sharp(pixels, { raw: { width: 640, height: 480, channels } }).png().toBuffer();
        const preview = await convertScreenshot(source);
        const image = await sharp(preview).metadata();
        expect(preview.length).toBeGreaterThan(100000);
        expect(preview.length).toBeLessThanOrEqual(maxWebpBytes);
        expect(image).toMatchObject({ format: "webp", width: 640, height: 480 });
    }
});

test("rate-limit JSON rejects unsafe quotas and inconsistent scopes", () => {
    expect(rateLimitsSchema.parse(rateLimits)).toEqual(rateLimits);

    for (const value of [0, -1, 1.5, Infinity, NaN, "300", 1000001]) {
        expect(rateLimitsSchema.safeParse({ ...rateLimits, apiPerMinute: value }).success).toBe(false);
    }

    for (const changes of [
        { apiPerMinute: rateLimits.apiPerHour + 1 },
        { inspectionPerRepositoryPerHour: rateLimits.inspectionPerIpPerHour },
        { inspectionGlobalPerHour: rateLimits.inspectionPerRepositoryPerHour },
        { inspectionTimeoutsPerHour: rateLimits.inspectionPerIpPerHour + 1 },
        { unexpected: 1 },
    ]) {
        expect(rateLimitsSchema.safeParse({ ...rateLimits, ...changes }).success).toBe(false);
    }
});

test("only demonstrable local Git resource failures trigger resource classifications", () => {
    const result = { success: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), signalCode: undefined as string | number | undefined };

    for (const signalCode of ["SIGXCPU", "SIGXFSZ", 24, 25]) {
        expect(() => checkGitResult({ ...result, signalCode }, 4096, Infinity)).toThrow(InspectionLimitError);
    }

    for (const stderr of ["fatal: Out of memory, malloc failed (tried to allocate 200000000 bytes)",
        "fatal: mmap failed: Cannot allocate memory", "error: index-pack died of signal 25"]) {
        try {
            checkGitResult({ ...result, stderr: Buffer.from(stderr) }, 4096, Infinity);
            throw new Error("Expected a resource violation");
        } catch (error) {
            expect(error).toMatchObject({ kind: "resource" });
        }
    }

    expect(() => checkGitResult({ ...result, stdout: Buffer.alloc(4097) }, 4096, Infinity)).toThrow(InspectionLimitError);

    for (const stderr of ["remote: fatal: Out of memory", "fatal: unable to access repository: Connection reset",
        "fatal: remote error: Out of memory", "error: invalid commit contains 'out of memory'", "fatal: repository not found"]) {
        try {
            checkGitResult({ ...result, stderr: Buffer.from(stderr) }, 4096, Infinity);
            throw new Error("Expected a normal Git failure");
        } catch (error) {
            expect(error).not.toBeInstanceOf(InspectionLimitError);
            expect(error).toMatchObject({ message: "Git inspection failed; check that the HTTPS repository is public and available" });
        }
    }

    // SIGKILL alone does not prove a configured resource limit was exceeded.
    expect(() => checkGitResult({ ...result, signalCode: "SIGKILL" }, 4096, Infinity)).not.toThrow(InspectionLimitError);

    expect(() => checkGitResult(result, 4096, Date.now() - 1)).toThrow("Inspection timed out");
});
