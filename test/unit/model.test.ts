// TASK-201 / TEST-001: node unit tests for the pure Social Localization
// model. No network, no D1, no facet — model.js has no I/O beyond the
// platform crypto API and the system clock.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  boundExport,
  contentHash,
  detectProtectedLiterals,
  duplicateKey,
  exportBounds,
  messages,
  normalizeFacebookPagePosts,
  normalizeInstagramMedia,
  posterLayoutSchema,
  posterPngConstraints,
  revisionCas,
  ledgerFromProtectedOverrides,
  normalizeLedger,
  rightsObligation,
  usesGroundedValidation,
  validateGrounded,
  validateLocalization,
  validatePosterLayout,
  validateRevisionDraft
} from "../../src/model.js";

const MODEL_PATH = fileURLToPath(new URL("../../src/model.js", import.meta.url));

const instagramPage = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/social-localization/instagram-media-page.json", import.meta.url)), "utf8")
);
const facebookPage = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/social-localization/facebook-page-posts-page.json", import.meta.url)), "utf8")
);

/**
 * Spoken-form particles that must never appear in this blueprint's own
 * zh-HK product copy — see AGENTS.md / studio/scripts/i18n-diff.mjs. Kept
 * here (not imported) so this test does not depend on model.js re-exporting
 * its internal detection list.
 */
const SPOKEN_FORM_TOKENS = ["嘅", "咗", "唔", "呢個", "邊個", "幾多", "睇", "喺", "嗰"];

const INSTAGRAM_SOURCE = { binding: "IG_MAIN", label: "Main Instagram", provider: "instagram" };
const FACEBOOK_SOURCE = { binding: "FB_MAIN", label: "Main Page", provider: "facebook", pageId: "synthetic_page_id" };

describe("normalizeInstagramMedia", () => {
  it("normalizes Instagram media into the shared SourceItem shape", async () => {
    const result = await normalizeInstagramMedia(instagramPage, INSTAGRAM_SOURCE);

    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).toBe("synthetic_after_cursor");
    expect(result.dropped).toEqual([]);

    const [image, video, carousel] = result.items;

    expect(image).toMatchObject({
      id: "instagram:IG_MAIN:ig_media_1001",
      provider: "instagram",
      sourceBinding: "IG_MAIN",
      sourceLabel: "Main Instagram",
      providerItemId: "ig_media_1001",
      authorHandle: "synthetic_brand",
      permalink: "https://www.instagram.com/p/synthetic_1001/",
      publishedAt: "2026-08-20T09:15:00.000Z",
      text: "New arrivals for the season! Check out our latest collection.",
      locale: null
    });
    expect(image.media).toEqual([
      { id: "ig_media_1001", kind: "image", url: "https://cdn.example.test/synthetic/ig-1001.jpg" }
    ]);
    // Metrics the provider supplied are used (GUD-003).
    expect(image.metrics).toEqual({ likes: 42, comments: 5, shares: null, views: null });
    expect(image.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(image.firstSeenAt).toBe(image.lastSeenAt);

    expect(video.media).toEqual([
      { id: "ig_media_1002", kind: "video", url: "https://cdn.example.test/synthetic/ig-1002.mp4" }
    ]);
    // No like_count/comments_count on this fixture item — stays null, never 0 (GUD-003).
    expect(video.metrics).toEqual({ likes: null, comments: null, shares: null, views: null });

    expect(carousel.media).toEqual([
      { id: "ig_child_1", kind: "carousel_child", url: "https://cdn.example.test/synthetic/ig-1003-a.jpg" },
      { id: "ig_child_2", kind: "carousel_child", url: "https://cdn.example.test/synthetic/ig-1003-b.jpg" },
      { id: "ig_child_3", kind: "carousel_child", url: "https://cdn.example.test/synthetic/ig-1003-c.mp4" }
    ]);
  });

  it("caps media entries and bounds text fields, reporting truncation", async () => {
    const bigChildren = Array.from({ length: 14 }, (_, index) => ({
      id: `child-${index + 1}`,
      media_type: "IMAGE",
      media_url: `https://cdn.example.test/child-${index + 1}.jpg`
    }));
    const page = {
      data: [
        {
          id: "ig_media_over",
          caption: "x".repeat(6_000),
          timestamp: "2026-08-20T09:15:00+0000",
          permalink: `https://example.test/${"p".repeat(2_100)}`,
          media_type: "CAROUSEL_ALBUM",
          username: "u".repeat(150),
          children: { data: bigChildren }
        }
      ]
    };

    const result = await normalizeInstagramMedia(page, INSTAGRAM_SOURCE);
    expect(result.items).toHaveLength(1);
    const [item] = result.items;

    expect(item.text).toHaveLength(5_000);
    expect(item.authorHandle).toHaveLength(100);
    expect(item.permalink).toHaveLength(2_048);
    expect(item.media).toHaveLength(10);

    const byReason = Object.fromEntries(result.dropped.map((entry) => [entry.reason, entry.count]));
    expect(byReason.caption_truncated).toBe(1);
    expect(byReason.handle_truncated).toBe(1);
    expect(byReason.url_truncated).toBeGreaterThanOrEqual(1);
    expect(byReason.media_truncated).toBe(4);
  });

  it("skips items with no provider id and counts the drop", async () => {
    const page = { data: [{ caption: "no id here" }] };
    const result = await normalizeInstagramMedia(page, INSTAGRAM_SOURCE);
    expect(result.items).toEqual([]);
    expect(result.dropped).toEqual([{ reason: "missing_id", count: 1 }]);
  });
});

