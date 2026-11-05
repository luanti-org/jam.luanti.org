import { resolve } from "node:path";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import limitsData from "../content/limits.json";
import jamData from "../content/jam.json";
import { apiUrlSchema, jamSchema } from "../shared/schemas";

const quota = z.number().int().positive().max(1000000);
export const rateLimitsSchema = z.strictObject({
    apiPerMinute: quota,
    apiPerHour: quota,
    apiTrackedIps: quota,
    inspectionPerIpPerHour: quota,
    inspectionPerRepositoryPerHour: quota,
    inspectionGlobalPerHour: quota,
    inspectionTimeoutsPerHour: quota,
}).refine(
    (limits) => limits.apiPerHour >= limits.apiPerMinute
        && limits.inspectionPerRepositoryPerHour > limits.inspectionPerIpPerHour
        && limits.inspectionGlobalPerHour > limits.inspectionPerRepositoryPerHour
        && limits.inspectionTimeoutsPerHour <= limits.inspectionPerIpPerHour,
    "Expected minute <= hour, IP < repository < global, and timeout threshold <= IP inspections",
);

// Operator-owned JSON is validated once at startup. Restart the API after changing quotas.
export const rateLimits = rateLimitsSchema.parse(limitsData);

export const httpIdleTimeout = 180;
export const maxRequestBodyBytes = 64 * 1024;

function configuredOrigin(value: string | undefined, name: string, dev = false) {
    const parsed = apiUrlSchema.safeParse(value);

    if (!parsed.success) {
        throw new Error(`Set ${name} to a valid HTTP(S) origin in .env`);
    }

    const url = new URL(parsed.data);

    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error(`${name} must be an origin without credentials, path, query or fragment`);
    }

    if (!dev && url.protocol !== "https:") {
        throw new Error(`${name} must use HTTPS outside local development`);
    }

    return url.origin;
}

export function loadPublicApiUrl(env: Record<string, string | undefined> = process.env) {
    return configuredOrigin(env.PUBLIC_API_URL, "PUBLIC_API_URL");
}

/** Only explicit development mode permits HTTP origins. */
export function loadConfig(dev = false, env: Record<string, string | undefined> = process.env) {
    const jam = jamSchema.parse(jamData);
    const port = Number(env.API_PORT ?? (dev ? 3000 : 3001));

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("API_PORT must be between 1 and 65535");
    }

    const audience = configuredOrigin(
        env.PUBLIC_API_URL ?? (dev ? `http://127.0.0.1:${port}` : undefined),
        "PUBLIC_API_URL",
        dev,
    );

    return {
        audience,
        origin: configuredOrigin(env.CLIENT_ORIGIN ?? (dev ? audience : undefined), "CLIENT_ORIGIN", dev),
        host: env.API_HOST ?? "127.0.0.1",
        port,
        dataDir: resolve(env.DATA_DIR ?? "data"),
        jamId: jam.id,
        startsAt: Date.parse(jam.startsAt),
        endsAt: Date.parse(jam.endsAt),
        trustLocalProxy: env.TRUST_LOCAL_PROXY === "1",
    };
}

export type Config = ReturnType<typeof loadConfig>;

/** One abuse identity for mapped IPv4 aliases and all addresses in an IPv6 /64. */
export function clientIdentity(address: string) {
    // Internal callers may supply an opaque identity (including "unknown").
    if (!ipaddr.isValid(address)) {
        return address;
    }

    const ip = ipaddr.process(address);

    return ip.kind() === "ipv6"
        ? `${ipaddr.IPv6.networkAddressFromCIDR(`${ip.toString()}/64`).toString()}/64`
        : ip.toString();
}

/** Trust forwarding headers only from an explicitly enabled loopback proxy. */
export function clientAddress(request: Request, peer: string | undefined, trustLocalProxy: boolean) {
    const forwarded = request.headers.get("x-real-ip");
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "");

    if (trustLocalProxy && loopback && forwarded && ipaddr.isValid(forwarded)) {
        return ipaddr.parse(forwarded).toNormalizedString();
    }

    return peer;
}
