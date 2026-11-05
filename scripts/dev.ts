import adminPage from "../client/admin.html";
import page from "../client/index.html";
import { renderPage } from "../client/markdown";
import { createApp } from "../server/app";
import { clientAddress, httpIdleTimeout, loadConfig, maxRequestBodyBytes } from "../server/config";
import { checkRuntime } from "../server/submissions";

const config = loadConfig(true);
checkRuntime();
const app = createApp({ config });

const server = Bun.serve({
    idleTimeout: httpIdleTimeout,
    hostname: config.host,
    port: config.port,
    development: true,
    routes: {
        "/": page,
        "/index.html": page,
        "/guide.html": async () => new Response(
            await renderPage(await Bun.file(new URL("../client/guide.html", import.meta.url)).text(), "guide"),
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
        "/guide.css": () => new Response(Bun.file(new URL("../client/guide.css", import.meta.url))),
        "/theme.css": () => new Response(Bun.file(new URL("../client/theme.css", import.meta.url))),
        "/assets/luanti.svg": () => new Response(Bun.file(new URL("../client/assets/luanti.svg", import.meta.url))),
        "/admin.html": adminPage,
    },
    fetch: (request, server) => {
        return app.fetch(request, {
            // Extend only validated inspection requests; body uploads retain the ordinary idle timeout.
            beginInspection: () => server.timeout(request, 0),
            ip: clientAddress(request, server.requestIP(request)?.address, config.trustLocalProxy),
        });
    },
    maxRequestBodySize: maxRequestBodyBytes,
});

console.log(`Development server: ${server.url}`);
