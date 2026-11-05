import { createApp } from "./app";
import { clientAddress, httpIdleTimeout, loadConfig, maxRequestBodyBytes } from "./config";
import { checkRuntime } from "./submissions";

const config = loadConfig();
checkRuntime();
const app = createApp({ config });
const server = Bun.serve({
    idleTimeout: httpIdleTimeout,
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: maxRequestBodyBytes,
    fetch: (request, server) => {
        return app.fetch(request, {
            // Extend only validated inspection requests; body uploads retain the ordinary idle timeout.
            beginInspection: () => server.timeout(request, 0),
            ip: clientAddress(request, server.requestIP(request)?.address, config.trustLocalProxy),
        });
    },
});

console.log(`Jam API: ${server.url}`);
