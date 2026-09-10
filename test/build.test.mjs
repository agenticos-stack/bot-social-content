import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

/*
 * The client's stylesheet is a JavaScript template literal.
 *
 * A backtick inside it — in a CSS comment, naming a selector the way prose
 * names a selector — closes the literal early. Everything after that point is
 * parsed as JavaScript, the build still SUCCEEDS, and the page ships with the
 * rest of its stylesheet missing and a `ReferenceError` on load. That happened
 * twice in one afternoon, both times in a comment explaining a CSS rule.
 *
 * Assert the last rules in the sheet survive the build. A cheaper check than
 * reading every comment, and it fails on exactly the shape of the bug: the
 * literal breaks somewhere, and everything past the break disappears.
 */
test("the client stylesheet survives the bundler intact", async () => {
  const { buildClient } = await import("../scripts/client.mjs");
  const bundle = await buildClient();
  for (const rule of [
    ".sl-icon-action { width:34px",   // early, before the drawer rules
    ".sl-preview-head-actions",       // the drawer header
    ".sl-stage-strip",                // the media stage
    ".sl-announce-card",              // the last block in the sheet
    ".sl-drawer-facts"
  ]) {
    assert.ok(bundle.includes(rule), `stylesheet lost ${rule} — a backtick probably closed the template literal early`);
  }
  assert.ok(!/`/.test(clientStylesheetSource()), "no backticks belong inside the stylesheet literal");
});

/** The source text between the stylesheet literal's own backticks. */
function clientStylesheetSource() {
  const source = readFileSync(new URL("../src/src/client/client.js", import.meta.url), "utf8");
  const start = source.indexOf("const BASE_STYLE = `");
  assert.ok(start >= 0, "BASE_STYLE literal not found");
  const open = source.indexOf("`", start);
  const close = source.indexOf("\n`;", open);
  assert.ok(close > open, "BASE_STYLE literal is not closed");
  // Skip the two ${...} interpolations the sheet opens with.
  return source.slice(source.indexOf("\n", open), close);
}
