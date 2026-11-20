// @ts-check
import { module } from "@prisma/composer";
import zeroAiStudioService from "./service.mjs";

export default module("zero-ai-studio", ({ provision }) => {
  provision(zeroAiStudioService, { id: "zeroaistudio" });
});
