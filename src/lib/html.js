/**
 * The single `wrapAsDocument`. Pure string templating, so the service worker
 * and the offscreen document can both use it.
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
