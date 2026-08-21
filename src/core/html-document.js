/**
 * html-document.js — the single `wrapAsDocument` implementation (spec v3
 * §2/P3). Used to exist three times: `src/entry/content.js`'s DOMScanner,
 * `src/entry/offscreen.js`'s OffscreenParser, and `src/entry/background.js`'s
 * HtmlDocument (whose comment openly admitted it "deliberately mirrors" the
 * other two). Merged here.
 *
 * Drift found between the three copies during the merge (reported instead
 * of silently picked):
 *
 *  - CSS: content.js and offscreen.js were byte-identical — full rule set
 *    (h1/h2/h3/p/table/blockquote/ul/ol/li). background.js's `HtmlDocument`
 *    carried a reduced subset (only body/table/td/th), sufficient for its
 *    one caller (the Sheets swFetch pipeline, whose csv-derived HTML never
 *    contains headings/paragraphs/lists) but NOT a safe stand-in for the
 *    Docs path, which does. Kept: the fuller rule set — it's a strict
 *    superset, so the extra selectors are simply inert on Sheets' table-only
 *    output, whereas the reduced set would have dropped heading/list/
 *    blockquote styling had it been reused for Docs.
 *  - escapeHtml: offscreen.js and background.js both defensively wrap the
 *    input in `String(str)` before replacing; content.js's did not. Kept:
 *    the defensive version — majority (2 of 3) and strictly safer against a
 *    non-string `title`.
 *
 * Pure string templating — no Chrome APIs, no DOM. Usable from the service
 * worker (which has no DOM) and the offscreen document alike.
 */

/**
 * Wrap cleaned body HTML in a minimal document structure suitable for
 * Word/Google Docs import / rich clipboard copy.
 * @param {string} bodyHtml
 * @param {string} title
 * @returns {string}
 */
export function wrapAsDocument(bodyHtml, title) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.5; max-width: 800px; margin: 20px auto; color: #222; }
  h1 { font-size: 20pt; margin: 16pt 0 8pt; }
  h2 { font-size: 16pt; margin: 14pt 0 6pt; }
  h3 { font-size: 13pt; margin: 12pt 0 4pt; }
  p { margin: 0 0 8pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  td, th { border: 1px solid #ccc; padding: 6px 8px; }
  th { background: #f5f5f5; font-weight: bold; }
  blockquote { border-left: 3px solid #ccc; margin: 8pt 0; padding: 4pt 12pt; color: #555; }
  ul, ol { margin: 4pt 0 8pt 20pt; }
  li { margin: 2pt 0; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
