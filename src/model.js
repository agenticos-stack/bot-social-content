// Social Localization blueprint — pure model.
//
// No imports beyond the platform (crypto.subtle for SHA-256 hashing). This
// file has no I/O beyond reading the system clock and the platform crypto
// API, so it is bundled unchanged into both the sandboxed client and the
// facet server, and is unit-testable in plain node (PAT-002).
//
// SourceItem shape (REQ-004): the common record both providers normalize
// into.
//   {
//     id,                 // `${provider}:${sourceBinding}:${providerItemId}`
//     provider,            // "instagram" | "facebook"
//     sourceBinding,        // the granted connector door's env binding name
//     sourceLabel,          // the binding's owner-chosen label
//     providerItemId,       // the provider's own id for the item
//     authorHandle,         // string | null, bounded to 100 chars
//     permalink,            // string | null, bounded to 2048 chars
//     publishedAt,          // ISO 8601 string | null
//     text,                 // string, bounded to 5000 chars
//     locale,               // null unless the provider reports one
//     media,                // { id, kind, url, width?, height?, alt? }[]
//     metrics,              // { likes, comments, shares, views }, each number | null
//     contentHash,          // SHA-256 hex over the stable fields (see contentHash())
//     firstSeenAt,          // ISO 8601 string, set at normalization/retrieval time
//     lastSeenAt            // ISO 8601 string, set at normalization/retrieval time
//   }

const MAX_MEDIA_PER_ITEM = 10;
const MAX_CAPTION_CHARS = 5_000;
const MAX_HANDLE_CHARS = 100;
const MAX_URL_CHARS = 2_048;
const DEFAULT_MIN_CHINESE_SHARE = 0.3;
const POSTER_MAX_BYTES = 2_000_000; // SQLite row-size headroom, CON-009.
const REFINEMENT_BRIEF_VERSION = 1;
const VISUAL_MODES = ["keep_original", "text_poster", "ai_refinement"];

/**
 * Written zh-HK product copy must never contain these — see AGENTS.md and
 * studio/scripts/i18n-diff.mjs, whose register list this mirrors. Also used
 * by validateLocalization() to block a draft written in spoken Cantonese.
 */
const SPOKEN_FORM_TOKENS = ["嘅", "咗", "唔", "呢個", "邊個", "幾多", "睇", "喺", "嗰"];

const POSTER_TEMPLATES = Object.freeze({
  "1080x1350": Object.freeze({ width: 1_080, height: 1_350 }),
  "1080x1080": Object.freeze({ width: 1_080, height: 1_080 })
});

const CJK_PATTERN = /[㐀-鿿豈-﫿]/;
const HALFWIDTH_PUNCTUATION = /[,.!?;:'"()]/;
const PRICE_PATTERN = /(?:HK\$|US\$|\$)\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g;
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;
const HASHTAG_PATTERN = /#[\p{L}\p{N}_]+/gu;

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Bounded, data-only refinement instructions. Source text is never merged into this object. */
export function normalizeRefinementBrief(input) {
  const value = record(input) ?? {};
  const list = (candidate, max, itemMax = 200) =>
    (Array.isArray(candidate) ? candidate : [])
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.trim().slice(0, itemMax))
      .filter(Boolean)
      .slice(0, max);
  const text = (candidate, max) => (typeof candidate === "string" ? candidate.trim().slice(0, max) : "");
  const visualTreatment = VISUAL_MODES.includes(value.visualTreatment) ? value.visualTreatment : "keep_original";
  return {
    version: REFINEMENT_BRIEF_VERSION,
    targetLanguage: text(value.targetLanguage, 40) || "zh-HK",
    register: text(value.register, 80) || "written",
    tone: text(value.tone, 120),
    allowedChanges: list(value.allowedChanges, 20),
    protectedTerms: list(value.protectedTerms, 100),
    protectedFacts: list(value.protectedFacts, 100),
    protectedClaims: list(value.protectedClaims, 100),
    callToAction: text(value.callToAction, 300) || null,
    visualTreatment
  };
}

export function normalizeProtectedOverrides(input) {
  const list = Array.isArray(input) ? input : [];
  return list
    .map((entry) => {
      const value = record(entry);
      if (!value || typeof value.literal !== "string" || !value.literal.trim()) return null;
      return {
        literal: value.literal.trim().slice(0, 500),
        reason: typeof value.reason === "string" ? value.reason.trim().slice(0, 500) : "",
        approvedBy: typeof value.approvedBy === "string" ? value.approvedBy.trim().slice(0, 200) : "",
        approvedAt: typeof value.approvedAt === "string" ? value.approvedAt.trim().slice(0, 80) : ""
      };
    })
    .filter(Boolean)
    .slice(0, 100);
}

export function normalizeAssetRefs(input, source = "original") {
  const list = Array.isArray(input) ? input : [];
  return list
    .map((entry) => {
      const value = record(entry);
      if (!value || typeof value.assetId !== "string" || !value.assetId.trim()) return null;
      return {
        assetId: value.assetId.trim().slice(0, 200),
        kind: typeof value.kind === "string" ? value.kind.trim().slice(0, 40) : "image",
        url: typeof value.url === "string" ? value.url.trim().slice(0, MAX_URL_CHARS) : null,
        // The containing revision field defines the role, not a redundant caller label.
        source
      };
    })
    .filter(Boolean)
    .slice(0, MAX_MEDIA_PER_ITEM);
}

const GENERATED_MEDIA_PATH = /^\/v1\/media\/[^/]+\/assets\/[^/]+\/?$/;

/**
 * TASK-026: Meta fetches `image_url` / `video_url` with no AgenticOS session.
 * `GET /v1/media/:jobId/assets/:idx` is org-auth + Drive ACL, so it is not
 * publisher-addressable. Do not mint a public URL as a workaround (SEC-006).
 */
export function isPublisherAddressableUrl(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return false;
  return !GENERATED_MEDIA_PATH.test(parsed.pathname);
}

function doorMediaEntry(entry) {
  const value = record(entry);
  if (!value) return null;
  const assetId =
    typeof value.assetId === "string" && value.assetId.trim()
      ? value.assetId.trim().slice(0, 200)
      : typeof value.id === "string" && value.id.trim()
        ? value.id.trim().slice(0, 200)
        : "";
  if (!assetId) return null;
  const url = typeof value.url === "string" ? value.url.trim().slice(0, MAX_URL_CHARS) : "";
  return {
    assetId,
    url,
    kind: value.kind === "video" ? "video" : "image"
  };
}

function packDoorMedia(entries) {
  const media = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const packed = doorMediaEntry(entry);
    if (!packed) continue;
    if (!isPublisherAddressableUrl(packed.url)) {
      return {
        ok: false,
        code: "media_unaddressable",
        message:
          "Every media item needs a publisher-addressable https url. Generated assets at /v1/media/:id/assets/:idx cannot be fetched by the publisher."
      };
    }
    media.push(packed);
  }
  return { ok: true, media };
}

/**
 * Phase 1 (TASK-027): derived refs when they are publisher-addressable,
 * otherwise the source item's own media. Generated media-job URLs refuse.
 */
export function publicationMedia({ derivedMediaRefs, sourceMedia } = {}) {
  const derived = Array.isArray(derivedMediaRefs) ? derivedMediaRefs : [];
  if (derived.length > 0) return packDoorMedia(derived);
  return packDoorMedia(sourceMedia);
}

