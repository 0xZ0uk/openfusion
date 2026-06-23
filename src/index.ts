import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { app } from "./routes.js";

const { host, port } = config.server;

console.log(`\n  🧬 Fusion Service`);
console.log(`  ───────────────`);
console.log(`  Listening : ${host}:${port}`);
console.log(`  LiteLLM   : ${config.litellm.baseUrl}`);
if (config.search.braveApiKey) {
  console.log(`  Search    : Brave Search API + DDG fallback`);
} else {
  console.log(`  Search    : DuckDuckGo (no Brave key set)`);
}
console.log(`  Defaults  : panel=${config.defaults.panel.join(", ")}`);
console.log(`              judge=${config.defaults.judge}`);
console.log(`              outer=${config.defaults.outerModel}`);
console.log(`\n  POST /v1/chat/completions  — Fusion endpoint (streaming supported)`);
console.log(`  GET  /health              — Health check\n`);

serve(
  {
    port,
    hostname: host,
    fetch: app.fetch,
  },
  (info) => {
    console.log(`  ➜ Server ready at http://${info.address}:${info.port}`);
  },
);