describe("normalizeFacebookPagePosts", () => {
  it("normalizes Facebook Page posts into the same SourceItem shape", async () => {
    const result = await normalizeFacebookPagePosts(facebookPage, FACEBOOK_SOURCE);

    expect(result.nextCursor).toBe("synthetic_fb_after_cursor");
    expect(result.items).toHaveLength(1);

    const [item] = result.items;
    expect(item).toMatchObject({
      id: "facebook:FB_MAIN:fb_post_2001",
      provider: "facebook",
      sourceBinding: "FB_MAIN",
      sourceLabel: "Main Page",
      providerItemId: "fb_post_2001",
      authorHandle: "Synthetic Brand",
      permalink: "https://www.facebook.com/synthetic.page/posts/2001",
      publishedAt: "2026-08-19T10:00:00.000Z",
      text: "We just launched our HK$1,299 bundle — check it out!",
      locale: null
    });
    expect(item.media).toEqual([
      { id: "fb-media-1", kind: "image", url: "https://cdn.example.test/synthetic/fb-2001-a.jpg" }
    ]);
    // Facebook Page-post reads carry no reaction counts — every metric null (GUD-003).
    expect(item.metrics).toEqual({ likes: null, comments: null, shares: null, views: null });
  });

  it("drops unpublished and non-Page-authored posts, with counted reasons", async () => {
    const result = await normalizeFacebookPagePosts(facebookPage, FACEBOOK_SOURCE);
    expect(result.dropped).toEqual(
      expect.arrayContaining([
        { reason: "unpublished", count: 1 },
        { reason: "not_page_author", count: 1 }
      ])
    );
  });

  it("requires source.pageId to filter by Page authorship", async () => {
    await expect(normalizeFacebookPagePosts(facebookPage, { binding: "FB_MAIN", label: "Main Page" })).rejects.toThrow(
      /pageId/
    );
  });
});

describe("contentHash", () => {
  const base = {
    provider: "instagram",
    providerItemId: "abc123",
    text: "Hello world",
    media: [{ id: "m1", url: "https://cdn.example.test/a.jpg" }],
    publishedAt: "2026-08-20T09:15:00.000Z"
  };

  it("is stable across key order", async () => {
    const reordered = {
      publishedAt: base.publishedAt,
      media: base.media,
      text: base.text,
      providerItemId: base.providerItemId,
      provider: base.provider
    };
    expect(await contentHash(base)).toBe(await contentHash(reordered));
  });

  it("is stable across retrieval timestamps and metrics", async () => {
    const withExtras = {
      ...base,
      firstSeenAt: "2026-09-01T00:00:00.000Z",
      lastSeenAt: "2026-09-02T00:00:00.000Z",
      metrics: { likes: 999, comments: 1, shares: null, views: null }
    };
    expect(await contentHash(base)).toBe(await contentHash(withExtras));
  });

  it("changes when the text changes", async () => {
    expect(await contentHash(base)).not.toBe(await contentHash({ ...base, text: "Different text" }));
  });

  it("changes when media changes", async () => {
    const changedMedia = { ...base, media: [{ id: "m1", url: "https://cdn.example.test/different.jpg" }] };
    expect(await contentHash(base)).not.toBe(await contentHash(changedMedia));
  });
});

