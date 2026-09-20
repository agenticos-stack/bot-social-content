// Carousel frame recovery on the rail: correlated host answers, one pending
// action per frame, liveness, no silent refetch, and real API-shaped refusal
// codes. Deterministic fixture coverage only — not a browser or runtime proof.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createMediaRail } from "../../src/src/client/preview-media.js";
import { fetchMedia } from "../../src/doors.js";
import { findAll, flushAsyncWork, installMinimalDom } from "./_helpers/minimal-dom.js";

type Answer = { ok: false; code: string; message: string } | { bytes: number[] };
type HostAnswer = { outcome: string; message?: string | null };

function door(initial: Record<string, Answer>) {
  const answers = { ...initial };
  const asked: string[] = [];
  return {
    asked,
    answers,
    rpc: {
      getMedia: async (_itemId: string, mediaId: string) => {
        asked.push(mediaId);
        const answer = answers[mediaId];
        if (!answer) return { ok: false, code: "fetch_uncertain", message: "unknown" };
        if ("ok" in answer) return answer;
        return { mime: "image/jpeg", total: answer.bytes.length, chunk: 0, chunks: 1, bytes: answer.bytes };
      }
    } as never
  };
}

/** A host whose answer the test releases, like the owner deciding in a dialog. */
function deferredHost() {
  const calls: ((answer: HostAnswer) => void)[] = [];
  return {
    calls,
    ask: () => new Promise<HostAnswer>((resolve) => { calls.push(resolve); }),
    answer: (value: HostAnswer) => calls.shift()!(value)
  };
}

const JPEG = { bytes: [255, 216, 255, 217] };
const blocked = (code: string) => ({ ok: false as const, code, message: "Public account fetching is not granted for this workspace." });
const carousel = { id: "item-1", text: "a carousel", media: [{ id: "a", kind: "image" }, { id: "b", kind: "image" }, { id: "c", kind: "video" }] } as never;
const single = { id: "item-1", text: "one frame", media: [{ id: "a", kind: "image" }] } as never;

const texts = (node: unknown) =>
  findAll(node as never, () => true).map((e: { textContent?: string }) => e.textContent ?? "").join(" ");
type Clickable = { textContent: string; disabled?: boolean; dispatchEvent(event: unknown): void };
const buttons = (node: unknown) =>
  findAll(node as never, (e: { tagName?: string }) => e.tagName === "BUTTON") as unknown as Clickable[];
const click = (target: unknown) => (target as Clickable).dispatchEvent({ type: "click" });
const button = (node: unknown, label: string) => {
  const found = buttons(node).find((b) => b.textContent.includes(label));
  if (!found) throw new Error(`no button ${label}: ${texts(node)}`);
  return found;
};
/** One slot of the rail — where a frame's own refusal and action live. */
const slot = (rail: { node: unknown }, at: number) => (rail.node as { children: unknown[] }).children[at];
const statuses = (rail: { frameStates(): { status: string }[] }) => rail.frameStates().map((f) => f.status);

