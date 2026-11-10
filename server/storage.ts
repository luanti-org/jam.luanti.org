import { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { clientIdentity, rateLimits, rateLimitsSchema } from "./config";
import {
    type Entry,
    type ModerationDecision,
    publicKeySchema,
    type reviewSchema,
    shelfLimit,
    type Snapshot,
    type statusSchema,
} from "../shared/schemas";

type Receipt = z.infer<typeof statusSchema>;

type Review = z.infer<typeof reviewSchema>;

const schemaVersion = 1;
const maxDatabaseBytes = 256 * 1024 ** 2;
const maxIncidentLogBytes = 1024 * 1024;
const incidentSalt = randomBytes(32);

type Incident = "api-minute-limit" | "api-hour-limit" | "api-ip-capacity" | "request-body-limit"
    | "inspection-ip-limit" | "inspection-repository-limit" | "inspection-global-limit"
    | "inspection-queue-full" | "inspection-resource-limit" | "inspection-timeout"
    | "inspection-penalty" | "inspection-worker-failure" | "storage-full";

const adminKeysSchema = z.array(publicKeySchema.refine((key) => {
    try {
        const point = ed25519.Point.fromHex(key.slice(8));

        return !point.isSmallOrder() && point.isTorsionFree();
    } catch {
        return false;
    }
}, "Invalid Ed25519 public key")).refine((keys) => new Set(keys).size === keys.length, "Duplicate administrator key");

export class Store {
    readonly db: Database;
    private readonly seenIncidents = new Set<string>();
    private incidentHour = -1;
    private incidentLogFailed = false;

    constructor(readonly dataDir: string, readonly limits = rateLimits) {
        rateLimitsSchema.parse(limits);
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });

        try {
            writeFileSync(join(dataDir, "admins.json"), "[]\n", { flag: "wx", mode: 0o600 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }

        this.validateAdminConfiguration();
        const path = join(dataDir, "jam.sqlite");
        this.db = new Database(path, { create: true, strict: true });

        try {
            const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
            const tables = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all();

            if (tables.length && version !== schemaVersion) {
                throw new Error(`Unsupported database schema at ${path}`);
            }

            // FULL must be enabled before creating tables. These limits apply to the main
            // database, not WAL/backups or process memory; the page count uses its actual page size.
            // Secure deletion reduces live-file remnants; it cannot erase backups or snapshots.
            this.db.run(`
                PRAGMA auto_vacuum = FULL;
                PRAGMA secure_delete = ON;
                PRAGMA journal_mode = WAL;
                PRAGMA journal_size_limit = 0;
                PRAGMA busy_timeout = 5000;
            `);
            const pageSize = this.db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
            this.db.run(`PRAGMA max_page_count = ${Math.floor(maxDatabaseBytes / pageSize)}`);

            this.db.transaction(() => this.db.run(`
                CREATE TABLE IF NOT EXISTS submissions (
                    id TEXT PRIMARY KEY,
                    jam_id TEXT NOT NULL,
                    repository TEXT NOT NULL,
                    commit_path TEXT NOT NULL,
                    "commit" TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'superseded', 'removed')),
                    title TEXT,
                    description TEXT,
                    image BLOB,
                    submitted_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    moderator TEXT,
                    reason TEXT,
                    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
                    UNIQUE(jam_id, repository, "commit"),
                    CHECK (
                        (status IN ('pending', 'approved') AND title IS NOT NULL
                            AND description IS NOT NULL AND image IS NOT NULL)
                        OR
                        (status IN ('rejected', 'superseded', 'removed') AND title IS NULL
                            AND description IS NULL AND image IS NULL)
                    ),
                    CHECK(status NOT IN ('rejected', 'removed') OR reason IS NOT NULL)
                ) STRICT;
                CREATE UNIQUE INDEX IF NOT EXISTS one_pending
                    ON submissions(jam_id, repository) WHERE status = 'pending';
                CREATE UNIQUE INDEX IF NOT EXISTS one_approved
                    ON submissions(jam_id, repository) WHERE status = 'approved';
                CREATE TABLE IF NOT EXISTS budgets (
                    key TEXT PRIMARY KEY,
                    window INTEGER NOT NULL,
                    count INTEGER NOT NULL
                ) STRICT;
                PRAGMA user_version = ${schemaVersion};
            `)).immediate();
        } catch (error) {
            this.db.close();
            throw error;
        }
    }

    pruneExpired(now: number) {
        this.db.query("DELETE FROM budgets WHERE window < ?").run(Math.floor(now / 3600000) - 1);
    }

    private takeBudget(key: string, now: number) {
        const row = this.db.query<{ count: number }, [string, number]>(`
            INSERT INTO budgets VALUES (?, ?, 1)
            ON CONFLICT(key) DO UPDATE SET
                count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END,
                window = excluded.window
            RETURNING count
        `).get(key, Math.floor(now / 3600000))!;

        return row.count;
    }

    /**
     * Private, bounded best-effort logging; never copy request bodies, tokens or worker diagnostics.
     * Pseudonyms and deduplication reset on restart, so this is not a complete audit trail.
     */
    incident(event: Incident, ip: string, now: number, repository?: string) {
        ip = clientIdentity(ip);
        const hour = Math.floor(now / 3600000);

        if (hour !== this.incidentHour) {
            this.seenIncidents.clear();
            this.incidentHour = hour;
        }

        const ipToken = createHmac("sha256", incidentSalt).update(ip).digest("hex").slice(0, 16);
        const window = event === "api-minute-limit" ? Math.floor(now / 60000) : hour;
        const subject = event === "inspection-global-limit" || event === "api-ip-capacity" ? "global"
            : event === "inspection-repository-limit" ? repository : `${ipToken}:${repository ?? ""}`;
        const key = `${event}:${subject}:${window}`;

        if (this.seenIncidents.has(key) || this.seenIncidents.size >= 1000) {
            return;
        }

        this.seenIncidents.add(key);
        const record = this.seenIncidents.size === 1000
            ? { at: new Date(now).toISOString(), event: "incident-log-suppressed" }
            : { at: new Date(now).toISOString(), event, ip: ipToken, repository };
        const line = `${JSON.stringify(record)}\n`;
        const path = join(this.dataDir, "incidents.log");

        try {
            if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > maxIncidentLogBytes) {
                renameSync(path, `${path}.1`);
            }

            appendFileSync(path, line, { mode: 0o600 });
        } catch {
            // Disk/logging failures must not release a quota or replace the original API response.
            if (!this.incidentLogFailed) {
                console.error("Security incident log unavailable");
                this.incidentLogFailed = true;
            }
        }
    }

    /** Refuse exhausted budgets before queueing, without charging or reserving an admission. */
    checkSubmissionBudget(ip: string, repository: string, now: number) {
        ip = clientIdentity(ip);
        const exhausted = this.db.query<{ key: string }, [number, string, number, string, number, number]>(`
            SELECT key FROM budgets WHERE window = ? AND (
                (key = ? AND count >= ?) OR (key = ? AND count >= ?)
                OR (key = 'submission:global' AND count >= ?)
            ) LIMIT 1
        `).get(Math.floor(now / 3600000), `submission:${ip}`, this.limits.inspectionPerIpPerHour,
            `repository:${repository}`, this.limits.inspectionPerRepositoryPerHour, this.limits.inspectionGlobalPerHour);

        if (exhausted) {
            const event = exhausted.key === "submission:global" ? "inspection-global-limit"
                : exhausted.key.startsWith("repository:") ? "inspection-repository-limit" : "inspection-ip-limit";
            this.incident(event, ip, now, repository);
            throw new HTTPException(429, { message: "Inspection limit reached; try next hour" });
        }
    }

    /**
     * Recheck and charge all three scopes atomically; refusals cannot drain another scope's budget.
     * Budgets span jams and use canonical repository identities, so URL aliases cannot create allowances.
     */
    admitSubmission(ip: string, repository: string, now: number) {
        ip = clientIdentity(ip);
        this.db.transaction(() => {
            this.checkSubmissionBudget(ip, repository, now);
            this.takeBudget(`submission:${ip}`, now);
            this.takeBudget(`repository:${repository}`, now);
            this.takeBudget("submission:global", now);
        }).immediate();
    }

    /**
     * Resource breaches block immediately; repeated full deadlines block both identities in the completion hour.
     * Count timeouts per IP and repository to handle rotations of either identity. Leave the global budget
     * intact: anonymous submissions cannot prove ownership, and penalties must not lock out every repository.
     */
    recordInspectionLimit(ip: string, repository: string, kind: "resource" | "timeout", now: number) {
        ip = clientIdentity(ip);
        const penalized = this.db.transaction(() => {
            if (kind === "timeout") {
                const ipTimeouts = this.takeBudget(`timeout-ip:${ip}`, now);
                const repoTimeouts = this.takeBudget(`timeout-repository:${repository}`, now);

                if (ipTimeouts < this.limits.inspectionTimeoutsPerHour && repoTimeouts < this.limits.inspectionTimeoutsPerHour) {
                    return false;
                }
            }

            const exhaust = this.db.query(`
                INSERT INTO budgets VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    count = CASE WHEN window = excluded.window THEN max(count, excluded.count) ELSE excluded.count END,
                    window = excluded.window
            `);
            const window = Math.floor(now / 3600000);
            exhaust.run(`submission:${ip}`, window, this.limits.inspectionPerIpPerHour);
            exhaust.run(`repository:${repository}`, window, this.limits.inspectionPerRepositoryPerHour);

            return true;
        }).immediate();
        this.incident(kind === "resource" ? "inspection-resource-limit" : "inspection-timeout", ip, now, repository);

        if (penalized) {
            this.incident("inspection-penalty", ip, now, repository);
        }
    }

    submissionReceipt(jamId: string, repository: string, commit: string) {
        return this.db.query<Receipt, [string, string, string]>(`
            SELECT id, "commit", submitted_at AS submittedAt, status, reason,
                repository || replace(commit_path, '{sha}', "commit") AS commitUrl
            FROM submissions WHERE jam_id = ? AND repository = ? AND "commit" = ?
        `).get(jamId, repository, commit);
    }

    /** New commits replace pending reviews; duplicate receipts and existing publication remain intact. */
    recordSubmission(jamId: string, repository: string, snapshot: Snapshot, now: number, commitPath: string) {
        const receipt = this.db.transaction(() => {
            // The immediate transaction serializes this check and write across connections;
            // the unique identity constraint remains the final guard against duplicate records.
            const duplicate = this.submissionReceipt(jamId, repository, snapshot.commit);

            if (duplicate) {
                return duplicate;
            }

            const at = new Date(now).toISOString();
            this.db.query(`
                UPDATE submissions
                SET status = 'superseded', title = NULL, description = NULL, image = NULL,
                    updated_at = ?, moderator = NULL, reason = NULL, revision = revision + 1
                WHERE jam_id = ? AND repository = ? AND status = 'pending'
            `).run(at, jamId, repository);
            const id = crypto.randomUUID();
            this.db.query(`
                INSERT INTO submissions (
                    id, jam_id, repository, commit_path, "commit", status,
                    title, description, image, submitted_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
            `).run(id, jamId, repository, commitPath, snapshot.commit,
                snapshot.title, snapshot.description, snapshot.screenshot, at, at);

            return this.status(id, jamId);
        }).immediate();
        this.checkpoint();

        return receipt;
    }

    /** Public progress survives purging; an identifier never grants access to unapproved presentation. */
    status(id: string, jamId: string) {
        const row = this.db.query<Receipt, [string, string]>(`
            SELECT id, "commit", submitted_at AS submittedAt, status, reason,
                repository || replace(commit_path, '{sha}', "commit") AS commitUrl
            FROM submissions WHERE id = ? AND jam_id = ?
        `).get(id, jamId);

        if (!row) {
            throw new HTTPException(404, { message: "Submission not found" });
        }

        return row;
    }

    /** Read existing rows only. Pending work takes precedence over the latest recorded submission. */
    repositoryStatus(repository: string, jamId: string) {
        const row = this.db.query<Receipt & { repository: string }, [string, string]>(`
            SELECT id, repository, "commit", submitted_at AS submittedAt, status, reason,
                repository || replace(commit_path, '{sha}', "commit") AS commitUrl
            FROM submissions WHERE jam_id = ? AND repository = ?
            ORDER BY (status = 'pending') DESC, submitted_at DESC, rowid DESC LIMIT 1
        `).get(jamId, repository);

        if (!row) {
            throw new HTTPException(404, { message: "Submission not found" });
        }

        return row;
    }

    listEntries(jamId: string) {
        // An approved row's updated_at is its approval time; pending updates have separate rows.
        return this.db.query<Omit<Entry, "hasScreenshot"> & { hasScreenshot: number }, [string, number]>(`
            SELECT id, repository, "commit", title, description,
                repository || replace(commit_path, '{sha}', "commit") AS commitUrl,
                length(image) > 0 AS hasScreenshot, updated_at AS publishedAt
            FROM submissions WHERE jam_id = ? AND status = 'approved'
            ORDER BY updated_at DESC, id LIMIT ?
        `).all(jamId, shelfLimit).map((row) => ({ ...row, hasScreenshot: row.hasScreenshot === 1 }));
    }

    /** Return every administrative record; sorting belongs to the client. */
    queue(jamId: string) {
        return this.db.query<Omit<Review, "hasScreenshot"> & { hasScreenshot: number }, [string]>(`
            SELECT id, repository, "commit", title, description, status, reason, revision,
                submitted_at AS submittedAt,
                repository || replace(commit_path, '{sha}', "commit") AS commitUrl,
                coalesce(length(image), 0) > 0 AS hasScreenshot
            FROM submissions WHERE jam_id = ?
        `).all(jamId).map((row) => ({ ...row, hasScreenshot: row.hasScreenshot === 1 }));
    }

    /** Pending images require signed administrator authorization. Purged images are unavailable to everyone. */
    image(id: string, commit: string, jamId: string, admin = false) {
        const row = this.db.query<{ image: Uint8Array }, [string, string, string]>(`
            SELECT image FROM submissions WHERE id = ? AND "commit" = ? AND jam_id = ?
                AND status ${admin ? "IN ('pending', 'approved')" : "= 'approved'"}
        `).get(id, commit, jamId);

        if (!row || row.image.length === 0) {
            throw new HTTPException(404, { message: "Image not found" });
        }

        return row.image;
    }

    /**
     * Checks a purged revision and returns its exact recorded Git target. Reinspection cannot
     * displace an existing pending review; check again after Git work to detect concurrent changes.
     */
    reinspectionTarget(decision: ModerationDecision, jamId: string) {
        const row = this.db.query<{ repository: string; commit: string }, [string, string, number]>(`
            SELECT repository, "commit" FROM submissions AS target
            WHERE id = ? AND jam_id = ? AND revision = ?
                AND status IN ('rejected', 'superseded', 'removed')
                AND NOT EXISTS (
                    SELECT 1 FROM submissions AS pending
                    WHERE pending.jam_id = target.jam_id AND pending.repository = target.repository
                        AND pending.status = 'pending'
                )
        `).get(decision.id, jamId, decision.revision);

        if (!row) {
            throw new HTTPException(409, { message: "Submission changed or another review is pending; refresh first" });
        }

        return row;
    }

    /** Restores only the recorded commit to pending review. Git failure or a stale revision changes nothing. */
    restore(decision: ModerationDecision, snapshot: Snapshot, moderator: string, now: number, jamId: string) {
        return this.db.transaction(() => {
            const target = this.reinspectionTarget(decision, jamId);

            if (snapshot.commit !== target.commit) {
                throw new HTTPException(422, { message: "Reinspection did not return the recorded commit" });
            }

            this.db.query(`
                UPDATE submissions SET status = 'pending', title = ?, description = ?, image = ?,
                    updated_at = ?, moderator = ?, reason = NULL, revision = revision + 1
                WHERE id = ? AND jam_id = ? AND revision = ?
            `).run(snapshot.title, snapshot.description, snapshot.screenshot,
                new Date(now).toISOString(), moderator, decision.id, jamId, decision.revision);

            return { ok: true as const };
        }).immediate();
    }

    /** Every decision consumes its revision; purged rows must be reinspected before another approval. */
    moderate(decision: ModerationDecision, moderator: string, now: number, jamId: string) {
        if (decision.operation === "reinspect") {
            throw new HTTPException(409, { message: "Reinspection requires Git inspection first" });
        }

        this.db.transaction(() => {
            const expected = decision.operation === "unpublish" ? "approved" : "pending";
            const target = this.db.query<{ repository: string }, [string, string, number, string]>(`
                SELECT repository FROM submissions WHERE id = ? AND jam_id = ? AND revision = ? AND status = ?
            `).get(decision.id, jamId, decision.revision, expected);

            if (!target) {
                throw new HTTPException(409, { message: "Submission changed or operation unavailable; refresh first" });
            }

            const at = new Date(now).toISOString();

            if (decision.operation === "approve") {
                this.db.query(`
                    UPDATE submissions
                    SET status = 'superseded', title = NULL, description = NULL, image = NULL,
                        updated_at = ?, moderator = ?, revision = revision + 1
                    WHERE jam_id = ? AND repository = ? AND status = 'approved'
                `).run(at, moderator, jamId, target.repository);
            }

            const changes = decision.operation === "approve"
                ? "status = 'approved', reason = NULL"
                : "status = $status, title = NULL, description = NULL, image = NULL, reason = $reason";
            this.db.query(`
                UPDATE submissions SET ${changes}, updated_at = $at, moderator = $actor, revision = revision + 1
                WHERE id = $id AND jam_id = $jam AND revision = $revision
            `).run({
                at, actor: moderator, id: decision.id, jam: jamId, revision: decision.revision,
                ...(decision.operation !== "approve" ? {
                    status: decision.operation === "reject" ? "rejected" : "removed", reason: decision.reason!,
                } : {}),
            });
        }).immediate();
        this.checkpoint();

        return { ok: true as const };
    }

    /** Logical purging has committed. A busy external reader can defer WAL truncation until a later checkpoint. */
    private checkpoint() {
        this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    }

    /** No cache: startup and every authorization validate the same private operator-owned file. */
    private validateAdminConfiguration(): string[] {
        const path = join(this.dataDir, "admins.json");

        try {
            return adminKeysSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        } catch (cause) {
            throw new Error(`Repair the private administrator allowlist at ${path}: expected unique Ed25519 public keys`, { cause });
        }
    }

    authorize(key: string) {
        let keys: string[];

        try {
            keys = this.validateAdminConfiguration();
        } catch {
            throw new HTTPException(403, { message: "Administrator configuration unavailable" });
        }

        if (!keys.includes(key)) {
            throw new HTTPException(403, { message: "Administrator access required" });
        }
    }

    close() {
        this.db.close();
    }
}
