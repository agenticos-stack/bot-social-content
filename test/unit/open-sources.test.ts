import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeOpenInstagramPosts,
  openSourceBinding,
  resolveOpenSource
} from "../../src/model.js";
import { listOpenAccountPosts } from "../../src/doors.js";
import { LOCALES, t } from "../../src/src/client/i18n.js";

describe("resolving a typed account link", () => {
  it("reads an Instagram profile link", () => {
    expect(resolveOpenSource("https://www.instagram.com/natgeo/")).toEqual({
      ok: true,
      platform: "instagram",
      accountKey: "natgeo",
      displayName: "@natgeo"
    });
  });

  it("reads a Facebook page link, and a numeric profile link", () => {
    expect(resolveOpenSource("https://facebook.com/nasa")).toMatchObject({
      ok: true,
      platform: "facebook",
      accountKey: "nasa"
    });
    expect(resolveOpenSource("https://facebook.com/profile.php?id=123456")).toMatchObject({
      ok: true,
      platform: "facebook",
      accountKey: "123456"
    });
  });

  it("accepts a link without a scheme, because owners paste those", () => {
    expect(resolveOpenSource("instagram.com/natgeo")).toMatchObject({ ok: true, accountKey: "natgeo" });
  });

  it("REFUSES a bare handle rather than guessing the platform", () => {
    // "@nike" is an account on both platforms and they are different
    // companies' pages. Guessing would silently watch the wrong one.
    const result = resolveOpenSource("@nike");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("platform_unknown");
  });

  it("refuses a link that names the platform's own pages, not an account", () => {
    // Without this, `instagram.com/explore` stores a source called "explore"
    // that scans forever and finds nothing — which reads as a quiet account
    // rather than a bad link.
    for (const link of [
      "https://instagram.com/explore",
      "https://instagram.com/p/abc123",
      "https://facebook.com/groups/something"
    ]) {
      expect(resolveOpenSource(link).ok, link).toBe(false);
    }
  });

  it("refuses a platform it cannot watch, and says so", () => {
    const result = resolveOpenSource("https://tiktok.com/@someone");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_platform");
  });

  it("refuses empty and unreadable input by value, never by throwing", () => {
    expect(resolveOpenSource("").ok).toBe(false);
    expect(resolveOpenSource("   ").ok).toBe(false);
    expect(() => resolveOpenSource(null as unknown as string)).not.toThrow();
    expect(resolveOpenSource(null as unknown as string).ok).toBe(false);
  });
});

describe("the key an open source is stored under", () => {
  it("cannot collide with a connector binding an owner happened to name 'instagram'", () => {
    // A binding's key is a label the OWNER chose at grant time. `items` keys
    // de-duplication off this string, so a collision would merge two accounts'
    // posts into one source.
    expect(openSourceBinding("instagram", "natgeo")).toBe("open:instagram:natgeo");
    expect(openSourceBinding("instagram", "natgeo")).not.toBe("instagram");
  });
});

describe("reading a public account through the fetch door", () => {
  const source = { platform: "instagram", accountKey: "natgeo" };

  it("treats a door that was never granted as configuration, not failure", async () => {
    // The fetch requirement is `min: 0`. A workspace whose sources are all
    // authorised bindings never grants it, so its absence must not read as a
    // broken scan.
    const result = await listOpenAccountPosts({}, source);
    expect(result.outcome).toBe("failed_safe");
    expect(result.page.data).toEqual([]);
  });

  it("distinguishes a MISS from an account that published nothing", async () => {
    /**
     * The broker answers HTTP 200 with no posts when no provider could answer.
     * That is not the same as an account with nothing new, and only one of them
     * is a successful read. Filing the first as the second is how a scan
     * reports a clean run while fetching nothing.
     */
    const miss = await listOpenAccountPosts(
      { fetch: { socialPostsForAccount: async () => ({ ok: true, posts: [], miss: true, servedBy: "tikhub.instagram.user.posts", provider: "tikhub", nextCursor: null, credits: 30 }) } },
      source
    );
    expect(miss.outcome).toBe("no_answer");

    const empty = await listOpenAccountPosts(
      { fetch: { socialPostsForAccount: async () => ({ ok: true, posts: [], miss: false, servedBy: "tikhub.instagram.user.posts", provider: "tikhub", nextCursor: null, credits: 30 }) } },
      source
    );
    expect(empty.outcome).toBe("confirmed");
  });

  it("carries which provider served it, and what it cost", async () => {
    const result = await listOpenAccountPosts(
      {
        fetch: {
          socialPostsForAccount: async () => ({
            ok: true,
            posts: [{ id: "p1" }],
            miss: false,
            servedBy: "scrapecreators.instagram.user.posts",
            provider: "scrapecreators",
            nextCursor: "AQHTPOdBg2VviWnDa10",
            credits: 30
          })
        }
      },
      source
    );
    expect(result.outcome).toBe("confirmed");
    // The short provider name, because that is what a person reads on a
    // source row; the full endpoint id stays available on the door's result.
    expect(result.servedBy).toBe("scrapecreators");
    expect(result.credits).toBe(30);
    expect(result.page.data).toHaveLength(1);
    // The cursor a first version of this dropped. Without it a scan can only
    // ever see an account's most recent page.
    expect(result.page.paging).toEqual({ cursors: { after: "AQHTPOdBg2VviWnDa10" } });
  });

  it("turns the door's refusal into a safe failure, never a throw", async () => {
    const refused = await listOpenAccountPosts(
      { fetch: { socialPostsForAccount: async () => ({ ok: false, code: "no_credential", message: "none" }) } },
      source
    );
    expect(refused.outcome).toBe("failed_safe");

    const threw = await listOpenAccountPosts(
      {
        fetch: {
          socialPostsForAccount: async () => {
            throw new Error("rpc broke");
          }
        }
      },
      source
    );
    expect(threw.outcome).toBe("failed_safe");
    expect(threw.message).toContain("rpc broke");
  });

  it("passes the account, not a binding — an open source has no grant", async () => {
    let seen: unknown = null;
    await listOpenAccountPosts(
      {
        fetch: {
          socialPostsForAccount: async (input: unknown) => {
            seen = input;
            return { ok: true, posts: [], miss: true, servedBy: null, provider: null, nextCursor: null, credits: 0 };
          }
        }
      },
      { platform: "facebook", accountKey: "nasa" },
      { after: "cursor_1" }
    );
    expect(seen).toEqual({ platform: "facebook", accountKey: "nasa", cursor: "cursor_1" });
  });
});