describe("carousel frame recovery", () => {
  beforeEach(() => { installMinimalDom(); });

  it("a blocked frame beside a loaded one: cancel fetches nothing, and an unrelated answer cannot retry it", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_permission_required") });
    const host = deferredHost();
    const rail = createMediaRail(d.rpc, carousel, "en", { requestGrant: host.ask });
    await flushAsyncWork();
    expect(texts(slot(rail, 1))).toContain("Permission needed for this frame");

    click(button(slot(rail, 1), "Allow public fetching"));
    await flushAsyncWork();
    expect(host.calls).toHaveLength(1);
    expect(button(slot(rail, 1), "Waiting for your answer").disabled).toBe(true);

    // Repeated clicks while waiting ask the host nothing more.
    click(button(slot(rail, 1), "Waiting for your answer"));
    await flushAsyncWork();
    expect(host.calls).toHaveLength(1);

    const asksBefore = d.asked.length;
    host.answer({ outcome: "cancelled" });
    await flushAsyncWork();
    expect(d.asked.length).toBe(asksBefore);
    expect(texts(slot(rail, 1))).not.toContain("Waiting for your answer");
    expect(texts(slot(rail, 1))).toContain("No permission was granted");
    // Frame c reads on show like every other slot; the door refused it.
    expect(statuses(rail)).toEqual(["held", "refused", "refused"]);
  });

  it("activation failed → retry activation → activated reads every permission-waiting frame", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_permission_required"), c: blocked("fetch_permission_required") });
    const grant = deferredHost();
    const activation = deferredHost();
    const rail = createMediaRail(d.rpc, carousel, "en", { requestGrant: grant.ask, requestActivation: activation.ask });
    await flushAsyncWork();
    click(button(slot(rail, 1), "Allow public fetching"));
    await flushAsyncWork();
    grant.answer({ outcome: "activation_failed", message: "runtime could not start" });
    await flushAsyncWork();
    expect(texts(slot(rail, 1))).toContain("Permission saved, fetching not started");

    d.answers.b = JPEG;
    d.answers.c = JPEG;
    d.asked.length = 0;
    click(button(slot(rail, 1), "Retry activation"));
    await flushAsyncWork();
    expect(d.asked).toEqual([]); // nothing is read before the runtime confirms
    activation.answer({ outcome: "activated" });
    await flushAsyncWork();
    // One answer opens the door for every frame still waiting on permission —
    // the grant was for the surface, not for the one slot the owner pressed.
    expect(d.asked.sort()).toEqual(["b", "c"]);
    expect(statuses(rail)).toEqual(["held", "held", "held"]);
    expect(d.asked.length).toBe(2);

    await flushAsyncWork();
    expect(d.asked.length).toBe(2); // held frames are never re-read
  });

  it("a rejected or unconfirmed activation stays visible and reads nothing", async () => {
    const d = door({ a: blocked("fetch_activation_failed") });
    let calls = 0;
    const rail = createMediaRail(d.rpc, single, "en", {
      requestActivation: async () => { calls += 1; throw new Error("host unreachable"); }
    });
    await flushAsyncWork();
    d.asked.length = 0;
    click(button(rail.node, "Retry activation"));
    await flushAsyncWork();
    expect(calls).toBe(1);
    expect(d.asked).toEqual([]);
    // Unconfirmed is not "permission saved": the owner is told it is unknown.
    expect(texts(rail.node)).toContain("Could not confirm the permission");
    expect(texts(rail.node)).toContain("It is not known whether the permission was saved");
    expect(texts(rail.node)).not.toContain("Permission saved, fetching not started");
    expect(button(rail.node, "Retry activation").disabled).toBe(false);
  });

  it("closing the drawer during recovery starts no read when the answer arrives", async () => {
    const d = door({ a: blocked("fetch_activation_failed") });
    const activation = deferredHost();
    const rail = createMediaRail(d.rpc, single, "en", { requestActivation: activation.ask });
    await flushAsyncWork();
    click(button(rail.node, "Retry activation"));
    await flushAsyncWork();
    rail.dispose();
    d.asked.length = 0;
    activation.answer({ outcome: "activated" });
    await flushAsyncWork();
    expect(d.asked).toEqual([]);
  });

  it("a busy or denied answer explains itself without reading", async () => {
    for (const [outcome, sentence] of [["busy", "Another permission request is still open"], ["denied", "not granted"]]) {
      const d = door({ a: blocked("fetch_permission_required") });
      const host = deferredHost();
      const rail = createMediaRail(d.rpc, single, "en", { requestGrant: host.ask });
      await flushAsyncWork();
      d.asked.length = 0;
      click(button(rail.node, "Allow public fetching"));
      await flushAsyncWork();
      host.answer({ outcome });
      await flushAsyncWork();
      expect(d.asked).toEqual([]);
      expect(texts(rail.node)).toContain(sentence);
    }
  });

  it("an activation on one slot never re-reads a frame refused for another reason", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_transient"), c: blocked("fetch_permission_required") });
    const grant = deferredHost();
    const rail = createMediaRail(d.rpc, carousel, "en", { requestGrant: grant.ask });
    await flushAsyncWork();
    expect(d.asked).toEqual(["a", "b", "c"]);

    d.answers.c = JPEG;
    click(button(slot(rail, 2), "Allow public fetching"));
    await flushAsyncWork();
    grant.answer({ outcome: "activated" });
    await flushAsyncWork();
    // Propagation opens permission-waiting frames only: b's refusal is about
    // the transport, not the door, and stays exactly where the owner left it.
    expect(d.asked).toEqual(["a", "b", "c", "c"]);
    expect(statuses(rail)).toEqual(["held", "refused", "held"]);
  });

  it("labels a video frame as a cover image that was not played", async () => {
    const rail = createMediaRail(door({ c: JPEG }).rpc, { id: "v", text: "reel", media: [{ id: "c", kind: "video" }] } as never, "en");
    await flushAsyncWork();
    expect(texts(rail.node)).toContain("cover image only, not played");
  });

  // F2: Studio's own access popover can grant or revoke `metered_fetch`
  // while this drawer is already open, showing a permission-refused frame.
  // Nothing in this file's normal flow tells the frame about that — these
  // cases are the caller's fresh `metered_fetch` read, handed to the rail
  // as `notifyPermission({ state })` (client.js's job — see the
  // "onDoorsChanged" describe block below — is to notice the host's
  // unprompted `gadget:doors-changed` message, then re-read consent itself
  // rather than trust what the notice merely says was attempted; see
  // grant-request.test.ts for the message parsing).
  it("a stuck frame — waiting on a grant answer that will never arrive because it was granted elsewhere — becomes actionable again once the read finds it granted", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    const host = deferredHost(); // never answered: the owner used Studio's popover instead
    const rail = createMediaRail(d.rpc, single, "en", { requestGrant: host.ask });
    await flushAsyncWork();
    click(button(rail.node, "Allow public fetching"));
    await flushAsyncWork();
    expect(button(rail.node, "Waiting for your answer").disabled).toBe(true);
    d.asked.length = 0;

    rail.notifyPermission({ state: "granted" });
    await flushAsyncWork();

    // Unstuck, but NOT auto-fetched: the owner's own next press reads once.
    expect(d.asked).toEqual([]);
    expect(texts(rail.node)).toContain("Permission updated in Studio");
    expect(button(rail.node, "Check again").disabled).toBe(false);
  });

  it("an idle permission-needed frame stays actionable (not auto-fetched) once a read finds it granted", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    const rail = createMediaRail(d.rpc, single, "en", { requestGrant: deferredHost().ask });
    await flushAsyncWork();
    d.asked.length = 0;

    rail.notifyPermission({ state: "granted" });
    await flushAsyncWork();

    expect(d.asked).toEqual([]);
    expect(texts(rail.node)).not.toContain("Permission needed for this frame");
    expect(texts(rail.node)).toContain("Permission updated in Studio");

    // Only the owner's check reads the frame, exactly once.
    d.answers.a = JPEG;
    click(button(rail.node, "Check again"));
    await flushAsyncWork();
    expect(d.asked).toEqual(["a"]);
  });

  it("a successful revoke — read finds consent absent — drops activation and offers the grant again", async () => {
    const d = door({ a: blocked("fetch_activation_failed") });
    const rail = createMediaRail(d.rpc, single, "en", { requestActivation: deferredHost().ask });
    await flushAsyncWork();
    expect(button(rail.node, "Retry activation").disabled).toBe(false);
    d.asked.length = 0;

    rail.notifyPermission({ state: "absent" });
    await flushAsyncWork();
    expect(buttons(rail.node).some((candidate) => candidate.textContent.includes("Retry activation"))).toBe(false);
    expect(texts(rail.node)).toContain("Permission needed for this frame");
    expect(button(rail.node, "Allow public fetching").disabled).toBe(false);

    rail.notifyPermission({ state: "granted" });
    await flushAsyncWork();
    expect(button(rail.node, "Check again").disabled).toBe(false);
    expect(d.asked).toEqual([]); // still nothing read automatically
  });

  it("a revoke ATTEMPT that failed or was lost, with consent still live, does not read as permission needed", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    const rail = createMediaRail(d.rpc, single, "en", { requestGrant: deferredHost().ask });
    await flushAsyncWork();
    d.asked.length = 0;

    // The host notice named "revoke" as the operation it tried; the read is
    // the authority, and it found the grant still live.
    rail.notifyPermission({ state: "granted" });
    await flushAsyncWork();

    expect(texts(rail.node)).not.toContain("Permission needed for this frame");
    expect(texts(rail.node)).toContain("Permission updated in Studio");
    expect(d.asked).toEqual([]);
  });

  it("an unreadable metadata read shows an unconfirmed state with an explicit recheck, and a later successful recheck applies its result", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    let recheckCalls = 0;
    const rail = createMediaRail(d.rpc, single, "en", {
      requestGrant: deferredHost().ask,
      recheckPermission: async () => { recheckCalls += 1; return { state: "granted" }; }
    });
    await flushAsyncWork();
    d.asked.length = 0;

    rail.notifyPermission({ state: "unknown" });
    await flushAsyncWork();
    expect(texts(rail.node)).toContain("Could not confirm this frame's permission");
    expect(d.asked).toEqual([]);

    click(button(rail.node, "Check again"));
    await flushAsyncWork();

    expect(recheckCalls).toBe(1);
    expect(d.asked).toEqual([]); // the recheck itself is metadata-only, never getMedia
    expect(texts(rail.node)).toContain("Permission updated in Studio");
    expect(button(rail.node, "Check again").disabled).toBe(false);
  });

  it("a metadata read that stays unreadable leaves the frame available to recheck again, never getMedia", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    const rail = createMediaRail(d.rpc, single, "en", {
      requestGrant: deferredHost().ask,
      recheckPermission: async () => { throw new Error("metadata read failed"); }
    });
    await flushAsyncWork();
    d.asked.length = 0;

    rail.notifyPermission({ state: "unknown" });
    await flushAsyncWork();
    click(button(rail.node, "Check again"));
    await flushAsyncWork();

    expect(d.asked).toEqual([]);
    expect(texts(rail.node)).toContain("Could not confirm this frame's permission");
    expect(button(rail.node, "Check again").disabled).toBe(false);
  });

  it("leaves a non-permission refusal (a transient or stale-source refusal) alone", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_transient") });
    const rail = createMediaRail(d.rpc, carousel, "en");
    await flushAsyncWork();
    expect(button(slot(rail, 1), "Try again")).toBeDefined();

    rail.notifyPermission({ state: "absent" });
    await flushAsyncWork();
    // Unaffected: this refusal has nothing to do with `metered_fetch` consent.
    expect(button(slot(rail, 1), "Try again").disabled).toBe(false);
  });

  it("touches only the refused permission frame's own action state — a held frame and the other slots stay exactly as they were", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_permission_required") });
    const rail = createMediaRail(d.rpc, carousel, "en", { requestGrant: deferredHost().ask });
    await flushAsyncWork();
    d.asked.length = 0;
    const slotZeroBefore = texts(slot(rail, 0));
    const slotTwoBefore = texts(slot(rail, 2));

    rail.notifyPermission({ state: "granted" });
    await flushAsyncWork();

    expect(d.asked).toEqual([]); // the already-held frame is not re-read
    expect(statuses(rail)).toEqual(["held", "refused", "refused"]); // no status changed, only its action did
    expect(texts(slot(rail, 0))).toBe(slotZeroBefore); // the held slot is unchanged
    expect(texts(slot(rail, 2))).toBe(slotTwoBefore); // and so is the unrelated one
  });

  it("does nothing once the rail is disposed", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    const rail = createMediaRail(d.rpc, single, "en", { requestGrant: deferredHost().ask });
    await flushAsyncWork();
    rail.dispose();
    expect(() => rail.notifyPermission({ state: "granted" })).not.toThrow();
  });

  it("an expired media link offers a deliberate source refresh, not a retry loop", async () => {
    const d = door({ a: blocked("reference_media_stale") });
    let refreshes = 0;
    const rail = createMediaRail(d.rpc, single, "en", { refreshSources: async () => { refreshes += 1; d.answers.a = JPEG; } });
    await flushAsyncWork();
    expect(texts(rail.node)).toContain("does not mean the post was deleted");
    expect(d.asked).toEqual(["a"]);
    click(button(rail.node, "Refresh sources"));
    await flushAsyncWork();
    expect(refreshes).toBe(1);
    expect(statuses(rail)[0]).toBe("held");
  });
});

