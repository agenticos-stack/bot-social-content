import { refuse } from './door-certainty.mjs';

/**
 * The door half of the local runtime: consent and activation as separate
 * answers.
 *
 * `grant` records the owner's yes once, then starts the door. A grant that
 * saved but could not start returns `refresh_failed` (the API's own
 * `GrantRuntimeRefresh` vocabulary) instead of throwing. A failed grant keeps
 * its certainty: a refusal from `agent.grantDoor` stays refused, and anything
 * else stays unknown, because consent may already be saved.
 *
 * `activate` is also the recovery path for an unconfirmed grant: it re-reads
 * the platform's authoritative grant list and starts only a key listed there.
 * It never writes or broadens consent.
 *
 * `activateRuntime` is handed the requirement key it is being asked to bring
 * up, not just a force flag: a refresh that finishes without error only
 * proves the refresh ran, never that the requested door ended up in the
 * running spec (an unchanged, still-empty environment "finishes" too). The
 * caller uses the key to check the door is actually there and to report
 * `refresh_failed` — never `ready` — when it is not (F02a).
 */
export function createDoorRuntime({ agent, activateRuntime }) {
  return {
    grant: async (input, credential) => {
      const granted = await agent.grantDoor(input, credential);
      return { ...granted, runtime: await activateRuntime(false, granted.requirementKey) };
    },
    activate: async (input) => {
      const requirementKey = typeof input?.requirementKey === 'string' ? input.requirementKey : '';
      const listed = await agent.grantedDoorKeys();
      if (!Array.isArray(listed)) throw new Error('The platform grant list could not be read.');
      if (!listed.includes(requirementKey)) throw refuse('That permission has not been granted in this conversation.', 'not_granted');
      return { requirementKey, runtime: await activateRuntime(true, requirementKey) };
    }
  };
}