export function normalizePublicationIntent(input) {
  if (input === undefined) {
    return {
      ok: true,
      intent: {
        publishMode: "save_draft",
        publishLocalTime: null,
        timezone: null,
        utcOffsetMinutes: null,
        latePolicy: "hold",
        lateThresholdMinutes: 15
      }
    };
  }
  const value = record(input);
  if (!value)
    return { ok: false, code: "publication_intent_invalid", message: "Publication intent must be an object." };
  if (value.latePolicy !== undefined && value.latePolicy !== "hold") {
    return { ok: false, code: "publication_intent_invalid", message: "Social Content requires latePolicy hold. Review late posts before publishing." };
  }
  if (!["save_draft", "publish_now", "schedule"].includes(value.publishMode)) {
    return {
      ok: false,
      code: "publication_intent_invalid",
      message: "Publication intent has an unknown publish mode."
    };
  }
  const publishMode = value.publishMode;
  const local = typeof value.publishLocalTime === "string" ? value.publishLocalTime.trim().slice(0, 25) : null;
  const timezone = typeof value.timezone === "string" ? value.timezone.trim().slice(0, 64) : null;
  if (publishMode === "schedule" && (!local || !timezone)) {
    return {
      ok: false,
      code: "publication_intent_invalid",
      message: "A scheduled intent needs local time and timezone."
    };
  }
  if (publishMode !== "schedule" && (local || timezone)) {
    return { ok: false, code: "publication_intent_invalid", message: "Only scheduled intent may carry a time." };
  }
  return {
    ok: true,
    intent: {
      publishMode,
      publishLocalTime: local,
      timezone,
      utcOffsetMinutes: typeof value.utcOffsetMinutes === "number" ? value.utcOffsetMinutes : null,
      latePolicy: "hold",
      lateThresholdMinutes: Number.isInteger(value.lateThresholdMinutes)
        ? Math.max(0, Math.min(1440, value.lateThresholdMinutes))
        : 15
    }
  };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasCJK(value) {
  return CJK_PATTERN.test(value);
}

function isCJK(char) {
  return CJK_PATTERN.test(char);
}

function makeCounter() {
  const counts = new Map();
  return {
    add(reason, amount = 1) {
      counts.set(reason, (counts.get(reason) || 0) + amount);
    },
    toDropped() {
      return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
    }
  };
}

/** Trims, drops empty to null, and bounds length while counting truncation. */
function boundOrNull(counter, reason, value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= max) return trimmed;
  counter.add(reason);
  return trimmed.slice(0, max);
}

/** Bounds a caption's length without trimming its internal formatting. */
function boundCaption(counter, value, max = MAX_CAPTION_CHARS) {
  const str = typeof value === "string" ? value : "";
  if (str.length <= max) return str;
  counter.add("caption_truncated");
  return str.slice(0, max);
}