describe("detectProtectedLiterals", () => {
  it("detects a price with a comma", () => {
    const spans = detectProtectedLiterals("Grab the HK$1,299 bundle today.", {});
    expect(spans).toContainEqual({ start: 9, end: 17, kind: "price", value: "HK$1,299" });
  });

  it("detects a URL with a query string", () => {
    const spans = detectProtectedLiterals("Shop at https://example.test/product?ref=ig&utm=1 now.", {});
    expect(spans.some((span) => span.kind === "url" && span.value === "https://example.test/product?ref=ig&utm=1")).toBe(
      true
    );
  });

  it("detects a protected hashtag but not an unprotected one", () => {
    const spans = detectProtectedLiterals("New drop #BrandName #random", {
      protectedHashtags: ["#BrandName"]
    });
    expect(spans).toEqual([{ start: 9, end: 19, kind: "hashtag", value: "#BrandName" }]);
  });

  it("detects a disclaimer", () => {
    const spans = detectProtectedLiterals("New product launch. Results may vary.", {
      disclaimers: ["Results may vary."]
    });
    expect(spans).toContainEqual({ start: 20, end: 37, kind: "disclaimer", value: "Results may vary." });
  });

  it("does not false-match a protected term inside a longer word by default", () => {
    const spans = detectProtectedLiterals("Our Essential range is popular.", { protectedTerms: ["Ess"] });
    expect(spans).toEqual([]);
  });

  it("matches inside a longer word only when the policy marks it", () => {
    const spans = detectProtectedLiterals("Our Essential range is popular.", {
      protectedTerms: [{ value: "Ess", allowSubstring: true }]
    });
    expect(spans).toContainEqual({ start: 4, end: 7, kind: "product", value: "Ess" });
  });
});

describe("validateLocalization", () => {
  it("blocks an empty draft", () => {
    const result = validateLocalization({ source: {}, draft: "   ", policy: {} });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: "empty_draft", severity: "block" });
  });

  it("blocks an altered price", () => {
    const result = validateLocalization({
      source: { text: "Get the HK$1,299 bundle now." },
      draft: "宣傳優惠：套裝價錢係HK$999，立即購買。",
      policy: {}
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "protected_literal_altered", severity: "block" })
    );
  });

  it("blocks a missing disclaimer", () => {
    const result = validateLocalization({
      source: { text: "New product launch. Results may vary." },
      draft: "全新產品正式登場，歡迎選購。",
      policy: { disclaimers: ["Results may vary."] }
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "disclaimer_missing", severity: "block" }));
  });

  it("blocks a spoken-form token", () => {
    const result = validateLocalization({
      source: {},
      draft: "呢個係我哋嘅新產品，大家快啲嚟睇吓啦。",
      policy: {}
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "spoken_form_detected", severity: "block" }));
  });

  it("blocks an over-limit caption", () => {
    const result = validateLocalization({
      source: {},
      draft: "全新產品正式登場，歡迎選購。",
      policy: {},
      limits: { captionMax: 5 }
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "caption_too_long", severity: "block" }));
  });

  it("asks for confirmation on an unconfirmed claim without blocking", () => {
    const result = validateLocalization({
      source: { text: "This is clinically proven to work." },
      draft: "本產品經臨床實證，效果顯著，歡迎選購。",
      policy: { claimsRequiringConfirmation: ["clinically proven"] }
    });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "claim_unconfirmed", severity: "confirm" }));
    expect(result.issues.some((issue) => issue.severity === "block")).toBe(false);

    const confirmed = validateLocalization({
      source: { text: "This is clinically proven to work." },
      draft: "本產品經臨床實證，效果顯著，歡迎選購。",
      policy: { claimsRequiringConfirmation: ["clinically proven"], confirmedClaims: ["clinically proven"] }
    });
    expect(confirmed.issues.some((issue) => issue.code === "claim_unconfirmed")).toBe(false);
  });

  it("notes half-width punctuation between Chinese characters without blocking", () => {
    const result = validateLocalization({ source: {}, draft: "全新產品,正式登場歡迎選購。", policy: {} });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "halfwidth_punctuation", severity: "note" }));
    expect(result.issues.some((issue) => issue.severity === "block")).toBe(false);
  });

  it("accepts a clean written-Chinese draft with no issues", () => {
    const result = validateLocalization({
      source: { text: "New arrivals are here." },
      draft: "全新產品正式登場，歡迎選購。",
      policy: {}
    });
    expect(result).toEqual({ ok: true, issues: [] });
  });
});

