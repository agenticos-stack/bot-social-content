import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("preview seed leaves fetch budget at zero and says so at startup", async () => {
  const runtime = await readFile(new URL("../scripts/local-runtime.mjs", import.meta.url), "utf8");
  const preview = await readFile(new URL("../scripts/preview.mjs", import.meta.url), "utf8");
  assert.match(runtime, /fetchBudgetCredits:\s*0/);
  assert.match(runtime, /set a budget in Settings/);
  assert.doesNotMatch(runtime, /fetchBudgetCredits:\s*[1-9]/);
  assert.match(preview, /fetchBudgetCredits is 0/);
  assert.match(preview, /set a budget in Settings/);
});