describe("normalizing what the broker actually returns", () => {
  /**
   * The fixture is a REAL response, trimmed: one treg call for @natgeo on
   * 2026-09-04, twelve posts, with the giant Polaris module keys and all but
   * the first image candidate removed. Nothing about its shape is invented,
   * which is the point — a normalizer written from the Graph API docs would
   * have matched `id` and nothing else.
   */
  const payload = JSON.parse(
    readFileSync(new URL("./_fixtures/treg-instagram-posts.json", import.meta.url), "utf8")
  ) as { posts: unknown[]; next_cursor: string };

  const page = { data: payload.posts, paging: { cursors: { after: payload.next_cursor } } };
  const source = { binding: "open:instagram:natgeo", label: "@natgeo" };

  it("keeps the real posts and drops the one stub, saying so", async () => {
    /**
     * The real page held twelve entries and TEN posts. Two are stubs: a
     * `product_type: "carousel_container"` and an ordinary `feed` post, both
     * with no `taken_at`, no `created_at`, and no image, video or carousel —
     * an id and little else.
     *
     * I first wrote this expecting ONE. Two is what the payload actually
     * holds, and the difference matters: a stub is not a rare malformed
     * carousel, it is a normal thing this broker returns for a sixth of a
     * page. Stored, each would be an undated imageless card an owner cannot
     * act on, counted as a new item on every scan report.
     *
     * Dropped WITH A REASON, because "saw twelve, kept ten" is the sentence
     * an owner needs when the numbers do not match.
     */
    const result = await normalizeOpenInstagramPosts(page, source);
    expect(result.items).toHaveLength(10);
    // `dropped` is a list of `{ reason, count }`, which is what a scan report
    // reads to say WHY the numbers differ. THREE conditions in one real page,
    // and the third surprised me too: a kept post carried a media node with no
    // usable url, so that entry went and the post stayed.
    expect(result.dropped).toEqual(
      expect.arrayContaining([
        { reason: "incomplete_post", count: 2 },
        { reason: "media_missing_url", count: 1 }
      ])
    );
  });

  it("takes the caption's TEXT, not the caption object", async () => {
    // `caption` is an object here. A parser expecting a string would have
    // stored "[object Object]" or nothing at all.
    const { items } = await normalizeOpenInstagramPosts(page, source);
    const withText = items.filter((item) => typeof item.text === "string" && item.text.length > 0);
    expect(withText.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.text === null || typeof item.text === "string").toBe(true);
      expect(String(item.text)).not.toContain("[object");
    }
  });

  it("dates every KEPT post, from an ISO field or unix SECONDS", async () => {
    // `taken_at` is unix seconds. Passed to `new Date()` unchanged it would
    // date every post to January 1970 — sorted correctly among itself, and
    // wrong on every screen.
    const { items } = await normalizeOpenInstagramPosts(page, source);
    for (const item of items) {
      expect(item.publishedAt, item.providerItemId).toBeTruthy();
      const year = new Date(item.publishedAt!).getUTCFullYear();
      expect(year, item.providerItemId).toBeGreaterThan(2000);
    }
  });

  it("keys on the bare pk, so a broker item and a connector item are one row", async () => {
    // `id` is `POLARIS_<pk>`. Storing that would make the same post two rows
    // once an owner also connects the account — `UNIQUE(source_binding,
    // provider_item_id)` can only de-duplicate if both paths spell it alike.
    const { items } = await normalizeOpenInstagramPosts(page, source);
    for (const item of items) {
      expect(item.providerItemId).toMatch(/^\d+$/);
      expect(item.providerItemId).not.toContain("POLARIS");
    }
  });

  it("finds a permalink and at least one media url for every post", async () => {
    const { items } = await normalizeOpenInstagramPosts(page, source);
    for (const item of items) {
      expect(item.permalink, item.providerItemId).toContain("instagram.com");
      expect(item.media.length, item.providerItemId).toBeGreaterThan(0);
      for (const entry of item.media) expect(entry.url).toMatch(/^https?:\/\//);
    }
  });

  it("reads a carousel's children, and a video's own rendition", async () => {
    const { items } = await normalizeOpenInstagramPosts(page, source);
    const raw = payload.posts as Array<{ pk: string; media_type: number }>;
    const carouselIds = raw.filter((p) => p.media_type === 8).map((p) => String(p.pk));
    const videoIds = raw.filter((p) => p.media_type === 2).map((p) => String(p.pk));

    // The fixture has all three media types, which is why it was kept whole.
    expect(carouselIds.length).toBeGreaterThan(0);
    expect(videoIds.length).toBeGreaterThan(0);

    // The stub carousel is not among the kept items, so only the real ones
    // are checked — a `find` that returned undefined here would mean the drop
    // rule took something it should not have.
    const keptCarousels = carouselIds.filter((id) => items.some((entry) => entry.providerItemId === id));
    expect(keptCarousels.length).toBeGreaterThan(0);
    for (const id of keptCarousels) {
      const item = items.find((entry) => entry.providerItemId === id)!;
      expect(item.media.length, `carousel ${id}`).toBeGreaterThan(1);
    }
    for (const id of videoIds) {
      const item = items.find((entry) => entry.providerItemId === id)!;
      expect(item.media.some((entry) => entry.kind === "video"), `video ${id}`).toBe(true);
    }
  });

  it("reads comment_count, not the Graph API's comments_count", async () => {
    const { items } = await normalizeOpenInstagramPosts(page, source);
    const withComments = items.filter((item) => typeof item.metrics.comments === "number");
    expect(withComments.length).toBeGreaterThan(0);
  });

  it("carries the cursor so a scan can page past the first twelve", async () => {
    const result = await normalizeOpenInstagramPosts(page, source);
    expect(result.nextCursor).toBe(payload.next_cursor);
  });
});