describe("usesGroundedValidation", () => {
  it("routes keep_original with no allowed changes to localization", () => {
    expect(usesGroundedValidation({ visualTreatment: "keep_original", allowedChanges: [] })).toBe(false);
    expect(usesGroundedValidation({ visualTreatment: "text_poster" })).toBe(false);
  });

  it("routes allowed changes or ai_refinement to grounded validation", () => {
    expect(usesGroundedValidation({ visualTreatment: "keep_original", allowedChanges: ["price"] })).toBe(true);
    expect(usesGroundedValidation({ visualTreatment: "ai_refinement", allowedChanges: [] })).toBe(true);
  });
});

describe("validateGrounded", () => {
  const source = { id: "instagram:IG_MAIN:p1", text: "Get the HK$1,299 bundle now." };
  const derivedCaption = "宣傳優惠：套裝價錢HK$999，立即購買。";

  it("passes a derived draft with a new price when the ledger names a basis", () => {
    const result = validateGrounded({
      source,
      draft: derivedCaption,
      brief: { allowedChanges: ["price"], visualTreatment: "ai_refinement" },
      ledger: { spans: [{ text: "HK$999", kind: "price", basis: "knowledge:fact_price" }] }
    });
    expect(result.ok).toBe(true);
    expect(result.issues.some((entry) => entry.severity === "block")).toBe(false);
  });

  it("blocks the same derived draft when the new price has no basis", () => {
    const result = validateGrounded({
      source,
      draft: derivedCaption,
      brief: { allowedChanges: ["price"], visualTreatment: "ai_refinement" },
      ledger: { spans: [] }
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "ungrounded_span", severity: "block" }));
  });

  it("blocks a spoken-form token on the grounded path as house policy", () => {
    const result = validateGrounded({
      source,
      draft: "呢個係新價錢HK$999，立即購買。",
      brief: { allowedChanges: ["price"] },
      ledger: { spans: [{ text: "HK$999", kind: "price", basis: "owner:confirm_1" }] }
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "spoken_form_detected", severity: "block" }));
  });

  it("blocks an unknown basis form rather than ignoring it", () => {
    const result = validateGrounded({
      source,
      draft: derivedCaption,
      brief: { allowedChanges: ["price"] },
      ledger: { spans: [{ text: "HK$999", kind: "price", basis: "memory:fact_price" }] }
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "unknown_basis", severity: "block" }));
  });

  it("blocks a source: basis that contradicts the cited item", () => {
    const result = validateGrounded({
      source,
      draft: derivedCaption,
      brief: { allowedChanges: ["price"] },
      ledger: { spans: [{ text: "HK$999", kind: "price", basis: "source:instagram:IG_MAIN:p1" }] }
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "source_basis_mismatch", severity: "block" }));
  });
});

