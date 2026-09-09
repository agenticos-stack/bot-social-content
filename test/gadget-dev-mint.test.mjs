import assert from 'node:assert/strict';
import test from 'node:test';

import { assertDeveloperKey, describeExpiry, mintGadgetDevSession, readDeveloperKey } from '../scripts/gadget-dev-mint.mjs';

const KEY = 'ag_mcp_' + 'a'.repeat(64);
const ORIGIN = 'https://api.agenticos.hk';

function minted(overrides = {}) {
  return {
    ok: true,
    status: 201,
    json: async () => ({
      data: {
        workspaceId: 'chat_dev_1',
        devToken: 'gadget-dev-token',
        expiresAtMs: 1_770_000_000_000,
        ...overrides
      }
    })
  };
}

test('reads a key from the environment, or reports none', () => {
  assert.equal(readDeveloperKey('  ' + KEY + ' '), KEY);
  assert.equal(readDeveloperKey(''), null);
  assert.equal(readDeveloperKey(undefined), null);
});

test('refuses a key that is not shaped like one, before any request', () => {
  // A mistyped key and an expired one both answer 401; only one of them is
  // worth re-copying, so the shape is checked locally.
  assert.throws(() => assertDeveloperKey('hunter2'), /gadget_dev\.session/);
  assert.throws(() => assertDeveloperKey('ag_mcp_short'), /gadget_dev\.session/);
  assert.doesNotThrow(() => assertDeveloperKey(KEY));
});

test('mints with the key as a bearer, and asks for this gadget', async () => {
  let seen;
  const result = await mintGadgetDevSession({
    apiOrigin: ORIGIN,
    developerKey: KEY,
    gadgetKey: 'social_localization',
    title: 'Social Content',
    fetcher: async (url, init) => {
      seen = { url, init };
      return minted();
    }
  });

  assert.equal(seen.url, ORIGIN + '/v2/gadget-dev/sessions');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, 'Bearer ' + KEY);
  assert.deepEqual(JSON.parse(seen.init.body), { gadgetKey: 'social_localization', title: 'Social Content' });
  assert.deepEqual(result, {
    devToken: 'gadget-dev-token',
    workspaceId: 'chat_dev_1',
    expiresAtMs: 1_770_000_000_000
  });
});

test('reports the API message and status, without echoing the key', async () => {
  const failure = await mintGadgetDevSession({
    apiOrigin: ORIGIN,
    developerKey: KEY,
    gadgetKey: 'social_localization',
    fetcher: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'Missing gadget_dev.session scope.' } })
    })
  }).catch((error) => error);

  assert.match(failure.message, /403/);
  assert.match(failure.message, /Missing gadget_dev\.session scope\./);
  assert.equal(failure.message.includes(KEY), false);
});

test('treats a 200 with no token as a failure', async () => {
  const failure = await mintGadgetDevSession({
    apiOrigin: ORIGIN,
    developerKey: KEY,
    gadgetKey: 'social_localization',
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) })
  }).catch((error) => error);

  assert.match(failure.message, /could not be started/);
});

test('describes expiry without inventing one', () => {
  assert.equal(describeExpiry(1_770_000_000_000), new Date(1_770_000_000_000).toISOString());
  assert.equal(describeExpiry(undefined), 'unknown');
});
