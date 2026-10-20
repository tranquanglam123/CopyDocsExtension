/**
 * Injected on demand into a web page (bridge/chrome/scripting.js). Lists what
 * the page embeds and returns its HTML; lib/embed.js decides what each
 * candidate is. Not a module, like main.js, and its value is its last
 * expression.
 */
(() => {
    'use strict';

    /** Where a site puts the post body; links outside it are navigation. */
    const ARTICLE = [
        'article', 'main', '[role="main"]', '[itemprop="articleBody"]',
        '.entry-content', '.post-content', '.td-post-content', '.single-content', '#content',
    ].join(', ');

    const candidates = [];

    const absolute = (value) => {
        if (!value || /^\s*(about:|javascript:|data:)/i.test(value)) return null;
        try {
            return new URL(value, document.baseURI).href;
        } catch {
            return null;
        }
    };

    const push = (el, tag, value) => {
        const src = absolute(value);
        if (!src) return;
        const rect = el.getBoundingClientRect();
        candidates.push({
            tag,
            src,
            area: Math.round(rect.width * rect.height),
            inArticle: Boolean(el.closest(ARTICLE)),
        });
    };

    // Lazy loaders park the real URL in a data attribute behind about:blank.
    document.querySelectorAll('iframe, frame').forEach((el) => {
        push(el, 'iframe', el.dataset.src || el.dataset.lazySrc || el.getAttribute('data-litespeed-src') || el.getAttribute('src'));
    });
    document.querySelectorAll('embed[src]').forEach((el) => push(el, 'embed', el.getAttribute('src')));
    document.querySelectorAll('object[data]').forEach((el) => push(el, 'embed', el.getAttribute('data')));
    // Flipbook and PDF plugins that build their viewer from an attribute.
    document.querySelectorAll('[data-pdf], [data-pdf-url], [data-file], ._df_book[source], a.pdfemb-viewer').forEach((el) => {
        push(el, 'embed', el.dataset.pdf || el.dataset.pdfUrl || el.dataset.file || el.getAttribute('source') || el.getAttribute('href'));
    });
    document.querySelectorAll('a[href]').forEach((el) => push(el, 'a', el.getAttribute('href')));

    // The page itself, for when nothing is embedded. URLs are made absolute
    // because the parser loads it from srcdoc, and a CSP stops that load from
    // fetching every image and stylesheet before it can finish.
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, noscript, template, link[rel~="stylesheet"]').forEach((el) => el.remove());
    clone.querySelectorAll('img').forEach((img) => {
        const src = absolute(img.dataset.src || img.dataset.lazySrc || img.getAttribute('src'));
        if (src) img.setAttribute('src', src);
        img.removeAttribute('srcset');
    });
    clone.querySelectorAll('a[href]').forEach((a) => {
        const href = absolute(a.getAttribute('href'));
        if (href) a.setAttribute('href', href);
    });
    const head = clone.querySelector('head') || clone.insertBefore(document.createElement('head'), clone.firstChild);
    const csp = document.createElement('meta');
    csp.setAttribute('http-equiv', 'Content-Security-Policy');
    csp.setAttribute('content', "default-src 'none'; style-src 'unsafe-inline'");
    head.insertBefore(csp, head.firstChild);

    return {
        url: location.href,
        title: document.title,
        html: '<!DOCTYPE html>' + clone.outerHTML,
        candidates,
    };
})();