describe("normalizeLedger", () => {
  it("keeps recognised spans and media provenance and drops the rest", () => {
    expect(
      normalizeLedger({
        spans: [
          { text: "HK$999", kind: "price", basis: "knowledge:fact_price" },
          { text: "   ", kind: "price", basis: "knowledge:empty" },
          { text: "#sale", kind: "hashtag", basis: "owner:confirm_1" },
          { text: "emoji", kind: "emoji", basis: "knowledge:x" },
          { text: "HK$1", kind: "price", basis: "memory:x" }
        ],
        media: [
          { ref: "asset-1", provenance: "source" },
          { ref: "asset-2", provenance: "derived-from:asset-1", derivedFrom: "asset-1" },
          { ref: "asset-3", provenance: "original" },
          { ref: "", provenance: "original" },
          { ref: "asset-4", provenance: "generated" }
        ]
      })
    ).toEqual({
      spans: [
        { text: "HK$999", kind: "price", basis: "knowledge:fact_price" },
        { text: "#sale", kind: "hashtag", basis: "owner:confirm_1" },
        { text: "HK$1", kind: "price", basis: "memory:x" }
      ],
      media: [
        { ref: "asset-1", provenance: "source" },
        { ref: "asset-2", provenance: "derived-from:asset-1", derivedFrom: "asset-1" },
        { ref: "asset-3", provenance: "original" }
      ]
    });
  });

  it("turns protectedOverrides into owner: ledger spans", () => {
    expect(
      ledgerFromProtectedOverrides([
        { literal: "HK$999", reason: "owner correction", approvedBy: "owner_1", approvedAt: "2026-09-09T00:00:00.000Z" }
      ])
    ).toEqual({
      spans: [
        {
          text: "HK$999",
          kind: "price",
          basis: "owner:owner_1",
          reason: "owner correction",
          approvedBy: "owner_1",
          approvedAt: "2026-09-09T00:00:00.000Z"
        }
      ],
      media: []
    });
  });
});

describe("rightsObligation", () => {
  it("does not require confirmation for an original-only ledger", () => {
    expect(
      rightsObligation({
        ledger: { spans: [{ text: "HK$999", kind: "price", basis: "knowledge:fact_price" }], media: [{ ref: "gen-1", provenance: "original" }] },
        sourceOrigin: "binding"
      })
    ).toMatchObject({ required: false, relationship: "inspiration" });
  });

  it("requires confirmation when the ledger reuses the source photo", () => {
    expect(
      rightsObligation({
        ledger: { spans: [], media: [{ ref: "source-media", provenance: "source" }] },
        sourceOrigin: "binding"
      })
    ).toMatchObject({ required: true, relationship: "reuse" });
  });

  it("treats an empty ledger as republication, so localization still requires confirmation", () => {
    expect(rightsObligation({ ledger: { spans: [], media: [] }, sourceOrigin: "binding" })).toMatchObject({
      required: true,
      relationship: "reuse"
    });
  });

  it("forces confirmation for an open source even when the ledger is original-only", () => {
    expect(
      rightsObligation({
        ledger: { media: [{ ref: "gen-1", provenance: "original" }] },
        sourceOrigin: "open"
      })
    ).toMatchObject({ required: true });
  });
});

describe("validateRevisionDraft routing", () => {
  it("still blocks an altered price on the localization path", () => {
    const result = validateRevisionDraft({
      source: { text: "Get the HK$1,299 bundle now." },
      draft: "宣傳優惠：套裝價錢係HK$999，立即購買。",
      brief: { visualTreatment: "keep_original", allowedChanges: [] },
      policy: {}
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "protected_literal_altered", severity: "block" })
    );
  });

  it("applies the zh-HK register check on both paths", () => {
    const spoken = "呢個係我哋嘅新產品，大家快啲嚟睇吓啦。";
    const localized = validateRevisionDraft({
      source: {},
      draft: spoken,
      brief: { visualTreatment: "keep_original" }
    });
    const grounded = validateRevisionDraft({
      source: {},
      draft: spoken,
      brief: { allowedChanges: ["copy"] },
      ledger: { spans: [] }
    });
    expect(localized.issues).toContainEqual(expect.objectContaining({ code: "spoken_form_detected", severity: "block" }));
    expect(grounded.issues).toContainEqual(expect.objectContaining({ code: "spoken_form_detected", severity: "block" }));
  });
});

