import './env-setup';

import { startWebServer } from './web/server';
import { start } from './ui/main';

const WEB_PORT = parseInt(process.env.HFV_WEB_PORT ?? "4173", 10) || 4173;
// Loopback-only, deliberately not configurable: the web UI/API has no
// transport encryption of its own (plain HTTP) and a lighter-weight auth
// model than the CLI (see web/server.ts) — both are fine for "another
// process on this same machine", neither is fine for "the network".
// Put a reverse proxy with TLS in front if you actually need remote access.
const WEB_HOST = "127.0.0.1";

if (process.argv.includes("web")) {
    startWebServer(WEB_PORT, WEB_HOST);
    console.log(`HF-VAULT web UI: http://${WEB_HOST}:${WEB_PORT}`);
}
else {
    start();
}
