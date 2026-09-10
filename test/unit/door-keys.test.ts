import { describe, it, expect } from "vitest";
import { FIXED_DOOR_KEYS, FETCH_DOOR_KEY } from "../../src/doors.js";
import { SOCIAL_LOCALIZATION_DEFINITION } from "../../definition.ts";

/**
 * A door the gadget reads but never declares is a door the platform is never
 * asked to resolve, and `env.<key>` is then absent no matter what the owner
 * grants.
 *
 * That is exactly how the open-account path stayed unreachable: `doors.js`
 * called the door `fetch`, the platform mints it as `metered_fetch`, and the
 * definition declared neither. `methodsByDoor[door.envKey]` never matched, so
 * the door quietly never entered `env` — and because the gadget is required to
 * treat a missing fetch door as "this workspace does not watch open accounts",
 * the absence looked exactly like correct configuration.
 *
 * The unit tests could not catch it: they built their own `env` using the
 * gadget's invented key, so they asserted the bug rather than the contract.
 */
describe("the doors this gadget reads are doors it declares", () => {
  const declared = new Set(SOCIAL_LOCALIZATION_DEFINITION.requirements.map(r => r.requirementKey));

  it("declares every fixed door key", () => {
    for (const key of FIXED_DOOR_KEYS) {
      expect(declared.has(key), `${key} is read but not declared in definition.ts`).toBe(true);
    }
  });

  it("declares the fetch door under the platform's own name", () => {
    // The gatekeeper registry's key, and what a grant reports: `env.metered_fetch`.
    expect(FETCH_DOOR_KEY).toBe("metered_fetch");
    expect(declared.has(FETCH_DOOR_KEY)).toBe(true);
  });
});
