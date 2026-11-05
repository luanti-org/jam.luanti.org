import { rm } from "node:fs/promises";
import { renderPage } from "../client/markdown";
import { loadPublicApiUrl } from "../server/config";

/** Bun emits one literal head tag. Refuse unexpected output rather than publishing without the policy. */
export function insertCsp(html: string, policy: string) {
    if (html.split("<head>").length !== 2 || /http-equiv=["']Content-Security-Policy["']/i.test(html)) {
        throw new Error("Expected exactly one <head> and no existing Content-Security-Policy");
    }

    return html.replace("<head>", () => `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

if (import.meta.main) {
    const audience = loadPublicApiUrl();
    const outdir = "dist";

    await rm(outdir, {
        recursive: true,
        force: true,
    });

    const pages = ["index", "guide", "admin"] as const;
    const result = await Bun.build({
        entrypoints: pages.map((page) => `client/${page}.html`),
        outdir,
        target: "browser",
        conditions: ["browser", "production"],
        define: { "process.env.PUBLIC_API_URL": JSON.stringify(audience) },
        minify: true,
        splitting: true,
    });

    if (!result.success) {
        throw new AggregateError(result.logs, "Client build failed");
    }

    const policy = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${audience}; img-src 'self' blob: ${audience}; base-uri 'none'; form-action 'none'; object-src 'none'`;

    for (const page of pages) {
        const path = `${outdir}/${page}.html`;
        const template = await Bun.file(path).text();
        const html = await renderPage(template, page);
        await Bun.write(
            path,
            insertCsp(html, policy),
        );
    }

    console.log("Built public and administrator pages in dist/");
}