describe("poster layout and PNG constraints", () => {
  it("accepts a valid layout", () => {
    const result = validatePosterLayout({
      template: "1080x1080",
      headline: "New Arrivals",
      subline: "Shop the new season",
      background: { kind: "solid", value: "#FFFFFF" },
      textColor: "#000000",
      align: "center"
    });
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("rejects an invalid layout with one issue per problem", () => {
    const result = validatePosterLayout({ template: "bogus" });
    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "poster_template_invalid",
        "poster_headline_required",
        "poster_background_invalid",
        "poster_text_color_required",
        "poster_align_invalid"
      ])
    );
  });

  it("declares the two supported templates in posterLayoutSchema", () => {
    expect(posterLayoutSchema.template.enum.sort()).toEqual(["1080x1080", "1080x1350"]);
  });

  it("returns fixed pixel dimensions and a byte cap per template", () => {
    expect(posterPngConstraints("1080x1080")).toEqual({ width: 1_080, height: 1_080, maxBytes: 2_000_000 });
    expect(posterPngConstraints("1080x1350")).toEqual({ width: 1_080, height: 1_350, maxBytes: 2_000_000 });
  });

  it("throws for an unknown template", () => {
    expect(() => posterPngConstraints("999x999")).toThrow(/Unknown poster template/);
  });
});

describe("duplicateKey and revisionCas", () => {
  it("builds a stable key from a source item id and destination binding", () => {
    expect(duplicateKey("item-1", "FB_DEST")).toBe("item-1::FB_DEST");
  });

  it("throws when either half is missing", () => {
    expect(() => duplicateKey("", "FB_DEST")).toThrow();
    expect(() => duplicateKey("item-1", "")).toThrow();
  });

  it("passes compare-and-set only when current matches expected", () => {
    expect(revisionCas(3, 3)).toEqual({ ok: true, current: 3 });
    expect(revisionCas(3, 4)).toEqual({ ok: false, current: 3 });
    expect(revisionCas(undefined, null)).toEqual({ ok: true, current: null });
  });
});

describe("GUD-002: the model's own zh-HK copy is written Chinese, never spoken", () => {
  it("has an en / zh-HK pair for every message key with no spoken-form token in the zh-HK text", () => {
    for (const [key, entry] of Object.entries(messages)) {
      expect(typeof entry.en).toBe("string");
      expect(entry.en.length).toBeGreaterThan(0);
      const zh = entry["zh-HK"];
      expect(typeof zh, `messages.${key} is missing its zh-HK counterpart`).toBe("string");
      expect(zh.length).toBeGreaterThan(0);
      for (const token of SPOKEN_FORM_TOKENS) {
        expect(zh.includes(token), `messages.${key}["zh-HK"] reads as spoken Cantonese (${token}): ${zh}`).toBe(false);
      }
    }
  });

  it("contains no spoken-form token anywhere in model.js outside its own detection list", () => {
    const source = readFileSync(MODEL_PATH, "utf8");
    const lines = source.split("\n").filter((line) => !line.includes("SPOKEN_FORM_TOKENS = ["));
    const rest = lines.join("\n");
    for (const token of SPOKEN_FORM_TOKENS) {
      expect(rest.includes(token), `model.js contains the spoken-form token ${token} outside its detection list`).toBe(
        false
      );
    }
  });
});

/**
 * REQ-028: "a bounded `exportAs("json")` of items, batches and revisions
 * without media bytes, WITHIN THE EXISTING 8 MiB EXPORT CAP".
 *
 * The cap is not a suggestion the host trims to. `readGadgetExport`
 * (`src/domains/gadgets/gadget-capabilities.ts`) REFUSES a body over
 * `MAX_GADGET_EXPORT_BODY_BYTES` and returns null, which the owner sees as
 * the gadget's export "not coming back in a usable shape" — the whole export,
 * gone, for being one byte too big. So the gadget has to arrive under it, and
 * say what it left out when it does.
 *
 * Bounded HERE rather than in `server.js` because it is arithmetic over
 * arrays with no I/O in it, which is what `model.js` is for (PAT-002) — and
 * because proving an 8 MiB cap needs a fixture nobody wants to build inside a
 * facet.
 */
