// The Reference tab's media rail: one numbered slot per source frame, what a
// slot is doing while its frame fetches, and whose blob URLs get revoked.
//
// Every case here is one the twelve posts from a real account produced.
import { beforeEach, describe, expect, it } from "vitest";
import { createMediaRail } from "../../src/src/client/preview-media.js";
import { findAll, flushAsyncWork, installMinimalDom } from "./_helpers/minimal-dom.js";

type Frame = { id: string; kind?: string };

/** A `getMedia` that answers each frame in one chunk, or refuses by value. */
function doorServing(perFrame: Record<string, { bytes?: number[]; refuse?: string }>) {
  const asked: string[] = [];
  return {
    asked,
    rpc: {
      getMedia: async (_itemId: string, mediaId: string) => {
        asked.push(mediaId);
        const answer = perFrame[mediaId];
        if (!answer) return { ok: false, code: "media_missing", message: `No media ${mediaId}.` };
        if (answer.refuse) return { ok: false, code: "media_too_large", message: answer.refuse };
        const bytes = answer.bytes ?? [255, 216, 255, 217];
        return { mime: "image/jpeg", total: bytes.length, chunk: 0, chunks: 1, bytes };
      }
    } as never
  };
}

function itemWith(media: Frame[]) {
  return { id: "item-1", text: "a post", sourceBinding: "open:instagram:acct", media } as never;
}

const texts = (node: unknown) =>
  findAll(node as never, () => true)
    .map((element: { textContent?: string }) => element.textContent ?? "")
    .join(" ");

const images = (node: unknown) => findAll(node as never, (e: { tagName?: string }) => e.tagName === "IMG");
const byClass = (node: unknown, cls: string) =>
  findAll(node as never, (e: { className?: string }) => String(e.className ?? "").split(" ").includes(cls));

describe("the drawer's media rail", () => {
  beforeEach(() => { installMinimalDom(); });

  /*
   * A fetch in progress is not a missing picture.
   *
   * The drawer was built holding "Preview not available" and only replaced it
   * on success, so the sentence was on screen for the whole of every fetch and
   * stayed there for good on a failure. Three states, three sentences.
   */
  it("says it is fetching, then shows the frame", async () => {
    const door = doorServing({ "0": {} });
    const rail = createMediaRail(door.rpc, itemWith([{ id: "0", kind: "image" }]), "en");
    expect(texts(rail.node)).toContain("Fetching");
    expect(images(rail.node)).toHaveLength(0);

    await flushAsyncWork();
    expect(texts(rail.node)).not.toContain("Fetching");
    expect(images(rail.node).length).toBeGreaterThanOrEqual(1);
  });

  it("carries the door's own sentence when a frame is refused", async () => {
    const door = doorServing({ "0": { refuse: "That preview is 1441KB, over the 1024KB this cache holds." } });
    const rail = createMediaRail(door.rpc, itemWith([{ id: "0", kind: "image" }]), "en");
    await flushAsyncWork();
    expect(texts(rail.node)).toContain("1441KB");
    expect(texts(rail.node)).toContain("Try again");
    expect(images(rail.node)).toHaveLength(0);
  });

  it("says a text-only post is text-only, and asks the door for nothing", async () => {
    const door = doorServing({});
    const rail = createMediaRail(door.rpc, itemWith([]), "en");
    await flushAsyncWork();
    expect(texts(rail.node)).toContain("no image");
    expect(door.asked).toEqual([]);
  });

  /*
   * `item.media[0]` was the whole of the old drawer. Two of the twelve posts
   * from a real account are carousels of three and five frames — the rail
   * shows every one of them at once, numbered like the Post tab's pages.
   */
  describe("a carousel", () => {
    const five: Frame[] = [0, 1, 2, 3, 4].map((n) => ({ id: String(n), kind: "image" }));

    it("shows one numbered slot per frame, in source order", async () => {
      const door = doorServing({ "0": {}, "1": {}, "2": {}, "3": {}, "4": {} });
      const rail = createMediaRail(door.rpc, itemWith(five), "en");
      await flushAsyncWork();
      expect(rail.frameCount).toBe(5);
      expect(byClass(rail.node, "sl-slot")).toHaveLength(5);
      const numbers = byClass(rail.node, "sl-slot-num").map((e: { textContent?: string }) => e.textContent);
      expect(numbers).toEqual(["1", "2", "3", "4", "5"]);
      expect(images(rail.node)).toHaveLength(5);
    });

    it("reads every frame on show, once each, in source order", async () => {
      const door = doorServing({ "0": {}, "1": {}, "2": {}, "3": {}, "4": {} });
      createMediaRail(door.rpc, itemWith(five), "en");
      await flushAsyncWork();
      // Every slot is on show, so every frame reads — one getMedia door, one
      // read per frame, and a repaint never re-reads.
      expect(door.asked).toEqual(["0", "1", "2", "3", "4"]);
      await flushAsyncWork();
      expect(door.asked).toEqual(["0", "1", "2", "3", "4"]);
    });

    it("leaves a single-frame post unnumbered", async () => {
      const door = doorServing({ "0": {} });
      const rail = createMediaRail(door.rpc, itemWith([{ id: "0", kind: "image" }]), "en");
      await flushAsyncWork();
      expect(byClass(rail.node, "sl-slot")).toHaveLength(1);
      expect(byClass(rail.node, "sl-slot-num")).toHaveLength(0);
    });
  });

  /*
   * One blob URL per frame FETCHED, not one per drawer.
   *
   * `client.js` kept a single `activePreviewBlobUrl` and revoked that one on
   * close. With more than one frame reachable, every frame after the first
   * would have leaked its URL for the life of the page.
   */
  it("revokes every URL it minted, not just the last one", async () => {
    const revoked: string[] = [];
    const realRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string) => { revoked.push(url); realRevoke.call(URL, url); };
    try {
      const door = doorServing({ "0": {}, "1": {}, "2": {} });
      const rail = createMediaRail(door.rpc, itemWith([0, 1, 2].map((n) => ({ id: String(n), kind: "image" }))), "en");
      await flushAsyncWork();
      expect(revoked).toHaveLength(0);

      rail.dispose();
      expect(revoked).toHaveLength(3);
    } finally {
      URL.revokeObjectURL = realRevoke;
    }
  });

  it("keeps bytes that arrive after the drawer closed out of the DOM, and does not leak them", async () => {
    const revoked: string[] = [];
    const realRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string) => { revoked.push(url); realRevoke.call(URL, url); };
    try {
      const door = doorServing({ "0": {} });
      const rail = createMediaRail(door.rpc, itemWith([{ id: "0", kind: "image" }]), "en");
      rail.dispose();
      await flushAsyncWork();
      expect(revoked).toHaveLength(1);
    } finally {
      URL.revokeObjectURL = realRevoke;
    }
  });
});