// client.js's `onDoorsChanged` — the handler for the host's unprompted
// `gadget:doors-changed` notice — extracted UNCHANGED from its own source,
// the same technique drawer-session.test.ts uses for other client handlers.
// It owns the metadata-only read and the out-of-order sequencing; the rail
// tests above only cover what happens once it hands a rail `{ state }`.
describe("onDoorsChanged (client.js notice handler)", () => {
  const clientSource = readFileSync(new URL("../../src/src/client/client.js", import.meta.url), "utf8");

  // The real read/commit block from client.js: onDoorsChanged, the owner recheck,
  // the consent reader and the ordered summary read that writes shared state.
  function extractPermissionBlock(scope: Record<string, unknown>) {
    const start = clientSource.indexOf("  async function onDoorsChanged()");
    const end = clientSource.indexOf("  function askHost(", start);
    if (start < 0 || end <= start) throw new Error("client.js extraction boundary changed for the permission read block");
    return new Function(
      "scope",
      `with(scope){${clientSource.slice(start, end)}; return { onDoorsChanged, recheckMeteredFetchConsent };}`
    )(scope) as { onDoorsChanged: () => Promise<void>; recheckMeteredFetchConsent: () => Promise<{ state: string }> };
  }

  /** Controlled summary RPC: each call waits until the test settles it. */
  function permissionHarness() {
    const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
    const notified: string[] = [];
    let mediaReads = 0;
    const initialPolicy = { cadence: "daily" };
    const scope: Record<string, unknown> = {
      summary: { doors: { metered_fetch: false }, config: initialPolicy },
      policy: initialPolicy,
      summaryReadSeq: 0,
      liveMediaRails: new Set([{ notifyPermission: ({ state }: { state: string }) => notified.push(state) }]),
      console: { error() {} },
      rpc: {
        summary: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
        getMedia: () => { mediaReads += 1; }
      }
    };
    const block = extractPermissionBlock(scope);
    const snapshot = (granted: boolean, cadence: string) => ({ doors: { metered_fetch: granted }, config: { cadence } });
    return {
      ...block,
      scope,
      notified,
      pending,
      snapshot,
      mediaReads: () => mediaReads,
      // What Settings renders: runSetup passes Boolean(summary?.doors?.metered_fetch).
      settingsFetchGranted: () => Boolean((scope.summary as { doors?: { metered_fetch?: boolean } })?.doors?.metered_fetch)
    };
  }

  it("Settings derives fetchGranted from the same shared summary this block commits", () => {
    expect(clientSource).toContain("Boolean(summary?.doors?.metered_fetch),");
  });

  it("A: an older absent read resolving after a newer granted read changes neither the panel nor Settings", async () => {
    const h = permissionHarness();
    const olderA = h.onDoorsChanged();
    const newerB = h.onDoorsChanged();
    h.pending[1].resolve(h.snapshot(true, "newer"));
    await newerB;
    h.pending[0].resolve(h.snapshot(false, "older"));
    await olderA;

    expect(h.notified).toEqual(["granted"]);
    expect(h.settingsFetchGranted()).toBe(true);
    expect((h.scope.policy as { cadence: string }).cadence).toBe("newer");
    expect(h.mediaReads()).toBe(0);
  });

  it("B: an older granted read resolving after a newer absent read cannot restore granted UI", async () => {
    const h = permissionHarness();
    const olderA = h.onDoorsChanged();
    const newerB = h.onDoorsChanged();
    h.pending[1].resolve(h.snapshot(false, "newer"));
    await newerB;
    h.pending[0].resolve(h.snapshot(true, "older"));
    await olderA;

    expect(h.notified).toEqual(["absent"]);
    expect(h.settingsFetchGranted()).toBe(false);
    expect((h.scope.policy as { cadence: string }).cadence).toBe("newer");
    expect(h.mediaReads()).toBe(0);
  });

  it("C: an older failure resolving after a newer success does not downgrade to unknown", async () => {
    const h = permissionHarness();
    const olderA = h.onDoorsChanged();
    const newerB = h.onDoorsChanged();
    h.pending[1].resolve(h.snapshot(true, "newer"));
    await newerB;
    h.pending[0].reject(new Error("late summary failure"));
    await olderA;

    expect(h.notified).toEqual(["granted"]);
    expect(h.settingsFetchGranted()).toBe(true);
    expect((h.scope.policy as { cadence: string }).cadence).toBe("newer");
  });

  it("D: a current failed read is unconfirmed, keeps the last committed state, and the owner recheck recovers both panel and Settings", async () => {
    const h = permissionHarness();
    const failing = h.onDoorsChanged();
    h.pending[0].reject(new Error("summary unreachable"));
    await failing;
    expect(h.notified).toEqual(["unknown"]);
    expect(h.settingsFetchGranted()).toBe(false); // unchanged, not an invented denial or grant
    expect((h.scope.policy as { cadence: string }).cadence).toBe("daily");

    const recheck = h.recheckMeteredFetchConsent();
    expect(h.pending).toHaveLength(2); // one metadata read, nothing else
    h.pending[1].resolve(h.snapshot(true, "rechecked"));
    await expect(recheck).resolves.toEqual({ state: "granted" });
    expect(h.settingsFetchGranted()).toBe(true);
    expect((h.scope.policy as { cadence: string }).cadence).toBe("rechecked");
    expect(h.mediaReads()).toBe(0);
  });

  it("E: an owner recheck overtaken by a newer host notice reports the committed newer state, and panel and Settings agree", async () => {
    const h = permissionHarness();
    const recheck = h.recheckMeteredFetchConsent(); // older
    const notice = h.onDoorsChanged(); // newer
    h.pending[1].resolve(h.snapshot(false, "notice"));
    await notice;
    h.pending[0].resolve(h.snapshot(true, "recheck"));

    await expect(recheck).resolves.toEqual({ state: "absent" });
    expect(h.notified).toEqual(["absent"]);
    expect(h.settingsFetchGranted()).toBe(false);
    expect((h.scope.policy as { cadence: string }).cadence).toBe("notice");
    expect(h.mediaReads()).toBe(0);
  });
});

