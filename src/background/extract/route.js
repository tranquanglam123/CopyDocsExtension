/**
 * targets.js — doc-type → extraction-endpoint mapping (spec v3 §2/§4 P2).
 * Moved out of core/document-url.js's `UrlTransformer.toExtractionTarget`
 * so document-url.js stays pure URL parsing (`identify`/`getDocId`/
 * `getTypeLabel`); this file encodes WHICH endpoint/transport each doc type
 * extracts through, which is extraction-orchestration knowledge, not URL
 * parsing.
 */
import { DOC_TYPES } from '../../lib/const.js';
import { UrlTransformer } from '../../lib/url.js';

/**
 * Build the extraction target for a Google Workspace URL (fixes D1 —
 * `/mobilebasic` does not exist for Sheets or Slides, only for Docs).
 *
 * - docs   → `/document/d/{id}/mobilebasic`, parsed as HTML, fetched
 *            directly (`fetch` — T1 `swFetch` then T2 `csFetch`, spec
 *            §3.2, pulled forward from P3). No tab navigation, no DNR
 *            rule. `extraction/pipeline-runner.js` falls back to the
 *            legacy `tabNav` pipeline only if every fetch tier fails.
 * - sheets → the `gviz` CSV export endpoint, parsed as CSV, fetched
 *            directly from the service worker (`swFetch` — no tab
 *            navigation, no DNR rule). P1 reads `gid=0` only; the
 *            caller must surface `warnings: ['single_sheet_only']`.
 * - slides → no working server-rendered path exists yet (see spec
 *            §3.3) — returns `null`, unsupported in P1.
 *
 * @param {string} url
 * @returns {{ url: string, parser: 'html'|'csv', mode: 'fetch'|'swFetch' } | null}
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
            // Unsupported in P1 — no reliable server-rendered path exists.
            return null;
        default:
            return null;
    }
}
