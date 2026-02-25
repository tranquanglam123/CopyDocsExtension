/**
 * DOMScanner — Content script injected into /mobilebasic pages.
 * Extracts document content with formatting preserved as clean HTML.
 */
(() => {
    'use strict';

    class DOMScanner {

        /**
         * Known container selectors for mobilebasic pages, ordered by specificity.
         */
        static CONTAINER_SELECTORS = [
            'div.doc-content',
            '#contents',
            '[role="main"]',
            'div.doc',
            'table.waffle',
            '.grid-container',
            '.punch-viewer-content',
            '.slide-content',
            'body',
        ];

        /**
         * Elements that are Google UI chrome — exclude from extraction.
         */
        static NOISE_SELECTORS = [
            'nav', 'header', 'footer',
            '[role="navigation"]',
            '[role="banner"]',
            '.gb_', '#gb',
            '.docs-butterbar',
            '.docs-companion',
            'script', 'style', 'noscript',
            '.mobile-topbar',
            '.docs-ml-header',
            '#docs-header',
        ];

        /**
         * Tags to keep in cleaned HTML — everything else is unwrapped.
         */
        static ALLOWED_TAGS = new Set([
            'P', 'BR', 'HR',
            'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
            'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE',
            'SUP', 'SUB',
            'UL', 'OL', 'LI',
            'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'CAPTION',
            'A',
            'BLOCKQUOTE', 'PRE', 'CODE',
            'SPAN', 'DIV',
            'IMG',
        ]);

        /**
         * Inline styles worth keeping for formatting fidelity.
         */
        static KEEP_STYLES = [
            'font-weight',
            'font-style',
            'text-decoration',
            'font-size',
            'color',
            'background-color',
            'text-align',
            'vertical-align',
            'border',
            'padding',
            'margin-left',   // indentation
        ];

        /**
         * Find the best content container on the page.
         * @returns {Element|null}
         */
        static findContainer() {
            for (const selector of DOMScanner.CONTAINER_SELECTORS) {
                const el = document.querySelector(selector);
                if (el && el.tagName !== 'BODY') return el;
            }
            return document.body;
        }

        /**
         * Remove noise elements from a cloned subtree.
         * @param {Element} root
         */
        static removeNoise(root) {
            for (const sel of DOMScanner.NOISE_SELECTORS) {
                root.querySelectorAll(sel).forEach((el) => el.remove());
            }
        }

        /**
         * Clean an element's HTML: keep only allowed tags and meaningful styles.
         * @param {Element} el  A cloned element (will be mutated).
         */
        static cleanHtml(el) {
            // Process all elements depth-first
            const allEls = [...el.querySelectorAll('*')];

            for (const node of allEls) {
                // Remove empty spans/divs that are just wrappers
                if ((node.tagName === 'SPAN' || node.tagName === 'DIV') &&
                    !node.hasChildNodes()) {
                    node.remove();
                    continue;
                }

                // Convert Google's <span style="font-weight:700"> to <b> etc.
                if (node.tagName === 'SPAN') {
                    const cs = node.style;
                    if (cs.fontWeight === '700' || cs.fontWeight === 'bold') {
                        const b = document.createElement('b');
                        b.innerHTML = node.innerHTML;
                        node.replaceWith(b);
                        continue;
                    }
                    if (cs.fontStyle === 'italic') {
                        const i = document.createElement('i');
                        i.innerHTML = node.innerHTML;
                        node.replaceWith(i);
                        continue;
                    }
                    if (cs.textDecoration?.includes('underline') ||
                        cs.textDecorationLine?.includes('underline')) {
                        const u = document.createElement('u');
                        u.innerHTML = node.innerHTML;
                        node.replaceWith(u);
                        continue;
                    }
                }

                // Strip all class attributes
                node.removeAttribute('class');
                node.removeAttribute('id');
                node.removeAttribute('data-aria-level');
                node.removeAttribute('data-aria-posinset');
                node.removeAttribute('role');
                node.removeAttribute('dir');

                // Filter inline styles — keep only relevant ones
                if (node.hasAttribute('style')) {
                    const computed = node.style;
                    const kept = [];
                    for (const prop of DOMScanner.KEEP_STYLES) {
                        const val = computed.getPropertyValue(prop);
                        if (val && val !== 'normal' && val !== 'none' &&
                            val !== 'inherit' && val !== 'initial') {
                            kept.push(`${prop}:${val}`);
                        }
                    }
                    if (kept.length > 0) {
                        node.setAttribute('style', kept.join(';'));
                    } else {
                        node.removeAttribute('style');
                    }
                }

                // If the tag isn't allowed, unwrap it (keep children)
                if (!DOMScanner.ALLOWED_TAGS.has(node.tagName)) {
                    const frag = document.createDocumentFragment();
                    while (node.firstChild) frag.appendChild(node.firstChild);
                    node.replaceWith(frag);
                }
            }

            // Clean up any remaining DIVs that should be Ps (mobilebasic uses divs for paragraphs)
            el.querySelectorAll('div').forEach(div => {
                // Only convert if it contains inline content
                const hasBlockChild = [...div.children].some(c =>
                    ['DIV', 'P', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(c.tagName)
                );
                if (!hasBlockChild && div.textContent.trim()) {
                    const p = document.createElement('p');
                    p.innerHTML = div.innerHTML;
                    if (div.hasAttribute('style')) {
                        p.setAttribute('style', div.getAttribute('style'));
                    }
                    div.replaceWith(p);
                }
            });
        }

        /**
         * Wrap cleaned HTML in a minimal document structure suitable for
         * Word/Google Docs import.
         * @param {string} bodyHtml  Cleaned inner HTML
         * @param {string} title     Document title
         * @returns {string}         Complete HTML document string
         */
        static wrapAsDocument(bodyHtml, title) {
            return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${DOMScanner.escapeHtml(title)}</title>
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
         * Escape HTML entities in a string.
         */
        static escapeHtml(str) {
            return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        /**
         * Extract structured content from the page.
         * @returns {{ title: string, text: string, html: string, bodyHtml: string, charCount: number }}
         */
        static scan() {
            const container = DOMScanner.findContainer();
            if (!container) {
                return { title: '', text: '', html: '', bodyHtml: '', charCount: 0 };
            }

            // Clone so we don't mutate the live DOM
            const clone = container.cloneNode(true);
            DOMScanner.removeNoise(clone);

            // Extract title
            const title =
                document.title?.replace(/ - Google (Docs|Sheets|Slides).*/, '').trim() ||
                clone.querySelector('h1, h2, h3')?.textContent?.trim() ||
                'Untitled Document';

            // ── Plain text extraction ────────────────────────

            const textParts = [];
            const walker = document.createTreeWalker(
                clone,
                NodeFilter.SHOW_ELEMENT,
                {
                    acceptNode(node) {
                        const tag = node.tagName;
                        if (['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'BR'].includes(tag)) {
                            return NodeFilter.FILTER_ACCEPT;
                        }
                        return NodeFilter.FILTER_SKIP;
                    },
                }
            );

            let node;
            while ((node = walker.nextNode())) {
                const txt = node.textContent?.trim();
                if (txt) textParts.push(txt);
            }

            let text = textParts.join('\n\n');
            if (!text.trim()) {
                text = clone.innerText || clone.textContent || '';
            }

            // ── Cleaned HTML extraction ─────────────────────

            const htmlClone = container.cloneNode(true);
            DOMScanner.removeNoise(htmlClone);
            DOMScanner.cleanHtml(htmlClone);

            const cleanedBodyHtml = htmlClone.innerHTML || '';
            const html = DOMScanner.wrapAsDocument(cleanedBodyHtml, title);

            return {
                title,
                text: text.trim(),
                html,              // full HTML doc (for rich clipboard copy)
                bodyHtml: cleanedBodyHtml,  // body-only HTML (for DOCX generator)
                charCount: text.trim().length,
            };
        }
    }

    // ─── Auto-run & message handling ────────────────────────────────

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.action === 'extract') {
            try {
                const result = DOMScanner.scan();
                sendResponse({ success: true, data: result });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
            return true;
        }
    });

    if (window.location.href.includes('/mobilebasic')) {
        setTimeout(() => {
            const result = DOMScanner.scan();
            chrome.runtime.sendMessage({ action: 'contentReady', data: result });
        }, 500);
    }
})();
