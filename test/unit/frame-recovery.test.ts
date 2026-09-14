// Carousel frame recovery: correlated host answers, one pending action per
// frame, liveness, no silent refetch, and real API-shaped refusal codes.
// Deterministic fixture coverage only — not a browser or runtime proof.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createMediaStage } from "../../src/src/client/preview-media.js";
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

const texts = (node: unknown) =>
  findAll(node as never, () => true).map((e: { textContent?: string }) => e.textContent ?? "").join(" ");
type Clickable = { textContent: string; disabled?: boolean; dispatchEvent(event: unknown): void };
const buttons = (node: unknown) =>
  findAll(node as never, (e: { tagName?: string }) => e.tagName === "BUTTON") as unknown as Clickable[];
const click = (target: unknown) => (target as Clickable).dispatchEvent({ type: "click" });
const frameTab = (stage: { strip: unknown }, at: number) => click((stage.strip as { children: unknown[] }).children[at]);
const button = (node: unknown, label: string) => {
  const found = buttons(node).find((b) => b.textContent.includes(label));
  if (!found) throw new Error(`no button ${label}: ${texts(node)}`);
  return found;
};
const statuses = (stage: { frameStates(): { status: string }[] }) => stage.frameStates().map((f) => f.status);

describe("carousel frame recovery", () => {
  beforeEach(() => { installMinimalDom(); });

  it("a blocked later frame beside a loaded first one: cancel fetches nothing, and an unrelated answer cannot retry it", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_permission_required") });
    const host = deferredHost();
    const stage = createMediaStage(d.rpc, carousel, "en", { requestGrant: host.ask });
    await flushAsyncWork();
    frameTab(stage, 1);
    await flushAsyncWork();
    expect(texts(stage.node)).toContain("Permission needed for this frame");

    click(button(stage.node, "Allow public fetching"));
    await flushAsyncWork();
    expect(host.calls).toHaveLength(1);
    expect(button(stage.node, "Waiting for your answer").disabled).toBe(true);

    // Repeated clicks while waiting ask the host nothing more.
    click(button(stage.node, "Waiting for your answer"));
    await flushAsyncWork();
    expect(host.calls).toHaveLength(1);

    const asksBefore = d.asked.length;
    host.answer({ outcome: "cancelled" });
    await flushAsyncWork();
    expect(d.asked.length).toBe(asksBefore);
    expect(texts(stage.node)).not.toContain("Waiting for your answer");
    expect(texts(stage.node)).toContain("No permission was granted");
    expect(statuses(stage)).toEqual(["held", "refused", "unread"]);
  });

  it("activation failed → retry activation → activated reads only the intended frame", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_permission_required") });
    const grant = deferredHost();
    const activation = deferredHost();
    const stage = createMediaStage(d.rpc, carousel, "en", { requestGrant: grant.ask, requestActivation: activation.ask });
    await flushAsyncWork();
    frameTab(stage, 1);
    await flushAsyncWork();
    click(button(stage.node, "Allow public fetching"));
    await flushAsyncWork();
    grant.answer({ outcome: "activation_failed", message: "runtime could not start" });
    await flushAsyncWork();
    expect(texts(stage.node)).toContain("Permission saved, fetching not started");

    d.answers.b = JPEG;
    d.asked.length = 0;
    click(button(stage.node, "Retry activation"));
    await flushAsyncWork();
    expect(d.asked).toEqual([]); // nothing is read before the runtime confirms
    activation.answer({ outcome: "activated" });
    await flushAsyncWork();
    expect(d.asked).toEqual(["b"]);
    expect(statuses(stage)).toEqual(["held", "held", "unread"]);
    expect(texts(stage.node)).toContain("2 of 3 frames loaded");

    frameTab(stage, 0);
    frameTab(stage, 1);
    await flushAsyncWork();
    expect(d.asked).toEqual(["b"]);
  });

  it("a rejected or unconfirmed activation stays visible and reads nothing", async () => {
    const d = door({ a: blocked("fetch_activation_failed") });
    let calls = 0;
    const stage = createMediaStage(d.rpc, carousel, "en", {
      requestActivation: async () => { calls += 1; throw new Error("host unreachable"); }
    });
    await flushAsyncWork();
    d.asked.length = 0;
    click(button(stage.node, "Retry activation"));
    await flushAsyncWork();
    expect(calls).toBe(1);
    expect(d.asked).toEqual([]);
    // Unconfirmed is not "permission saved": the owner is told it is unknown.
    expect(texts(stage.node)).toContain("Could not confirm the permission");
    expect(texts(stage.node)).toContain("It is not known whether the permission was saved");
    expect(texts(stage.node)).not.toContain("Permission saved, fetching not started");
    expect(button(stage.node, "Retry activation").disabled).toBe(false);
  });

  it("closing the drawer during recovery starts no read when the answer arrives", async () => {
    const d = door({ a: blocked("fetch_activation_failed") });
    const activation = deferredHost();
    const stage = createMediaStage(d.rpc, carousel, "en", { requestActivation: activation.ask });
    await flushAsyncWork();
    click(button(stage.node, "Retry activation"));
    await flushAsyncWork();
    stage.dispose();
    d.asked.length = 0;
    activation.answer({ outcome: "activated" });
    await flushAsyncWork();
    expect(d.asked).toEqual([]);
  });

  it("a busy or denied answer explains itself without reading", async () => {
    for (const [outcome, sentence] of [["busy", "Another permission request is still open"], ["denied", "not granted"]]) {
      const d = door({ a: blocked("fetch_permission_required") });
      const host = deferredHost();
      const stage = createMediaStage(d.rpc, carousel, "en", { requestGrant: host.ask });
      await flushAsyncWork();
      d.asked.length = 0;
      click(button(stage.node, "Allow public fetching"));
      await flushAsyncWork();
      host.answer({ outcome });
      await flushAsyncWork();
      expect(d.asked).toEqual([]);
      expect(texts(stage.node)).toContain(sentence);
    }
  });

  it("a refused frame is not re-read by navigating away and back", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_transient") });
    const stage = createMediaStage(d.rpc, carousel, "en");
    await flushAsyncWork();
    frameTab(stage, 1);
    await flushAsyncWork();
    frameTab(stage, 0);
    frameTab(stage, 1);
    await flushAsyncWork();
    expect(d.asked.filter((id) => id === "b")).toHaveLength(1);
  });

  it("labels a video frame as a cover image that was not played", async () => {
    const stage = createMediaStage(door({ c: JPEG }).rpc, { id: "v", text: "reel", media: [{ id: "c", kind: "video" }] } as never, "en");
    await flushAsyncWork();
    expect(texts(stage.node)).toContain("cover image only, not played");
  });

  // F2: Studio's own access popover can grant or revoke `metered_fetch`
  // while this drawer is already open, showing a permission-refused frame.
  // Nothing in this file's normal flow tells the frame about that — these
  // cases are the caller's fresh `metered_fetch` read, handed to the stage
  // as `notifyPermission({ state })` (client.js's job — see the
  // "onDoorsChanged" describe block below — is to notice the host's
  // unprompted `gadget:doors-changed` message, then re-read consent itself
  // rather than trust what the notice merely says was attempted; see
  // grant-request.test.ts for the message parsing).
  it("a stuck frame — waiting on a grant answer that will never arrive because it was granted elsewhere — becomes actionable again once the read finds it granted", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    const host = deferredHost(); // never answered: the owner used Studio's popover instead
    const stage = createMediaStage(d.rpc, carousel, "en", { requestGrant: host.ask });
    await flushAsyncWork();
    click(button(stage.node, "Allow public fetching"));
    await flushAsyncWork();
    expect(button(stage.node, "Waiting for your answer").disabled).toBe(true);
    d.asked.length = 0;

    stage.notifyPermission({ state: "granted" });
    await flushAsyncWork();

    // Unstuck, but NOT auto-fetched: the owner's own next press reads once.
    expect(d.asked).toEqual([]);
    expect(texts(stage.node)).toContain("Permission updated in Studio");
    expect(button(stage.node, "Check again").disabled).toBe(false);
  });

  it("an idle permission-needed frame stays actionable (not auto-fetched) once a read finds it granted", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    const stage = createMediaStage(d.rpc, carousel, "en", { requestGrant: deferredHost().ask });
    await flushAsyncWork();
    d.asked.length = 0;

    stage.notifyPermission({ state: "granted" });
    await flushAsyncWork();

    expect(d.asked).toEqual([]);
    expect(texts(stage.node)).not.toContain("Permission needed for this frame");
    expect(texts(stage.node)).toContain("Permission updated in Studio");

    // Only the owner's check reads the frame, exactly once.
    d.answers.a = JPEG;
    click(button(stage.node, "Check again"));
    await flushAsyncWork();
    expect(d.asked).toEqual(["a"]);
  });

  it("a successful revoke — read finds consent absent — drops activation and offers the grant again", async () => {
    const d = door({ a: blocked("fetch_activation_failed") });
    const stage = createMediaStage(d.rpc, carousel, "en", { requestActivation: deferredHost().ask });
    await flushAsyncWork();
    expect(button(stage.node, "Retry activation").disabled).toBe(false);
    d.asked.length = 0;

    stage.notifyPermission({ state: "absent" });
    await flushAsyncWork();
    expect(buttons(stage.node).some((candidate) => candidate.textContent.includes("Retry activation"))).toBe(false);
    expect(texts(stage.node)).toContain("Permission needed for this frame");
    expect(button(stage.node, "Allow public fetching").disabled).toBe(false);

    stage.notifyPermission({ state: "granted" });
    await flushAsyncWork();
    expect(button(stage.node, "Check again").disabled).toBe(false);
    expect(d.asked).toEqual([]); // still nothing read automatically
  });

  it("a revoke ATTEMPT that failed or was lost, with consent still live, does not read as permission needed", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    const stage = createMediaStage(d.rpc, carousel, "en", { requestGrant: deferredHost().ask });
    await flushAsyncWork();
    d.asked.length = 0;

    // The host notice named "revoke" as the operation it tried; the read is
    // the authority, and it found the grant still live.
    stage.notifyPermission({ state: "granted" });
    await flushAsyncWork();

    expect(texts(stage.node)).not.toContain("Permission needed for this frame");
    expect(texts(stage.node)).toContain("Permission updated in Studio");
    expect(d.asked).toEqual([]);
  });

  it("an unreadable metadata read shows an unconfirmed state with an explicit recheck, and a later successful recheck applies its result", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    let recheckCalls = 0;
    const stage = createMediaStage(d.rpc, carousel, "en", {
      requestGrant: deferredHost().ask,
      recheckPermission: async () => { recheckCalls += 1; return { state: "granted" }; }
    });
    await flushAsyncWork();
    d.asked.length = 0;

    stage.notifyPermission({ state: "unknown" });
    await flushAsyncWork();
    expect(texts(stage.node)).toContain("Could not confirm this frame's permission");
    expect(d.asked).toEqual([]);

    click(button(stage.node, "Check again"));
    await flushAsyncWork();

    expect(recheckCalls).toBe(1);
    expect(d.asked).toEqual([]); // the recheck itself is metadata-only, never getMedia
    expect(texts(stage.node)).toContain("Permission updated in Studio");
    expect(button(stage.node, "Check again").disabled).toBe(false);
  });

  it("a metadata read that stays unreadable leaves the frame available to recheck again, never getMedia", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    const stage = createMediaStage(d.rpc, carousel, "en", {
      requestGrant: deferredHost().ask,
      recheckPermission: async () => { throw new Error("metadata read failed"); }
    });
    await flushAsyncWork();
    d.asked.length = 0;

    stage.notifyPermission({ state: "unknown" });
    await flushAsyncWork();
    click(button(stage.node, "Check again"));
    await flushAsyncWork();

    expect(d.asked).toEqual([]);
    expect(texts(stage.node)).toContain("Could not confirm this frame's permission");
    expect(button(stage.node, "Check again").disabled).toBe(false);
  });

  it("leaves a non-permission refusal (a transient or stale-source refusal) alone", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_transient") });
    const stage = createMediaStage(d.rpc, carousel, "en");
    await flushAsyncWork();
    frameTab(stage, 1);
    await flushAsyncWork();
    expect(button(stage.node, "Try again")).toBeDefined();

    stage.notifyPermission({ state: "absent" });
    await flushAsyncWork();
    // Unaffected: this refusal has nothing to do with `metered_fetch` consent.
    expect(button(stage.node, "Try again").disabled).toBe(false);
  });

  it("touches only the refused permission frame's own action state — a held frame, the selection and the strip stay exactly as they were", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_permission_required") });
    const stage = createMediaStage(d.rpc, carousel, "en", { requestGrant: deferredHost().ask });
    await flushAsyncWork();
    frameTab(stage, 1); // select the refused frame
    await flushAsyncWork();
    d.asked.length = 0;
    const selectedBefore = (stage.strip as { children: { getAttribute(name: string): string | null }[] }).children.map(
      (child) => child.getAttribute("aria-selected")
    );

    stage.notifyPermission({ state: "granted" });
    await flushAsyncWork();

    expect(d.asked).toEqual([]); // the already-held frame is not re-read
    expect(statuses(stage)).toEqual(["held", "refused", "unread"]); // no status changed, only its action did
    expect(
      (stage.strip as { children: { getAttribute(name: string): string | null }[] }).children.map((child) =>
        child.getAttribute("aria-selected")
      )
    ).toEqual(selectedBefore); // the selected frame is unchanged
  });

  it("does nothing once the stage is disposed", async () => {
    const d = door({ a: blocked("fetch_permission_required") });
    const stage = createMediaStage(d.rpc, carousel, "en", { requestGrant: deferredHost().ask });
    await flushAsyncWork();
    stage.dispose();
    expect(() => stage.notifyPermission({ state: "granted" })).not.toThrow();
  });

  it("an expired media link offers a deliberate source refresh, not a retry loop", async () => {
    const d = door({ a: blocked("reference_media_stale") });
    let refreshes = 0;
    const stage = createMediaStage(d.rpc, carousel, "en", { refreshSources: async () => { refreshes += 1; d.answers.a = JPEG; } });
    await flushAsyncWork();
    expect(texts(stage.node)).toContain("does not mean the post was deleted");
    expect(d.asked).toEqual(["a"]);
    click(button(stage.node, "Refresh sources"));
    await flushAsyncWork();
    expect(refreshes).toBe(1);
    expect(statuses(stage)[0]).toBe("held");
  });
});

