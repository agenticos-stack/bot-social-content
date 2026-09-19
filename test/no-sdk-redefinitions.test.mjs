import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {assertNoSdkRedefinitions} from '@agenticos-dev/bot-devkit/redefinitions';

/*
 * A local declaration that shadows an SDK export is how the forks started:
 * the copy compiles, the import that would have replaced it never happens,
 * and the two drift. The export lists are read from the installed packages —
 * never kept by hand — so a new SDK module joins the guard the day it is
 * adopted. bot-testkit's subpaths join the list when the package lands as a
 * dependency.
 */
const SDK_MODULES = [
  '@agenticos-dev/bot-sdk',
  '@agenticos-dev/bot-devkit',
  '@agenticos-dev/bot-devkit/doors',
  '@agenticos-dev/bot-devkit/host-events',
  '@agenticos-dev/bot-devkit/origins',
  '@agenticos-dev/bot-devkit/redefinitions',
  '@agenticos-dev/bot-devkit/scaffold',
  '@agenticos-dev/bot-devkit/session',
  '@agenticos-dev/bot-shell/client/collection.js',
  '@agenticos-dev/bot-shell/client/dom.js',
  '@agenticos-dev/bot-shell/client/drawer.js',
  '@agenticos-dev/bot-shell/client/elements.js',
  '@agenticos-dev/bot-shell/client/rpc.js',
  '@agenticos-dev/bot-shell/client/steps.js',
  '@agenticos-dev/bot-shell/client/toast.js'
];

const SOURCE_DIRS = ['scripts', 'src'];

/*
 * Sanctioned shadows: same-name wrappers that IMPORT the SDK implementation
 * and inject this canvas's vocabulary — the shared code runs, the wrapper
 * only carries the arguments it cannot know (class names, filter words,
 * method lists, step rails). Each is named here so adding a shadow is a
 * review-visible act; a wrapper that stops delegating is caught by reading
 * its diff, which this list makes unavoidable.
 */
const ALLOWED_SHADOWS = new Set([
  // dom.js — injects the sl-* class map and decorates nodes; delegates to createEl/icon paths.
  'src/src/client/dom.js declares el',
  'src/src/client/dom.js declares icon',
  // collection.js — injects FILTERS and the card's searchable text; delegates to the shared reducers.
  'src/src/client/collection.js declares createCollectionState',
  'src/src/client/collection.js declares setFilter',
  'src/src/client/collection.js declares visibleItems',
  // drawer.js — injects CONFIRM_CLASSES chrome; delegates to the shared choice flow.
  'src/src/client/drawer.js declares confirmDrawerChoice',
  // rpc.js — injects this gadget's method allowlist; delegates to the shared rpc mechanics.
  'src/src/client/rpc.js declares createRpc',
  // steps.js — injects STEPS/MOBILE_PANES; delegates to the shared state guards.
  'src/src/client/steps.js declares goToStep',
  'src/src/client/steps.js declares setMobilePane'
]);

async function* sourceFiles(directory) {
  for (const entry of await readdir(new URL(`../${directory}/`, import.meta.url), {withFileTypes: true})) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(mjs|js)$/.test(entry.name)) yield path;
  }
}

test('bot source declares no name an SDK package already exports, outside documented delegating wrappers', async () => {
  const sdkExports = new Map();
  for (const mod of SDK_MODULES) {
    for (const name of Object.keys(await import(mod))) {
      if (!sdkExports.has(name)) sdkExports.set(name, mod);
    }
  }
  const collisions = [];
  for (const dir of SOURCE_DIRS) {
    for await (const path of sourceFiles(dir)) {
      const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
      try {
        assertNoSdkRedefinitions({files: {[path]: text}, sdkExports});
      } catch (error) {
        collisions.push(...error.message.split('\n').slice(1).map((line) => line.trim().replace(/, which .*$/, '')));
      }
    }
  }
  assert.deepEqual(collisions.sort(), [...ALLOWED_SHADOWS].sort());
});
