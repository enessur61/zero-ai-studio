import service from "./service.mjs";
import { configureRuntimeConfig } from "./server/runtimeConfig.ts";

const { db } = service.load();
const input = service.input();
const databaseUrl = db.url;
const databaseTarget = new URL(databaseUrl);
console.log("[ZERO Compute] PostgreSQL target:", {
  protocol: databaseTarget.protocol,
  hostname: databaseTarget.hostname,
  port: databaseTarget.port || "5432",
  database: databaseTarget.pathname,
});

const secret = (value: { expose(): string } | undefined): string | undefined =>
  value?.expose();

configureRuntimeConfig({
  DATABASE_URL: databaseUrl,
  PORT: String(service.port()),
  NODE_ENV: "production",
  ZERO_ADMIN_PASSWORD: secret(input.ZERO_ADMIN_PASSWORD),
  ZERO_SESSION_SECRET: secret(input.ZERO_SESSION_SECRET),
  GEMINI_API_KEY: secret(input.GEMINI_API_KEY),
  ZERO_GEMINI_FREE_TIER_ONLY: input.ZERO_GEMINI_FREE_TIER_ONLY,
  CLOUDFLARE_ACCOUNT_ID: input.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: secret(input.CLOUDFLARE_API_TOKEN),
  ZERO_WEB_SEARCH_URL: input.ZERO_WEB_SEARCH_URL,
  ZERO_WEB_SEARCH_TOKEN: secret(input.ZERO_WEB_SEARCH_TOKEN),
  ZERO_TTS_WORKER_URL: input.ZERO_TTS_WORKER_URL,
  ZERO_TTS_WORKER_TOKEN: secret(input.ZERO_TTS_WORKER_TOKEN),
  ZERO_VIDEO_ENGINE_URL: input.ZERO_VIDEO_ENGINE_URL,
  ZERO_VIDEO_ENGINE_TOKEN: secret(input.ZERO_VIDEO_ENGINE_TOKEN),
});

// The deployment workflow probes /api/health and /api/auth/status after this
// entrypoint starts, validating only this branch-scoped preview environment.
// The existing Express routes, middleware, auth and static-file handling are
// retained. Import only after the Prisma-provided port, DB and inputs are ready.
await import("./server.ts");
