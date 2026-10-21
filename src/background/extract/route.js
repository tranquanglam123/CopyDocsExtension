/**
 * Doc type to extraction endpoint. Kept out of lib/url.js, which stays pure
 * URL parsing; which endpoint to use is orchestration knowledge.
 */
import { DOC_TYPES, TRANSPORTS } from '../../lib/const.js';
import { UrlTransformer } from '../../lib/url.js';

/**
 * `/mobilebasic` exists for Docs only, so each type routes differently:
 *
 * - docs   → `/mobilebasic` as HTML, fetched. run.js falls back to tabnav
 *            only if every tier fails.
 * - sheets → the `gviz` CSV export, fetched from the worker. `gid=0` only;
 *            the caller must surface SINGLE_SHEET_ONLY.
 * - slides → `null`. No server-rendered path exists.
 * - web    → the tab itself; via-embed.js finds what it embeds.
 *
 * @param {string} url
 * @returns {{ url: string, parser: 'html'|'csv'|'embed', mode: 'fetch'|'swFetch'|'embed' } | null}
 */
export function toExtractionTarget(url) {
    const { isValid, type } = UrlTransformer.identify(url);
    if (!isValid) return null;

    const docId = UrlTransformer.getDocId(url);
    if (!docId) return null;

    switch (type) {
        case DOC_TYPES.DOCS:
            return {
                url: `https://docs.google.com/document/d/${docId}/mobilebasic`,
                parser: 'html',
                mode: 'fetch',
            };
        case DOC_TYPES.SHEETS:
            return {
                url: `https://docs.google.com/spreadsheets/d/${docId}/gviz/tq?tqx=out:csv&gid=0`,
                parser: 'csv',
                mode: 'swFetch',
            };
        case DOC_TYPES.SLIDES:
            // No reliable server-rendered path exists.
            return null;
        case DOC_TYPES.WEB:
            return { url, parser: 'embed', mode: TRANSPORTS.EMBED };
        default:
            return null;
    }
}

/**
 * Google's own .docx of a document. It answers only when the owner allows
 * downloads, which is why it is a bonus to the HTML, never the route.
 * @param {string} docId
 * @returns {string}
 */
export function toDocxExport(docId) {
    return `https://docs.google.com/document/d/${encodeURIComponent(docId)}/export?format=docx`;
}
