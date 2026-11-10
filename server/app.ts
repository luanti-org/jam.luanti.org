import { zValidator } from "@hono/zod-validator";
import { SQLiteError } from "bun:sqlite";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { commitSchema, submissionSchema } from "../shared/schemas";
import { verifyRequest } from "../shared/signatures";
import { clientIdentity, type Config, maxRequestBodyBytes } from "./config";
import { Store } from "./storage";
import { InspectionLimitError } from "./inspection-errors";
import { createSubmissions } from "./submissions";
import { repositoryInfo } from "./repositories";

const hourMs = 3600000;
const maxAdminTokenLength = 16000;
const validationHook = (result: { success: boolean; error?: unknown }) => {
    if (!result.success) {
        throw result.error;
    }
};

const imageParams = z.strictObject({ id: z.uuid(), commit: commitSchema });

/** The caller owns an injected store; production keeps its store for the process lifetime. */
export function createApp({
    config,
    store = new Store(config.dataDir),
    clock = Date.now,
    submissions = createSubmissions(config, store, { clock }),
}: {
    config: Config;
    store?: Store;
    clock?: () => number;
    submissions?: ReturnType<typeof createSubmissions>;
}) {
    store.pruneExpired(clock());
    const app = new Hono<{ Bindings: { ip?: string; beginInspection?: () => void } }>();
    let requestWindow = Math.floor(clock() / hourMs);
    const requests = new Map<string, { count: number; minute: number; minuteCount: number }>();

    // Account before middleware that can return early, including preflight and oversized bodies.
    app.use("/api/*", async (context, next) => {
        context.header("Cache-Control", "no-store");
        context.header("X-Content-Type-Options", "nosniff");

        const now = clock();
        const currentWindow = Math.floor(now / hourMs);

        if (currentWindow !== requestWindow) {
            requests.clear();
            store.pruneExpired(now);
            requestWindow = currentWindow;
        }

        const ip = clientIdentity(context.env?.ip ?? "unknown");
        const minute = Math.floor(now / 60000);
        const counts = requests.get(ip) ?? { count: 0, minute, minuteCount: 0 };

        if (counts.minute !== minute) {
            counts.minute = minute;
            counts.minuteCount = 0;
        }

        if (counts.count >= store.limits.apiPerHour) {
            store.incident("api-hour-limit", ip, now);
            context.header("Retry-After", String(Math.ceil(((currentWindow + 1) * hourMs - now) / 1000)));
            throw new HTTPException(429, { message: "Request limit reached; try next hour" });
        }

        if (counts.minuteCount >= store.limits.apiPerMinute) {
            store.incident("api-minute-limit", ip, now);
            context.header("Retry-After", String(Math.ceil(((minute + 1) * 60000 - now) / 1000)));
            throw new HTTPException(429, { message: "Request limit reached; try next minute" });
        }

        counts.count++;
        counts.minuteCount++;

        // API counters are best effort under churn. Keep memory bounded without refusing
        // every new visitor; expensive inspection budgets remain durable and are never evicted.
        if (!requests.delete(ip) && requests.size >= store.limits.apiTrackedIps) {
            requests.delete(requests.keys().next().value!);
            store.incident("api-ip-capacity", ip, now);
        }

        requests.set(ip, counts);

        if (context.req.header("origin") && context.req.header("origin") !== config.origin) {
            throw new HTTPException(403, { message: "Origin is not allowed" });
        }

        await next();
    });
    app.use(
        "/api/*",
        cors({
            origin: config.origin,
            allowMethods: ["GET", "POST", "OPTIONS"],
            allowHeaders: ["Content-Type"],
            maxAge: 600,
        }),
    );
    app.use(
        "/api/*",
        bodyLimit({
            maxSize: maxRequestBodyBytes,
            onError: (context) => {
                store.incident("request-body-limit", context.env?.ip ?? "unknown", clock());

                return context.json({ error: "Request body exceeds 64 KiB" }, 413);
            },
        }),
    );

    // Verification proves who signed the operation. Authorization is a separate dynamic policy
    // check so removing a key denies even an otherwise valid, unexpired token immediately.
    async function administrator(token: string) {
        let claims: Awaited<ReturnType<typeof verifyRequest>>;

        try {
            claims = await verifyRequest(token, config.audience, clock());
        } catch {
            throw new HTTPException(403, { message: "Invalid or expired administrator token" });
        }

        store.authorize(claims.sub);

        return claims;
    }

    function imageResponse(image: Uint8Array) {
        return new Response(image as BodyInit, {
            headers: {
                "Content-Type": "image/webp",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
    }

    app.get("/api/health", (context) =>
        context.json({
            ok: true,
            audience: config.audience,
            jam: config.jamId,
            startsAt: new Date(config.startsAt).toISOString(),
            endsAt: new Date(config.endsAt).toISOString(),
        }),
    );
    app.post("/api/brews/submit", zValidator("json", submissionSchema, validationHook), async (context) => {
        context.env?.beginInspection?.();

        return context.json(
            await submissions.submit(
                context.req.valid("json").repository,
                context.env?.ip ?? "unknown",
                context.req.raw.signal,
            ),
        );
    });
    app.get("/api/brews", (context) => context.json(store.listEntries(config.jamId)));
    app.get("/api/submissions", zValidator("query", submissionSchema, validationHook), (context) => {
        const { repository } = repositoryInfo(context.req.valid("query").repository);

        return context.json(store.repositoryStatus(repository, config.jamId));
    });
    app.get(
        "/api/submissions/:id",
        zValidator("param", z.strictObject({ id: z.uuid() }), validationHook),
        (context) => context.json(store.status(context.req.valid("param").id, config.jamId)),
    );
    app.get("/api/brews/:id/images/:commit", zValidator("param", imageParams, validationHook), (context) => {
        const { id, commit } = context.req.valid("param");

        return imageResponse(store.image(id, commit, config.jamId));
    });
    app.post(
        "/api/admin",
        zValidator("json", z.string().min(1).max(maxAdminTokenLength), validationHook),
        async (context) => {
            const claims = await administrator(context.req.valid("json"));

            if (claims.action.operation === "admin.image") {
                const { id, commit } = claims.action.args;

                return imageResponse(store.image(id, commit, config.jamId, true));
            }

            if (claims.action.operation === "admin.queue") {
                return context.json(store.queue(config.jamId));
            }

            const decision = claims.action.args;

            if (decision.operation === "reinspect") {
                context.env?.beginInspection?.();

                return context.json(await submissions.reinspect(
                    decision, claims.sub, context.env?.ip ?? "unknown", context.req.raw.signal,
                ));
            }

            return context.json(store.moderate(decision, claims.sub, clock(), config.jamId));
        },
    );

    app.onError((error, context) => {
        // Early request-limit errors precede CORS middleware; let the allowed client read them.
        if (context.req.header("origin") === config.origin) {
            context.header("Access-Control-Allow-Origin", config.origin);
            context.header("Vary", "Origin");
        }

        if (context.req.raw.signal.aborted) {
            return context.json({ error: "Request cancelled" }, 408);
        }

        if (error instanceof InspectionLimitError) {
            return context.json({ error: error.message }, 422);
        }

        if (error instanceof HTTPException) {
            return context.json({ error: error.message }, error.status);
        }

        if (error instanceof z.ZodError) {
            return context.json(
                {
                    error: error.issues
                        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                        .join("; "),
                },
                400,
            );
        }

        if (error instanceof SQLiteError && error.code === "SQLITE_FULL") {
            store.incident("storage-full", context.env?.ip ?? "unknown", clock());

            return context.json({ error: "Gallery storage is full; contact the administrator" }, 507);
        }

        console.error("Internal API error", error);

        return context.json(
            { error: "Internal server error; contact the administrator or try again later" },
            500,
        );
    });

    return app;
}
