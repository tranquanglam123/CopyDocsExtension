/**
 * Sheets extraction: the `gviz` CSV export, fetched from the service worker.
 * No tab navigation, no DNR rule. Reads `gid=0` only, and says so through
 * SINGLE_SHEET_ONLY — never silently.
 */
import { DOC_TYPES, TRANSPORTS, WARNINGS } from '../../lib/const.js';
import { parseCsv, csvToHtml } from '../../lib/csv.js';
import { wrapAsDocument } from '../../lib/html.js';
import { AppError } from '../../lib/error.js';
import { PipelineState } from './state.js';
import { setExtractionComplete } from '../../bridge/chrome/storage.js';

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
        const title = (tab.title || '').replace(/ - Google Sheets.*/i, '').trim();
        const result = await extractSheet(target, title);
        result.meta.docId = docId;

        await setExtractionComplete(result, docId);

        return result;
    } finally {
        // No rule, no tab touched — the slot is the only cleanup.
        await PipelineState.clear();
    }
}

/**
 * Fetch and convert one sheet. Shared with via-embed.js, which reads Sheets
 * embedded in web pages and owns its own pipeline state.
 * @param {{url: string}} target
 * @param {string} title
 * @returns {Promise<object>}
 */
export async function extractSheet(target, title) {
    let response;
    try {
        response = await fetch(target.url, { credentials: 'include' });
    } catch (err) {
        throw new AppError('error.sheetNetworkFailed', { message: err.message });
    }

    // Login wall via redirect.
    if (response.url && /accounts\.google\.com|\/ServiceLogin/i.test(response.url)) {
        throw new AppError('error.sheetSignInRequired');
    }

    const contentType = response.headers.get('content-type') || '';
    const bodyText = await response.text();

    if (!response.ok) {
        throw new AppError('error.sheetFetchFailed', { status: response.status });
    }

    // Denied access returns a small HTML/JS payload, not CSV. Gated on
    // content type: a sign-in sheet legitimately contains "Sign in", so
    // only a non-CSV response can be a wall.
    const isCsvResponse = /text\/csv|application\/csv/i.test(contentType);
    if (!isCsvResponse && /Sign in|You need access|Request access/i.test(bodyText)) {
        throw new AppError('error.sheetAccessWall');
    }

    // gviz answers errors with HTML/JS and a 2xx. The CSV parser would
    // turn that into convincing garbage.
    if (!isCsvResponse && /^\s*(<!DOCTYPE|<html|\)\]\}')/i.test(bodyText)) {
        throw new AppError('error.sheetNonCsvResponse');
    }

    const rows = parseCsv(bodyText);
    const { bodyHtml, text, charCount } = csvToHtml(rows);
    const sheetTitle = title || 'Untitled Spreadsheet';

    return {
        title: sheetTitle,
        text,
        html: wrapAsDocument(bodyHtml, sheetTitle),
        bodyHtml,
        charCount,
        meta: {
            transport: TRANSPORTS.SW_FETCH,
            docType: DOC_TYPES.SHEETS,
            // gid=0 only — never silent.
            warnings: [WARNINGS.SINGLE_SHEET_ONLY],
        },
    };
}
