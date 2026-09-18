import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPackage as buildGadgetPackage,
  assertPackedImports,
  assertStorageSchemaDeclaration
} from "@agenticos-dev/bot-devkit";
import { SOCIAL_LOCALIZATION_DEFINITION } from "../definition.ts";
import { buildClient } from "./client.mjs";
import { CURRENT_SCHEMA_VERSION } from "../src/storage.js";

export const packageRoot = new URL("../", import.meta.url);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export { assertPackedImports, assertStorageSchemaDeclaration };

/**
 * Byte budgets — a regression trips the build, and the only way past one is a
 * deliberate bump here, in the diff.
 *
 * `CLIENT_JS_BYTE_BUDGET` is NOT the gadget-authoring store's 156,000-byte
 * read ceiling: this canvas is already over that line (the authoring path is
 * tracked as its own hazard). It is a ratchet pinned at the measured
 * post-adoption floor so the bundle cannot grow silently. Moving the
 * reducers, RPC/chunk mechanics, drawer choice, toaster and DOM builders to
 * @agenticos-dev/bot-shell cost +496B over a fresh HEAD build (292,317): the
 * shared helpers carry the generality both canvases need, and this canvas's
 * local copies were already the tighter node-side variants. The constants the
 * package ships for a canvas that uses its default chrome (bot-toast-card,
 * bot-drawer-sheet) are dead literals here — this canvas re-skins them with
 * its `sl-*` classes — and the wrappers that preserve those contracts are the
 * rest of it.
 *
 * `ARCHIVE_BYTE_BUDGET` freezes today's `.gadget` so feature work cannot grow
 * the artifact silently. Bump it only when the growth is the change being
 * reviewed.
 */
export const CLIENT_JS_BYTE_BUDGET = 292_813;
export const ARCHIVE_BYTE_BUDGET = 219_329;

/** Members that are built rather than read from src/: the bundled client and the manifest itself. */
const generatedMembers = {
  "client.js": () => buildClient(),
  "manifest.json": async () => readFile(new URL("manifest.json", packageRoot), "utf8")
};

export async function buildGadget({ outputDir = new URL("dist/", packageRoot), maxBytes = ARCHIVE_BYTE_BUDGET } = {}) {
  return buildGadgetPackage(fileURLToPath(packageRoot), {
    definition: SOCIAL_LOCALIZATION_DEFINITION,
    generatedMembers,
    storageSchemaVersion: CURRENT_SCHEMA_VERSION,
    budgets: {
      clientJs: {
        limit: CLIENT_JS_BYTE_BUDGET,
        reason: "size ratchet at the measured post-adoption floor — the bundle already exceeds the authoring store's 156,000-byte read ceiling (tracked as its own hazard); growth is reviewed in the diff"
      },
      archive: {
        limit: maxBytes,
        reason: "freezes the .gadget so feature work cannot grow the artifact silently — bump only when the growth is the change being reviewed"
      }
    },
    outputDir: outputDir instanceof URL ? fileURLToPath(outputDir) : outputDir
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { release } = await buildGadget();
  console.log(
    `${release.artifact}: ${release.byteSize} bytes (client.js ${release.clientBytes} bytes), sha256 ${release.sha256}`
  );
}
