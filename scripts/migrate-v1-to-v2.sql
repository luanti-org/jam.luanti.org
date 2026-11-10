-- Run once against a backed-up v1 database with the API stopped:
-- sqlite3 -bail /path/to/jam.sqlite < scripts/migrate-v1-to-v2.sql
BEGIN IMMEDIATE;
CREATE TEMP TABLE migration_version (version INTEGER NOT NULL CHECK(version = 1));
INSERT INTO migration_version SELECT user_version FROM pragma_user_version;

ALTER TABLE submissions RENAME TO submissions_v1;

CREATE TABLE submissions (
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
    PRIMARY KEY(jam_id, repository, "commit"),
    CHECK (
        (status IN ('pending', 'approved') AND title IS NOT NULL
            AND description IS NOT NULL AND image IS NOT NULL)
        OR
        (status IN ('rejected', 'superseded', 'removed') AND title IS NULL
            AND description IS NULL AND image IS NULL)
    ),
    CHECK(status NOT IN ('rejected', 'removed') OR reason IS NOT NULL)
) STRICT;

INSERT INTO submissions (
    rowid, jam_id, repository, commit_path, "commit", status,
    title, description, image, submitted_at, updated_at, moderator, reason, revision
) SELECT rowid, jam_id, repository, commit_path, "commit", status,
    title, description, image, submitted_at, updated_at, moderator, reason, revision
FROM submissions_v1;
DROP TABLE submissions_v1;

CREATE UNIQUE INDEX one_pending
    ON submissions(jam_id, repository) WHERE status = 'pending';
CREATE UNIQUE INDEX one_approved
    ON submissions(jam_id, repository) WHERE status = 'approved';

PRAGMA user_version = 2;
COMMIT;
