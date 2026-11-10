import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { HTTPException } from "hono/http-exception";
import {
    createIdentity, getAdminImage, getAdminQueue, getRepositoryStatus, jam, listBrews,
    moderateEntry, restoreIdentity, submitBrew,
} from "../client/sdk";
import workshop from "../content/workshop.json";
import { renderWorkshop } from "../client/markdown";
import { insertCsp } from "../scripts/build";
import { createApp } from "../server/app";
import { clientAddress, clientIdentity, loadConfig, loadPublicApiUrl, rateLimits } from "../server/config";
import { Store } from "../server/storage";
import { InspectionLimitError } from "../server/inspection-errors";
import { createSubmissions } from "../server/submissions";
import { actionSchema, type Snapshot } from "../shared/schemas";
import { publicKeyFromSecret, signRequest, verifyRequest } from "../shared/signatures";

const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

const sha = (value: string) => value.repeat(40);
const snapshot = (commit = sha("a")): Snapshot => ({
    commit, title: `<script>Game ${commit[0]}</script>`, description: "A small game",
    screenshot: Buffer.from(`WebP fixture ${commit}`),
});

async function fixture(limits: Partial<typeof rateLimits> = {}) {
    const directory = mkdtempSync(join(tmpdir(), "jam-test-"));

    // Keep global boundary tests inexpensive while using the deployed limits for every other scope.
    const store = new Store(directory, { ...rateLimits, inspectionGlobalPerHour: 100, ...limits });
    cleanups.push(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    const config = { ...loadConfig(true, {}), dataDir: directory, startsAt: 0, endsAt: Date.now() + 3600000 };

    // Ordinary authorization tests need real signatures, without repeating mnemonic derivation.
    const secretKey = new Uint8Array(32).fill(1);
    const identity = { secretKey, publicKey: publicKeyFromSecret(secretKey) };
    writeFileSync(join(directory, "admins.json"), JSON.stringify([identity.publicKey]));
    let head = sha("a");
    let failure: Error | undefined;
    const inspected: Array<{ repository: string; commit: string | undefined }> = [];
    const submissions = createSubmissions(config, store, {
        inspect: async (info, _deadline, _endsAt, _signal, options) => {
            await options?.onCommit?.(options?.commit ?? head);
            inspected.push({ repository: info.repository, commit: options?.commit });

            if (failure) {
                throw failure;
            }

            return snapshot(options?.commit ?? head);
        },
    });
    const app = createApp({ config, store, submissions });
    const options = { fetch: ((input, init) => app.fetch(new Request(input, init), { ip: "127.0.0.1" })) as typeof fetch };

    return {
        directory, store, config, identity, app, options, submissions, inspected,
        setHead: (commit: string) => { head = commit; },
        failInspection: (error?: Error) => { failure = error; },
    };
}

function reference(entry: { repository: string; commit: string }) {
    return { repository: entry.repository, commit: entry.commit };
}

function referenceKey(entry: { repository: string; commit: string }) {
    return JSON.stringify([entry.repository, entry.commit]);
}

async function recordedStatus(f: Awaited<ReturnType<typeof fixture>>, entry: { repository: string; commit: string }) {
    const reviews = await getAdminQueue(f.config.audience, f.identity, f.options);
    const row = reviews.find((row) => referenceKey(row) === referenceKey(entry))!;
    const { repository, commit, commitUrl, submittedAt, status, reason } = row;

    return { repository, commit, commitUrl, submittedAt, status, reason };
}

function expectPurged(store: Store, entry: { repository: string; commit: string }, status: string) {
    expect(store.db.query('SELECT status, title, description, image FROM submissions WHERE repository = ? AND "commit" = ?')
        .get(entry.repository, entry.commit))
        .toEqual({ status, title: null, description: null, image: null });
}

test("repository status reads existing databases after the jam without inspections or record changes", async () => {
    const f = await fixture();
    const repository = "https://github.com/o/game";
    const now = Date.now();
    const first = f.store.recordSubmission(f.config.jamId, repository, snapshot(), now, "/tree/{sha}");
    f.store.moderate({ ...reference(first), revision: 0, operation: "approve" }, f.identity.publicKey, now, f.config.jamId);
    const second = f.store.recordSubmission(f.config.jamId, repository, snapshot(sha("b")), now, "/tree/{sha}");
    f.store.recordSubmission("another-jam", repository, snapshot(sha("f")), now + 1, "/tree/{sha}");
    const rows = f.store.db.query("SELECT * FROM submissions ORDER BY rowid").all();
    const budgets = f.store.db.query("SELECT * FROM budgets ORDER BY key").all();
    const version = f.store.db.query("PRAGMA user_version").get();
    const reopened = new Store(f.directory);

    try {
        const app = createApp({ config: { ...f.config, endsAt: 0 }, store: reopened });
        const options = { fetch: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch };
        const result = await getRepositoryStatus(f.config.audience, "http://www.github.com/O/GAME.git/", options);
        expect(result).toEqual({ ...second, repository });
        expect(result).not.toHaveProperty("id");
        expect(result).not.toHaveProperty("title");
        expect(result).not.toHaveProperty("description");
        expect(result).not.toHaveProperty("hasScreenshot");
        await expect(getRepositoryStatus(f.config.audience, "https://github.com/o/unknown", options))
            .rejects.toMatchObject({ status: 404 });
        await expect(getRepositoryStatus(f.config.audience, "https://unknown.example/o/game", options))
            .rejects.toMatchObject({ status: 400 });
        expect((await app.request("/api/submissions")).status).toBe(400);
        expect(reopened.db.query("SELECT * FROM submissions ORDER BY rowid").all()).toEqual(rows);
        expect(reopened.db.query("SELECT * FROM budgets ORDER BY key").all()).toEqual(budgets);
        expect(reopened.db.query("PRAGMA user_version").get()).toEqual(version);
    } finally {
        reopened.close();
    }
});

test("repository status follows replacement pending commits and retains the latest review feedback", async () => {
    const f = await fixture();
    const api = f.config.audience;
    const repository = "https://github.com/o/game";
    const now = Date.now();
    const first = f.store.recordSubmission(f.config.jamId, repository, snapshot(), now, "/tree/{sha}");
    f.store.moderate({ ...reference(first), revision: 0, operation: "approve" }, f.identity.publicKey, now, f.config.jamId);
    const second = f.store.recordSubmission(f.config.jamId, repository, snapshot(sha("b")), now, "/tree/{sha}");
    const third = f.store.recordSubmission(f.config.jamId, repository, snapshot(sha("c")), now, "/tree/{sha}");
    expectPurged(f.store, second, "superseded");
    expect(await getRepositoryStatus(api, repository, f.options)).toEqual({ ...third, repository });
    expect(referenceKey((await listBrews(api, f.options))[0])).toBe(referenceKey(first));

    f.store.moderate({ ...reference(third), revision: 0, operation: "reject", reason: "Add credits" },
        f.identity.publicKey, now + 1, f.config.jamId);
    expect(await getRepositoryStatus(api, repository, f.options)).toMatchObject({
        ...reference(third), status: "rejected", reason: "Add credits",
    });

    // Reopening an older review makes it current even though its submission predates the rejection.
    f.store.restore({ ...reference(second), revision: 1, operation: "reinspect" }, snapshot(sha("b")),
        f.identity.publicKey, now + 2, f.config.jamId);
    expect(await getRepositoryStatus(api, repository, f.options)).toMatchObject({ ...reference(second), status: "pending" });
    f.store.moderate({ ...reference(second), revision: 2, operation: "reject", reason: "Still unsuitable" },
        f.identity.publicKey, now + 3, f.config.jamId);
    expect(await getRepositoryStatus(api, repository, f.options)).toMatchObject({
        ...reference(third), status: "rejected", reason: "Add credits",
    });

    // Reading status neither resolves a changed HEAD nor submits it.
    f.setHead(sha("d"));
    expect(await getRepositoryStatus(api, repository, f.options)).toMatchObject({ commit: third.commit });
    expect(f.inspected).toEqual([]);
    expect(f.store.queue(f.config.jamId)).toHaveLength(3);

    // Reapproving an older commit replaces the newer publication. Its superseded row must not win lookup.
    f.store.restore({ ...reference(third), revision: 1, operation: "reinspect" }, snapshot(sha("c")),
        f.identity.publicKey, now + 4, f.config.jamId);
    f.store.moderate({ ...reference(third), revision: 2, operation: "approve" }, f.identity.publicKey, now + 5, f.config.jamId);
    f.store.restore({ ...reference(second), revision: 3, operation: "reinspect" }, snapshot(sha("b")),
        f.identity.publicKey, now + 6, f.config.jamId);
    f.store.moderate({ ...reference(second), revision: 4, operation: "approve" }, f.identity.publicKey, now + 7, f.config.jamId);
    expectPurged(f.store, third, "superseded");
    expect(await getRepositoryStatus(api, repository, f.options)).toMatchObject({ ...reference(second), status: "approved" });
});

test("each commit has a receipt; pending updates preserve publication and duplicates return every existing state", async () => {
    const f = await fixture();
    const api = f.config.audience;
    const repository = "https://github.com/o/game";
    const duplicate = async (receipt: Awaited<ReturnType<typeof submitBrew>>, input = repository) => {
        const rows = f.store.db.query('SELECT * FROM submissions ORDER BY repository, "commit"').all();
        const inspections = f.inspected.length;
        const current = await recordedStatus(f, receipt);

        // Existing identities return even if presentation cannot be inspected again.
        f.failInspection(new HTTPException(422, { message: "Presentation unavailable" }));
        expect(await submitBrew(api, input, f.options)).toEqual(current);
        f.failInspection();
        expect(f.inspected.length).toBe(inspections);
        expect(f.store.db.query('SELECT * FROM submissions ORDER BY repository, "commit"').all()).toEqual(rows);
    };

    const first = await submitBrew(api, repository, f.options);
    expect(await listBrews(api, f.options)).toEqual([]);
    expect(await recordedStatus(f, first)).not.toHaveProperty("title");
    expect((await f.app.request(`/api/brews/image?${new URLSearchParams(reference(first))}`)).status).toBe(404);
    await duplicate(first, repository.toUpperCase().replace("HTTPS", "https"));
    await moderateEntry(api, f.identity, { ...reference(first), revision: 0, operation: "approve" }, f.options);
    await duplicate(first);

    f.setHead(sha("b"));
    const second = await submitBrew(api, repository, f.options);
    expect(referenceKey(second)).not.toBe(referenceKey(first));
    expect(referenceKey((await listBrews(api, f.options))[0])).toBe(referenceKey(first));
    f.setHead(first.commit);
    await duplicate(first);
    expect(f.store.submissionReceipt(f.config.jamId, second.repository, second.commit)!.status).toBe("pending");
    f.setHead(second.commit);
    await moderateEntry(api, f.identity, { ...reference(second), revision: 0, operation: "reject", reason: "Public explanation" }, f.options);
    expectPurged(f.store, second, "rejected");
    await expect(getAdminImage(api, f.identity, second.repository, second.commit, f.options)).rejects.toMatchObject({ status: 404 });
    await duplicate(second);
    expect(referenceKey((await listBrews(api, f.options))[0])).toBe(referenceKey(first));

    f.setHead(sha("c"));
    const third = await submitBrew(api, repository, f.options);
    await moderateEntry(api, f.identity, { ...reference(third), revision: 0, operation: "approve" }, f.options);
    expectPurged(f.store, first, "superseded");
    expect((await listBrews(api, f.options)).map((entry) => referenceKey(entry))).toEqual([referenceKey(third)]);
    expect((await f.app.request(`/api/brews/image?${new URLSearchParams(reference(first))}`)).status).toBe(404);
    f.setHead(first.commit);
    await duplicate(first);

    await moderateEntry(api, f.identity, { ...reference(third), revision: 1, operation: "unpublish", reason: "Removed content" }, f.options);
    expectPurged(f.store, third, "removed");
    expect(await listBrews(api, f.options)).toEqual([]);
    expect(await recordedStatus(f, third)).toMatchObject({ status: "removed", reason: "Removed content" });
    f.setHead(third.commit);
    await duplicate(third);
    const purged = await getAdminQueue(api, f.identity, f.options);
    expect(purged.length).toBe(3);

    // Previously published and superseded identities can also return to review,
    // without restoring publication until a fresh approval.
    for (const receipt of [first, third]) {
        const row = purged.find((entry) => referenceKey(entry) === referenceKey(receipt))!;
        await moderateEntry(api, f.identity, { ...reference(row), revision: row.revision, operation: "reinspect" }, f.options);
        expect(f.inspected.at(-1)?.commit).toBe(receipt.commit);
        expect((await recordedStatus(f, row)).status).toBe("pending");
        expect(await listBrews(api, f.options)).toEqual([]);
        await moderateEntry(api, f.identity, { ...reference(row), revision: row.revision + 1, operation: "reject", reason: "Still unsuitable" }, f.options);
    }
});

test("public receipts retain the accepted commit link through review, purging, and duplicate submissions", async () => {
    const f = await fixture();
    const jamId = f.config.jamId;
    const repository = "https://gitlab.com/group/subgroup/game";
    const receipt = f.store.recordSubmission(jamId, repository, snapshot(), Date.now(), "/-/tree/{sha}");
    const commitUrl = `${repository}/-/tree/${receipt.commit}`;
    const check = async (status: string) => {
        const result = status === "superseded" ? await recordedStatus(f, receipt)
            : await getRepositoryStatus(f.config.audience, repository, f.options);
        expect(result).toMatchObject({ commit: receipt.commit, commitUrl, status });
        expect(result).not.toHaveProperty("title");
        expect(result).not.toHaveProperty("description");
        expect(result).not.toHaveProperty("hasScreenshot");

        // A different current host template cannot rewrite the link recorded with this identity.
        expect(f.store.recordSubmission(jamId, repository, snapshot(), Date.now(), "/tree/{sha}"))
            .toEqual(result);
    };

    await check("pending");
    f.store.moderate({ ...reference(receipt), revision: 0, operation: "reject", reason: "Add credits" }, f.identity.publicKey, Date.now(), jamId);
    await check("rejected");
    f.store.restore({ ...reference(receipt), revision: 1, operation: "reinspect" }, snapshot(), f.identity.publicKey, Date.now(), jamId);
    await check("pending");
    f.store.moderate({ ...reference(receipt), revision: 2, operation: "approve" }, f.identity.publicKey, Date.now(), jamId);
    await check("approved");
    f.store.moderate({ ...reference(receipt), revision: 3, operation: "unpublish", reason: "Revise" }, f.identity.publicKey, Date.now(), jamId);
    await check("removed");
    f.store.restore({ ...reference(receipt), revision: 4, operation: "reinspect" }, snapshot(), f.identity.publicKey, Date.now(), jamId);
    f.store.recordSubmission(jamId, repository, snapshot(sha("b")), Date.now(), "/-/tree/{sha}");
    await check("superseded");
});

test("concurrent duplicate requests share one receipt and inspect presentation once", async () => {
    const f = await fixture();
    const receipts = await Promise.all(Array.from({ length: 5 }, () =>
        submitBrew(f.config.audience, "https://github.com/o/game", f.options),
    ));

    expect(receipts).toEqual(Array(5).fill(receipts[0]));
    expect(f.inspected).toHaveLength(1);
    expect(f.store.queue(f.config.jamId)).toHaveLength(1);
    expect(f.store.queue(f.config.jamId)[0].revision).toBe(0);
});

test("a duplicate committed by another connection during inspection preserves every stored row", async () => {
    const f = await fixture();
    const other = new Store(f.directory);
    cleanups.push(() => other.close());
    const repository = "https://github.com/o/game";
    let existing: ReturnType<Store["recordSubmission"]> | undefined;
    const submissions = createSubmissions(f.config, f.store, {
        inspect: async (_info, _deadline, _endsAt, _signal, options) => {
            await options?.onCommit?.(sha("a"));
            existing = other.recordSubmission(f.config.jamId, repository, snapshot(), 1000, "/tree/{sha}");
            other.moderate({ ...reference(existing), revision: 0, operation: "reject", reason: "Already reviewed" },
                f.identity.publicKey, 2000, f.config.jamId);
            other.recordSubmission(f.config.jamId, repository, snapshot(sha("b")), 3000, "/tree/{sha}");

            return { ...snapshot(), title: "Must not replace the recorded content" };
        },
    });
    const receipt = await submissions.submit(repository, "ip");
    expect(receipt).toEqual(other.submissionReceipt(f.config.jamId, existing!.repository, existing!.commit)!);
    expect(receipt).toMatchObject({ status: "rejected", reason: "Already reviewed", submittedAt: new Date(1000).toISOString() });
    const rows = other.db.query('SELECT * FROM submissions ORDER BY repository, "commit"').all();
    expect(rows).toHaveLength(2);

    // A stale final write is also idempotent while another commit remains pending.
    expect(f.store.recordSubmission(f.config.jamId, repository, snapshot(), 4000, "/ignored/{sha}"))
        .toEqual(receipt);
    expect(other.db.query('SELECT * FROM submissions ORDER BY repository, "commit"').all()).toEqual(rows);
    expect(f.store.queue(f.config.jamId).find((row) => row.commit === sha("b")))
        .toMatchObject({ status: "pending", revision: 0 });
});

test("screenshot-free entries can be reviewed, published, purged and reinspected without image responses", async () => {
    const f = await fixture();
    const api = f.config.audience;
    const withoutImage = { ...snapshot(), screenshot: Buffer.alloc(0) };
    const receipt = f.store.recordSubmission(f.config.jamId, "https://github.com/o/g", withoutImage, 1000, "/tree/{sha}");
    expect((await getAdminQueue(api, f.identity, f.options)).find((entry) => referenceKey(entry) === referenceKey(receipt))?.hasScreenshot).toBe(false);
    await expect(getAdminImage(api, f.identity, receipt.repository, receipt.commit, f.options)).rejects.toMatchObject({ status: 404 });
    expect(f.store.db.query("SELECT length(image) AS size FROM submissions WHERE repository = ? AND \"commit\" = ?").get(receipt.repository, receipt.commit))
        .toEqual({ size: 0 });

    await moderateEntry(api, f.identity, { ...reference(receipt), revision: 0, operation: "approve" }, f.options);
    expect((await listBrews(api, f.options))[0]).toMatchObject({ ...reference(receipt), hasScreenshot: false });
    expect((await f.app.request(`/api/brews/image?${new URLSearchParams(reference(receipt))}`)).status).toBe(404);

    const withImage = f.store.recordSubmission(f.config.jamId, "https://github.com/o/other", snapshot(sha("b")), 2000, "/tree/{sha}");
    expect((await getAdminQueue(api, f.identity, f.options)).find((entry) => referenceKey(entry) === referenceKey(withImage)))
        .toMatchObject({ hasScreenshot: true });

    await moderateEntry(api, f.identity, { ...reference(receipt), revision: 1, operation: "unpublish", reason: "Review again" }, f.options);
    expectPurged(f.store, receipt, "removed");
    expect((await getAdminQueue(api, f.identity, f.options)).find((entry) => referenceKey(entry) === referenceKey(receipt))?.hasScreenshot).toBe(false);

    f.store.restore({ ...reference(receipt), revision: 2, operation: "reinspect" }, withoutImage, f.identity.publicKey, 3000, f.config.jamId);
    expect((await getAdminQueue(api, f.identity, f.options)).find((entry) => referenceKey(entry) === referenceKey(receipt)))
        .toMatchObject({ status: "pending", hasScreenshot: false });
    await moderateEntry(api, f.identity, { ...reference(receipt), revision: 3, operation: "approve" }, f.options);
    expect((await listBrews(api, f.options))[0]).toMatchObject({ ...reference(receipt), hasScreenshot: false });
});

test("new pending submissions purge older reviews; stale or replayed approvals cannot publish them", async () => {
    const f = await fixture();
    const api = f.config.audience;
    const first = await submitBrew(api, "https://github.com/o/g", f.options);
    const oldDecision = { ...reference(first), revision: 0, operation: "approve" as const };
    f.setHead(sha("b"));
    const latest = await submitBrew(api, "https://github.com/o/g", f.options);
    expectPurged(f.store, first, "superseded");
    const reviews = await getAdminQueue(api, f.identity, f.options);
    expect(reviews).toHaveLength(2);
    expect(reviews.find((row) => referenceKey(row) === referenceKey(first))?.status).toBe("superseded");
    expect(reviews.find((row) => referenceKey(row) === referenceKey(latest))?.status).toBe("pending");
    await expect(moderateEntry(api, f.identity, oldDecision, f.options)).rejects.toMatchObject({ status: 409 });
    await expect(moderateEntry(api, f.identity, { ...oldDecision, revision: 1 }, f.options)).rejects.toMatchObject({ status: 409 });
    const decision = { ...reference(latest), revision: 0, operation: "approve" as const };
    const responses = await Promise.allSettled([
        moderateEntry(api, f.identity, decision, f.options), moderateEntry(api, f.identity, decision, f.options),
    ]);
    expect(responses.filter((response) => response.status === "fulfilled").length).toBe(1);
    expect((await listBrews(api, f.options))[0].commit).toBe(latest.commit);
});

test("reinspection fetches the recorded SHA after jam close and requires another approval", async () => {
    const f = await fixture();
    const api = f.config.audience;
    const original = await submitBrew(api, "https://github.com/o/g", f.options);
    await moderateEntry(api, f.identity, { ...reference(original), revision: 0, operation: "reject", reason: "Review later" }, f.options);
    f.setHead(sha("b"));
    f.config.endsAt = 1;
    const decision = { ...reference(original), revision: 1, operation: "reinspect" as const };
    await moderateEntry(api, f.identity, decision, f.options);
    expect(f.inspected.at(-1)?.commit).toBe(original.commit);
    expect(await recordedStatus(f, original)).toMatchObject({
        ...reference(original), status: "pending", submittedAt: original.submittedAt,
    });
    expect(await listBrews(api, f.options)).toEqual([]);
    await expect(moderateEntry(api, f.identity, decision, f.options)).rejects.toMatchObject({ status: 409 });
    await moderateEntry(api, f.identity, { ...reference(original), revision: 2, operation: "approve" }, f.options);
    expect((await listBrews(api, f.options))[0].commit).toBe(original.commit);
});

test("unavailable recorded commits leave purged rows unchanged; reinspection never displaces a pending review", async () => {
    const f = await fixture();
    const api = f.config.audience;
    const original = await submitBrew(api, "https://github.com/o/g", f.options);
    await moderateEntry(api, f.identity, { ...reference(original), revision: 0, operation: "reject", reason: "Review later" }, f.options);
    const before = f.store.db.query("SELECT * FROM submissions WHERE repository = ? AND \"commit\" = ?").get(original.repository, original.commit);
    f.failInspection(new HTTPException(422, { message: "Recorded commit unavailable" }));
    await expect(moderateEntry(api, f.identity, { ...reference(original), revision: 1, operation: "reinspect" }, f.options))
        .rejects.toMatchObject({ status: 422 });
    expect(f.store.db.query("SELECT * FROM submissions WHERE repository = ? AND \"commit\" = ?").get(original.repository, original.commit)).toEqual(before);
    f.failInspection();
    f.setHead(sha("b"));
    const pending = await submitBrew(api, "https://github.com/o/g", f.options);
    const inspected = f.inspected.length;
    await expect(moderateEntry(api, f.identity, { ...reference(original), revision: 1, operation: "reinspect" }, f.options))
        .rejects.toMatchObject({ status: 409 });
    expect(f.inspected.length).toBe(inspected);
    expect(f.store.submissionReceipt(f.config.jamId, pending.repository, pending.commit)!.status).toBe("pending");
    expect(() => f.store.restore({ ...reference(original), revision: 1, operation: "reinspect" }, snapshot(sha("c")), f.identity.publicKey, Date.now(), f.config.jamId))
        .toThrow();
});

test("reinspection rejects changed authorization or mismatched commits without restoring presentation", async () => {
    const f = await fixture();
    const receipt = f.store.recordSubmission(f.config.jamId, "https://github.com/o/g", snapshot(), 1000, "/tree/{sha}");
    f.store.moderate({ ...reference(receipt), revision: 0, operation: "reject", reason: "Review later" }, f.identity.publicKey, 2000, f.config.jamId);
    const decision = { ...reference(receipt), revision: 1, operation: "reinspect" as const };
    expect(() => f.store.restore(decision, snapshot(sha("b")), f.identity.publicKey, 3000, f.config.jamId)).toThrow("recorded commit");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const submissions = createSubmissions(f.config, f.store, {
        inspect: async () => {
            await gate;

            return snapshot();
        },
    });
    const work = submissions.reinspect(decision, f.identity.publicKey, "admin").catch((error) => error);
    writeFileSync(join(f.directory, "admins.json"), "[]");
    release();
    expect(await work).toMatchObject({ status: 403 });
    expectPurged(f.store, receipt, "rejected");
});

test("publication order is stable across pending and rejected updates, with a bounded unpaginated shelf", async () => {
    const f = await fixture();
    const keys: string[] = [];
    const data = snapshot();
    const insert = f.store.db.query(`
        INSERT INTO submissions (jam_id, repository, commit_path, "commit", status,
            title, description, image, submitted_at, updated_at, revision)
        VALUES (?, ?, '/tree/{sha}', ?, 'approved', ?, ?, ?, ?, ?, 1)
    `);

    // Seed collection size in one transaction; dedicated transition tests use normal Store mutations.
    f.store.db.transaction(() => {
        for (let index = 0; index < 105; index++) {
            const repository = `https://github.com/o/game${index}`;
            insert.run(f.config.jamId, repository, data.commit,
                data.title, data.description, data.screenshot,
                new Date(index).toISOString(), new Date(index + 1000).toISOString());
            keys.unshift(referenceKey({ repository, commit: data.commit }));
        }
    })();

    const shelf = await listBrews(f.config.audience, f.options);
    expect(shelf.map(referenceKey)).toEqual(keys.slice(0, 100));
    expect((await f.app.request("/api/brews?offset=20")).status).toBe(200);
    expect((await (await f.app.request("/api/brews?offset=20")).json()).length).toBe(100);
    const candidate = f.store.recordSubmission(f.config.jamId, "https://github.com/o/game104", snapshot(sha("b")), 10000, "/tree/{sha}");
    expect(await listBrews(f.config.audience, f.options)).toEqual(shelf);
    f.store.moderate({ ...reference(candidate), revision: 0, operation: "reject", reason: "No" }, f.identity.publicKey, 11000, f.config.jamId);
    expect(await listBrews(f.config.audience, f.options)).toEqual(shelf);
    const superseded = f.store.recordSubmission(f.config.jamId, "https://github.com/o/new", snapshot(), 12000, "/tree/{sha}");
    const pending = f.store.recordSubmission(f.config.jamId, "https://github.com/o/new", snapshot(sha("b")), 13000, "/tree/{sha}");
    const removed = f.store.recordSubmission(f.config.jamId, "https://github.com/o/removed", snapshot(), 14000, "/tree/{sha}");
    f.store.moderate({ ...reference(removed), revision: 0, operation: "approve" }, f.identity.publicKey, 15000, f.config.jamId);
    f.store.moderate({ ...reference(removed), revision: 1, operation: "unpublish", reason: "Removed" }, f.identity.publicKey, 16000, f.config.jamId);
    const token = await signRequest({ operation: "admin.queue" }, f.config.audience, f.identity);
    const response = await f.app.request("/api/admin", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(token),
    });
    expect(response.status).toBe(200);
    const raw = await response.json();
    expect(raw).toHaveLength(109);
    expect(raw.every((row: object) => !Object.hasOwn(row, "image") && !Object.hasOwn(row, "screenshot"))).toBe(true);

    const reviews = await getAdminQueue(f.config.audience, f.identity, f.options);
    expect(reviews.map(referenceKey).sort()).toEqual([...keys, referenceKey(candidate), referenceKey(pending), referenceKey(superseded), referenceKey(removed)].sort());
    expect(new Set(reviews.map((row) => row.status))).toEqual(new Set(["pending", "approved", "rejected", "superseded", "removed"]));
    expect(reviews.filter((row) => ["rejected", "superseded", "removed"].includes(row.status))
        .every((row) => row.title === null && row.description === null && !row.hasScreenshot)).toBe(true);
});