// client.js's `onDoorsChanged` — the handler for the host's unprompted
// `gadget:doors-changed` notice — extracted UNCHANGED from its own source,
// the same technique drawer-session.test.ts uses for other client handlers.
// It owns the metadata-only read and the out-of-order sequencing; the stage
// tests above only cover what happens once it hands a stage `{ state }`.
describe("onDoorsChanged (client.js notice handler)", () => {
  const clientSource = readFileSync(new URL("../../src/src/client/client.js", import.meta.url), "utf8");

  function extractOnDoorsChanged(scope: Record<string, unknown>) {
    const start = clientSource.indexOf("  async function onDoorsChanged()");
    const end = clientSource.indexOf("  function askHost(", start);
    if (start < 0 || end <= start) throw new Error("client.js extraction boundary changed for onDoorsChanged");
    return new Function("scope", `with(scope){${clientSource.slice(start, end)}; return onDoorsChanged;}`)(scope) as () => Promise<void>;
  }

  it("re-reads metadata and reports the read's outcome, not the reason a notice never carries", async () => {
    const notified: { state: string }[] = [];
    const stage = { notifyPermission: (payload: { state: string }) => notified.push(payload) };
    const scope: Record<string, unknown> = {
      permissionReadSeq: 0,
      liveMediaStages: new Set([stage]),
      console,
      refreshSummary: async () => ({ doors: { metered_fetch: true } })
    };
    await extractOnDoorsChanged(scope)();
    expect(notified).toEqual([{ state: "granted" }]);
  });

  it("reports unknown, not absent, when the metadata read fails", async () => {
    const notified: { state: string }[] = [];
    const stage = { notifyPermission: (payload: { state: string }) => notified.push(payload) };
    const scope: Record<string, unknown> = {
      permissionReadSeq: 0,
      liveMediaStages: new Set([stage]),
      console: { error() {} },
      refreshSummary: async () => { throw new Error("summary unreachable"); }
    };
    await extractOnDoorsChanged(scope)();
    expect(notified).toEqual([{ state: "unknown" }]);
  });

  it("out of order: a slower read an earlier notice started must not overwrite a newer notice's already-applied result", async () => {
    const notified: { state: string }[] = [];
    const stage = { notifyPermission: (payload: { state: string }) => notified.push(payload) };
    const resolvers: Array<(value: { doors: { metered_fetch: boolean } }) => void> = [];
    const scope: Record<string, unknown> = {
      permissionReadSeq: 0,
      liveMediaStages: new Set([stage]),
      console,
      refreshSummary: () => new Promise((resolve) => { resolvers.push(resolve); })
    };
    const onDoorsChanged = extractOnDoorsChanged(scope);

    const noticeA = onDoorsChanged(); // started first, answered last
    const noticeB = onDoorsChanged(); // started second, answered first

    resolvers[1]({ doors: { metered_fetch: true } }); // B: consent is granted
    await noticeB;
    resolvers[0]({ doors: { metered_fetch: false } }); // A: would have said absent
    await noticeA;

    // B's result is the only one ever handed to a stage; A's late, stale read
    // never overwrites it.
    expect(notified).toEqual([{ state: "granted" }]);
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
