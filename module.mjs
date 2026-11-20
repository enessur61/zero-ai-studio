// @ts-check
import { module } from "@prisma/composer";
import { envSecret, rawPostgres } from "@prisma/composer-prisma-cloud";
import zeroAiStudioService from "./service.mjs";

export default module("zero-ai-studio", ({ provision }) => {
  // Composer provisions a distinct database for each branch/environment.
  const database = provision(rawPostgres({ name: "database" }));

  provision(zeroAiStudioService, {
    id: "zeroaistudio",
    deps: { db: database },
    input: {
      // Dedicated preview credentials are injected only when present in the
      // branch-scoped Prisma environment. Optional provider credentials remain
      // unbound until the operator configures them.
      ZERO_ADMIN_PASSWORD: envSecret("ZERO_ADMIN_PASSWORD"),
      ZERO_SESSION_SECRET: envSecret("ZERO_SESSION_SECRET"),
    },
  });
});