test("SQLite enforces content/state and publication uniqueness independently of application checks", async () => {
    const f = await fixture();
    const first = f.store.recordSubmission(f.config.jamId, "https://github.com/o/g", snapshot(), 1000, "/tree/{sha}");
    f.store.moderate({ ...reference(first), revision: 0, operation: "approve" }, f.identity.publicKey, 2000, f.config.jamId);
    const next = f.store.recordSubmission(f.config.jamId, "https://github.com/o/g", snapshot(sha("b")), 3000, "/tree/{sha}");
    expect(() => f.store.db.query("UPDATE submissions SET status = 'approved' WHERE repository = ? AND \"commit\" = ?").run(next.repository, next.commit)).toThrow();
    expect(() => f.store.db.query("UPDATE submissions SET status = 'removed' WHERE repository = ? AND \"commit\" = ?").run(first.repository, first.commit)).toThrow();
    expect(() => f.store.db.query("UPDATE submissions SET image = NULL WHERE repository = ? AND \"commit\" = ?").run(next.repository, next.commit)).toThrow();
    expect(f.store.db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
        .toEqual([{ name: "budgets" }, { name: "submissions" }]);
});

test("new databases enable full autovacuum and secure deletion with a page-size-derived 256 MiB limit", () => {
    const directory = mkdtempSync("/tmp/jam-storage-");
    const initial = new Database(join(directory, "jam.sqlite"));
    initial.run("PRAGMA page_size = 8192; PRAGMA auto_vacuum = FULL; VACUUM");
    initial.close();

    try {
        for (let reopen = 0; reopen < 2; reopen++) {
            const store = new Store(directory);
            expect(store.db.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 1 });
            expect(store.db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
            expect(store.db.query("PRAGMA page_size").get()).toEqual({ page_size: 8192 });
            expect(store.db.query("PRAGMA max_page_count").get()).toEqual({ max_page_count: 32768 });
            store.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("purging removes presentation bytes from the live database and truncates WAL when readers permit", async () => {
    const f = await fixture();
    const marker = `objectionable-${crypto.randomUUID()}`;
    const receipt = f.store.recordSubmission(f.config.jamId, "https://github.com/o/g", {
        ...snapshot(), title: marker, screenshot: Buffer.from(marker.repeat(4000)),
    }, 1000, "/tree/{sha}");
    const path = join(f.directory, "jam.sqlite");
    const before = statSync(path).size;
    expect(readFileSync(path).includes(Buffer.from(marker))).toBe(true);
    f.store.moderate({ ...reference(receipt), revision: 0, operation: "reject", reason: "Removed" }, f.identity.publicKey, 2000, f.config.jamId);
    expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false);
    expect(statSync(path).size).toBeLessThan(before);
    expect(statSync(`${path}-wal`).size).toBe(0);
});

test("full storage rolls back purging and reports capacity without losing the pending review or approval", async () => {
    const f = await fixture();
    const first = f.store.recordSubmission(f.config.jamId, "https://github.com/o/g", snapshot(), 1000, "/tree/{sha}");
    f.store.moderate({ ...reference(first), revision: 0, operation: "approve" }, f.identity.publicKey, 2000, f.config.jamId);
    const pending = f.store.recordSubmission(f.config.jamId, "https://github.com/o/g", snapshot(sha("b")), 3000, "/tree/{sha}");
    const pages = f.store.db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
    f.store.db.run(`PRAGMA max_page_count = ${pages + 2}`);
    const submissions = createSubmissions(f.config, f.store, {
        inspect: async () => ({ ...snapshot(sha("c")), screenshot: Buffer.alloc(128 * 1024) }),
    });
    const app = createApp({ config: f.config, store: f.store, submissions });
    const response = await app.request("/api/brews/submit", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository: "https://github.com/o/g" }),
    });
    expect(response.status).toBe(507);
    expect(f.store.submissionReceipt(f.config.jamId, pending.repository, pending.commit)!.status).toBe("pending");
    expect(f.store.image(pending.repository, pending.commit, f.config.jamId, true)).toEqual(snapshot(sha("b")).screenshot);
    expect(referenceKey(f.store.listEntries(f.config.jamId)[0])).toBe(referenceKey(first));
});

test("incompatible database schemas fail at startup", () => {
    const directory = mkdtempSync("/tmp/jam-schema-");
    const db = new Database(join(directory, "jam.sqlite"));
    db.run("CREATE TABLE entries (id TEXT)");
    db.close();

    try {
        expect(() => new Store(directory)).toThrow("Unsupported database schema");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("CSP injection rejects missing, ambiguous or already-secured build output", () => {
    expect(insertCsp("<html><head></head><body></body></html>", "default-src 'none'"))
        .toContain('<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">');
    expect(insertCsp("<head></head>", "literal $& policy")).toContain('content="literal $& policy"');
    expect(() => insertCsp("<html></html>", "policy")).toThrow();
    expect(() => insertCsp("<head><head>", "policy")).toThrow();
    expect(() => insertCsp('<head><meta http-equiv="Content-Security-Policy" content="old">', "policy")).toThrow();
});

test("shelf publication time follows approval and reapproval, while pending updates leave it intact", async () => {
    const f = await fixture();
    const jamId = f.config.jamId;
    const repository = "https://github.com/o/game";
    const submittedAt = Date.parse("2026-11-01T00:00:00Z");
    const publishedAt = Date.parse("2026-11-10T00:00:00Z");
    const receipt = f.store.recordSubmission(jamId, repository, snapshot(), submittedAt, "/tree/{sha}");
    expect(await listBrews(f.config.audience, f.options)).toEqual([]);
    f.store.moderate({ ...reference(receipt), revision: 0, operation: "approve" }, f.identity.publicKey, publishedAt, jamId);
    const published = await listBrews(f.config.audience, f.options);
    expect(published[0].publishedAt).toBe(new Date(publishedAt).toISOString());
    expect(published[0].publishedAt).not.toBe(receipt.submittedAt);

    const update = f.store.recordSubmission(jamId, repository, snapshot(sha("b")), publishedAt + 1000, "/tree/{sha}");
    expect(await listBrews(f.config.audience, f.options)).toEqual(published);
    f.store.moderate({ ...reference(update), revision: 0, operation: "reject", reason: "Revise" }, f.identity.publicKey, publishedAt + 2000, jamId);
    expect(await listBrews(f.config.audience, f.options)).toEqual(published);
    f.store.moderate({ ...reference(receipt), revision: 1, operation: "unpublish", reason: "Revise" }, f.identity.publicKey, publishedAt + 3000, jamId);
    expect(await listBrews(f.config.audience, f.options)).toEqual([]);

    f.store.restore({ ...reference(receipt), revision: 2, operation: "reinspect" }, snapshot(), f.identity.publicKey, publishedAt + 4000, jamId);
    expect(await listBrews(f.config.audience, f.options)).toEqual([]);
    f.store.moderate({ ...reference(receipt), revision: 3, operation: "approve" }, f.identity.publicKey, publishedAt + 5000, jamId);
    expect((await listBrews(f.config.audience, f.options))[0].publishedAt).toBe(new Date(publishedAt + 5000).toISOString());
});

test("production pages contain configured metadata and prose, with deployable assets and a JavaScript-free guide", async () => {
    const project = fileURLToPath(new URL("../", import.meta.url));
    const directory = mkdtempSync("/tmp/jam-build-");
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

    // Run the actual build with the current sources, isolating its destructive dist/ cleanup.
    for (const name of ["client", "content", "server", "shared", "scripts", "node_modules", "package.json", "bunfig.toml"]) {
        symlinkSync(join(project, name), join(directory, name));
    }

    const result = Bun.spawnSync([process.execPath, "run", "build"], {
        cwd: directory,
        env: {
            ...process.env,
            PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
            PUBLIC_API_URL: "https://api.example.org",
        },
        timeout: 20000,
        maxBuffer: 65536,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const output = join(directory, "dist");
    const index = await Bun.file(join(output, "index.html")).text();
    const copy = renderWorkshop();

    for (const [page, title] of [["index", copy.pageTitle], ["guide", copy.guide.title], ["admin", copy.admin.title]]) {
        const built = await Bun.file(join(output, `${page}.html`)).text();
        let pageTitle = "";
        let description = "";
        let heading = "";
        const references: string[] = [];

        await new HTMLRewriter()
            .on("title", {
                text(chunk) {
                    pageTitle += chunk.text;
                },
            })
            .on('meta[name="description"]', {
                element(element) {
                    description = element.getAttribute("content")!;
                },
            })
            .on("h1", {
                text(chunk) {
                    heading += chunk.text;
                },
            })
            .on("script[src], link[href], img[src]", {
                element(element) {
                    references.push(element.getAttribute(element.tagName === "link" ? "href" : "src")!);
                },
            })
            .transform(new Response(built))
            .text();

        expect(pageTitle).toBe(title);
        expect(heading.replace(/\s+/g, " ").trim()).toBe(page === "admin" ? copy.admin.title : copy.heading);
        expect(built).toContain(copy.footer.copyright);
        expect(built).not.toContain("{{");

        if (page !== "admin") {
            expect(description).toBe(copy.description);
            expect(built).toContain("Times are shown in");
            expect(built).toContain(jam.participationFile);
            expect(built.indexOf("Jam window")).toBeLessThan(built.indexOf("Pack your spellbook"));
        }

        for (const reference of references) {
            expect(reference).toStartWith("./");
            const url = new URL(reference, `https://example.org/jam/${page}.html`);
            expect(url.origin).toBe("https://example.org");
            expect(url.pathname).toStartWith("/jam/");
            expect(await Bun.file(join(output, url.pathname.slice("/jam/".length))).exists()).toBe(true);
        }
    }

    let guideLabel = "";
    let guideHref = "";
    let fallback = "";
    let fallbackGuideHref = "";
    let fallbackGuideLabel = "";

    await new HTMLRewriter()
        .on("#plain-version", {
            element(element) {
                guideHref = element.getAttribute("href")!;
            },
            text(chunk) {
                guideLabel += chunk.text;
            },
        })
        .on("noscript", {
            text(chunk) {
                fallback += chunk.text;
            },
        })
        .transform(new Response(index))
        .text();

    // HTMLRewriter treats noscript as raw text; parse its markup as the browser does without scripts.
    await new HTMLRewriter()
        .on("a", {
            element(element) {
                fallbackGuideHref = element.getAttribute("href")!;
            },
            text(chunk) {
                fallbackGuideLabel += chunk.text;
            },
        })
        .transform(new Response(fallback))
        .text();

    expect(guideLabel.trim()).not.toBe("");
    expect(guideHref).toBe("./guide.html");
    expect(fallbackGuideHref).toBe("./guide.html");
    expect(fallbackGuideLabel.trim()).not.toBe("");

    const html = await Bun.file(join(output, "guide.html")).text();
    const stylesheets: string[] = [];
    const images: string[] = [];
    let content = "";
    let title = "";

    await new HTMLRewriter()
        .on("#guide", {
            text(chunk) {
                content += chunk.text;
            },
        })
        .on("title", {
            text(chunk) {
                title += chunk.text;
            },
        })
        .on('link[rel="stylesheet"]', {
            element(element) {
                stylesheets.push(element.getAttribute("href")!);
            },
        })
        .on('link[rel="icon"], img', {
            element(element) {
                images.push(element.getAttribute(element.tagName === "img" ? "src" : "href")!);
            },
        })
        .transform(new Response(html))
        .text();

    expect(title).toBe(`${workshop.title} - Text guide`);
    expect(content).toContain("Themes and pantry resources are optional.");
    expect(content).toContain("Pack your spellbook");
    expect(content).toContain("(optional theme)");
    expect(content).toContain("Kenney game assets");
    expect(content).toContain("Artwork credits");
    expect(content).toContain("UTC");
    expect(html).toContain('id="artwork-credits"');
    expect(html).toContain('href="./index.html"');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).not.toMatch(/<script\b|rel=["']modulepreload["']|\son\w+\s*=/i);
    expect(html).not.toContain("{{participationFile}}");
    expect(html).not.toContain("Enable JavaScript");

    // Relative references must stay inside a Pages project path and resolve to emitted files.
    function artifact(reference: string) {
        expect(reference).toStartWith("./");
        const url = new URL(reference, "https://example.org/jam/guide.html");
        expect(url.origin).toBe("https://example.org");
        expect(url.pathname).toStartWith("/jam/");

        return join(output, url.pathname.slice("/jam/".length));
    }

    expect(stylesheets.length).toBeGreaterThan(0);
    const css = (await Promise.all(stylesheets.map((href) => Bun.file(artifact(href)).text()))).join("\n");
    expect(css).toMatch(/#guide\s*>\s*h1/);
    expect(css).toContain("#artwork-credits");
    expect(css).not.toContain("@import");

    expect(images).toHaveLength(2);

    for (const src of images) {
        expect(await Bun.file(artifact(src)).bytes()).toEqual(
            await Bun.file(join(project, "client/assets/luanti.svg")).bytes(),
        );
    }

    expect(await Bun.file(artifact("./index.html")).exists()).toBe(true);
});

test("authorization reloads admins.json; malformed policies fail closed; JWT arguments, audience and expiry are checked", async () => {
    const f = await fixture();
    const { identity: other } = await createIdentity();
    expect(actionSchema.safeParse({ operation: "admin.queue" }).success).toBe(true);
    expect(actionSchema.safeParse({ operation: "admin.queue", args: { ignored: true } }).success).toBe(false);
    await expect(getAdminQueue(f.config.audience, other, f.options)).rejects.toMatchObject({
        status: 403,
    });

    for (const value of ["[]", "{broken", JSON.stringify([f.identity.publicKey, f.identity.publicKey])]) {
        writeFileSync(join(f.directory, "admins.json"), value);
        await expect(
            getAdminQueue(f.config.audience, f.identity, f.options),
        ).rejects.toMatchObject({ status: 403 });
    }

    writeFileSync(join(f.directory, "admins.json"), JSON.stringify([f.identity.publicKey]));

    for (const [audience, time] of [
        ["https://other.example", Date.now()],
        [f.config.audience, Date.now() - 600000],
    ] as const) {
        const token = await signRequest(
            { operation: "admin.queue" },
            audience,
            f.identity,
            time,
        );
        expect(
            (
                await f.app.request("/api/admin", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(token),
                })
            ).status,
        ).toBe(403);
    }

    const restored = await restoreIdentity(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(restored.publicKey).toBe(
        "ed25519:dd416ba9c2c7c954f0a7504afe1807a39f2a8e8ae983c7f8464f378139a487ae",
    );
});

test("generated recovery phrases restore the same administrator identity", async () => {
    const generated = await createIdentity();
    expect(generated.phrase.split(" ")).toHaveLength(12);
    const restored = await restoreIdentity(generated.phrase);
    expect(restored.publicKey).toBe(generated.identity.publicKey);
    expect(restored.secretKey).toEqual(generated.identity.secretKey);
});

test("one active inspection, FIFO capacity, failure recovery and queued deadline checks", async () => {
    const f = await fixture();
    let now = 100;
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const releases: Array<() => void> = [];
    const started = Array.from({ length: 7 }, () => Promise.withResolvers<void>());
    const submit = createSubmissions({ ...f.config, startsAt: 0, endsAt: 1000 }, f.store, {
        clock: () => now,
        inspect: async (info) => {
            active++;
            peak = Math.max(peak, active);
            const index = Number(info.repository.at(-1));
            order.push(index);
            started[index].resolve();
            await new Promise<void>((resolve) => releases.push(resolve));
            active--;

            if (index === 0) {
                throw new HTTPException(422, { message: "failed clone" });
            }

            return snapshot();
        },
    }).submit;
    const jobs = Array.from({ length: 5 }, (_, i) =>
        submit(`https://github.com/o/g${i}`, `ip${i}`).then(
            () => 200,
            (error: { status: number }) => error.status,
        ),
    );
    await expect(submit("https://github.com/o/g5", "extra")).rejects.toMatchObject({ status: 429 });
    expect(order).toEqual([0]);
    releases.shift()!();
    await started[1].promise;
    expect(order).toEqual([0, 1]);

    releases.shift()!();
    await started[2].promise;
    expect(order).toEqual([0, 1, 2]);

    now = 1000;
    releases.shift()!();
    expect(await Promise.all(jobs)).toEqual([422, 200, 200, 403, 403]);
    expect(peak).toBe(1);

    now = 100;
    const recovered = submit("https://github.com/o/g6", "new");
    await started[6].promise;
    releases.shift()!();
    await recovered;
    expect(order.at(-1)).toBe(6);
});

test("signed mutation arguments cannot be altered and concurrent decisions cannot overwrite each other", async () => {
    const f = await fixture();
    const result = f.store.recordSubmission(
        "2026",
        "https://github.com/o/g",
        snapshot(),
        Date.now(),
        "/tree/{sha}",
    );
    const token = await signRequest(
        { operation: "admin.moderate", args: { ...reference(result), revision: 0, operation: "approve" } },
        f.config.audience,
        f.identity,
    );

    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    payload.action.args.operation = "reject";
    payload.action.args.reason = "Tampered signed arguments";
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const send = (signed: string) =>
        f.app.request("/api/admin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(signed),
        });
    expect((await send(parts.join("."))).status).toBe(403);

    const responses = await Promise.all([send(token), send(token)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
});

test("image requests sign their actual repository and commit, and share SDK errors and cancellation", async () => {
    const f = await fixture();
    const entry = await submitBrew(f.config.audience, "https://github.com/o/g", f.options);
    const fetchImage = (async (input, init) => {
        const claims = await verifyRequest(JSON.parse(init!.body as string), f.config.audience);
        expect(claims.action).toEqual({
            operation: "admin.image",
            args: reference(entry),
        });
        expect(claims).not.toHaveProperty("jti");

        return f.options.fetch(input, init);
    }) as typeof fetch;
    expect(
        (await getAdminImage(f.config.audience, f.identity, entry.repository, entry.commit, { fetch: fetchImage }))
            .type,
    ).toBe("image/webp");
    await expect(
        getAdminImage(f.config.audience, f.identity, entry.repository, "f".repeat(40), f.options),
    ).rejects.toMatchObject({ status: 404, message: "Image not found" });

    const controller = new AbortController();
    const waitingFetch = ((_input, init) =>
        new Promise((_resolve, reject) => {
            const signal = init!.signal!;

            if (signal.aborted) {
                reject(signal.reason);
            } else {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }
        })) as typeof fetch;
    await expect(
        getAdminImage(f.config.audience, f.identity, entry.repository, entry.commit, {
            fetch: waitingFetch,
            timeoutMs: 5,
            signal: controller.signal,
        }),
    ).rejects.toMatchObject({ status: 0 });
    controller.abort();
    await expect(
        listBrews(f.config.audience, { fetch: waitingFetch, signal: controller.signal }),
    ).rejects.toMatchObject({ status: 0 });
});

test("production origins require HTTPS and local development can explicitly use HTTP", () => {
    const valid = { PUBLIC_API_URL: "https://api.example.org", CLIENT_ORIGIN: "https://jam.example.org" };
    expect(loadConfig(false, valid).audience).toBe(valid.PUBLIC_API_URL);
    expect(() => loadConfig(false, { ...valid, PUBLIC_API_URL: "http://api.example.org" })).toThrow("HTTPS");
    expect(() => loadConfig(false, { ...valid, CLIENT_ORIGIN: "http://jam.example.org" })).toThrow("HTTPS");
    expect(() => loadPublicApiUrl({ PUBLIC_API_URL: "http://api.example.org" })).toThrow("HTTPS");
    expect(
        loadConfig(true, { PUBLIC_API_URL: "http://127.0.0.1:3000", CLIENT_ORIGIN: "http://localhost:3000" })
            .origin,
    ).toBe("http://localhost:3000");
});

test("queue-full refusals do not consume either durable submission budget", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const submit = createSubmissions(f.config, f.store, {
        inspect: async () => {
            await gate;

            return snapshot();
        },
    }).submit;
    const admitted = Array.from({ length: 5 }, (_, index) =>
        submit(`https://github.com/o/g${index}`, `accepted-${index}`),
    );

    // More refusals than either hourly limit: the next real admission must still succeed.
    for (let index = 0; index < 105; index++) {
        await expect(submit("https://github.com/o/refused", "refused")).rejects.toMatchObject({
            status: 429,
            message: "Inspection queue is full; try again shortly",
        });
    }

    release();
    await Promise.all(admitted);
    expect((await submit("https://github.com/o/refused", "refused")).status).toBe("pending");
});

test("cancellation during slot handoff releases ownership without overlapping inspections", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let release!: () => void;
    let finishNext!: () => void;
    const firstGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const nextGate = new Promise<void>((resolve) => {
        finishNext = resolve;
    });
    const entered: string[] = [];
    const nextStarted = Promise.withResolvers<void>();
    const submit = createSubmissions(f.config, f.store, {
        inspect: async (info) => {
            entered.push(info.repository);

            if (info.repository.endsWith("/next")) {
                nextStarted.resolve();
            }

            await (entered.length === 1 ? firstGate : nextGate);

            return snapshot();
        },
    }).submit;
    const first = submit("https://github.com/o/first", "first");
    const cancelled = submit("https://github.com/o/cancelled", "cancelled", controller.signal).catch((error) => error);
    const next = submit("https://github.com/o/next", "next");
    const last = submit("https://github.com/o/last", "last");

    // Grant detaches the queued abort listener. Abort at that boundary, before the waiter resumes.
    const removeListener = controller.signal.removeEventListener.bind(controller.signal);
    const grant = spyOn(controller.signal, "removeEventListener").mockImplementation((...args: Parameters<typeof removeListener>) => {
        removeListener(...args);
        controller.abort();
    });

    try {
        release();
        await first;
        expect(await cancelled).toMatchObject({ name: "AbortError" });
        await nextStarted.promise;
        expect(entered).toEqual(["https://github.com/o/first", "https://github.com/o/next"]);
    } finally {
        grant.mockRestore();
        release();
        finishNext();
        await Promise.all([first, next, last]);
    }

    expect(entered.at(-1)).toBe("https://github.com/o/last");
});

test("cancelling active work waits for inspector cleanup before handing off the slot", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let cleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
        cleanup = resolve;
    });
    const entered: string[] = [];
    const aborted = Promise.withResolvers<void>();
    const submit = createSubmissions(f.config, f.store, {
        inspect: async (info, _deadline, _endsAt, signal) => {
            entered.push(info.repository);

            if (signal) {
                await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => {
                        aborted.resolve();
                        resolve();
                    }, { once: true }),
                );
                await cleanupGate;
                signal.throwIfAborted();
            }

            return snapshot();
        },
    }).submit;
    const cancelled = submit("https://github.com/o/active", "active", controller.signal).catch((error) => error);
    const queued = submit("https://github.com/o/queued", "queued");
    controller.abort();
    await aborted.promise;
    expect(entered).toEqual(["https://github.com/o/active"]);
    cleanup();
    expect(await cancelled).toMatchObject({ name: "AbortError" });
    await queued;
    expect(entered).toEqual(["https://github.com/o/active", "https://github.com/o/queued"]);
});

test("cancelled waiters cannot exhaust inspection budgets without starting work", async () => {
    const f = await fixture();
    const now = 1000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let inspections = 0;
    const submit = createSubmissions(f.config, f.store, {
        clock: () => now,
        inspect: async () => {
            inspections++;
            await gate;

            return snapshot();
        },
    }).submit;
    const active = submit("https://github.com/o/active", "active");
    const budgets = f.store.db.query("SELECT * FROM budgets ORDER BY key").all();

    // Repeated join/abort cycles exceed both limits while using just one waiting place.
    for (let index = 0; index < 105; index++) {
        const controller = new AbortController();
        const cancelled = submit("https://github.com/o/waiter", "waiter", controller.signal).catch((error) => error);
        controller.abort();
        expect(await cancelled).toMatchObject({ name: "AbortError" });
    }

    expect(inspections).toBe(1);
    expect(f.store.db.query("SELECT * FROM budgets ORDER BY key").all()).toEqual(budgets);
    release();
    await active;

    // Bring both counters to one below the limit without persisting another 98 submissions.
    f.store.db.transaction(() => {
        for (let index = 0; index < 19; index++) {
            f.store.admitSubmission("waiter", "https://github.com/o/waiter", now);
        }

        for (let index = 0; index < 79; index++) {
            f.store.admitSubmission(`other-${index}`, `https://github.com/o/other${index}`, now);
        }
    })();

    await submit("https://github.com/o/waiter", "waiter");
    expect(inspections).toBe(2);
    await expect(submit("https://github.com/o/waiter", "waiter")).rejects.toMatchObject({ status: 429 });
    await expect(submit("https://github.com/o/other", "extra")).rejects.toMatchObject({ status: 429 });
});

test.each(["ip", "global"])("exhausted %s budgets cannot queue submissions or administrator reinspections", async (scope) => {
    const f = await fixture();
    let now = 1000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const entered: string[] = [];
    const submissions = createSubmissions(f.config, f.store, {
        clock: () => now,
        inspect: async (info) => {
            entered.push(info.repository);
            await gate;

            return snapshot();
        },
    });
    const purged = f.store.recordSubmission(f.config.jamId, "https://github.com/o/purged", snapshot(), now, "/tree/{sha}");
    f.store.moderate({ ...reference(purged), revision: 0, operation: "reject", reason: "Not ready" }, f.identity.publicKey, now, f.config.jamId);
    const active = submissions.submit("https://github.com/o/active", "active");

    for (let index = 0; index < (scope === "ip" ? 20 : 99); index++) {
        f.store.admitSubmission(scope === "ip" ? "limited" : `other-${index}`, `https://github.com/o/budget${index}`, now);
    }

    const budgets = f.store.db.query("SELECT * FROM budgets ORDER BY key").all();
    const waiters: ReturnType<typeof submissions.submit>[] = [];

    try {
        for (let index = 0; index < 4; index++) {
            await expect(submissions.submit("https://github.com/o/refused", "limited", AbortSignal.timeout(1000)))
                .rejects.toMatchObject({ status: 429, message: "Inspection limit reached; try next hour" });
        }

        await expect(submissions.reinspect(
            { ...reference(purged), revision: 1, operation: "reinspect" }, f.identity.publicKey, "limited", AbortSignal.timeout(1000),
        )).rejects.toMatchObject({ status: 429, message: "Inspection limit reached; try next hour" });
        expect(f.store.db.query("SELECT * FROM budgets ORDER BY key").all()).toEqual(budgets);

        if (scope === "ip") {
            for (let index = 0; index < 4; index++) {
                waiters.push(submissions.submit(`https://github.com/o/accepted${index}`, `accepted-${index}`));
            }

            expect(f.store.db.query("SELECT * FROM budgets ORDER BY key").all()).toEqual(budgets);
        }

        expect(entered).toEqual(["https://github.com/o/active"]);
    } finally {
        release();
        await Promise.all([active, ...waiters]);
    }

    now += 3600000;
    expect((await submissions.submit("https://github.com/o/new-hour", "limited")).status).toBe("pending");
});

test("budget exhaustion after queueing is rechecked at FIFO handoff without entering inspection", async () => {
    const f = await fixture();

    for (let index = 0; index < 19; index++) {
        f.store.admitSubmission("limited", "https://github.com/o/limited", Date.now());
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const entered: string[] = [];
    const submit = createSubmissions(f.config, f.store, {
        inspect: async (info) => {
            entered.push(info.repository);
            await gate;

            return snapshot();
        },
    }).submit;
    const active = submit("https://github.com/o/active", "active");
    const refused = submit("https://github.com/o/limited", "limited").catch((error) => error);
    const next = submit("https://github.com/o/next", "next");

    // Another admission after the read-only precheck must still make this waiter fail.
    f.store.admitSubmission("limited", "https://github.com/o/limited", Date.now());
    release();
    await Promise.all([active, next]);

    expect(await refused).toMatchObject({ status: 429 });
    expect(entered).toEqual(["https://github.com/o/active", "https://github.com/o/next"]);
});

test("queued inspections use the start-hour budget while retaining their arrival receipt", async () => {
    const f = await fixture();
    let now = 3599999;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const submit = createSubmissions(f.config, f.store, {
        clock: () => now,
        inspect: async () => {
            await gate;

            return snapshot();
        },
    }).submit;
    const active = submit("https://github.com/o/active", "active");
    const queued = submit("https://github.com/o/queued", "queued");
    now = 3600000;
    release();
    await active;
    expect((await queued).submittedAt).toBe(new Date(3599999).toISOString());

    for (let index = 0; index < 19; index++) {
        await submit(`https://github.com/o/queued${index}`, "queued");
    }

    await expect(submit("https://github.com/o/queued", "queued")).rejects.toMatchObject({ status: 429 });
});

test("preflights and body-limit refusals share request accounting, with readable CORS errors", async () => {
    const f = await fixture();
    let now = 1000;
    const app = createApp({ config: f.config, store: f.store, clock: () => now });
    const request = (method: string, ip = "limited", body?: string) => app.fetch(
        new Request(`${f.config.audience}/api/brews/submit`, {
            method,
            headers: {
                "Origin": f.config.origin,
                "Content-Type": "application/json",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
            body,
        }),
        { ip },
    );

    const oversized = await request("POST", "limited", JSON.stringify({ repository: "x".repeat(70000) }));
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("Cache-Control")).toBe("no-store");

    for (let index = 0; index < 4999; index++) {
        // Stay below the minute quota while exhausting the shared hourly request allowance.
        now = 1000 + Math.floor(index / 200) * 60000;
        expect((await request("OPTIONS")).status).toBe(204);
    }

    const blocked = await request("OPTIONS");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Access-Control-Allow-Origin")).toBe(f.config.origin);
    expect((await request("GET")).status).toBe(429);
    expect((await request("OPTIONS", "other")).status).toBe(204);

    now += 3600000;
    expect((await request("OPTIONS")).status).toBe(204);
});

test("exhausted per-IP admissions cannot consume the remaining global budget", async () => {
    const f = await fixture();

    for (let index = 0; index < 20; index++) {
        f.store.admitSubmission("limited", "https://github.com/o/limited", 1000);
    }

    for (let index = 0; index < 100; index++) {
        expect(() => f.store.admitSubmission("limited", "https://github.com/o/limited", 1000)).toThrow("Inspection limit");
    }

    for (let index = 0; index < 80; index++) {
        f.store.admitSubmission(`other-${index}`, `https://github.com/o/other${index}`, 1000);
    }

    expect(() => f.store.admitSubmission("global-full", "https://github.com/o/full", 1000)).toThrow("Inspection limit");
});

test("minute and hourly API quotas allow bursts, isolate IPs, reset independently, and log exhaustion once", async () => {
    const f = await fixture({ apiPerMinute: 3, apiPerHour: 5, apiTrackedIps: 2 });
    let now = 1000;
    const app = createApp({ config: f.config, store: f.store, clock: () => now });
    const request = (ip = "192.0.2.5") => app.fetch(new Request(`${f.config.audience}/api/health`, {
        headers: { Origin: f.config.origin },
    }), { ip });

    for (let i = 0; i < 3; i++) {
        expect((await request()).status).toBe(200);
    }

    const minute = await request();
    expect(minute.status).toBe(429);
    expect(minute.headers.get("Retry-After")).toBe("59");
    expect(minute.headers.get("Access-Control-Allow-Origin")).toBe(f.config.origin);
    expect(await minute.json()).toMatchObject({ error: "Request limit reached; try next minute" });

    for (let i = 0; i < 10; i++) {
        expect((await request()).status).toBe(429);
    }

    expect((await request("other")).status).toBe(200);
    now = 60000;
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    now = 120000;
    expect((await request()).status).toBe(429);
    now = 3600000;
    expect((await request()).status).toBe(200);
    const lines = readFileSync(join(f.directory, "incidents.log"), "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["api-minute-limit", "api-hour-limit"]);
    expect(lines.join("\n")).not.toContain("192.0.2.5");
});

test("client identities canonicalize mapped IPv4 and IPv6 /64s after trusted proxy resolution", () => {
    for (const address of ["192.0.2.5", "::ffff:192.0.2.5", "::ffff:c000:205"]) {
        expect(clientIdentity(address)).toBe("192.0.2.5");
    }

    for (const address of ["2001:db8:1234:5678::1", "2001:0DB8:1234:5678:abcd:ef01:2345:6789"]) {
        expect(clientIdentity(address)).toBe("2001:db8:1234:5678::/64");
    }

    expect(clientIdentity("2001:db8:1234:5679::1")).toBe("2001:db8:1234:5679::/64");
    expect(clientIdentity(clientIdentity("2001:db8::1"))).toBe("2001:db8::/64");
    const request = new Request("http://localhost/api/health", { headers: { "X-Real-IP": "::ffff:192.0.2.5" } });
    expect(clientIdentity(clientAddress(request, "127.0.0.1", true)!)).toBe("192.0.2.5");
    expect(clientAddress(request, "192.0.2.10", true)).toBe("192.0.2.10");
    expect(clientAddress(request, "127.0.0.1", false)).toBe("127.0.0.1");
});

test("API quotas share IPv6 /64 and mapped IPv4 allowances without grouping separate networks", async () => {
    const f = await fixture({ apiPerMinute: 2 });
    const request = (ip: string) => f.app.fetch(new Request(`${f.config.audience}/api/health`), { ip });

    for (const prefix of ["2001:db8:1234:5678:", "2001:db8:1234:5679:"]) {
        expect((await request(`${prefix}:1`)).status).toBe(200);
        expect((await request(`${prefix}:2`)).status).toBe(200);
        expect((await request(`${prefix}:3`)).status).toBe(429);
    }

    expect((await request("192.0.2.5")).status).toBe(200);
    expect((await request("::ffff:192.0.2.5")).status).toBe(200);
    expect((await request("::ffff:c000:205")).status).toBe(429);
    expect((await request("192.0.2.6")).status).toBe(200);
});

test("API table saturation evicts cold counters, preserves hot quotas and leaves durable inspection budgets intact", async () => {
    const f = await fixture({ apiTrackedIps: 2, apiPerMinute: 4 });
    const request = (ip: string) => f.app.fetch(new Request(`${f.config.audience}/api/health`), { ip });
    f.store.recordInspectionLimit("192.0.2.1", "https://github.com/o/game", "resource", Date.now());
    expect((await request("192.0.2.1")).status).toBe(200);
    expect((await request("192.0.2.2")).status).toBe(200);
    expect((await request("192.0.2.1")).status).toBe(200);
    expect((await request("192.0.2.3")).status).toBe(200);
    expect((await request("192.0.2.1")).status).toBe(200);
    expect((await request("192.0.2.4")).status).toBe(200);
    expect((await request("192.0.2.1")).status).toBe(200);
    expect((await request("192.0.2.1")).status).toBe(429);

    for (let index = 5; index < 50; index++) {
        expect((await request(`192.0.2.${index}`)).status).toBe(200);
    }

    expect(() => f.store.checkSubmissionBudget("::ffff:192.0.2.1", "https://github.com/o/fresh", Date.now()))
        .toThrow("Inspection limit");
    expect(readFileSync(join(f.directory, "incidents.log"), "utf8")).toContain("api-ip-capacity");
});

test("IPv6 rotation cannot drain inspection admissions or erase timeout penalties", async () => {
    const f = await fixture();
    const now = 1000;

    for (let index = 0; index < f.store.limits.inspectionPerIpPerHour; index++) {
        f.store.admitSubmission(`2001:db8::${index.toString(16)}`, `https://github.com/o/game${index}`, now);
    }

    expect(() => f.store.admitSubmission("2001:db8::ffff", "https://github.com/o/fresh", now)).toThrow("Inspection limit");
    expect(f.store.db.query("SELECT count FROM budgets WHERE key = 'submission:global'").get()).toEqual({ count: 20 });
    expect(() => f.store.admitSubmission("2001:db8:0:1::1", "https://github.com/o/fresh", now)).not.toThrow();

    f.store.recordInspectionLimit("2001:db8:1::1", "https://github.com/o/slow1", "timeout", now);
    f.store.recordInspectionLimit("2001:db8:1::2", "https://github.com/o/slow2", "timeout", now);
    expect(() => f.store.checkSubmissionBudget("2001:db8:1::3", "https://github.com/o/slow3", now)).toThrow("Inspection limit");
    f.store.recordInspectionLimit("::ffff:192.0.2.5", "https://github.com/o/slow4", "timeout", now);
    f.store.recordInspectionLimit("192.0.2.5", "https://github.com/o/slow5", "timeout", now);
    expect(() => f.store.checkSubmissionBudget("::ffff:c000:205", "https://github.com/o/slow6", now)).toThrow("Inspection limit");
    expect(() => f.store.checkSubmissionBudget("2001:db8:1::4", "https://github.com/o/fresh", now + 3600000)).not.toThrow();
});

test("canonical repository quotas reject concurrent URL variants at handoff without charging refused scopes", async () => {
    const f = await fixture({ inspectionPerIpPerHour: 2, inspectionPerRepositoryPerHour: 3, inspectionGlobalPerHour: 8 });
    const now = 1000;
    const repository = "https://github.com/o/game";
    f.store.admitSubmission("seed1", repository, now);
    f.store.admitSubmission("seed2", repository, now);
    const gate = Promise.withResolvers<void>();
    const entered: string[] = [];
    const submit = createSubmissions(f.config, f.store, {
        clock: () => now,
        inspect: async (info) => {
            expect(info.clone).toStartWith("https://");
            entered.push(info.repository);
            await gate.promise;

            return snapshot();
        },
    }).submit;
    const active = submit("https://github.com/o/active", "active");
    const jobs = ["http://www.github.com/O/GAME.git/", "https://github.com/o/game", "https://WWW.GitHub.com/O/Game.git"]
        .map((url, index) => submit(url, `ip${index}`).catch((error) => error));
    gate.resolve();
    await active;
    const results = await Promise.all(jobs);
    expect(results.map((result) => result.status)).toEqual(["pending", 429, 429]);
    expect(entered).toEqual(["https://github.com/o/active", repository]);
    expect(f.store.db.query("SELECT count FROM budgets WHERE key = 'submission:global'").get()).toEqual({ count: 4 });
    expect(f.store.db.query("SELECT count FROM budgets WHERE key = ?").get(`repository:${repository}`)).toEqual({ count: 3 });
    expect(f.store.db.query("SELECT key FROM budgets WHERE key IN ('submission:ip1', 'submission:ip2')").all()).toEqual([]);
    await expect(submit("http://www.github.com/o/game.git", "fresh")).rejects.toMatchObject({ status: 429 });
    expect(entered).toHaveLength(2);
});

test("atomic admissions across connections cannot spend another scope after repository exhaustion", async () => {
    const f = await fixture({ inspectionPerIpPerHour: 2, inspectionPerRepositoryPerHour: 3, inspectionGlobalPerHour: 8 });
    const other = new Store(f.directory, f.store.limits);
    cleanups.unshift(() => other.close());
    const repository = "https://github.com/o/game";
    f.store.admitSubmission("seed1", repository, 1000);
    f.store.admitSubmission("seed2", repository, 1000);
    const results = await Promise.all([f.store, other, f.store].map(async (store, index) => {
        try {
            store.admitSubmission(`ip${index}`, repository, 1000);

            return "accepted";
        } catch (error) {
            return (error as HTTPException).status;
        }
    }));
    expect(results).toEqual(["accepted", 429, 429]);
    expect(f.store.db.query("SELECT count FROM budgets WHERE key = 'submission:global'").get()).toEqual({ count: 3 });
    expect(f.store.db.query("SELECT key FROM budgets WHERE key IN ('submission:ip1', 'submission:ip2')").all()).toEqual([]);
});

test("resource violations immediately block both identities, including existing waiters and aliases", async () => {
    const f = await fixture();
    const now = 1000;
    const repository = "https://github.com/o/game";
    const gate = Promise.withResolvers<void>();
    const entered: string[] = [];
    const submit = createSubmissions(f.config, f.store, {
        clock: () => now,
        inspect: async (info) => {
            entered.push(info.repository);
            await gate.promise;

            if (info.repository === repository) {
                throw new InspectionLimitError("resource");
            }

            return snapshot();
        },
    }).submit;
    const failed = submit(repository, "offender").catch((error) => error);
    const sameRepo = submit("http://www.GitHub.com/O/GAME.git/", "other-ip").catch((error) => error);
    const sameIp = submit("https://github.com/o/other", "offender").catch((error) => error);
    const good = submit("https://github.com/o/good", "good-ip");
    gate.resolve();
    expect(await failed).toMatchObject({ kind: "resource" });
    expect(await sameRepo).toMatchObject({ status: 429 });
    expect(await sameIp).toMatchObject({ status: 429 });
    expect((await good).status).toBe("pending");
    expect(entered).toEqual([repository, "https://github.com/o/good"]);
    expect(f.store.db.query("SELECT count FROM budgets WHERE key = 'submission:offender'").get())
        .toEqual({ count: f.store.limits.inspectionPerIpPerHour });
    expect(f.store.db.query("SELECT count FROM budgets WHERE key = ?").get(`repository:${repository}`))
        .toEqual({ count: f.store.limits.inspectionPerRepositoryPerHour });
    expect(f.store.db.query("SELECT count FROM budgets WHERE key = 'submission:global'").get()).toEqual({ count: 2 });
    const log = readFileSync(join(f.directory, "incidents.log"), "utf8");
    expect(log).toContain("inspection-resource-limit");
    expect(log).toContain("inspection-penalty");
    expect(log).not.toContain("offender");
});

test.each(["ip", "repository"])("repeated full timeouts across %s identity rotations exhaust both current scopes", async (scope) => {
    const f = await fixture();
    let now = 1000;
    let timeout = true;
    let entered = 0;
    const submit = createSubmissions(f.config, f.store, {
        clock: () => now,
        inspect: async () => {
            entered++;

            if (timeout) {
                throw new InspectionLimitError("timeout");
            }

            return snapshot();
        },
    }).submit;
    const firstRepo = "https://github.com/o/first";
    const secondRepo = scope === "ip" ? "https://github.com/o/second" : firstRepo;
    const secondIp = scope === "ip" ? "first-ip" : "second-ip";
    await expect(submit(firstRepo, "first-ip")).rejects.toMatchObject({ kind: "timeout" });
    expect(f.store.db.query("SELECT count FROM budgets WHERE key = 'submission:first-ip'").get()).toEqual({ count: 1 });
    await expect(submit(secondRepo, secondIp)).rejects.toMatchObject({ kind: "timeout" });
    await expect(submit(secondRepo, "fresh-ip")).rejects.toMatchObject({ status: 429 });
    await expect(submit("https://github.com/o/fresh", secondIp)).rejects.toMatchObject({ status: 429 });
    expect(entered).toBe(2);
    now += 3600000;
    timeout = false;
    expect((await submit(secondRepo, secondIp)).status).toBe("pending");
});

test("ordinary validation and transient network failures do not impose inspection penalties", async () => {
    const f = await fixture();
    let failure: Error | undefined = new HTTPException(422, { message: "Commit a regular root game.conf" });
    const submit = createSubmissions(f.config, f.store, {
        clock: () => 1000,
        inspect: async () => {
            if (failure) {
                throw failure;
            }

            return snapshot();
        },
    }).submit;

    for (const message of ["Commit a regular root game.conf", "Repository host did not resolve", "Git HTTPS repository unavailable"]) {
        failure = new HTTPException(422, { message });
        await expect(submit("http://www.github.com/o/game.git", "participant")).rejects.toMatchObject({ status: 422 });
    }

    expect(f.store.db.query("SELECT count FROM budgets WHERE key = 'submission:participant'").get()).toEqual({ count: 3 });
    expect(f.store.db.query("SELECT key FROM budgets WHERE key LIKE 'timeout-%'").all()).toEqual([]);
    failure = undefined;
    expect((await submit("https://github.com/o/game", "participant")).status).toBe("pending");
});

test("resource penalties use the completion hour and survive a new store connection", async () => {
    const f = await fixture();
    let now = 3599999;
    const gate = Promise.withResolvers<void>();
    const submit = createSubmissions(f.config, f.store, {
        clock: () => now,
        inspect: async () => {
            await gate.promise;
            throw new InspectionLimitError("resource");
        },
    }).submit;
    const failed = submit("https://github.com/o/game", "ip").catch((error) => error);
    now = 3600000;
    gate.resolve();
    expect(await failed).toMatchObject({ kind: "resource" });
    const other = new Store(f.directory, f.store.limits);

    try {
        expect(() => other.checkSubmissionBudget("ip", "https://github.com/o/other", now)).toThrow("Inspection limit");
        expect(() => other.checkSubmissionBudget("fresh", "https://github.com/o/game", now)).toThrow("Inspection limit");
        expect(() => other.checkSubmissionBudget("ip", "https://github.com/o/game", now + 3600000)).not.toThrow();
    } finally {
        other.close();
    }
});

test("incident logs deduplicate, protect identity, rotate, and cannot weaken quotas when unwritable", async () => {
    const f = await fixture();
    const path = join(f.directory, "incidents.log");

    for (let i = 0; i < 50; i++) {
        f.store.incident("api-minute-limit", "192.0.2.1", 1000);
    }

    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(path, "utf8")).not.toContain("192.0.2.1");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    f.store.incident("api-minute-limit", "192.0.2.1", 60000);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    writeFileSync(path, "x".repeat(1024 * 1024));
    f.store.incident("api-hour-limit", "192.0.2.1", 60000);
    expect(statSync(`${path}.1`).size).toBe(1024 * 1024);
    expect(JSON.parse(readFileSync(path, "utf8")).event).toBe("api-hour-limit");

    rmSync(path);
    mkdirSync(path);
    const warning = spyOn(console, "error").mockImplementation(() => {});

    try {
        f.store.recordInspectionLimit("ip", "https://github.com/o/game", "resource", 1000);
        expect(() => f.store.checkSubmissionBudget("ip", "https://github.com/o/game", 1000)).toThrow("Inspection limit");
        expect(warning).toHaveBeenCalledTimes(1);
    } finally {
        warning.mockRestore();
    }
});

test("incident floods have bounded deduplication memory and output", async () => {
    const f = await fixture();

    for (let i = 0; i < 1100; i++) {
        f.store.incident("api-minute-limit", `ip-${i}`, 1000);
    }

    const lines = readFileSync(join(f.directory, "incidents.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1000);
    expect(JSON.parse(lines.at(-1)!).event).toBe("incident-log-suppressed");
});

test("resource incidents return 422, preserve publication, and block administrator reinspection without consuming its revision", async () => {
    const f = await fixture();
    const api = f.config.audience;
    const repository = "https://github.com/o/game";
    const published = await submitBrew(api, repository, f.options);
    await moderateEntry(api, f.identity, { ...reference(published), revision: 0, operation: "approve" }, f.options);
    const purged = f.store.recordSubmission(f.config.jamId, repository, snapshot(sha("c")), Date.now(), "/tree/{sha}");
    f.store.moderate({ ...reference(purged), revision: 0, operation: "reject", reason: "Revise" }, f.identity.publicKey, Date.now(), f.config.jamId);
    f.setHead(sha("b"));
    f.failInspection(new InspectionLimitError("resource"));
    await expect(submitBrew(api, "http://www.github.com/O/GAME.git/", f.options)).rejects.toMatchObject({
        status: 422, message: "Inspection exceeded its resource limits",
    });
    expect((await listBrews(api, f.options)).map((entry) => referenceKey(entry))).toEqual([referenceKey(published)]);
    const inspections = f.inspected.length;
    const freshIp = { fetch: ((input, init) => f.app.fetch(new Request(input, init), { ip: "fresh" })) as typeof fetch };
    await expect(moderateEntry(api, f.identity, { ...reference(purged), revision: 1, operation: "reinspect" }, freshIp))
        .rejects.toMatchObject({ status: 429 });
    expect(f.inspected).toHaveLength(inspections);
    expect(f.store.queue(f.config.jamId).find((row) => referenceKey(row) === referenceKey(purged))).toMatchObject({ status: "rejected", revision: 1 });
});

test("early participant cancellation does not count as a resource violation or timeout", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const gate = Promise.withResolvers<void>();
    const submit = createSubmissions(f.config, f.store, {
        clock: () => 1000,
        inspect: async () => {
            await gate.promise;
            controller.signal.throwIfAborted();

            return snapshot();
        },
    }).submit;
    const failed = submit("https://github.com/o/game", "ip", controller.signal).catch((error) => error);
    controller.abort();
    gate.resolve();
    expect(await failed).toMatchObject({ name: "AbortError" });
    expect(f.store.db.query("SELECT count FROM budgets WHERE key = 'submission:ip'").get()).toEqual({ count: 1 });
    expect(f.store.db.query("SELECT key FROM budgets WHERE key LIKE 'timeout-%'").all()).toEqual([]);
});

test("incident records exclude credentials and oversized request contents", async () => {
    const f = await fixture();
    const secret = "private-token-do-not-log";
    const post = (body: unknown) => f.app.fetch(new Request(`${f.config.audience}/api/brews/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), { ip: "192.0.2.10" });
    expect((await post({ repository: `http://user:${secret}@www.github.com/o/game` })).status).toBe(400);
    expect((await post({ repository: secret.repeat(5000) })).status).toBe(413);
    const log = readFileSync(join(f.directory, "incidents.log"), "utf8");
    expect(log).toContain("request-body-limit");
    expect(log).not.toContain(secret);
    expect(log).not.toContain("user:");
    expect(log).not.toContain("192.0.2.10");
});

test("abandoning a request cannot erase a measured resource breach", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const gate = Promise.withResolvers<void>();
    const submit = createSubmissions(f.config, f.store, {
        clock: () => 1000,
        inspect: async () => {
            await gate.promise;
            throw new InspectionLimitError("resource");
        },
    }).submit;
    const failed = submit("https://github.com/o/game", "ip", controller.signal).catch((error) => error);
    controller.abort();
    gate.resolve();
    expect(await failed).toMatchObject({ name: "AbortError" });
    expect(() => f.store.checkSubmissionBudget("ip", "https://github.com/o/other", 1000)).toThrow("Inspection limit");
    expect(() => f.store.checkSubmissionBudget("other", "https://github.com/o/game", 1000)).toThrow("Inspection limit");
});

test("elapsed inspection deadlines count even when the request ends with an unclassified cancellation", async () => {
    const f = await fixture();
    let now = 1000;
    let controller = new AbortController();
    const date = spyOn(Date, "now").mockImplementation(() => now);
    const repository = "https://github.com/o/game";
    const submit = createSubmissions(f.config, f.store, {
        clock: () => now,
        inspect: async () => {
            now += 120000;
            controller.abort();
            controller.signal.throwIfAborted();

            return snapshot();
        },
    }).submit;

    try {
        await expect(submit(repository, "ip", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(f.store.db.query("SELECT count FROM budgets WHERE key = 'submission:ip'").get()).toEqual({ count: 1 });
        controller = new AbortController();
        await expect(submit(repository, "ip", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(() => f.store.checkSubmissionBudget("ip", "https://github.com/o/other", now)).toThrow("Inspection limit");
        expect(() => f.store.checkSubmissionBudget("fresh", repository, now)).toThrow("Inspection limit");
    } finally {
        date.mockRestore();
    }
});
