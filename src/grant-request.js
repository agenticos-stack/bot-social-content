/**
 * A gadget:grant-door message is a REQUEST for host consent, not consent.
 *
 * Both Studio and the local Social Content preview import this module so they
 * share one parse/scope rule. The host still presents confirmation in its own
 * trusted UI. The platform still enforces membership and declarations.
 */

const REQUIREMENT_KEY = /^[a-z][a-z0-9_]{0,63}$/;

export function parseGadgetGrantDoorMessage(data) {
  if (!data || typeof data !== "object" || data.type !== "gadget:grant-door") return null;
  const requirementKey = typeof data.requirementKey === "string" ? data.requirementKey.trim() : "";
  if (!REQUIREMENT_KEY.test(requirementKey)) return null;
  return { requirementKey };
}

/**
 * Canvas Grant is conversation-only unless the owner ticks the explained
 * assistant-wide choice. Omitting the flag on the API defaults organization
 * doors to persist — hosts must send this boolean.
 */
export function canvasGrantPersistToAgent(persistToAssistant) {
  return persistToAssistant === true;
}

export function consentAllowsFetch(env, key = "metered_fetch") {
  if (env && typeof env === "object" && env.__consent && typeof env.__consent === "object") {
    return env.__consent[key] === true;
  }
  return Boolean(env && typeof env === "object" && env[key]);
}
