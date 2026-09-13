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
  it("opens without connected sources, destinations, the publisher or public fetching", () => {
    for (const key of ["source", "destination", "social", "metered_fetch"]) {
      expect({ key, optional: byKey[key]?.optional }).toEqual({ key, optional: true });
    }
  });

  it("still requires the capabilities setup can grant without any connection", () => {
    for (const key of ["schedule", "workspace"]) {
      expect({ key, optional: byKey[key]?.optional }).toEqual({ key, optional: undefined });
    }
  });

  it("keeps each connector family's bounds for when it is used", () => {
    expect(byKey.source).toMatchObject({ kind: "connector_resource", role: "source", min: 1, max: 20 });
    expect(byKey.destination).toMatchObject({ kind: "connector_resource", role: "destination", min: 1, max: 20 });
  });
});