describe("fetchMedia outcome codes follow the platform's structured reason", () => {
  const media = { id: "m", kind: "image", url: "https://cdn.example/m.jpg" };
  const withDoor = (response: unknown) => ({ metered_fetch: { fetch_media: async () => response } });

  it("reads consent from the runtime projection, not from the door's absence", async () => {
    expect(await fetchMedia({ __consent: { metered_fetch: false } }, "open:x", media, "preview", "open")).toMatchObject({ code: "fetch_permission_required" });
    expect(await fetchMedia({ __consent: { metered_fetch: true } }, "open:x", media, "preview", "open")).toMatchObject({ code: "fetch_activation_failed" });
    expect(await fetchMedia({}, "open:x", media, "preview", "open")).toMatchObject({ code: "fetch_uncertain" });
  });

  it("maps API reason codes, including the older outcome-as-code shape", async () => {
    const cases: [unknown, string][] = [
      [{ ok: false, code: "media_url_gone", outcome: "failed_safe", message: "The media host answered with status 404." }, "reference_media_stale"],
      [{ ok: false, code: "network", outcome: "unknown", message: "The media host did not respond." }, "fetch_uncertain"],
      [{ ok: false, code: "timeout", outcome: "failed_safe", message: "The media host did not respond in time." }, "fetch_transient"],
      [{ ok: false, code: "upstream_error", outcome: "failed_safe", message: "status 503" }, "fetch_transient"],
      [{ ok: false, code: "host_not_allowed", outcome: "failed_safe", message: "not an allowed host" }, "media_unusable"],
      // Today's API sends the outcome as the code.
      [{ ok: false, code: "unknown", message: "The media host did not respond." }, "fetch_uncertain"],
      [{ ok: false, code: "failed_safe", message: "The media host answered with status 404." }, "fetch_transient"]
    ];
    for (const [response, expected] of cases) {
      expect(await fetchMedia(withDoor(response), "open:x", media, "preview", "open")).toMatchObject({ code: expected });
    }
    const throwing = { metered_fetch: { fetch_media: async () => { throw new Error("socket closed"); } } };
    expect(await fetchMedia(throwing, "open:x", media, "preview", "open")).toMatchObject({ code: "fetch_transient" });
  });
});