describe("REQ-028: the JSON export is bounded by bytes, not only by count", () => {
  const payload = (over: Partial<Record<"items" | "batches" | "revisions", unknown[]>> = {}) => ({
    items: over.items ?? [],
    batches: over.batches ?? [],
    revisions: over.revisions ?? []
  });

  it("names its own limits, including the host's export cap", () => {
    expect(exportBounds.bytes).toBe(8 * 1024 * 1024);
    expect(exportBounds.items).toBeGreaterThan(0);
    expect(exportBounds.batches).toBeGreaterThan(0);
    expect(exportBounds.revisions).toBeGreaterThan(0);
  });

  it("reports nothing dropped when everything fits", () => {
    const bounded = boundExport(payload({ items: [{ id: "i1" }], batches: [{ id: "b1" }] }), {
      items: 1,
      batches: 1,
      revisions: 0
    });
    const parsed = JSON.parse(bounded.body) as { items: unknown[]; truncated: Record<string, unknown> };
    expect(parsed.items).toHaveLength(1);
    expect(parsed.truncated).toEqual({
      items: 0,
      batches: 0,
      revisions: 0,
      reachedByteLimit: false,
      limits: exportBounds
    });
  });

  it("says how many rows the count caps left behind, rather than dropping them silently", () => {
    const bounded = boundExport(payload({ items: [{ id: "i1" }] }), { items: 4321, batches: 0, revisions: 0 });
    const parsed = JSON.parse(bounded.body) as { truncated: { items: number } };
    expect(parsed.truncated.items).toBe(4320);
  });

  /**
   * One revision per 64 KiB of caption, 200 of them: 12.8 MiB of captions
   * against an 8 MiB cap. The point is the BODY, not the count — every one of
   * these is inside `exportBounds.revisions`.
   */
  it("sheds rows until the serialized body is under the cap, and marks that it did", () => {
    const caption = "本".repeat(64 * 1024);
    const revisions = Array.from({ length: 200 }, (_, index) => ({ batchItemId: `bi${index}`, revision: 1, caption }));
    const bounded = boundExport(payload({ revisions }), { items: 0, batches: 0, revisions: revisions.length });

    expect(new TextEncoder().encode(bounded.body).byteLength).toBeLessThanOrEqual(exportBounds.bytes);
    const parsed = JSON.parse(bounded.body) as {
      revisions: unknown[];
      truncated: { revisions: number; reachedByteLimit: boolean };
    };
    expect(parsed.truncated.reachedByteLimit).toBe(true);
    expect(parsed.revisions.length).toBeLessThan(revisions.length);
    expect(parsed.truncated.revisions).toBe(revisions.length - parsed.revisions.length);
    // Not everything: a cap that empties the export is a cap that lost it.
    expect(parsed.revisions.length).toBeGreaterThan(0);
  });

  it("sheds revisions before batches and batches before items, so the export keeps its spine", () => {
    const caption = "本".repeat(64 * 1024);
    const bounded = boundExport(
      payload({
        items: Array.from({ length: 4 }, (_, index) => ({ id: `i${index}` })),
        batches: Array.from({ length: 4 }, (_, index) => ({ id: `b${index}` })),
        revisions: Array.from({ length: 200 }, (_, index) => ({ batchItemId: `bi${index}`, caption }))
      }),
      { items: 4, batches: 4, revisions: 200 }
    );
    const parsed = JSON.parse(bounded.body) as { items: unknown[]; batches: unknown[]; revisions: unknown[] };
    expect(parsed.items).toHaveLength(4);
    expect(parsed.batches).toHaveLength(4);
    expect(parsed.revisions.length).toBeLessThan(200);
  });

  it("still returns readable JSON when a single row is larger than the whole cap", () => {
    const revisions = [{ batchItemId: "bi0", caption: "本".repeat(4 * 1024 * 1024) }];
    const bounded = boundExport(payload({ revisions }), { items: 0, batches: 0, revisions: 1 });
    const parsed = JSON.parse(bounded.body) as { revisions: unknown[]; truncated: { revisions: number } };
    expect(new TextEncoder().encode(bounded.body).byteLength).toBeLessThanOrEqual(exportBounds.bytes);
    expect(parsed.revisions).toEqual([]);
    expect(parsed.truncated.revisions).toBe(1);
  });
});
