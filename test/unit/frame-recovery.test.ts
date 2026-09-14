// Carousel frame recovery: structured outcomes, one intended retry, no silent
// refetch. Synthetic items only.
import { beforeEach, describe, expect, it } from "vitest";
import { createMediaStage } from "../../src/src/client/preview-media.js";
import { fetchMedia } from "../../src/doors.js";
import { findAll, flushAsyncWork, installMinimalDom } from "./_helpers/minimal-dom.js";

type Answer = { ok: false; code: string; message: string } | { bytes: number[] };

/** A getMedia whose answer per frame can change between calls, recording every ask. */
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

const JPEG = { bytes: [255, 216, 255, 217] };
const blocked = (code: string) => ({ ok: false as const, code, message: "Public account fetching is not granted for this workspace." });
const carousel = { id: "item-1", text: "a carousel", media: [{ id: "a", kind: "image" }, { id: "b", kind: "image" }, { id: "c", kind: "video" }] } as never;

const texts = (node: unknown) =>
  findAll(node as never, () => true).map((e: { textContent?: string }) => e.textContent ?? "").join(" ");
type Clickable = { textContent: string; dispatchEvent(event: unknown): void };
const buttons = (node: unknown) =>
  findAll(node as never, (e: { tagName?: string }) => e.tagName === "BUTTON") as unknown as Clickable[];
const click = (target: unknown) => (target as Clickable).dispatchEvent({ type: "click" });
const frameTab = (stage: { strip: unknown }, at: number) => click((stage.strip as { children: unknown[] }).children[at]);
const press = (node: unknown, label: string) => {
  const button = buttons(node).find((b) => b.textContent.includes(label));
  if (!button) throw new Error(`no button ${label}: ${texts(node)}`);
  click(button);
};

describe("carousel frame recovery", () => {
  beforeEach(() => { installMinimalDom(); });

  it("a held first frame and a permission-blocked later frame: grant asks once, cancel grants and fetches nothing", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_permission_required") });
    let grants = 0;
    const stage = createMediaStage(d.rpc, carousel, "en", { onGrantFetch: () => { grants += 1; } });
    await flushAsyncWork();
    frameTab(stage, 1);
    await flushAsyncWork();
    expect(texts(stage.node)).toContain("Permission needed for this frame");
    expect(texts(stage.node)).not.toContain("not granted for this workspace");

    press(stage.node, "Allow public fetching");
    expect(grants).toBe(1);
    expect(texts(stage.node)).toContain("Waiting for your answer");

    // Cancelled in the host: no doors_changed arrives, so nothing is fetched.
    const asksBefore = d.asked.length;
    await flushAsyncWork();
    expect(d.asked.length).toBe(asksBefore);
    expect(stage.frameStates().map((f: { status: string }) => f.status)).toEqual(["held", "refused", "unread"]);
  });

  it("after confirmed activation retries only the intended frame, never the held or unread ones", async () => {
    const d = door({ a: JPEG, b: blocked("fetch_permission_required") });
    const stage = createMediaStage(d.rpc, carousel, "en", { onGrantFetch: () => {} });
    await flushAsyncWork();
    frameTab(stage, 1);
    await flushAsyncWork();
    press(stage.node, "Allow public fetching");

    d.answers.b = JPEG;
    d.asked.length = 0;
    expect(stage.onDoorsChanged()).toBe(true);
    await flushAsyncWork();
    expect(d.asked).toEqual(["b"]);
    expect(stage.frameStates().map((f: { status: string }) => f.status)).toEqual(["held", "held", "unread"]);
    expect(texts(stage.node)).toContain("2 of 3 frames loaded");

    // Returning to a held frame does not spend another read.
    frameTab(stage, 0);
    await flushAsyncWork();
    expect(d.asked).toEqual(["b"]);
  });

  it("a doors change with nothing waiting fetches nothing", async () => {
    const d = door({ a: JPEG });
    const stage = createMediaStage(d.rpc, carousel, "en");
    await flushAsyncWork();
    d.asked.length = 0;
    expect(stage.onDoorsChanged()).toBe(false);
    await flushAsyncWork();
    expect(d.asked).toEqual([]);
  });

  it("consent saved but activation failed offers retry activation, re-checks, then retries that frame", async () => {
    const d = door({ a: blocked("fetch_activation_failed") });
    let rechecks = 0;
    const stage = createMediaStage(d.rpc, carousel, "en", { onRecheck: async () => { rechecks += 1; d.answers.a = JPEG; } });
    await flushAsyncWork();
    expect(texts(stage.node)).toContain("Permission saved, fetching not started");
    expect(texts(stage.node)).not.toContain("Allow public fetching");
    press(stage.node, "Retry activation");
    await flushAsyncWork();
    expect(rechecks).toBe(1);
    expect(stage.frameStates()[0].status).toBe("held");
  });

  it("transient, gone and uncertain outcomes each say what they are", async () => {
    for (const [code, title] of [
      ["fetch_transient", "This frame did not load"],
      ["source_unavailable", "no longer available"],
      ["fetch_uncertain", "Could not confirm this frame"]
    ]) {
      const stage = createMediaStage(door({ a: blocked(code) }).rpc, carousel, "en");
      await flushAsyncWork();
      expect(texts(stage.node)).toContain(title);
      expect(texts(stage.node)).not.toContain("Allow public fetching");
    }
  });

  it("a refused frame is not refetched by navigating away and back", async () => {
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
    const d = door({ c: JPEG });
    const stage = createMediaStage(d.rpc, { id: "v", text: "reel", media: [{ id: "c", kind: "video" }] } as never, "en");
    await flushAsyncWork();
    expect(texts(stage.node)).toContain("cover image only, not played");
  });
});

describe("fetchMedia outcome codes (open source)", () => {
  const media = { id: "m", kind: "image", url: "https://cdn.example/m.jpg" };

  it("reads consent from the runtime projection, not from the door's absence", async () => {
    expect(await fetchMedia({ __consent: { metered_fetch: false } }, "open:x", media, "preview", "open")).toMatchObject({ code: "fetch_permission_required" });
    expect(await fetchMedia({ __consent: { metered_fetch: true } }, "open:x", media, "preview", "open")).toMatchObject({ code: "fetch_activation_failed" });
    expect(await fetchMedia({}, "open:x", media, "preview", "open")).toMatchObject({ code: "fetch_uncertain" });
  });

  it("separates a broken call, a gone source and a door that refused without a code", async () => {
    const throwing = { metered_fetch: { fetch_media: async () => { throw new Error("socket closed"); } } };
    expect(await fetchMedia(throwing, "open:x", media, "preview", "open")).toMatchObject({ code: "fetch_transient" });
    const gone = { metered_fetch: { fetch_media: async () => ({ ok: false, code: "not_found", message: "404" }) } };
    expect(await fetchMedia(gone, "open:x", media, "preview", "open")).toMatchObject({ code: "source_unavailable" });
    const vague = { metered_fetch: { fetch_media: async () => ({ ok: false, message: "status 500" }) } };
    expect(await fetchMedia(vague, "open:x", media, "preview", "open")).toMatchObject({ code: "fetch_transient" });
  });
});
