import { describe, expect, it } from "vitest";
import { SOCIAL_LOCALIZATION_DEFINITION } from "../../definition.ts";

/**
 * Draft first: setup's gate waits only on declared, non-optional rows, so
 * what the owner needs only to publish must be optional here and enforced
 * at the operation instead (`submitForReview`, `addOpenSource`).
 */
const byKey = Object.fromEntries(
  SOCIAL_LOCALIZATION_DEFINITION.requirements.map((requirement) => [requirement.requirementKey, requirement as Record<string, unknown>])
);

describe("Social Content setup declarations", () => {
  it("opens with nothing granted: every requirement is checked by the operation that uses it", () => {
    // Sources, destinations, the publisher, public fetching, scan cadence and
    // notifications. Opening and drafting need none of them; monitoring
    // refuses `schedule_not_granted`, submitting refuses `publisher_not_granted`.
    for (const key of ["source", "destination", "social", "metered_fetch", "schedule", "workspace"]) {
      expect({ key, optional: byKey[key]?.optional }).toEqual({ key, optional: true });
    }
    expect(SOCIAL_LOCALIZATION_DEFINITION.requirements.filter((requirement) => !(requirement as { optional?: boolean }).optional)).toEqual([]);
  });

  it("keeps each connector family's bounds for when it is used", () => {
    expect(byKey.source).toMatchObject({ kind: "connector_resource", role: "source", min: 1, max: 20 });
    expect(byKey.destination).toMatchObject({ kind: "connector_resource", role: "destination", min: 1, max: 20 });
  });
});
