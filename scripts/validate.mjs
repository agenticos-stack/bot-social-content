import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validatePackage } from "@agenticos-dev/bot-devkit";
import { SOCIAL_CONTENT_DEFINITION } from "../definition.ts";
import { buildClient } from "./client.mjs";
import { packageRoot } from "./build.mjs";

/*
 * Archive-integrity validation, delegated to the SDK's devkit. Generated
 * members are regenerated and compared, so a stale bundle or a hand-edited
 * manifest fails here rather than shipping.
 */
const result = await validatePackage(fileURLToPath(packageRoot), {
  definition: SOCIAL_CONTENT_DEFINITION,
  generatedMembers: {
    "client.js": () => buildClient(),
    "manifest.json": async () => readFile(new URL("manifest.json", packageRoot), "utf8")
  }
});
console.log(`Validated ${result.artifact}; integrity is not publication authority.`);
