/**
 * What a door grant or activation response means, read strictly.
 *
 * The same contract Studio applies to the API's receipt: only an explicit
 * runtime answer is an answer. HTTP 200 with a body nobody can read, or a
 * receipt with no runtime status, is not "activated" — the permission may or
 * may not be live, so the canvas hears `unconfirmed` and can ask to activate
 * (which verifies before starting anything). Recovery never writes a grant.
 *
 * `response` is `{ ok, status, bodyText }`; the body is parsed here so a
 * malformed body is classified rather than thrown.
 */
export function grantReceiptOutcome(response) {
  let body = null;
  let readable = false;
  if (typeof response?.bodyText === "string" && response.bodyText.trim()) {
    try {
      body = JSON.parse(response.bodyText);
      readable = body !== null && typeof body === "object";
    } catch {
      readable = false;
    }
  }
  const status = Number(response?.status);
  if (!response?.ok) {
    const message = readable && typeof body?.error?.message === "string" ? body.error.message : null;
    // An explicit refusal: a client error the host explained. Anything else —
    // a server error, or a refusal nobody can read — may have landed or not.
    if (Number.isInteger(status) && status >= 400 && status < 500 && message) {
      return { outcome: "denied", message };
    }
    return { outcome: "unconfirmed", message: message ?? "The permission answer could not be confirmed." };
  }
  if (!readable) return { outcome: "unconfirmed", message: "The permission answer could not be read." };
  const runtime = body?.data?.runtime;
  const runtimeStatus = typeof runtime?.status === "string" ? runtime.status : null;
  const message = typeof runtime?.message === "string" ? runtime.message : undefined;
  if (runtimeStatus === "ready" || runtimeStatus === "unchanged") return { outcome: "activated", message };
  if (runtimeStatus === "refresh_failed") return { outcome: "activation_failed", message };
  return { outcome: "unconfirmed", message: "The permission answer did not say whether the door is running." };
}
