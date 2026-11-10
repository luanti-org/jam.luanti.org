import { z } from "zod";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const httpsUrl = z.url({ protocol: /^https$/ }).max(2200);

export const shelfLimit = 100;
export const apiUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);
export const publicKeySchema = z.string().regex(/^ed25519:[0-9a-f]{64}$/);
export const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const jamSchema = z
    .strictObject({
        id: text(80),
        engine: text(100),

        // A plain Markdown basename keeps the declaration at the repository root.
        participationFile: z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*$/i).endsWith(".md"),
        startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime(),
    })
    .refine((jam) => Date.parse(jam.endsAt) > Date.parse(jam.startsAt));

export const ingredientCatalogSchema = z.array(
    z.strictObject({
        id: text(80),
        name: text(200),
        description: text(2000).optional(),
        category: text(80).optional(),
        media: z.array(z.enum(["tool", "texture", "model", "sound"])).max(4).optional(),
        license: text(80).optional(),
        url: httpsUrl.optional(),
    }),
);

export const submissionSchema = z.strictObject({ repository: text(2048) });

// Public presentation is approval-only. Status links survive content purging and contain no
// presentation; administrator reviews may contain null presentation for purged submissions.
export const entrySchema = z.strictObject({
    id: z.uuid(),
    repository: httpsUrl,
    commit: commitSchema,
    title: text(200),
    description: text(2000),
    commitUrl: httpsUrl,
    hasScreenshot: z.boolean(),
    publishedAt: z.iso.datetime(),
});

export type Entry = z.infer<typeof entrySchema>;

export type Snapshot = {
    commit: string;
    title: string;
    description: string;

    // An empty buffer means no screenshot was supplied. Non-null storage distinguishes retained from purged content.
    screenshot: Uint8Array;
};

export const submissionStatusSchema = z.enum(["pending", "approved", "rejected", "superseded", "removed"]);

export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

export const statusSchema = z.strictObject({
    id: z.uuid(),
    commit: commitSchema,
    commitUrl: httpsUrl,
    submittedAt: z.iso.datetime(),
    status: submissionStatusSchema,
    reason: z.string().max(2000).nullable(),
});

export const repositoryStatusSchema = statusSchema.extend({ repository: httpsUrl });

export const reviewSchema = statusSchema.extend({
    repository: httpsUrl,
    title: text(200).nullable(),
    description: text(2000).nullable(),
    hasScreenshot: z.boolean(),
    revision: z.number().int().nonnegative(),
});

export const moderationSchema = z
    .strictObject({
        id: z.uuid(),
        revision: z.number().int().nonnegative(),
        operation: z.enum(["approve", "reject", "unpublish", "reinspect"]),
        reason: text(2000).optional(),
    })
    .refine(
        (decision) => !["reject", "unpublish"].includes(decision.operation) || !!decision.reason,
        "Explain the rejection or removal",
    );

export type ModerationDecision = z.infer<typeof moderationSchema>;

// Strict signed argument shapes prevent ignored fields from appearing to authorize another action.
export const actionSchema = z.discriminatedUnion("operation", [
    z.strictObject({ operation: z.literal("admin.queue") }),
    z.strictObject({ operation: z.literal("admin.moderate"), args: moderationSchema }),
    z.strictObject({
        operation: z.literal("admin.image"),
        args: z.strictObject({ id: z.uuid(), commit: commitSchema }),
    }),
]);

export type Action = z.infer<typeof actionSchema>;

export const adminClaimsSchema = z.strictObject({
    sub: publicKeySchema,
    aud: apiUrlSchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    action: actionSchema,
});

export type AdminClaims = z.infer<typeof adminClaimsSchema>;
