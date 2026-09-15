/**
 * How sure a failed door grant or activation is that nothing happened.
 *
 * `refused` is a known answer before any effect: validation, a door this
 * source never declared, a key the platform does not list as granted, the
 * wrong account, no running session, or an upstream 4xx that explained
 * itself. Everything else — transport loss, an upstream 5xx, a body nobody
 * can read, any error nobody classified — is `unknown`: consent may have been
 * saved. Unclassified is unknown by construction, so a new throw can never
 * read as a denial.
 */
export class DoorRefusal extends Error {
  constructor(message, code = 'refused') {
    super(message);
    this.name = 'DoorRefusal';
    this.code = code;
    this.certainty = 'refused';
  }
}

export function refuse(message, code) {
  return new DoorRefusal(message, code);
}

export function isRefusal(error) {
  return error instanceof Error && error.certainty === 'refused';
}

/**
 * The router's answer for a thrown grant/activation error: 409 with
 * `certainty: "refused"` only for a refusal; 502 with `certainty: "unknown"`
 * otherwise.
 */
export function doorFailureResponse(error, fallback) {
  const message = error instanceof Error && error.message ? error.message : fallback;
  const headers = { 'cache-control': 'no-store' };
  if (isRefusal(error)) {
    return Response.json({ error: { message, code: error.code, certainty: 'refused' } }, { status: 409, headers });
  }
  return Response.json({ error: { message, certainty: 'unknown' } }, { status: 502, headers });
}
