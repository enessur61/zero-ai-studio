// @ts-check
import { module } from "@prisma/composer";
import { envParam, envSecret, rawPostgres } from "@prisma/composer-prisma-cloud";
import zeroAiStudioService from "./service.mjs";

export default module("zero-ai-studio", ({ provision }) => {
  // Composer provisions a distinct database for each branch/environment.
  const database = provision(rawPostgres({ name: "database" }));

  provision(zeroAiStudioService, {
    id: "zeroaistudio",
    deps: { db: database },
    input: {
      ZERO_ADMIN_PASSWORD: envSecret("ZERO_ADMIN_PASSWORD"),
      ZERO_SESSION_SECRET: envSecret("ZERO_SESSION_SECRET"),
      GEMINI_API_KEY: envSecret("GEMINI_API_KEY"),
      ZERO_GEMINI_FREE_TIER_ONLY: envParam("ZERO_GEMINI_FREE_TIER_ONLY"),
      CLOUDFLARE_ACCOUNT_ID: envParam("CLOUDFLARE_ACCOUNT_ID"),
      CLOUDFLARE_API_TOKEN: envSecret("CLOUDFLARE_API_TOKEN"),
      ZERO_WEB_SEARCH_URL: envParam("ZERO_WEB_SEARCH_URL"),
      ZERO_WEB_SEARCH_TOKEN: envSecret("ZERO_WEB_SEARCH_TOKEN"),
      ZERO_TTS_WORKER_URL: envParam("ZERO_TTS_WORKER_URL"),
      ZERO_TTS_WORKER_TOKEN: envSecret("ZERO_TTS_WORKER_TOKEN"),
      ZERO_VIDEO_ENGINE_URL: envParam("ZERO_VIDEO_ENGINE_URL"),
      ZERO_VIDEO_ENGINE_TOKEN: envSecret("ZERO_VIDEO_ENGINE_TOKEN"),
    },
  });
});
