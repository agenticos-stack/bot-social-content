import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBlueprintArchive } from "@agenticos-dev/bot-archive-tools";
import { buildPackage, sha256 } from "../scripts/build.mjs";
import { SOCIAL_LOCALIZATION_DEFINITION } from "../definition.ts";

test("repeated builds preserve bytes, complete definition, and member checksums", async () => {
  const directory = await mkdtemp(join(tmpdir(), "social-content-build-test-"));
  try {
    const first = await buildPackage({ outputDir: join(directory, "first") });
    const second = await buildPackage({ outputDir: join(directory, "second") });
    assert.deepEqual(first.bytes, second.bytes);
    assert.deepEqual(first.release, second.release);
    assert.equal(first.release.artifact, "social-content.gadget");
    assert.equal(first.release.blueprintKey, "social_localization");
    assert.equal(first.release.sha256, sha256(first.bytes));
    const archive = await readBlueprintArchive(first.bytes.buffer.slice(first.bytes.byteOffset, first.bytes.byteOffset + first.bytes.byteLength));
    assert.deepEqual(archive.metadata.gadgetDefinition, SOCIAL_LOCALIZATION_DEFINITION);
    assert.equal(archive.metadata.title, "Social Content");
    assert.deepEqual(archive.files, first.files);
    for (const [name, content] of Object.entries(archive.files)) assert.equal(first.release.files[name], sha256(content));
    assert.deepEqual(await readFile(join(directory, "first", first.release.artifact)), first.bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host size limits reject before writing any release files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "social-content-limit-test-"));
  try {
    await assert.rejects(buildPackage({ outputDir: directory, maxBytes: 1 }), /host limit/);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(buildPackage({ outputDir: directory, maxBytes: 0 }), /positive integer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
