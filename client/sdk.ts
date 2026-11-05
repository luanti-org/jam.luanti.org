/**
 * Headless client for the jam API: submissions, receipts, the public shelf and signed moderation.
 * Calls take an API origin and optional fetch/signal/timeoutMs; custom fetch must honor cancellation.
 * No DOM, browser storage, cookies or automatic retries. Defaults are 15 seconds, or 630 seconds
 * for submission/reinspection including queue time. Response contracts live in shared/schemas.ts.
 * Transport/API failures are ApiError (status 0 for transport/decoding failures); local argument
 * validation can throw before transport. Keep administrator phrases and secret keys private;
 * callers own their lifetime. Admin requests sign the origin and operation, never send secret keys,
 * and require current revisions: refresh after a failed or ambiguous mutation before acting again.
 */
import { z } from "zod";
import ingredients from "../content/ingredients.json";
import jamData from "../content/jam.json";
import {
    type Action,
    apiUrlSchema,
    entrySchema,
    ingredientCatalogSchema,
    jamSchema,
    type ModerationDecision,
    reviewSchema,
    statusSchema,
    shelfLimit,
} from "../shared/schemas";
import type { Identity } from "../shared/signatures";

export type CallOptions = {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    timeoutMs?: number;
};

const requestTimeoutMs = 15000;
const submissionTimeoutMs = 630000;
const successSchema = z.strictObject({ ok: z.literal(true) });

async function request<T>(
    apiUrl: string,
    path: string,
    body: unknown,
    decode: z.ZodType<T> | ((response: Response) => Promise<T>),
    options: CallOptions = {},
) {
    const origin = new URL(apiUrlSchema.parse(apiUrl)).origin;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

    try {
        const response = await (options.fetch ?? globalThis.fetch)(`${origin}/api${path}`, {
            method: body === undefined ? "GET" : "POST",
            credentials: "omit",
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new ApiError(
                typeof error?.error === "string" ? error.error : "Request failed",
                response.status,
            );
        }

        return typeof decode === "function" ? await decode(response) : decode.parse(await response.json());
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }

        throw new ApiError(error instanceof Error ? error.message : "Request failed", 0);
    }
}

/** Returns a new or existing commit receipt. Upgrades HTTP locally; repository security policy is server-owned. */
export function submitBrew(apiUrl: string, repository: string, options: CallOptions = {}) {
    repository = repository.replace(/^http:\/\//i, "https://");
    z.url({ protocol: /^https$/ }).parse(repository);

    return request(apiUrl, "/brews/submit", { repository }, statusSchema, {
        ...options,
        timeoutMs: options.timeoutMs ?? submissionTimeoutMs,
    });
}

/**
 * Approved games, newest approval first; publishedAt is the approval time in UTC.
 * Fetch /api/brews/{id}/images/{commit} only when hasScreenshot is true.
 */
export function listBrews(apiUrl: string, options?: CallOptions) {
    return request(
        apiUrl,
        "/brews",
        undefined,
        z.array(entrySchema).max(shelfLimit),
        options,
    );
}

export function getSubmissionStatus(apiUrl: string, id: string, options?: CallOptions) {
    return request(apiUrl, `/submissions/${z.uuid().parse(id)}`, undefined, statusSchema, options);
}

async function adminRequest<T>(
    apiUrl: string,
    identity: Identity,
    action: Action,
    decode: z.ZodType<T> | ((response: Response) => Promise<T>),
    options: CallOptions = {},
) {
    const { signRequest } = await import("../shared/signatures");
    const token = await signRequest(action, new URL(apiUrlSchema.parse(apiUrl)).origin, identity);

    return request(apiUrl, "/admin", token, decode, options);
}

export function getAdminQueue(
    apiUrl: string,
    identity: Identity,
    options?: CallOptions,
) {
    return adminRequest(
        apiUrl,
        identity,
        { operation: "admin.queue" },
        z.array(reviewSchema),
        options,
    );
}

/**
 * Approve publishes a pending review; reject/unpublish purge its presentation with public feedback.
 * Reinspect restores a purged record's exact commit to pending, including after jam close; it
 * requires another approval and cannot displace another pending review. Each mutation consumes
 * its revision; refresh after failure instead of replaying an ambiguous mutation.
 */
export function moderateEntry(
    apiUrl: string,
    identity: Identity,
    decision: ModerationDecision,
    options: CallOptions = {},
) {
    return adminRequest(
        apiUrl,
        identity,
        { operation: "admin.moderate", args: decision },
        successSchema,
        { ...options, timeoutMs: options.timeoutMs ?? (decision.operation === "reinspect" ? submissionTimeoutMs : requestTimeoutMs) },
    );
}

/** Signs the requested entry and commit and fetches its WebP without putting credentials in an image URL. */
export function getAdminImage(
    apiUrl: string,
    identity: Identity,
    id: string,
    commit: string,
    options: CallOptions = {},
) {
    return adminRequest(
        apiUrl,
        identity,
        { operation: "admin.image", args: { id, commit } },
        async (response) => {
            if (response.headers.get("Content-Type") !== "image/webp") {
                throw new Error("Expected a WebP review image");
            }

            return response.blob();
        },
        options,
    );
}

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export type { Entry, ModerationDecision } from "../shared/schemas";

export type { Identity } from "../shared/signatures";

/** The caller must save the recovery phrase privately. Lazy imports keep recovery dependencies out of participant calls. */
export async function createIdentity() {
    const { createIdentity } = await import("../shared/identity");

    return createIdentity();
}

export async function restoreIdentity(phrase: string): Promise<Identity> {
    const { restoreIdentity } = await import("../shared/identity");

    return restoreIdentity(phrase);
}

export { signRequest } from "../shared/signatures";

export const jam = jamSchema.parse(jamData);
export const ingredientCatalog = ingredientCatalogSchema.parse(ingredients);
