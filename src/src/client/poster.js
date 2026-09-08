// Social Localization client — the poster editor's canvas renderer.
//
// REQ-008 / ALT-006: text is rendered deterministically from editable text
// and layout data by THIS module, never by an image model, so the exact
// bytes an owner approves are the exact bytes that publish (RISK-005). A
// background image through an image door is future work and, per REQ-008,
// must never itself carry the Chinese text — so this editor only ever draws
// a solid background plus text, never composites an external asset.
//
// `computePosterLayout` is pure geometry (testable in node without a canvas)
// so tests/social-localization-client.test.ts can assert the layout maths
// directly; `drawPoster` and `exportPosterPng` are the imperative half that
// needs a real `CanvasRenderingContext2D`.

import { posterPngConstraints } from "../../model.js";

const PADDING_RATIO = 0.08;
const HEADLINE_FONT_RATIO = 0.072;
const SUBLINE_FONT_RATIO = 0.032;
const HEADLINE_LINE_HEIGHT = 1.18;
const SUBLINE_LINE_HEIGHT = 1.4;
const BLOCK_GAP_RATIO = 0.02;
// A rough CJK/Latin-mixed average glyph width as a fraction of font size —
// good enough for pure layout maths; the imperative renderer below re-wraps
// with the canvas's own measureText for the pixels an owner actually sees.
const AVG_CHAR_WIDTH_RATIO = 0.58;

function estimateLineCount(text, contentWidth, fontSize) {
  const str = typeof text === "string" ? text.trim() : "";
  if (!str) return 1;
  const charsPerLine = Math.max(1, Math.floor(contentWidth / (fontSize * AVG_CHAR_WIDTH_RATIO)));
  return Math.max(1, Math.ceil(str.length / charsPerLine));
}

/**
 * Pure poster geometry for `template` (one of model.js's posterLayoutSchema
 * template keys) plus the owner's headline/sub-line/alignment. Returns pixel
 * positions and font sizes an imperative renderer (or a test) can use
 * without touching the DOM.
 */
export function computePosterLayout({ template, headline = "", subline = "", align = "left" }) {
  const { width, height } = posterPngConstraints(template);
  const padding = Math.round(width * PADDING_RATIO);
  const contentWidth = width - padding * 2;
  const headlineFontSize = Math.round(width * HEADLINE_FONT_RATIO);
  const sublineFontSize = Math.round(width * SUBLINE_FONT_RATIO);
  const headlineLines = estimateLineCount(headline, contentWidth, headlineFontSize);
  const headlineHeight = headlineLines * headlineFontSize * HEADLINE_LINE_HEIGHT;
  const trimmedSubline = typeof subline === "string" ? subline.trim() : "";
  const gap = trimmedSubline ? Math.round(height * BLOCK_GAP_RATIO) : 0;
  const sublineHeight = trimmedSubline ? sublineFontSize * SUBLINE_LINE_HEIGHT : 0;
  const blockHeight = headlineHeight + gap + sublineHeight;
  const blockTop = Math.max(padding, height - padding - blockHeight);
  const textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
  const x = textAlign === "center" ? width / 2 : textAlign === "right" ? width - padding : padding;

  return {
    width,
    height,
    padding,
    contentWidth,
    headline: { x, y: blockTop, fontSize: headlineFontSize, lineHeight: HEADLINE_LINE_HEIGHT, lines: headlineLines, align: textAlign },
    subline: trimmedSubline
      ? { x, y: blockTop + headlineHeight + gap, fontSize: sublineFontSize, lineHeight: SUBLINE_LINE_HEIGHT, align: textAlign }
      : null
  };
}

/** Wraps `text` to `maxWidth` using the canvas's own font metrics — the pixels an owner actually approves. */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  // CJK has no inter-word spaces; fall back to character wrapping when a
  // single "word" alone already overflows the line.
  const useCharWrap = words.some((word) => ctx.measureText(word).width > maxWidth);
  const units = useCharWrap ? [...text] : words;
  const joiner = useCharWrap ? "" : " ";
  const lines = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? current + joiner + unit : unit;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Draws the poster onto a 2D canvas context sized to `layout`. `config`
 * carries `background: { kind: "solid", value }`, `textColor`, `headline`,
 * `subline`. Deterministic given the same inputs (RISK-005).
 */
export function drawPoster(ctx, layout, config) {
  const { width, height } = layout;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = config.background?.value || "#1c1c1e";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = config.textColor || "#ffffff";
  ctx.textBaseline = "top";
  ctx.textAlign = layout.headline.align;

  ctx.font = `700 ${layout.headline.fontSize}px sans-serif`;
  const headlineLines = wrapText(ctx, config.headline || "", layout.contentWidth);
  headlineLines.forEach((line, index) => {
    ctx.fillText(line, layout.headline.x, layout.headline.y + index * layout.headline.fontSize * layout.headline.lineHeight);
  });

  if (layout.subline && config.subline) {
    ctx.font = `500 ${layout.subline.fontSize}px sans-serif`;
    ctx.globalAlpha = 0.86;
    const sublineLines = wrapText(ctx, config.subline, layout.contentWidth);
    sublineLines.forEach((line, index) => {
      ctx.fillText(line, layout.subline.x, layout.subline.y + index * layout.subline.fontSize * layout.subline.lineHeight);
    });
    ctx.globalAlpha = 1;
  }
}

/** Renders `config` onto a fresh canvas at `template`'s pixel size and returns the PNG as bytes ready for savePoster(). */
export async function renderPosterPng(template, config) {
  const layout = computePosterLayout({ template, headline: config.headline, subline: config.subline, align: config.align });
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  drawPoster(ctx, layout, config);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("canvas.toBlob returned no blob"))), "image/png");
  });
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const { maxBytes } = posterPngConstraints(template);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Rendered poster is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit.`);
  }
  return bytes;
}
