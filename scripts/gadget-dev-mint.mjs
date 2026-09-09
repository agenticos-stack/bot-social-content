/**
 * Mint a gadget development session from a developer key, so the host boots
 * without a token pasted out of a browser tab.
 *
 * WHY A KEY AND NOT A COOKIE. Production issues its session cookie
 * `__Secure-` + `Domain=agenticos.hk`, and that cookie is full scope for the
 * whole of its life. A personal access token carrying `gadget_dev.session` is
 * scoped, labelled, listable and revocable, and what it mints here is narrower
 * still: one organization, one user, one workspace, one gadget key, eight
 * hours, no doors.
 *
 * THE KEY STAYS IN THE HOST. It is read once, at boot, from the environment;
 * it is never proxied, never written to the canvas, and never logged — the
 * browser on `social.localhost` sees neither it nor the token it mints.
 */

const KEY_PATTERN = /^ag_mcp_[0-9a-f]{64}$/;

/** A trimmed key, or null when the environment did not carry one. */
export function readDeveloperKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return key || null;
}

/**
 * Refuse a key that is not shaped like one before it reaches the network.
 *
 * A pasted-wrong key would otherwise arrive as a plain 401 that reads exactly
 * like an expired one, and the difference matters: one is re-mint, the other
 * is re-copy.
 */
export function assertDeveloperKey(key) {
  if (!KEY_PATTERN.test(key ?? '')) {
    throw new Error('SOCIAL_CONTENT_DEV_KEY must be a personal access token (ag_mcp_…) carrying the gadget_dev.session scope.');
  }
}

/**
 * `POST /v2/gadget-dev/sessions`, returning what the host needs and nothing
 * else. Errors name the status and the API's own message; the key never
 * appears in one.
 */
export async function mintGadgetDevSession({ apiOrigin, developerKey, gadgetKey, title, fetcher = fetch }) {
  assertDeveloperKey(developerKey);
  const response = await fetcher(apiOrigin + '/v2/gadget-dev/sessions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + developerKey,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify(title ? { gadgetKey, title } : { gadgetKey }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data?.devToken) {
    const message = payload?.error?.message || 'The development session could not be started.';
    throw new Error(`Minting a development session failed (${response.status}): ${message}`);
  }
  const { devToken, workspaceId, expiresAtMs } = payload.data;
  return { devToken, workspaceId, expiresAtMs };
}

/** Local time the session stops working, for one line on stdout. Never the token. */
export function describeExpiry(expiresAtMs) {
  return Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : 'unknown';
}
