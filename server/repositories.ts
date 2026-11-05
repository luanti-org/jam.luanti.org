import type { PathLike } from "node:fs";
import { readFileSync } from "node:fs";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const policyPath = new URL("../content/hosts.json", import.meta.url);

// Before adding a host, verify namespace/case identity, public IPv4, pinned HTTPS and partial-clone support.
const policySchema = z
    .array(
        z.strictObject({
            host: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/),
            nested: z.boolean(),
            lowercase: z.boolean(),
            commit: z.enum(["/tree/{sha}", "/-/tree/{sha}", "/src/commit/{sha}", "/src/{sha}"]),
        }),
    )
    .min(1)
    .max(20)
    .refine((hosts) => new Set(hosts.map((host) => host.host)).size === hosts.length);

/** Loads operator policy dynamically; malformed configuration is unavailable (503), never a wider allowlist. */
export function readHosts(path: PathLike = policyPath) {
    try {
        return policySchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (cause) {
        throw new HTTPException(503, { message: "Repository host policy is unavailable", cause });
    }
}

/** Normalize recognized aliases to one HTTPS identity before any DNS, Git work or quota lookup. */
export function repositoryInfo(input: string, hosts = readHosts()) {
    if (
        input.length > 2048
        || /[\s\\%]/.test(input)
        || /\/\.{1,2}(?:\/|$)/.test(input)
        || !/^https?:\/\/[^/]+\//i.test(input)
    ) {
        throw new HTTPException(400, { message: "Use a plain public HTTPS repository URL" });
    }

    let url: URL;

    try {
        url = new URL(input);
    } catch {
        throw new HTTPException(400, { message: "Use a valid HTTPS repository URL" });
    }

    const host = hosts.find((host) => host.host === url.hostname)
        ?? hosts.find((host) => host.host === url.hostname.replace(/^www\./, ""));
    const authority = /^https?:\/\/([^/]+)\//i.exec(input)![1];

    if (
        !host
        || !["http:", "https:"].includes(url.protocol)
        || url.username
        || url.password
        || url.port
        || url.search
        || url.hash
        || /[:@]/.test(authority)
    ) {
        throw new HTTPException(400, { message: "Use an allowed HTTPS repository host without URL options" });
    }

    let path = url.pathname
        .slice(1)
        .replace(/\/$/, "")
        .replace(/\.git$/i, "");
    const parts = path.split("/");

    if (
        parts.length < 2
        || (!host.nested && parts.length !== 2)
        || parts.some((part) => !/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(part) || part === "." || part === "..")
    ) {
        throw new HTTPException(400, { message: "Use a repository root with a valid namespace" });
    }

    if (host.lowercase) {
        path = path.toLowerCase();
    }

    const repository = `https://${host.host}/${path}`;

    return {
        repository,
        clone: `${repository}.git`,
        host: host.host,
        commitPath: host.commit, // Persist with the receipt so later policy edits cannot rewrite accepted source links.
    };
}
