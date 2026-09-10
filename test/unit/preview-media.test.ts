// The source drawer's media stage: which frame is showing, what the stage is
// doing while it fetches, and whose blob URLs get revoked.
//
// Every case here is one the twelve posts from a real account produced.
import { beforeEach, describe, expect, it } from "vitest";
import { createMediaStage } from "../../src/src/client/preview-media.js";
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

describe("the drawer's media stage", () => {
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
    const stage = createMediaStage(door.rpc, itemWith([{ id: "0", kind: "image" }]), "en");
    expect(texts(stage.node)).toContain("Fetching");
    expect(images(stage.node)).toHaveLength(0);

    await flushAsyncWork();
    expect(texts(stage.node)).not.toContain("Fetching");
    // The readable frame plus the blurred copy behind it — one fetch, two uses.
    expect(images(stage.node).length).toBeGreaterThanOrEqual(1);
  });

  it("carries the door's own sentence when a frame is refused", async () => {
    const door = doorServing({ "0": { refuse: "That preview is 1441KB, over the 1024KB this cache holds." } });
    const stage = createMediaStage(door.rpc, itemWith([{ id: "0", kind: "image" }]), "en");
    await flushAsyncWork();
    expect(texts(stage.node)).toContain("1441KB");
    expect(texts(stage.node)).toContain("Try again");
    expect(images(stage.node)).toHaveLength(0);
  });

  it("says a text-only post is text-only, and asks the door for nothing", async () => {
    const door = doorServing({});
    const stage = createMediaStage(door.rpc, itemWith([]), "en");
    await flushAsyncWork();
    expect(texts(stage.node)).toContain("no image");
    expect(door.asked).toEqual([]);
  });

  /*
   * `item.media[0]` was the whole of the old drawer. Two of the twelve posts
   * from a real account are carousels of three and five frames.
   */
  describe("a carousel", () => {
    const five: Frame[] = [0, 1, 2, 3, 4].map((n) => ({ id: String(n), kind: "image" }));

    it("offers one control per frame and counts them", async () => {
      const door = doorServing({ "0": {}, "1": {}, "2": {}, "3": {}, "4": {} });
      const stage = createMediaStage(door.rpc, itemWith(five), "en");
      await flushAsyncWork();
      expect(stage.frameCount).toBe(5);
      expect(stage.strip?.children).toHaveLength(5);
      expect(texts(stage.node)).toContain("1 of 5");
    });

    it("fetches a frame only when it is asked for, and only once", async () => {
      const door = doorServing({ "0": {}, "1": {}, "2": {}, "3": {}, "4": {} });
      const stage = createMediaStage(door.rpc, itemWith(five), "en");
      await flushAsyncWork();
      // Five frames is five round trips down a transport that runs one call at
      // a time; nothing is fetched up front.
      expect(door.asked).toEqual(["0"]);

      stage.strip!.children[2].dispatchEvent({ type: "click" } as never);
      await flushAsyncWork();
      expect(door.asked).toEqual(["0", "2"]);
      expect(texts(stage.node)).toContain("3 of 5");

      stage.strip!.children[0].dispatchEvent({ type: "click" } as never);
      await flushAsyncWork();
      // Frame 0 is already held: showing it again is not another fetch.
      expect(door.asked).toEqual(["0", "2"]);
    });

    it("leaves a single-frame post without a strip to click through", async () => {
      const door = doorServing({ "0": {} });
      const stage = createMediaStage(door.rpc, itemWith([{ id: "0", kind: "image" }]), "en");
      await flushAsyncWork();
      expect(stage.strip).toBeNull();
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
      const stage = createMediaStage(door.rpc, itemWith([0, 1, 2].map((n) => ({ id: String(n), kind: "image" }))), "en");
      await flushAsyncWork();
      stage.strip!.children[1].dispatchEvent({ type: "click" } as never);
      await flushAsyncWork();
      expect(revoked).toHaveLength(0);

      stage.dispose();
      expect(revoked).toHaveLength(2);
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
      const stage = createMediaStage(door.rpc, itemWith([{ id: "0", kind: "image" }]), "en");
      stage.dispose();
      await flushAsyncWork();
      expect(revoked).toHaveLength(1);
    } finally {
      URL.revokeObjectURL = realRevoke;
    }
  });
});
