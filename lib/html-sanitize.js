/**
 * HtmlSanitize — Sanitisation rules applied to fetched HTML BEFORE anything
 * else reads it (spec §4.2 step 5). Kept in its own module so the rule set
 * is auditable in one place, separate from parsing/extraction logic.
 *
 * Requires a DOM (`Document`/`Element` with `querySelectorAll`); this is not
 * unit-testable under plain `node --test` and is exercised via the offscreen
 * parser in a real browser only (see test/MANUAL-CHECKLIST.md).
 *
 * Defense in depth: the offscreen parser also loads content into an
 * `<iframe sandbox="allow-same-origin">` with NO `allow-scripts`, so even if
 * a `<script>` tag or an inline event handler survived sanitisation, the
 * browser would refuse to execute it. This module removes them anyway so
 * the *extracted* HTML that gets copied/downloaded is clean too.
 */
export class HtmlSanitize {

    /** Elements that can execute code or load an active sub-document — always removed. */
    static DANGEROUS_TAGS = ['script', 'iframe', 'object', 'embed'];

    /**
     * Sanitise a Document or Element in place.
     * @param {Document|Element} root  Anything exposing `querySelectorAll`.
     * @returns {Document|Element}     The same `root`, for chaining.
     */
    static sanitize(root) {
        if (!root || typeof root.querySelectorAll !== 'function') {
            throw new TypeError('HtmlSanitize.sanitize requires a Document or Element.');
        }

        HtmlSanitize._removeDangerousTags(root);
        HtmlSanitize._stripEventHandlerAttributes(root);
        HtmlSanitize._stripJavascriptUrls(root);

        return root;
    }

    /**
     * Remove every `<script>`, `<iframe>`, `<object>`, `<embed>` element.
     * @param {Document|Element} root
     */
    static _removeDangerousTags(root) {
        for (const tag of HtmlSanitize.DANGEROUS_TAGS) {
            root.querySelectorAll(tag).forEach((el) => el.remove());
        }
    }

    /**
     * Strip every `on*` attribute (onclick, onerror, onload, ...) from every element.
     * @param {Document|Element} root
     */
    static _stripEventHandlerAttributes(root) {
        const all = root.querySelectorAll('*');
        for (const el of all) {
            // Snapshot first — mutating `attributes` (a live NamedNodeMap) while
            // iterating it directly skips entries.
            const attrNames = [...el.attributes].map((a) => a.name);
            for (const name of attrNames) {
                if (name.toLowerCase().startsWith('on')) {
                    el.removeAttribute(name);
                }
            }
        }
    }

    /**
     * Strip `href`/`src` attributes whose value starts with `javascript:`.
     * @param {Document|Element} root
     */
    static _stripJavascriptUrls(root) {
        const candidates = root.querySelectorAll('[href], [src]');
        for (const el of candidates) {
            for (const attr of ['href', 'src']) {
                const value = el.getAttribute(attr);
                if (value && /^\s*javascript:/i.test(value)) {
                    el.removeAttribute(attr);
                }
            }
        }
    }
}
