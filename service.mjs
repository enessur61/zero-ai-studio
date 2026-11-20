// @ts-check
import node from "@prisma/composer/node";
import { secretString } from "@prisma/composer/arktype";
import { compute, rawPostgres } from "@prisma/composer-prisma-cloud";
import { type } from "arktype";

const serviceInput = type({
  "ZERO_ADMIN_PASSWORD?": secretString(),
  "ZERO_SESSION_SECRET?": secretString(),
  "GEMINI_API_KEY?": secretString(),
  "ZERO_GEMINI_FREE_TIER_ONLY?": "string",
  "CLOUDFLARE_ACCOUNT_ID?": "string",
  "CLOUDFLARE_API_TOKEN?": secretString(),
  "ZERO_WEB_SEARCH_URL?": "string",
  "ZERO_WEB_SEARCH_TOKEN?": secretString(),
  "ZERO_TTS_WORKER_URL?": "string",
  "ZERO_TTS_WORKER_TOKEN?": secretString(),
  "ZERO_VIDEO_ENGINE_URL?": "string",
  "ZERO_VIDEO_ENGINE_TOKEN?": secretString(),
});

export default compute({
  name: "zero-ai-studio",
  deps: { db: rawPostgres() },
  input: serviceInput,
  build: node({
    module: import.meta.url,
    dir: "dist",
    entry: "index.js",
    dependencies: "external",
  }),
});
