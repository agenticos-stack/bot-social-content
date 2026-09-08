/**
 * The Social Localization gadget's definition (TASK-205).
 *
 * design-plans/feature-social-localization-gadget-1.md, REQ-029 (governing):
 * "all blueprint-specific logic and domain data live in the blueprint archive
 * and the gadget's own facet storage… the API MUST NOT gain any table,
 * migration, route, service, event type, agent tool, or seeder branch whose
 * name or purpose is specific to this blueprint." This file is the one
 * permitted exception the plan names explicitly — the definition itself, plus
 * its presentation and blueprint-id join — because a gadget cannot be created,
 * listed, or drawn with no declaration of what it is at all.
 *
 * NOT BUILT FROM `format()` IN `formats.ts`, on purpose. That factory bakes in
 * a `source` sourceSnapshot, `review_state`/`proposals`/`outputs` collections,
 * and a generic "Send" action bound to the `workflow-run` catalog entry — the
 * shape of a document an owner revises and eventually sends. Social
 * Localization is not that: it has no source document, its review loop is the
 * Social Hub door's own approval surface (REQ-009/REQ-010), and declaring a
 * second "Send" here would be exactly the second post/dispatch lifecycle
 * REQ-009 forbids. So `actions` is empty and the declarative fields below are
 * a fallback only — see NOT AN OUTPUT FORMAT below for what draws instead.
 *
 * THE DECLARATIVE SHAPE IS A FALLBACK, NOT THE PRODUCT. Real content is code:
 * `client.js` renders the collection, editor, and poster the mockup shows, and
 * `server.js` is the facet those calls reach (TASK-201-203). This mirrors
 * `FORMAT_DASHBOARD_DEFINITION` in `formats.ts` — a single `richText` body a
 * declarative reader sees when code is unavailable, plus the capability
 * requirements a setup screen needs to walk. Everything that makes this a
 * localization tool — sources, batches, drafts, revisions, posters — lives in
 * the archive's own storage and is never expressed as declarative `fields`.
 *
 * NOT AN OUTPUT FORMAT (REQ-024, TASK-205). This definition is deliberately
 * NOT a member of `SHIPPED_FORMAT_DEFINITIONS` (`formats.ts`) and carries no
 * entry in `format-blueprints.ts`'s `DEFINITION_NOUNS`. Both are the
 * classification that makes a definition an "Outputs" grouping offer — a
 * blueprint an org's own document can join by producing the same generic
 * `output.id`. Social Localization produces nothing of that shape; it is a
 * standing tool an owner sets up once, not a document type. Its own
 * presentation lives in `definition-presentation.ts` instead (REQ-024), which
 * is a different, unconditional join every definition gets, format or not.
 *
 * DOOR REQUIREMENTS, AND THE FAMILY EXTENSION THEY NEEDED (REQ-002). A door
 * requirement has always named exactly one binding. Social Localization needs
 * 1 to 20 source connector bindings and 1 to 20 destination connector
 * bindings — a fixed slot per account does not represent a set an owner grows
 * over time, and the platform will not invent `source_1`..`source_20`. TASK-205
 * therefore added `min`/`max`/`role` to `GadgetBindingRequirementV1`
 * (`@agenticos-dev/bot-contract`) and taught `conversationConnections` in
 * `conversation-connections.ts` to project every requirement's bindings as a
 * list, keyed by requirementKey or `${requirementKey}:<slug>` for a family
 * member — every requirement written before this pair existed keeps meaning
 * exactly one, unchanged. `social`, `schedule` and `workspace` stay
 * single-binding, same as `workflow_authoring` and `meeting_record` today.
 */

import { GADGET_DEFINITION_SCHEMA } from "@agenticos-dev/bot-contract";

export const SOCIAL_LOCALIZATION_DEFINITION = {
  schemaVersion: GADGET_DEFINITION_SCHEMA,
  key: "social_localization",
  version: 1,
  title: "Social Content",
  runtimeTier: "declarative",
  distribution: "installed",
  requiresSetup: true,

  fields: [
    { key: "title", kind: "text", label: "Title" },
    { key: "brief", kind: "text", label: "Owner brief" },
    // The declarative fallback reader's whole body, same pattern as
    // FORMAT_DASHBOARD_DEFINITION's "summary" — real content is `client.js`.
    { key: "summary", kind: "richText", label: "Social Content" }
  ],

  // Governance-bearing state (batches, drafts, revisions, approvals) lives in
  // the archive's own SQLite storage (REQ-029/REQ-031), never here — so the
  // only mutable declarative paths are the owner's own words.
  mutable: ["title", "brief"],

  commands: ["state.set", "state.merge"],

  // Deliberately empty. REQ-009: "the gadget MUST NOT implement a second
  // post, target, schedule, approval, dispatcher, receipt or analytics
  // lifecycle." A generic "Send" action bound to a catalog entry unrelated to
  // the Social Hub door would be exactly that second lifecycle.
  actions: [],

  views: [
    {
      key: "localization",
      label: "Localization",
      layout: "full",
      widgets: [
        { id: "summary", type: "rich_text", title: "Social Content", binding: "summary" }
      ]
    }
  ],

  // 1 to 20 connector bindings per role (REQ-002/REQ-030), plus the three
  // single-binding doors every method in `doors.js` calls through: `social`
  // (Social Hub door, TASK-103), `schedule` (cadence, REQ-012), `workspace`
  // (notifications, TASK-104). None declares `optional`: a scan, a submit, or
  // a notify with the door ungranted is a real gap the gadget's own `doors.js`
  // already reports rather than pretending the capability exists.
  requirements: [
    {
      requirementKey: "source",
      kind: "connector_resource",
      role: "source",
      min: 1,
      max: 20,
      label: "Source accounts"
    },
    {
      requirementKey: "destination",
      kind: "connector_resource",
      role: "destination",
      min: 1,
      max: 20,
      label: "Destination channels"
    },
    { requirementKey: "social", kind: "capability", label: "Social Hub publisher" },
    { requirementKey: "schedule", kind: "capability", label: "Scan cadence" },
    { requirementKey: "workspace", kind: "capability", label: "Workspace notifications" }
    // NO `fetch` REQUIREMENT, DELIBERATELY.
    //
    // The door that reads a PUBLIC account exists (`FETCH_DOOR_KEY` in the
    // blueprint's `doors.js`) and an owner grants it from the doors panel,
    // which lists what COULD be granted rather than only what a requirement
    // names. It is not declared here because in this system a declared
    // requirement is ALWAYS required: `conversationConnections` computes
    // `required: requirement !== null` and never reads `optional`, so
    // declaring it — even with `optional: true`, which the contract validator
    // accepts — would put "Public account fetching" in 所需項目 and refuse to
    // open setup until every existing workspace granted a metered door it
    // does not use.
    //
    // "Not required" in this model means "a door no definition requirement
    // names", which is exactly what this is. `listOpenAccountPosts` treats an
    // absent `env.fetch` as "this workspace does not watch open accounts",
    // never as a fault.
  ]
} as const;
