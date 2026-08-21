/**
 * csv-pipeline.js — Sheets extraction, fetching the `gviz` CSV export
 * directly from the service worker. Moved from background/service-worker.js's
 * `runSwFetchPipeline`. No tab navigation, no DNR rule (fixes D1 for Sheets;
 * see spec §3.2 T1 `swFetch`).
 *
 * P1 always reads `gid=0` — only the first sheet. This is surfaced via
 * `meta.warnings: [WARNINGS.SINGLE_SHEET_ONLY]` and must never be silent.
 */
import { DOC_TYPES, TRANSPORTS, WARNINGS } from '../shared/constants.js';
import { parseCsv, csvToHtml } from '../core/csv-to-html.js';
import { wrapAsDocument } from '../core/html-document.js';
import { PipelineState } from './pipeline-state.js';
import { setExtractionComplete } from '../platform/storage.js';

/**
 * @param {object} tab   The active tab (chrome tabs.Tab shape).
 * @param {{url: string, parser: string, mode: string}} target
 * @param {string} docId
 * @returns {Promise<object>}
 */
export async function runSwFetchPipeline(tab, target, docId) {
    const tabId = tab.id;
    await PipelineState.write({
        phase: 'fetching',
        tabId,
        ruleId: null,
        startedAt: Date.now(),
        docId,
    });

    try {
        let response;
        try {
            response = await fetch(target.url, { credentials: 'include' });
        } catch (err) {
            throw new Error(`Network request failed while fetching the sheet: ${err.message}`);
        }

        // Login-wall via redirect (e.g. accounts.google.com/ServiceLogin).
        if (response.url && /accounts\.google\.com|\/ServiceLogin/i.test(response.url)) {
            throw new Error(
                'This spreadsheet requires sign-in — the extension could not access it ' +
                '(redirected to a Google login page).'
            );
        }

        const contentType = response.headers.get('content-type') || '';
        const bodyText = await response.text();

        if (!response.ok) {
            throw new Error(`Failed to fetch sheet data (HTTP ${response.status}).`);
        }

        // Login-wall / access-wall via body content (gviz returns a
        // small HTML/JS error payload, not a CSV, when access is denied).
        //
        // Gate this on the content type: a legitimate spreadsheet can
        // legitimately contain the words "Sign in" (an attendance or
        // sign-in sheet), and matching the wall pattern against CSV cell
        // data would reject that user's own document. Only a non-CSV
        // response can be an access wall.
        const isCsvResponse = /text\/csv|application\/csv/i.test(contentType);
        if (!isCsvResponse && /Sign in|You need access|Request access/i.test(bodyText)) {
            throw new Error(
                'This spreadsheet requires access — the extension could not read it ' +
                '(access wall detected in the response).'
            );
        }

        // The gviz endpoint answers errors with an HTML/JS payload rather
        // than a non-2xx status. Feeding that to the CSV parser would
        // produce convincing-looking garbage, so refuse it outright.
        if (!isCsvResponse && /^\s*(<!DOCTYPE|<html|\)\]\}')/i.test(bodyText)) {
            throw new Error(
                'The spreadsheet endpoint returned a non-CSV response — the sheet may be ' +
                'restricted, empty, or the gviz endpoint has changed.'
            );
        }

        await PipelineState.write({ phase: 'parsing' });

        const rows = parseCsv(bodyText);
        const { bodyHtml, text, charCount } = csvToHtml(rows);
        const title = (tab.title || '').replace(/ - Google Sheets.*/i, '').trim() || 'Untitled Spreadsheet';
        const html = wrapAsDocument(bodyHtml, title);

        const result = {
            title,
            text,
            html,
            bodyHtml,
            charCount,
            meta: {
                transport: TRANSPORTS.SW_FETCH,
                docType: DOC_TYPES.SHEETS,
                docId,
                // P1 only ever reads gid=0 — never let this be silent.
                warnings: [WARNINGS.SINGLE_SHEET_ONLY],
            },
        };

        await setExtractionComplete(result);

        return result;
    } finally {
        // No DNR rule and no tab was ever touched — clearing the
        // pipeline slot is the only cleanup needed.
        await PipelineState.clear();
    }
}