describe("the setup form's public-accounts field", () => {
  const steps = readFileSync(
    new URL("../../src/src/client/steps.js", import.meta.url),
    "utf8"
  );
  const client = readFileSync(
    new URL("../../src/src/client/client.js", import.meta.url),
    "utf8"
  );
  const i18n = readFileSync(
    new URL("../../src/src/client/i18n.js", import.meta.url),
    "utf8"
  );

  it("does not reuse the tag inputs' class", () => {
    // `sl-field-input` marks the tag inputs — typed, stored verbatim. Sharing
    // it made this the FIRST such input on the form, which silently redirected
    // an existing test's protected-term typing into the account field. The
    // test was right; the class was wrong.
    expect(steps).toContain('class: "sl-open-source-input"');
  });

  it("keeps the account field's busy and error state out of the form's", () => {
    // A first version passed `error` twice in one object literal, so the
    // account error clobbered the setConfig error and a failed save showed
    // nothing at all.
    expect(client).toContain("openBusy,");
    expect(client).toContain("openError,");
    expect(client).not.toMatch(/\berror: openError\b/);
    expect(steps).toContain("state.openError");
    expect(steps).toContain("state.openBusy");
  });

  it("stores an account the moment it resolves, not on save", () => {
    // Resolution is the server's answer and it can refuse. Holding the link in
    // the draft would defer "that link does not name an account" to a save, or
    // to a scan at 09:00 tomorrow.
    expect(client).toContain("rpc.addOpenSource");
    expect(client).toContain("rpc.removeOpenSource");
  });

  it("says the rights rule where the rights choice is made, in both locales", () => {
    // A public account always confirms rights whatever the radio says. Without
    // this line the setting looks broken.
    expect(steps).toContain("openSourceRightsNote");
    for (const locale of LOCALES) {
      for (const key of [
        "openSourceLabel",
        "openSourceDesc",
        "openSourcePlaceholder",
        "openSourceHint",
        "openSourceRightsNote"
      ]) {
        expect(t(locale, key), `${locale}.${key}`).not.toBe(key);
      }
    }
  });

  it("tells the owner these accounts cost money, before they add one", () => {
    // The description sits above the field, not in a tooltip: an owner should
    // not learn that watching is metered from a bill.
    expect(i18n).toMatch(/paid provider/i);
    expect(i18n).toContain("付費供應商");
  });
});
