"use strict";

// Plain-text renderings of a notice, shared by every surface that shows or
// copies one (the notice stack in notice-bubble.js, the pet's head screen in
// notice-screen-runtime.js). Kept free of Electron so both the main-process
// owners and their tests can load it directly.

// A head-screen line is one terminal row, so it never needs the store's full
// 200-character title; this bound keeps the IPC payload and the SVG text node
// small even if the store limit grows later.
const NOTICE_HEADLINE_MAX_LENGTH = 200;

function formatSeriesValue(entry) {
  const points = Array.isArray(entry.points) ? entry.points : [];
  const value = Number.isFinite(entry.value) ? entry.value : points[points.length - 1];
  return Number.isFinite(value) ? `${value}${entry.unit || ""}` : "—";
}

// What a right-click copies: the title, the body, and for a trend card one
// "name value" line per series — what the card says, as plain text.
function noticeCopyText(notice) {
  if (!notice) return "";
  const lines = [];
  if (notice.title) lines.push(String(notice.title));
  if (notice.body) lines.push(String(notice.body));
  if (Array.isArray(notice.series)) {
    for (const entry of notice.series) {
      if (entry && entry.name) lines.push(`${entry.name} ${formatSeriesValue(entry)}`);
    }
  }
  return lines.join("\n");
}

// The single line a notice is known by: its title, or — for a body-only card —
// the first non-empty body line. Collapsed to one row because the head screen
// has exactly one. "" when the notice has neither (chart- or image-only cards).
function noticeHeadline(notice) {
  if (!notice) return "";
  const pick = (value) => {
    if (typeof value !== "string") return "";
    const line = value.split(/\r\n?|\n/).map((part) => part.trim()).find(Boolean) || "";
    return line.replace(/\s+/g, " ");
  };
  const line = pick(notice.title) || pick(notice.body);
  return line.length > NOTICE_HEADLINE_MAX_LENGTH ? line.slice(0, NOTICE_HEADLINE_MAX_LENGTH) : line;
}

module.exports = {
  NOTICE_HEADLINE_MAX_LENGTH,
  formatSeriesValue,
  noticeCopyText,
  noticeHeadline,
};
