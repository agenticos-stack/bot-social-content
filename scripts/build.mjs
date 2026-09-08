import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeBlueprintArchive } from "@agenticos-dev/bot-archive-tools";
import { validateGadgetDefinition } from "@agenticos-dev/bot-contract";
import { SOCIAL_LOCALIZATION_DEFINITION } from "../definition.ts";
import { buildClient } from "./client.mjs";

export const packageRoot = new URL("../", import.meta.url);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function buildPackage({ outputDir = new URL("dist/", packageRoot), maxBytes } = {}) {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", packageRoot), "utf8"));
  const checked = validateGadgetDefinition(SOCIAL_LOCALIZATION_DEFINITION);
  if (!checked.ok || checked.definition?.key !== manifest.blueprintKey) throw new Error("Package definition is invalid or conflicts with the manifest key.");
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error("maxBytes must be a positive integer.");
  const files = {};
  for (const name of manifest.files) {
    if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name) || Object.hasOwn(files, name)) throw new Error("Invalid or duplicate flat archive member.");
    files[name] = name === "client.js" ? await buildClient() : await readFile(new URL(`src/${name}`, packageRoot), "utf8");
  }
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
