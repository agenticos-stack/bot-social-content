import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { readBlueprintArchive } from "@agenticos-dev/bot-archive-tools";
import { validateGadgetDefinition } from "@agenticos-dev/bot-contract";
import { packageRoot, sha256 } from "./build.mjs";

const manifest = JSON.parse(await readFile(new URL("manifest.json", packageRoot), "utf8"));
const release = JSON.parse(await readFile(new URL("dist/release.json", packageRoot), "utf8"));
const bytes = await readFile(new URL(`dist/${manifest.artifact}`, packageRoot));
if (sha256(bytes) !== release.sha256 || bytes.length !== release.byteSize) throw new Error("Artifact checksum/size differs from release manifest.");
const archive = await readBlueprintArchive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const definition = validateGadgetDefinition(archive.metadata.gadgetDefinition);
if (!definition.ok || definition.definition?.key !== manifest.blueprintKey) throw new Error("Invalid archive definition.");
if (release.schemaVersion !== "ai-agent-package-release.v1" || release.artifact !== manifest.artifact || release.blueprintKey !== manifest.blueprintKey) throw new Error("Release identity differs from package manifest.");
if (!isDeepStrictEqual(release.definition, definition.definition)) throw new Error("Release definition differs from archive.");
if (JSON.stringify(Object.keys(archive.files).sort()) !== JSON.stringify([...manifest.files].sort())) throw new Error("Unexpected archive members.");
if (!isDeepStrictEqual(Object.keys(release.files).sort(), Object.keys(archive.files).sort())) throw new Error("Unexpected release members.");
for (const [name, text] of Object.entries(archive.files)) {
  if (sha256(text) !== release.files[name]) throw new Error(`Member checksum mismatch: ${name}`);
}
console.log(`Validated ${manifest.artifact}; integrity is not publication authority.`);