/** Parses a Graph/IG timestamp (with or without a colon in its offset) to ISO 8601, or null. */
function isoOrNull(value) {
  if (typeof value === "string" && value) {
    const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const date = new Date(normalized);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 1e12 ? value * 1_000 : value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

function extractCursor(page) {
  const paging = record(record(page)?.paging);
  const cursors = record(paging?.cursors);
  const after = cursors?.after;
  return typeof after === "string" && after ? after : null;
}

/** Validates the caller-supplied source binding this page was read through. */
function requireSource(source, provider) {
  const input = record(source);
  if (!input || typeof input.binding !== "string" || !input.binding.trim()) {
    throw new Error(`${provider} normalization requires source.binding.`);
  }
  if (typeof input.label !== "string" || !input.label.trim()) {
    throw new Error(`${provider} normalization requires source.label.`);
  }
  return {
    binding: input.binding.trim(),
    label: input.label.trim(),
    pageId: typeof input.pageId === "string" && input.pageId.trim() ? input.pageId.trim() : undefined
  };
}

// ---------------------------------------------------------------------------
// 1. Provider normalizers
// ---------------------------------------------------------------------------

function instagramMediaEntries(media, counter) {
  const mediaType = typeof media.media_type === "string" ? media.media_type : "";
  if (mediaType === "CAROUSEL_ALBUM") {
    const children = record(media.children)?.data;
    const list = Array.isArray(children) ? children : [];
    if (list.length > MAX_MEDIA_PER_ITEM) counter.add("media_truncated", list.length - MAX_MEDIA_PER_ITEM);
    return list.slice(0, MAX_MEDIA_PER_ITEM).flatMap((raw, index) => {
      const child = record(raw);
      const url = child && typeof child.media_url === "string" ? child.media_url : null;
      if (!child || !url) return [];
      return [
        {
          id: typeof child.id === "string" && child.id ? child.id : `carousel-${index + 1}`,
          kind: "carousel_child",
          url: boundOrNull(counter, "url_truncated", url, MAX_URL_CHARS)
        }
      ];
    });
  }
  const url =
    typeof media.media_url === "string"
      ? media.media_url
      : typeof media.thumbnail_url === "string"
        ? media.thumbnail_url
        : null;
  if (!url) return [];
  return [
    {
      id: typeof media.id === "string" && media.id ? media.id : "media-1",
      kind: mediaType === "VIDEO" ? "video" : "image",
      url: boundOrNull(counter, "url_truncated", url, MAX_URL_CHARS)
    }
  ];
}

/** Normalizes an `instagram.list_media` page (INSTAGRAM_GET_IG_USER_MEDIA) into SourceItems. */
export async function normalizeInstagramMedia(page, source) {
  const normalizedSource = requireSource(source, "instagram");
  const counter = makeCounter();
  const rawItems = Array.isArray(record(page)?.data) ? record(page).data : [];
  const now = new Date().toISOString();
  const items = [];

  for (const raw of rawItems) {
    const media = record(raw);
    if (!media || typeof media.id !== "string" || !media.id) {
      counter.add("missing_id");
      continue;
    }
    const item = {
      id: `instagram:${normalizedSource.binding}:${media.id}`,
      provider: "instagram",
      sourceBinding: normalizedSource.binding,
      sourceLabel: normalizedSource.label,
      providerItemId: media.id,
      authorHandle: boundOrNull(counter, "handle_truncated", media.username, MAX_HANDLE_CHARS),
      permalink: boundOrNull(counter, "url_truncated", media.permalink, MAX_URL_CHARS),
      publishedAt: isoOrNull(media.timestamp),
      text: boundCaption(counter, media.caption),
      locale: null,
      media: instagramMediaEntries(media, counter),
      metrics: {
        likes: isFiniteNumber(media.like_count) ? media.like_count : null,
        comments: isFiniteNumber(media.comments_count) ? media.comments_count : null,
        shares: null,
        views: null
      },
      contentHash: null,
      firstSeenAt: now,
      lastSeenAt: now
    };
    item.contentHash = await contentHash(item);
    items.push(item);
  }

  return { items, nextCursor: extractCursor(page), dropped: counter.toDropped() };
}

function facebookAttachmentEntries(post, counter) {
  const attachments = record(post.attachments)?.data;
  const list = Array.isArray(attachments) ? attachments : [];
  const entries = [];
  for (const raw of list) {
    const attachment = record(raw);
    if (!attachment) continue;
    const subs = record(attachment.subattachments)?.data;
    if (Array.isArray(subs) && subs.length) {
      for (const rawSub of subs) {
        const sub = record(rawSub);
        const image = record(sub?.media)?.image;
        const url = typeof image?.src === "string" ? image.src : null;
        if (!url) continue;
        entries.push({ url, kind: "carousel_child" });
      }
      continue;
    }
    const image = record(attachment.media)?.image;
    const url = typeof image?.src === "string" ? image.src : typeof attachment.url === "string" ? attachment.url : null;
    if (!url) continue;
    const kind = attachment.media_type === "video" || attachment.type === "video_inline" ? "video" : "image";
    entries.push({ url, kind });
  }
  if (!entries.length && typeof post.full_picture === "string" && post.full_picture) {
    entries.push({ url: post.full_picture, kind: "image" });
  }
  if (entries.length > MAX_MEDIA_PER_ITEM) counter.add("media_truncated", entries.length - MAX_MEDIA_PER_ITEM);
  return entries.slice(0, MAX_MEDIA_PER_ITEM).map((entry, index) => ({
    id: `fb-media-${index + 1}`,
    kind: entry.kind,
    url: boundOrNull(counter, "url_truncated", entry.url, MAX_URL_CHARS)
  }));
}

/**
 * Normalizes a `facebook.list_page_posts` page (FACEBOOK_GET_PAGE_POSTS,
 * `/feed` edge) into SourceItems, keeping only posts that are published and
 * authored by the connected Page (TASK-037 finding, REQ-003).
 */
export async function normalizeFacebookPagePosts(page, source) {
  const normalizedSource = requireSource(source, "facebook");
  if (!normalizedSource.pageId) {
    throw new Error("facebook normalization requires source.pageId.");
  }
  const counter = makeCounter();
  const rawPosts = Array.isArray(record(page)?.data) ? record(page).data : [];
  const now = new Date().toISOString();
  const items = [];

  for (const raw of rawPosts) {
    const post = record(raw);
    if (!post || typeof post.id !== "string" || !post.id) {
      counter.add("missing_id");
      continue;
    }
    if (post.is_published !== true) {
      counter.add("unpublished");
      continue;
    }
    const authorId = record(post.from)?.id;
    if (authorId !== normalizedSource.pageId) {
      counter.add("not_page_author");
      continue;
    }
    const captionSource =
      typeof post.message === "string" ? post.message : typeof post.story === "string" ? post.story : "";
    const item = {
      id: `facebook:${normalizedSource.binding}:${post.id}`,
      provider: "facebook",
      sourceBinding: normalizedSource.binding,
      sourceLabel: normalizedSource.label,
      providerItemId: post.id,
      authorHandle: boundOrNull(counter, "handle_truncated", record(post.from)?.name, MAX_HANDLE_CHARS),
      permalink: boundOrNull(counter, "url_truncated", post.permalink_url, MAX_URL_CHARS),
      publishedAt: isoOrNull(post.created_time),
      text: boundCaption(counter, captionSource),
      locale: null,
      media: facebookAttachmentEntries(post, counter),
      metrics: { likes: null, comments: null, shares: null, views: null },
      contentHash: null,
      firstSeenAt: now,
      lastSeenAt: now
    };
    item.contentHash = await contentHash(item);
    items.push(item);
  }

  return { items, nextCursor: extractCursor(page), dropped: counter.toDropped() };
}

// ---------------------------------------------------------------------------
// 3. Content hash
// ---------------------------------------------------------------------------

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The stable half of a media URL.
 *
 * A CDN delivery URL is not an identity. Instagram's carry a signature and an
 * expiry in the query (`oh`, `oe`, `_nc_ohc`, `_nc_gid`) and rotate their edge
 * host between fetches — `scontent-phl2-1` one hour, `scontent-lga3-2` the
 * next. Hashing the whole URL therefore made every item differ from itself on
 * every scan: a second scan of an account that had published nothing reported
 * 100 changed and 0 unchanged, which makes "what is new since yesterday"
 * meaningless and would notify an owner about posts nobody touched.
 *
 * The PATH is the object key and is stable — verified against two fetches of
 * the same account hours apart, where every path matched and no host did.
 *
 * A path that carries no identity (empty, or "/") falls back to the whole URL.
 * Losing identity is the worse direction: a hash that cannot tell two assets
 * apart reports a real edit as unchanged, and silence is harder to notice than
 * noise.
 */
function mediaIdentity(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    const { pathname } = new URL(url);
    return pathname && pathname !== "/" ? pathname : url;
  } catch {
    return url;
  }
}

/**
 * SHA-256 hex over a canonical JSON of [provider, providerItemId, text,
 * media ids/paths in order, publishedAt] — deliberately excludes metrics and
 * the firstSeenAt/lastSeenAt/contentHash fields, so retrieving the same item
 * again never changes its hash. Async because crypto.subtle is.
 */
export async function contentHash(item) {
  const media = Array.isArray(item?.media) ? item.media : [];
  const canonical = JSON.stringify({
    provider: item?.provider ?? null,
    providerItemId: item?.providerItemId ?? null,
    text: item?.text ?? "",
    media: media.map((entry) => ({ id: entry?.id ?? null, url: mediaIdentity(entry?.url) })),
    publishedAt: item?.publishedAt ?? null
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return toHex(new Uint8Array(digest));
}

/**
 * SHA-256 hex over any JSON-serializable value. General-purpose sibling of
 * `contentHash()` (which is specifically the SourceItem field set) — used by
 * `server.js` to hash a localized VERSION (caption, poster layout,
 * destination, origin reference) for SEC-005's "exact ... content hash is the
 * single input to approval preview, decision record, dispatcher, receipt and
 * audit".
 */
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return toHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// 4. Protected literal detection
// ---------------------------------------------------------------------------

function normalizeTermList(list) {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [{ value: entry, allowSubstring: false }];
    const item = record(entry);
    const value = typeof item?.value === "string" ? item.value : null;
    if (!value) return [];
    return [{ value, allowSubstring: item.allowSubstring === true }];
  });
}

function normalizeHashtag(tag) {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  return (trimmed.startsWith("#") ? trimmed : `#${trimmed}`).toLowerCase();
}

/** True unless a word-character sits immediately before or after the match. */
function isWordBoundaryMatch(input, start, end) {
  const before = start > 0 ? input[start - 1] : "";
  const after = end < input.length ? input[end] : "";
  const wordChar = /[A-Za-z0-9]/;
  if (before && wordChar.test(before)) return false;
  if (after && wordChar.test(after)) return false;
  return true;
}

function pushTermMatches(spans, input, term, kind) {
  const { value, allowSubstring } = term;
  if (!value) return;
  const substring = allowSubstring === true || hasCJK(value);
  let from = 0;
  for (;;) {
    const index = input.indexOf(value, from);
    if (index === -1) break;
    const end = index + value.length;
    if (substring || isWordBoundaryMatch(input, index, end)) {
      spans.push({ start: index, end, kind, value });
    }
    from = index + 1;
  }
}

/**
 * Finds product names, prices, URLs, protected hashtags, disclaimers and
 * claims in `text`. A `policy.protectedTerms` / `disclaimers` /
 * `claimsRequiringConfirmation` entry may be a plain string (word-boundary
 * matched, unless it contains CJK) or `{ value, allowSubstring: true }` to
 * match even inside a longer word.
 */
export function detectProtectedLiterals(text, policy = {}) {
  const input = typeof text === "string" ? text : "";
  const spans = [];
  if (!input) return spans;

  for (const term of normalizeTermList(policy.protectedTerms)) {
    pushTermMatches(spans, input, term, "product");
  }

  for (const match of input.matchAll(PRICE_PATTERN)) {
    spans.push({ start: match.index, end: match.index + match[0].length, kind: "price", value: match[0] });
  }

  for (const match of input.matchAll(URL_PATTERN)) {
    spans.push({ start: match.index, end: match.index + match[0].length, kind: "url", value: match[0] });
  }

  const protectedHashtags = new Set(
    (Array.isArray(policy.protectedHashtags) ? policy.protectedHashtags : []).map(normalizeHashtag).filter(Boolean)
  );
  if (protectedHashtags.size) {
    for (const match of input.matchAll(HASHTAG_PATTERN)) {
      if (protectedHashtags.has(match[0].toLowerCase())) {
        spans.push({ start: match.index, end: match.index + match[0].length, kind: "hashtag", value: match[0] });
      }
    }
  }

  for (const term of normalizeTermList(policy.disclaimers)) {
    pushTermMatches(spans, input, { ...term, allowSubstring: true }, "disclaimer");
  }

  for (const term of normalizeTermList(policy.claimsRequiringConfirmation)) {
    pushTermMatches(spans, input, { ...term, allowSubstring: true }, "claim");
  }

  return spans.sort((left, right) => left.start - right.start);
}

// ---------------------------------------------------------------------------
// 5. zh-HK validation
// ---------------------------------------------------------------------------

function chineseCharacterShare(text) {
  const chars = [...text].filter((char) => /\S/.test(char));
  if (!chars.length) return 0;
  return chars.filter((char) => isCJK(char)).length / chars.length;
}

function findHalfwidthPunctuationSpan(text) {
  for (let index = 1; index < text.length - 1; index += 1) {
    const char = text[index];
    if (!HALFWIDTH_PUNCTUATION.test(char)) continue;
    if (isCJK(text[index - 1]) && isCJK(text[index + 1])) {
      return { start: index, end: index + 1 };
    }
  }
  return null;
}

function issue(code, severity, message, span) {
  const entry = { code, severity, message };
  if (span) entry.span = { start: span.start, end: span.end };
  return entry;
}

function housePolicyIssues(trimmed, policy, limits) {
  const issues = [];
  const minShare = isFiniteNumber(policy.minChineseShare) ? policy.minChineseShare : DEFAULT_MIN_CHINESE_SHARE;
  if (chineseCharacterShare(trimmed) < minShare) {
    issues.push(issue("low_chinese_share", "block", messages.lowChineseShare.en));
  }

  const spokenForm = SPOKEN_FORM_TOKENS.find((token) => trimmed.includes(token));
  if (spokenForm) {
    issues.push(issue("spoken_form_detected", "block", `${messages.spokenFormDetected.en} (${spokenForm})`));
  }

  const halfwidthSpan = findHalfwidthPunctuationSpan(trimmed);
  if (halfwidthSpan) {
    issues.push(issue("halfwidth_punctuation", "note", messages.halfwidthPunctuation.en, halfwidthSpan));
  }

  const captionMax = isFiniteNumber(limits.captionMax) ? limits.captionMax : null;
  if (captionMax !== null && trimmed.length > captionMax) {
    issues.push(issue("caption_too_long", "block", `${messages.captionTooLong.en} (${trimmed.length}/${captionMax})`));
  }

  const hashtagMax = isFiniteNumber(limits.hashtagMax) ? limits.hashtagMax : null;
  const hashtagCount = (trimmed.match(HASHTAG_PATTERN) || []).length;
  if (hashtagMax !== null && hashtagCount > hashtagMax) {
    issues.push(issue("hashtag_count_high", "note", `${messages.hashtagCountHigh.en} (${hashtagCount}/${hashtagMax})`));
  }

  return issues;
}

/**
 * Localization when the brief allows no copy changes and is not ai_refinement.
 * `ai_refinement` or any allowedChanges selects the grounding ledger path.
 */
export function usesGroundedValidation(brief) {
  const normalized = normalizeRefinementBrief(brief);
  return normalized.allowedChanges.length > 0 || normalized.visualTreatment === "ai_refinement";
}

const GROUNDED_SPAN_KINDS = new Set(["price", "url", "hashtag", "disclaimer", "claim"]);
const BASIS_PATTERN = /^(source|knowledge|owner):(.+)$/;

export function parseGroundingBasis(basis) {
  if (typeof basis !== "string") return null;
  const match = BASIS_PATTERN.exec(basis.trim());
  if (!match) return null;
  const id = match[2].trim();
  return id ? { kind: match[1], id } : null;
}

function inferProtectedKind(text) {
  const input = typeof text === "string" ? text.trim() : "";
  if (!input) return null;
  const price = input.match(/(?:HK\$|US\$|\$)\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?/);
  if (price && price[0] === input) return "price";
  const url = input.match(/https?:\/\/[^\s<>"')\]]+/);
  if (url && url[0] === input) return "url";
  if (/^#[\p{L}\p{N}_]+$/u.test(input)) return "hashtag";
  return "claim";
}

function normalizeLedgerSpan(entry) {
  const value = record(entry);
  if (!value) return null;
  const text = typeof value.text === "string" ? value.text.trim().slice(0, 500) : "";
  if (!text || !GROUNDED_SPAN_KINDS.has(value.kind)) return null;
  const span = {
    text,
    kind: value.kind,
    basis: typeof value.basis === "string" ? value.basis.trim().slice(0, 300) : ""
  };
  if (typeof value.reason === "string" && value.reason.trim()) span.reason = value.reason.trim().slice(0, 500);
  if (typeof value.approvedBy === "string" && value.approvedBy.trim()) {
    span.approvedBy = value.approvedBy.trim().slice(0, 200);
  }
  if (typeof value.approvedAt === "string" && value.approvedAt.trim()) {
    span.approvedAt = value.approvedAt.trim().slice(0, 80);
  }
  return span;
}

function normalizeLedgerMedia(entry) {
  const value = record(entry);
  if (!value) return null;
  const ref = typeof value.ref === "string" ? value.ref.trim().slice(0, 200) : "";
  if (!ref) return null;
  const derivedFrom =
    typeof value.derivedFrom === "string" && value.derivedFrom.trim() ? value.derivedFrom.trim().slice(0, 200) : "";
  if (value.provenance === "source" || value.provenance === "original") {
    return { ref, provenance: value.provenance };
  }
  if (typeof value.provenance === "string" && value.provenance.startsWith("derived-from:")) {
    const from = value.provenance.slice("derived-from:".length).trim().slice(0, 200) || derivedFrom;
    if (!from) return null;
    return { ref, provenance: `derived-from:${from}`, derivedFrom: from };
  }
  return null;
}

/** REQ-001: the revision's record of what each protected span and media entry stands on. */
export function normalizeLedger(input) {
  const value = record(input) ?? {};
  return {
    spans: (Array.isArray(value.spans) ? value.spans : []).map(normalizeLedgerSpan).filter(Boolean).slice(0, 200),
    media: (Array.isArray(value.media) ? value.media : []).map(normalizeLedgerMedia).filter(Boolean).slice(0, MAX_MEDIA_PER_ITEM)
  };
}

/** TASK-010: the exception list is the owner: case of the ledger, not a parallel record. */
export function ledgerFromProtectedOverrides(input) {
  return {
    spans: normalizeProtectedOverrides(input)
      .map((entry) => {
        const kind = inferProtectedKind(entry.literal);
        if (!kind) return null;
        const approvedBy = entry.approvedBy || "owner";
        const span = {
          text: entry.literal,
          kind,
          basis: `owner:${approvedBy}`
        };
        if (entry.reason) span.reason = entry.reason;
        if (entry.approvedBy) span.approvedBy = entry.approvedBy;
        if (entry.approvedAt) span.approvedAt = entry.approvedAt;
        return span;
      })
      .filter(Boolean),
    media: []
  };
}

export function applyProtectedOverridesToLedger(ledger, overrides) {
  const normalized = normalizeLedger(ledger);
  const ownerSpans = ledgerFromProtectedOverrides(overrides).spans;
  const kept = normalized.spans.filter((span) => parseGroundingBasis(span.basis)?.kind !== "owner");
  return { spans: [...kept, ...ownerSpans].slice(0, 200), media: normalized.media };
}

function ledgerReusesSource(ledger) {
  const normalized = normalizeLedger(ledger);
  if (normalized.media.some((entry) => entry.provenance === "source" || entry.provenance.startsWith("derived-from:"))) {
    return true;
  }
  return normalized.spans.some((span) => parseGroundingBasis(span.basis)?.kind === "source");
}

/**
 * Rights follow the ledger, not an assumption of republication.
 * Reused source material is gated; original-only is inspiration, recorded
 * and not gated; an `open` source is always gated (TASK-013 / TASK-014).
 * An empty ledger is localization: the source survives, so confirmation is
 * required (RISK-002).
 */
export function rightsObligation({ ledger, sourceOrigin } = {}) {
  const open = sourceOrigin === "open";
  const reuse = ledgerReusesSource(ledger);
  const originalOnly = !reuse && normalizeLedger(ledger).media.some((entry) => entry.provenance === "original");
  return {
    required: open || !originalOnly,
    relationship: originalOnly ? "inspiration" : "reuse"
  };
}

/** PAT-001: the door origin block IS the observation record. */
export function observationOrigin(originLink) {
  const value = record(originLink);
  if (!value) return null;
  return {
    provider: value.provider,
    sourceLabel: value.sourceLabel,
    providerItemId: value.providerItemId,
    permalink: value.permalink,
    sourceContentHash: value.sourceContentHash,
    sourcePublishedAt: value.sourcePublishedAt,
    retrievedAt: value.retrievedAt
  };
}

/** Every field `createDraft` requires as a non-empty string, in the door's own order. */
const DOOR_ORIGIN_FIELDS = Object.freeze([
  "provider",
  "sourceLabel",
  "providerItemId",
  "permalink",
  "sourceContentHash",
  "sourcePublishedAt",
  "retrievedAt"
]);

/**
 * The door's `origin` block, checked against the ledger before it is sent.
 *
 * TASK-015 / PAT-001: attribution and the observation record are one fact
 * stated once. A `source:` basis names the item its span stands on, so a basis
 * naming an item other than the one observed would attribute the post to
 * something it does not stand on — refuse rather than send it. A ledger that
 * cites no source is inspiration-only, which `rightsObligation` reports on its
 * own; the observation record still travels, because it is what was observed.
 *
 * The completeness pass is here because `createDraft` requires all seven fields
 * as non-empty strings and refuses one field at a time, while `origin_links`
 * stores sourceLabel, permalink and sourcePublishedAt as nullable. Naming the
 * missing field here beats an opaque refusal from the far side of the door.
 */
export function draftOrigin({ originLink, ledger, sourceId } = {}) {
  const origin = observationOrigin(originLink);
  if (!origin) {
    return {
      ok: false,
      code: "origin_incomplete",
      message: "This post has no observation record to attribute. Re-run the scan for its source item."
    };
  }
  const item = typeof sourceId === "string" ? sourceId.trim() : "";
  if (item) {
    for (const span of normalizeLedger(ledger).spans) {
      const parsed = parseGroundingBasis(span.basis);
      if (parsed?.kind !== "source" || parsed.id === item) continue;
      return {
        ok: false,
        code: "origin_contradicted",
        message: `The grounding ledger stands on source item ${parsed.id}, but this post is attributed to ${item}. Re-save the revision against its own source.`
      };
    }
  }
  for (const field of DOOR_ORIGIN_FIELDS) {
    const value = origin[field];
    if (typeof value !== "string" || !value.trim()) {
      return {
        ok: false,
        code: "origin_incomplete",
        message: `The origin reference needs ${field}, and the observed source item did not record one.`
      };
    }
  }
  return { ok: true, origin };
}

function detectGroundedDraftSpans(text, policy = {}) {
  const input = typeof text === "string" ? text : "";
  const spans = [];
  if (!input) return spans;
  for (const match of input.matchAll(PRICE_PATTERN)) {
    spans.push({ start: match.index, end: match.index + match[0].length, kind: "price", value: match[0] });
  }
  for (const match of input.matchAll(URL_PATTERN)) {
    spans.push({ start: match.index, end: match.index + match[0].length, kind: "url", value: match[0] });
  }
  for (const match of input.matchAll(HASHTAG_PATTERN)) {
    spans.push({ start: match.index, end: match.index + match[0].length, kind: "hashtag", value: match[0] });
  }
  for (const term of normalizeTermList(policy.disclaimers)) {
    pushTermMatches(spans, input, { ...term, allowSubstring: true }, "disclaimer");
  }
  for (const term of normalizeTermList(policy.claimsRequiringConfirmation)) {
    pushTermMatches(spans, input, { ...term, allowSubstring: true }, "claim");
  }
  return spans.sort((left, right) => left.start - right.start);
}

/**
 * Source → draft preservation: every protected literal the SOURCE carried —
 * product name, price, URL, protected hashtag, disclaimer — must survive
 * verbatim into the draft. Runs on BOTH validation paths: a grounded brief
 * ("make it punchier") used to route around this entirely, which let a
 * protected product name be translated away and still validate.
 * Claims are the confirm-severity case and stay the caller's to answer.
 */
function sourcePreservationIssues(sourceText, draftText, policy) {
  const issues = [];
  const sourceSpans = detectProtectedLiterals(sourceText, policy);
  const draftSpans = detectProtectedLiterals(draftText, policy);
  for (const span of sourceSpans) {
    if (span.kind === "claim") continue;
    const preserved = draftSpans.some((candidate) => candidate.kind === span.kind && candidate.value === span.value);
    if (preserved) continue;
    if (span.kind === "disclaimer") {
      issues.push(issue("disclaimer_missing", "block", `${messages.disclaimerMissing.en}: "${span.value}"`, span));
      continue;
    }
    const altered = draftSpans.some((candidate) => candidate.kind === span.kind);
    const code = altered ? "protected_literal_altered" : "protected_literal_missing";
    const messageKey = altered ? "protectedLiteralAltered" : "protectedLiteralMissing";
    issues.push(issue(code, "block", `${messages[messageKey].en}: "${span.value}"`, span));
  }
  for (const claim of sourceSpans.filter((span) => span.kind === "claim")) {
    const confirmed = Array.isArray(policy.confirmedClaims) && policy.confirmedClaims.includes(claim.value);
    if (!confirmed) {
      issues.push(issue("claim_unconfirmed", "confirm", `${messages.claimUnconfirmed.en}: "${claim.value}"`, claim));
    }
  }
  return issues;
}

/**
 * Basis-anchored validation for derived drafts. House policy (register, limits)
 * AND source preservation both run — a caller-chosen `allowedChanges` narrows
 * what may change, it does not lift what must survive. Protected draft spans
 * additionally fail closed without a recognised basis.
 * A `knowledge:` basis is a citation only — this function never fetches.
 */
export function validateGrounded({ source = {}, draft, ledger, policy = {}, limits = {} } = {}) {
  const issues = [];
  const trimmed = typeof draft === "string" ? draft.trim() : "";
  if (!trimmed) {
    issues.push(issue("empty_draft", "block", messages.emptyDraft.en));
    return { ok: false, issues };
  }
  issues.push(...housePolicyIssues(trimmed, policy, limits));

  const entries = normalizeLedger(ledger).spans;
  const sourceText = typeof source.text === "string" ? source.text : "";
  const sourceId = typeof source.id === "string" ? source.id : "";
  issues.push(...sourcePreservationIssues(sourceText, trimmed, policy));

  for (const span of detectGroundedDraftSpans(trimmed, policy)) {
    if (!GROUNDED_SPAN_KINDS.has(span.kind)) continue;
    const match = entries.find((entry) => {
      const value = record(entry);
      return value && value.kind === span.kind && value.text === span.value;
    });
    if (!match) {
      issues.push(issue("ungrounded_span", "block", `${messages.ungroundedSpan.en}: "${span.value}"`, span));
      continue;
    }
    const parsed = parseGroundingBasis(match.basis);
    if (!parsed) {
      issues.push(issue("unknown_basis", "block", `${messages.unknownBasis.en}: "${String(match.basis ?? "")}"`, span));
      continue;
    }
    if (parsed.kind === "source") {
      const itemMatches = !sourceId || parsed.id === sourceId;
      if (!itemMatches || !sourceText.includes(span.value)) {
        issues.push(
          issue("source_basis_mismatch", "block", `${messages.sourceBasisMismatch.en}: "${span.value}"`, span)
        );
      }
    }
  }

  return { ok: !issues.some((entry) => entry.severity === "block"), issues };
}

/** REQ-003: localization stays the no-allowed-changes path; derivation uses the ledger. */
export function validateRevisionDraft({ brief, ...rest } = {}) {
  return usesGroundedValidation(brief) ? validateGrounded(rest) : validateLocalization(rest);
}

/**
 * Validates a localized draft against the source item, the org's protection
 * policy and destination limits. Never rewrites the draft — only reports.
 */
export function validateLocalization({ source = {}, draft, policy = {}, limits = {} } = {}) {
  const issues = [];
  const trimmed = typeof draft === "string" ? draft.trim() : "";

  if (!trimmed) {
    issues.push(issue("empty_draft", "block", messages.emptyDraft.en));
    return { ok: false, issues };
  }

  issues.push(...housePolicyIssues(trimmed, policy, limits));

  const sourceText = typeof source.text === "string" ? source.text : "";
  issues.push(...sourcePreservationIssues(sourceText, trimmed, policy));

  return { ok: !issues.some((entry) => entry.severity === "block"), issues };
}

// ---------------------------------------------------------------------------
// 6. Poster layout
// ---------------------------------------------------------------------------

export const posterLayoutSchema = Object.freeze({
  template: Object.freeze({ enum: Object.keys(POSTER_TEMPLATES) }),
  headline: Object.freeze({ type: "string", required: true, maxLength: 120 }),
  subline: Object.freeze({ type: "string", required: false, maxLength: 200 }),
  background: Object.freeze({
    kind: Object.freeze({ enum: ["solid", "asset"] }),
    value: Object.freeze({ type: "string", required: true, maxLength: 2_048 })
  }),
  textColor: Object.freeze({ type: "string", required: true, maxLength: 32 }),
  align: Object.freeze({ enum: ["left", "center", "right"] })
});

/** Validates a poster layout against posterLayoutSchema's bounds. */
export function validatePosterLayout(layout) {
  const input = record(layout);
  if (!input) {
    return { ok: false, issues: [{ code: "poster_layout_invalid", message: messages.posterLayoutInvalid.en }] };
  }

  const issues = [];
  if (!Object.hasOwn(POSTER_TEMPLATES, input.template)) {
    issues.push({ code: "poster_template_invalid", message: messages.posterTemplateInvalid.en });
  }

  const headline = typeof input.headline === "string" ? input.headline.trim() : "";
  if (!headline) {
    issues.push({ code: "poster_headline_required", message: messages.posterHeadlineRequired.en });
  } else if (headline.length > posterLayoutSchema.headline.maxLength) {
    issues.push({ code: "poster_headline_too_long", message: messages.posterHeadlineTooLong.en });
  }

  if (typeof input.subline === "string" && input.subline.length > posterLayoutSchema.subline.maxLength) {
    issues.push({ code: "poster_subline_too_long", message: messages.posterSublineTooLong.en });
  }

  const background = record(input.background);
  const backgroundValue = background?.value;
  if (
    !background ||
    !["solid", "asset"].includes(background.kind) ||
    typeof backgroundValue !== "string" ||
    !backgroundValue.trim()
  ) {
    issues.push({ code: "poster_background_invalid", message: messages.posterBackgroundInvalid.en });
  } else if (backgroundValue.length > posterLayoutSchema.background.value.maxLength) {
    issues.push({ code: "poster_background_too_long", message: messages.posterBackgroundTooLong.en });
  }

  if (typeof input.textColor !== "string" || !input.textColor.trim()) {
    issues.push({ code: "poster_text_color_required", message: messages.posterTextColorRequired.en });
  }

  if (!["left", "center", "right"].includes(input.align)) {
    issues.push({ code: "poster_align_invalid", message: messages.posterAlignInvalid.en });
  }

  return { ok: issues.length === 0, issues };
}

/** The fixed pixel dimensions and the SQLite-row-backed byte cap (CON-009) for a poster template. */
export function posterPngConstraints(template) {
  const size = POSTER_TEMPLATES[template];
  if (!size) {
    throw new Error(`Unknown poster template: ${String(template)}`);
  }
  return { width: size.width, height: size.height, maxBytes: POSTER_MAX_BYTES };
}

// ---------------------------------------------------------------------------
// 7. Storage-adjacent pure helpers
// ---------------------------------------------------------------------------

/** The duplicate-prevention key for (sourceItem, destinationBinding) — REQ-017. */
export function duplicateKey(sourceItemId, destinationBinding) {
  const item = typeof sourceItemId === "string" ? sourceItemId.trim() : "";
  const destination = typeof destinationBinding === "string" ? destinationBinding.trim() : "";
  if (!item || !destination) {
    throw new Error("duplicateKey requires a sourceItemId and a destinationBinding.");
  }
  return `${item}::${destination}`;
}

/** Pure compare-and-set check for an expected-revision write (PAT-004). */
export function revisionCas(current, expected) {
  const normalizedCurrent = current ?? null;
  const normalizedExpected = expected ?? null;
  return { ok: normalizedCurrent === normalizedExpected, current: normalizedCurrent };
}

// ---------------------------------------------------------------------------
// The model's own English / zh-HK (書面語) strings.
// ---------------------------------------------------------------------------

export const messages = {
  emptyDraft: { en: "The localized caption is empty.", "zh-HK": "本地化文案為空。" },
  lowChineseShare: { en: "The draft does not read as written Chinese.", "zh-HK": "文案未見以書面中文撰寫。" },
  spokenFormDetected: {
    en: "The draft contains a spoken Cantonese expression; product copy must be written Chinese.",
    "zh-HK": "文案包含口語表達，產品文案須以書面語撰寫。"
  },
  protectedLiteralMissing: {
    en: "A protected item from the source post is missing from the draft.",
    "zh-HK": "原文中的受保護內容於文案中缺失。"
  },
  protectedLiteralAltered: {
    en: "A protected item from the source post was altered in the draft.",
    "zh-HK": "原文中的受保護內容於文案中被更改。"
  },
  disclaimerMissing: { en: "A required disclaimer is missing from the draft.", "zh-HK": "文案缺少必要的免責聲明。" },
  claimUnconfirmed: {
    en: "A claim in the source post requires confirmation before publishing.",
    "zh-HK": "原文中的聲稱須先確認方可發佈。"
  },
  halfwidthPunctuation: {
    en: "Half-width punctuation appears between Chinese characters.",
    "zh-HK": "中文字之間出現半形標點符號。"
  },
  captionTooLong: {
    en: "The caption exceeds the destination's character limit.",
    "zh-HK": "文案超過目標平台的字數上限。"
  },
  hashtagCountHigh: {
    en: "The caption uses more hashtags than recommended.",
    "zh-HK": "文案使用的主題標籤數量超過建議上限。"
  },
  ungroundedSpan: {
    en: "A protected span has no basis.",
    "zh-HK": "受保護片段沒有依據。"
  },
  unknownBasis: {
    en: "The basis form is not recognised.",
    "zh-HK": "不支援此依據形式。"
  },
  sourceBasisMismatch: {
    en: "The cited source does not support this span.",
    "zh-HK": "所引用的來源並不支持此片段。"
  },
  posterLayoutInvalid: { en: "The poster layout is not a valid object.", "zh-HK": "海報版面資料無效。" },
  posterTemplateInvalid: { en: "The poster template is not supported.", "zh-HK": "不支援此海報範本。" },
  posterHeadlineRequired: { en: "The poster headline is required.", "zh-HK": "海報標題為必填項目。" },
  posterHeadlineTooLong: { en: "The poster headline is too long.", "zh-HK": "海報標題過長。" },
  posterSublineTooLong: { en: "The poster subline is too long.", "zh-HK": "海報副標題過長。" },
  posterBackgroundInvalid: { en: "The poster background is not valid.", "zh-HK": "海報背景資料無效。" },
  posterBackgroundTooLong: { en: "The poster background value is too long.", "zh-HK": "海報背景數值過長。" },
  posterTextColorRequired: { en: "The poster text colour is required.", "zh-HK": "海報文字顏色為必填項目。" },
  posterAlignInvalid: { en: "The poster text alignment is not supported.", "zh-HK": "不支援此海報文字對齊方式。" },
  droppedUnpublished: { en: "Not published on the Page.", "zh-HK": "尚未於專頁發佈。" },
  droppedNotPageAuthor: { en: "Not authored by the connected Page.", "zh-HK": "並非由已連接的專頁發佈。" },
  droppedMissingId: { en: "Missing a provider item id.", "zh-HK": "缺少來源項目編號。" },
  droppedCaptionTruncated: {
    en: "Caption text was shortened to fit the limit.",
    "zh-HK": "文案文字已縮短以符合上限。"
  },
  droppedHandleTruncated: {
    en: "Author handle was shortened to fit the limit.",
    "zh-HK": "作者帳號名稱已縮短以符合上限。"
  },
  droppedUrlTruncated: { en: "A URL was shortened to fit the limit.", "zh-HK": "網址已縮短以符合上限。" },
  droppedMediaTruncated: {
    en: "Extra media items beyond the limit were dropped.",
    "zh-HK": "超出上限的額外媒體項目已被捨棄。"
  }
};

// ---------------------------------------------------------------------------
// export bounds (REQ-028)
// ---------------------------------------------------------------------------

/**
 * What `exportAs("json")` will carry at most.
 *
 * `bytes` IS THE HOST'S OWN CAP, not a margin under it.
 * `MAX_GADGET_EXPORT_BODY_BYTES` in
 * `src/domains/gadgets/gadget-capabilities.ts` is 8 MiB, and a body over it is
 * not trimmed — `readGadgetExport` returns null and the owner is told the
 * gadget's export did not come back in a usable shape. The whole export is
 * lost for being one byte too big, so arriving under it is the gadget's job.
 *
 * The three counts are the first, cheap bound: they become SQL `LIMIT`s in
 * `storage.js`, so a large instance never materialises rows it is going to
 * drop. `boundExport` below is the second one, because no count of rows
 * predicts their size — one revision with a long caption is worth a thousand
 * short ones.
 */
export const exportBounds = Object.freeze({
  items: 200,
  batches: 200,
  revisions: 1000,
  bytes: 8 * 1024 * 1024
});

function encodedLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * The export body, under `bounds.bytes`, saying what it left out.
 *
 * `collections` are already count-capped by the caller (the SQL `LIMIT`s
 * above); `totals` is how many rows exist, so "dropped" is a real number
 * rather than the absence of one. TRUNCATION IS ALWAYS EXPLICIT: a reader who
 * does not check `truncated` still gets a correct export of what it holds,
 * and one who does can tell a complete export from a partial one — which is
 * the difference between "this organisation localized 40 posts" and "we
 * showed you 40 of them".
 *
 * SHED ORDER IS REVISIONS, THEN BATCHES, THEN ITEMS. Revisions carry the text
 * and are the deepest leaves; items are the spine everything else refers to,
 * so an export that has dropped its items explains nothing that is left. Each
 * pass halves the offending collection rather than dropping one row at a
 * time, so a body many times over the cap converges in a handful of
 * serializations instead of thousands.
 *
 * Pure: arrays in, a string out, no I/O and no clock (PAT-002).
 */
export function boundExport(collections, totals = {}, bounds = exportBounds) {
  const kept = {
    items: Array.isArray(collections?.items) ? collections.items.slice(0, bounds.items) : [],
    batches: Array.isArray(collections?.batches) ? collections.batches.slice(0, bounds.batches) : [],
    revisions: Array.isArray(collections?.revisions) ? collections.revisions.slice(0, bounds.revisions) : []
  };
  const totalOf = (name) =>
    typeof totals?.[name] === "number" && Number.isFinite(totals[name]) ? totals[name] : kept[name].length;

  let reachedByteLimit = false;
  const serialize = () =>
    JSON.stringify({
      items: kept.items,
      batches: kept.batches,
      revisions: kept.revisions,
      truncated: {
        items: Math.max(0, totalOf("items") - kept.items.length),
        batches: Math.max(0, totalOf("batches") - kept.batches.length),
        revisions: Math.max(0, totalOf("revisions") - kept.revisions.length),
        reachedByteLimit,
        limits: bounds
      }
    });

  let body = serialize();
  while (encodedLength(body) > bounds.bytes) {
    const shrinking = ["revisions", "batches", "items"].find((name) => kept[name].length > 0);
    // Nothing left to shed: the skeleton alone is over the cap, which cannot
    // happen with these bounds but is not worth an infinite loop to assume.
    if (!shrinking) break;
    reachedByteLimit = true;
    kept[shrinking] = kept[shrinking].slice(0, Math.floor(kept[shrinking].length / 2));
    body = serialize();
  }

  return { body, reachedByteLimit };
}

// ---------------------------------------------------------------------------
// Open source accounts (design-plans/feature-open-source-accounts-1.md)
// ---------------------------------------------------------------------------

/**
 * Instagram posts as the BROKER returns them, which is not the Graph API.
 *
 * WRITTEN AGAINST A REAL PAYLOAD, 2026-09-04. A parser written from the Graph
 * API documentation would have matched `id` and nothing else — every other
 * field it looks for is absent or a different type, so it would have produced
 * items with an identifier and no caption, no date, no link and no media. Not
 * a crash: silent garbage, on a schedule, with a scan-success rate reading
 * 100 %. The differences, each one confirmed rather than assumed:
 *
 *   Graph API              broker (Instagram's own "Polaris" shape)
 *   ---------------------  -----------------------------------------------
 *   caption: string        caption: { text, created_at, pk, ... }
 *   media_type: "IMAGE"    media_type: 1 (image) | 2 (video) | 8 (carousel)
 *   permalink              url
 *   timestamp (ISO)        taken_at (unix seconds), created_at (ISO)
 *   media_url              image_versions2.candidates[].url
 *   children.data[]        carousel_media[]
 *   comments_count         comment_count
 *
 * `pk` is the numeric post id and `id` is `POLARIS_<pk>`. The BARE `pk` is
 * what is stored, so an item fetched through the broker and the same item
 * fetched later through an authorised connector are one row rather than two —
 * `UNIQUE(source_binding, provider_item_id)` is what de-duplicates, and it can
 * only do that if both paths spell the id the same way.
 */
export async function normalizeOpenInstagramPosts(page, source) {
  const normalizedSource = requireSource(source, "instagram");
  const counter = makeCounter();
  const rawItems = Array.isArray(record(page)?.data) ? record(page).data : [];
  const now = new Date().toISOString();
  const items = [];

  for (const raw of rawItems) {
    const post = record(raw);
    // `pk` and not `id`: see the note above about de-duplication.
    const postId = post && (typeof post.pk === "string" || typeof post.pk === "number") ? String(post.pk) : "";
    if (!postId) {
      counter.add("missing_id");
      continue;
    }

    /**
     * A STUB, not a post — dropped rather than stored hollow.
     *
     * The observed payload contained one `product_type: "carousel_container"`
     * entry with `media_type: 8` and no `carousel_media`, no `taken_at`, no
     * `created_at` and no `image_versions2` — an id and a count, nothing else.
     * Storing it produces an undated, imageless card an owner cannot act on
     * and cannot explain, and it would count as a "new item" on every scan
     * report. Anything carrying neither a time nor a single piece of media is
     * not a post this gadget can localize.
     *
     * Dropped WITH A REASON, not silently: `dropped` is what tells an owner
     * their scan saw twelve things and kept eleven.
     */
    const publishedAt = openInstagramTakenAt(post);
    const media = openInstagramMediaEntries(post, counter);
    if (!publishedAt && media.length === 0) {
      counter.add("incomplete_post");
      continue;
    }

    const item = {
      id: `instagram:${normalizedSource.binding}:${postId}`,
      provider: "instagram",
      sourceBinding: normalizedSource.binding,
      sourceLabel: normalizedSource.label,
      providerItemId: postId,
      authorHandle: boundOrNull(counter, "handle_truncated", record(post.user)?.username, MAX_HANDLE_CHARS),
      // `url` is the permalink here; `seo_canonical_url` came back null on the
      // observed payload, so it is a fallback and never the first choice.
      permalink: boundOrNull(counter, "url_truncated", post.url ?? post.seo_canonical_url, MAX_URL_CHARS),
      publishedAt,
      text: boundCaption(counter, record(post.caption)?.text),
      locale: null,
      media,
      metrics: {
        likes: isFiniteNumber(post.like_count) ? post.like_count : null,
        // `comment_count`, singular — the Graph API spells it `comments_count`.
        comments: isFiniteNumber(post.comment_count) ? post.comment_count : null,
        shares: null,
        views: null
      },
      contentHash: null,
      firstSeenAt: now,
      lastSeenAt: now
    };
    item.contentHash = await contentHash(item);
    items.push(item);
  }

  return { items, nextCursor: extractCursor(page), dropped: counter.toDropped() };
}

/**
 * When the post was published.
 *
 * `taken_at` is unix SECONDS — passing it to `new Date()` unchanged would date
 * every post to January 1970, which sorts correctly among itself and is wrong
 * on every screen. `created_at` is already ISO and is preferred when present;
 * the observed payload carried both.
 */
function openInstagramTakenAt(post) {
  const iso = isoOrNull(post.created_at);
  if (iso) return iso;
  return isFiniteNumber(post.taken_at) ? new Date(post.taken_at * 1000).toISOString() : null;
}

/** Instagram's numeric media types, named where they are read. */
const OPEN_IG_IMAGE = 1;
const OPEN_IG_VIDEO = 2;
const OPEN_IG_CAROUSEL = 8;

function openInstagramMediaEntries(post, counter) {
  if (post.media_type === OPEN_IG_CAROUSEL) {
    const list = Array.isArray(post.carousel_media) ? post.carousel_media : [];
    if (list.length > MAX_MEDIA_PER_ITEM) counter.add("media_truncated", list.length - MAX_MEDIA_PER_ITEM);
    return list.slice(0, MAX_MEDIA_PER_ITEM).flatMap((raw, index) => {
      const child = record(raw);
      const entry = openInstagramOneMedia(child, `${index}`, counter);
      return entry ? [entry] : [];
    });
  }
  const entry = openInstagramOneMedia(post, "0", counter);
  return entry ? [entry] : [];
}

/**
 * One image or video, from whichever list the post carries.
 *
 * `candidates` is ordered largest first on the observed payload, so index 0 is
 * the full-size rendition — which is what a poster needs and what the media
 * cache is bounded for.
 */
function openInstagramOneMedia(node, id, counter) {
  if (!node) return null;
  const kind = node.media_type === OPEN_IG_VIDEO ? "video" : "image";
  const posterUrl = record(
    Array.isArray(record(node.image_versions2)?.candidates) ? record(node.image_versions2).candidates[0] : null
  )?.url;
  const url =
    kind === "video"
      ? record(Array.isArray(node.video_versions) ? node.video_versions[0] : null)?.url
      : posterUrl;
  const bounded = boundOrNull(counter, "url_truncated", url, MAX_URL_CHARS);
  if (!bounded) {
    counter.add("media_missing_url");
    return null;
  }
  /*
   * A video keeps its POSTER as well as its file.
   *
   * Instagram hands both over in the same payload — `video_versions` and an
   * `image_versions2.candidates` still frame — and this took the video and
   * dropped the poster. That left every reel with only a multi-megabyte MP4 as
   * its visual: too large for the preview cache to hold, and nothing an owner
   * can look at while choosing which post to derive from.
   *
   * The poster is what "the image of this post" means for a video, in both
   * places it is needed — the canvas showing a reference, and any later step
   * that wants a still. Keeping the file too means nothing is lost; the frame
   * is simply no longer thrown away for free.
   */
  if (kind !== "video" || !posterUrl) return { id, kind, url: bounded };
  const boundedPoster = boundOrNull(counter, "url_truncated", posterUrl, MAX_URL_CHARS);
  return boundedPoster ? { id, kind, url: bounded, posterUrl: boundedPoster } : { id, kind, url: bounded };
}

/**
 * A typed URL or handle, resolved to something storable.
 *
 * REQ-104: resolve BEFORE storing, and tell the owner what was resolved. An
 * unresolved string stored now is a scan that fails later, at 09:00, where
 * nobody is watching — and the owner would have no way to tell a typo from an
 * account that went private.
 *
 * Deliberately NOT a network call. This is the lexical half: which platform,
 * and what key identifies the account there. Whether that account exists is
 * the door's answer, and asking it is a metered call the owner has to have
 * granted first.
 *
 * Returns `{ ok: false, code }` rather than throwing — every refusal in this
 * blueprint is a value, because a throw over a facet poisons the actor.
 */
export function resolveOpenSource(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return { ok: false, code: "empty", message: "Enter an account link or handle." };

  // A bare handle, with or without a leading at-sign. Ambiguous between
  // platforms by design: it is only accepted WITH a platform stated, never
  // guessed — the same handle is often two different companies on Instagram
  // and Facebook, so guessing would silently watch the wrong one.
  const bare = /^@?([A-Za-z0-9._]{1,60})$/.exec(raw);
  if (bare) {
    return {
      ok: false,
      code: "platform_unknown",
      message: "Add the full link, so the platform is not a guess."
    };
  }

  let url;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return { ok: false, code: "unreadable", message: "That does not look like a link." };
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    const handle = segments[0];
    if (!handle || RESERVED_IG_PATHS.has(handle.toLowerCase())) {
      return { ok: false, code: "no_account", message: "That link does not name an account." };
    }
    return { ok: true, platform: "instagram", accountKey: handle, displayName: `@${handle}` };
  }

  if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com") {
    // Facebook names a page three ways; all three end up as the same key the
    // door takes, so the caller never learns which shape the owner pasted.
    const profileId = url.searchParams.get("id");
    if (segments[0] === "profile.php" && profileId) {
      return { ok: true, platform: "facebook", accountKey: profileId, displayName: profileId };
    }
    const handle = segments[0] === "pages" ? segments[1] : segments[0];
    if (!handle || RESERVED_FB_PATHS.has(handle.toLowerCase())) {
      return { ok: false, code: "no_account", message: "That link does not name a page." };
    }
    return { ok: true, platform: "facebook", accountKey: handle, displayName: handle };
  }

  return {
    ok: false,
    code: "unsupported_platform",
    message: "Only Instagram and Facebook accounts can be watched."
  };
}

/**
 * Paths that are Instagram or Facebook itself, not somebody's account.
 *
 * Without these, `instagram.com/explore` stores a source called "explore" that
 * scans forever and finds nothing — the failure looks like a quiet account
 * rather than a bad link.
 */
const RESERVED_IG_PATHS = new Set(["p", "reel", "reels", "stories", "explore", "accounts", "direct"]);
const RESERVED_FB_PATHS = new Set(["profile.php", "groups", "events", "watch", "marketplace", "pages"]);

/**
 * The stable key an open source is stored under.
 *
 * Prefixed so it can never collide with a connector binding's key, which is a
 * label the OWNER chose at grant time and could be anything — including
 * `instagram`. `items`' `UNIQUE(source_binding, provider_item_id)` keys
 * de-duplication off this, so a collision would silently merge two accounts'
 * posts.
 */
export function openSourceBinding(platform, accountKey) {
  return `open:${platform}:${accountKey}`;
}
