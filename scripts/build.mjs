import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeBlueprintArchive } from "@agenticos-dev/bot-archive-tools";
import { validateGadgetDefinition } from "@agenticos-dev/bot-contract";
import { SOCIAL_LOCALIZATION_DEFINITION } from "../definition.ts";
import { buildClient } from "./client.mjs";
import { CURRENT_SCHEMA_VERSION } from "../src/storage.js";

export const packageRoot = new URL("../", import.meta.url);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The storage schema this code expects, declared as data the host can read.
 *
 * A restore to older code is only safe when that code understands the storage
 * it will find: `migrate()` never runs down, so code written for schema N
 * reading storage at N+k silently sees empty columns. The host decides from
 * `storageSchemaVersion` inside the archive's own `manifest.json` — every
 * code-log revision carries the one it was built with — and never parses
 * `storage.js`. This check is what keeps that declaration honest: a migration
 * bump without the manifest fails the build instead of shipping a lie.
 */
export function assertStorageSchemaDeclaration(manifest, current = CURRENT_SCHEMA_VERSION) {
  const declared = manifest?.storageSchemaVersion;
  if (!Number.isSafeInteger(declared) || declared < 0) {
    throw new Error("manifest.json must declare storageSchemaVersion as a non-negative integer.");
  }
  if (declared !== current) {
    throw new Error(
      `manifest.json declares storageSchemaVersion ${declared}, but storage.js migrates to ${current}. Update the manifest with the migration.`
    );
  }
  if (!manifest.files?.includes("manifest.json")) {
    throw new Error("manifest.json must ship inside the archive so each code revision carries its storageSchemaVersion.");
  }
  return declared;
}

/**
 * Every relative module a packed file imports must itself be packed.
 *
 * The archive is flat and the platform loads exactly its members, so a module
 * added under `src/` but missing from `manifest.json` builds, passes every
 * unit test that imports it from disk, and then fails at load with `No such
 * module` the first time the gadget starts. That shipped once (grant-request.js).
 * A lexical scan is enough here: a static `from "./x.js"` or `import("./x.js")`
 * is the only way these modules reach each other.
 */
export function assertPackedImports(files) {
  const missing = [];
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith(".js") || name === "client.js") continue;
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)["']\.\/([^"']+)["']/gm)) {
      if (!Object.hasOwn(files, match[1])) missing.push(`${name} imports ./${match[1]}`);
    }
  }
  if (missing.length) throw new Error(`Archive is missing imported modules; add them to manifest.json: ${missing.join("; ")}.`);
}

export async function buildPackage({ outputDir = new URL("dist/", packageRoot), maxBytes } = {}) {
  const manifestText = await readFile(new URL("manifest.json", packageRoot), "utf8");
  const manifest = JSON.parse(manifestText);
  const checked = validateGadgetDefinition(SOCIAL_LOCALIZATION_DEFINITION);
  if (!checked.ok || checked.definition?.key !== manifest.blueprintKey) throw new Error("Package definition is invalid or conflicts with the manifest key.");
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error("maxBytes must be a positive integer.");
  assertStorageSchemaDeclaration(manifest);
  const files = {};
  for (const name of manifest.files) {
    if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name) || Object.hasOwn(files, name)) throw new Error("Invalid or duplicate flat archive member.");
    files[name] =
      name === "client.js"
        ? await buildClient()
        : name === "manifest.json"
          ? manifestText
          : await readFile(new URL(`src/${name}`, packageRoot), "utf8");
  }
  assertPackedImports(files);
  const metadata = { ...manifest.metadata, gadgetDefinition: checked.definition };
  const bytes = Buffer.from(await writeBlueprintArchive({ metadata, files }));
  if (maxBytes !== undefined && bytes.length > maxBytes) throw new Error(`Archive is ${bytes.length} bytes; host limit is ${maxBytes}.`);
  const release = {
    schemaVersion: "ai-agent-package-release.v1", blueprintKey: manifest.blueprintKey,
    artifact: manifest.artifact, sha256: sha256(bytes), byteSize: bytes.length,
    definition: checked.definition,
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)]))
  };
  await mkdir(outputDir, { recursive: true });
  const outputPath = outputDir instanceof URL ? fileURLToPath(outputDir) : outputDir;
  await writeFile(resolve(outputPath, manifest.artifact), bytes);
  await writeFile(resolve(outputPath, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  return { bytes, files, release };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { release } = await buildPackage();
  console.log(`${release.artifact}: ${release.byteSize} bytes, sha256 ${release.sha256}`);
}
