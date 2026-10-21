/**
 * Web pages: the files a page embeds (PDF, DOCX, an embedded Google Doc or
 * Sheet), else the page's own article. content/scan.js reads the live DOM;
 * lib/embed.js decides what each embed is. No DNR rule, no tab navigation.
 */
import { DOC_TYPES, EMBED_KINDS, FILE_LIMITS, TRANSPORTS, WARNINGS, WARNING_PREFIXES } from '../../lib/const.js';
import { classifyEmbed, pickEmbeds, originsToRequest, sniffFileType, fileNameOf } from '../../lib/embed.js';
import { wrapAsDocument, escapeHtml } from '../../lib/html.js';
import { AppError } from '../../lib/error.js';
import { CONTENT_SCRIPTS } from '../../bridge/contract.js';
import { executeFileInTab } from '../../bridge/chrome/scripting.js';
import { parse, parseFile } from '../../bridge/to-offscreen.js';
import { setExtractionComplete } from '../../bridge/chrome/storage.js';
import { fetchDocHtml, swFetch } from './http.js';
import { fetchFile } from './binary.js';
import { embedImagesIntoResult } from './image.js';
import { toExtractionTarget } from './route.js';
import { extractSheet } from './via-csv.js';
import { fetchDocxExport } from './via-fetch.js';
import { UrlTransformer } from '../../lib/url.js';
import { PipelineState } from './state.js';

/**
 * A tab that is itself a file (a PDF opened directly, a Drive preview) is
 * its own single embed: Chrome's PDF viewer cannot be scanned.
 * @param {{id: number, url: string}} tab
 * @returns {Promise<{scan: object|null, embeds: object[], overflow: number, origins: string[]}>}
 */
export async function findEmbeds(tab) {
    const direct = classifyEmbed(tab.url, undefined);
    if (direct && direct.kind === EMBED_KINDS.FILE) {
        return { scan: null, embeds: [direct], overflow: 0, origins: direct.origins };
    }

    let scan;
    try {
        scan = await executeFileInTab(tab.id, CONTENT_SCRIPTS.SCAN);
    } catch (err) {
        throw new AppError('error.pageScanFailed', { message: err.message });
    }
    if (!scan || typeof scan.html !== 'string') {
        throw new AppError('error.pageScanFailed', { message: 'no scan result' });
    }

    const { embeds, overflow } = pickEmbeds(scan.candidates, scan.url);
    return { scan, embeds, overflow, origins: originsToRequest(embeds, scan.url) };
}

/**
 * @param {object} tab   The active tab (chrome tabs.Tab shape).
 * @param {{url: string, parser: string, mode: string}} target
 * @param {string} docId
 * @returns {Promise<object>}
 */
export async function runEmbedPipeline(tab, target, docId) {
    await PipelineState.write({
        phase: 'scanning',
        tabId: tab.id,
        ruleId: null,
        startedAt: Date.now(),
        docId,
    });

    try {
        const { scan, embeds, overflow } = await findEmbeds(tab);
        const warnings = [];
        const parts = [];

        await PipelineState.write({ phase: 'fetching' });
        for (const embed of embeds) {
            try {
                parts.push(await extractEmbed(embed, tab));
            } catch (err) {
                console.warn(`[extract/embed] ${embed.fileUrl} failed:`, err.message);
                parts.push({ failed: err });
            }
        }

        const read = parts.filter((p) => !p.failed);
        const failed = parts.length - read.length;
        if (failed > 0) warnings.push(`${WARNING_PREFIXES.EMBED_FAILED}:${failed}`);
        if (overflow > 0) warnings.push(`${WARNING_PREFIXES.EMBEDS_OVER_LIMIT}:${overflow}`);

        // Nothing embedded, or nothing readable: the article still is.
        if (read.length === 0) {
            if (!scan) throw parts[0]?.failed || new AppError('error.noExtractionTarget');
            await PipelineState.write({ phase: 'parsing' });
            const page = await parse(scan.html, DOC_TYPES.WEB);
            read.push({ title: page.title, bodyHtml: page.bodyHtml, text: page.text, warnings: page.meta?.warnings || [] });
            if (embeds.length === 0) warnings.push(WARNINGS.PAGE_ARTICLE_USED);
        }

        const title = (scan?.title || tab.title || read[0].title || '').trim() || 'Untitled Page';
        // Several files get a heading each, so the reader can tell them apart.
        // Their OLE markers index one combined list, so later files shift.
        const titled = read.length > 1;
        const ole = [];
        const bodyHtml = read
            .map((p, i) => {
                const offset = ole.length;
                ole.push(...(p.ole || []));
                const body = offset === 0 ? p.bodyHtml
                    : p.bodyHtml.replace(/data-ole="(\d+)"/g, (_, n) => `data-ole="${Number(n) + offset}"`);
                return (titled ? `<h2>${escapeHtml(p.title || `#${i + 1}`)}</h2>\n` : '') + body;
            })
            .join('\n');
        const text = read.map((p) => (titled ? `${p.title}\n\n` : '') + p.text).join('\n\n').trim();

        const result = {
            title,
            text,
            html: wrapAsDocument(bodyHtml, title),
            bodyHtml,
            charCount: text.length,
            // MathType equations for popup/docx.js, by their data-ole index.
            ...(ole.length > 0 ? { ole } : {}),
            // One Word file (or exportable Google Doc) and nothing else: the
            // .docx download is that file.
            ...(read.length === 1 && read[0].docx ? { docx: read[0].docx } : {}),
            meta: {
                transport: TRANSPORTS.EMBED,
                docType: DOC_TYPES.WEB,
                docId,
                warnings: [...new Set([...read.flatMap((p) => p.warnings || []), ...warnings])],
                // Offered even when a file could not be parsed: the original
                // is often the better copy (MathType equations, legacy fonts).
                sourceFiles: embeds
                    .filter((e) => e.downloadUrl)
                    .map((e) => ({ url: e.downloadUrl, name: fileNameOf(e.downloadUrl), ext: e.ext })),
            },
        };

        await setExtractionComplete(result, docId);
        return result;
    } finally {
        // No rule, no navigation — the slot is the only cleanup.
        await PipelineState.clear();
    }
}

/**
 * @param {object} embed  From lib/embed.js.
 * @param {{id: number, url: string}} tab
 * @returns {Promise<{title: string, bodyHtml: string, text: string, warnings: string[], ole?: object[], docx?: string}>}
 */
async function extractEmbed(embed, tab) {
    switch (embed.kind) {
        case EMBED_KINDS.GDOC: {
            // Cross-origin to the tab, so the worker tier alone; docs.google.com
            // is a manifest host.
            const exported = fetchDocxExport(UrlTransformer.getDocId(embed.fileUrl));
            const { html } = await fetchDocHtml({ url: toExtractionTarget(embed.fileUrl).url, tabId: null });
            const parsed = await embedImagesIntoResult(await parse(html, DOC_TYPES.DOCS), null);
            const docx = await exported;
            return { ...fromParsed(parsed), ...(docx ? { docx } : {}) };
        }
        case EMBED_KINDS.GSHEET:
            return fromParsed(await extractSheet(toExtractionTarget(embed.fileUrl), ''));

        case EMBED_KINDS.HTML: {
            const res = await swFetch(embed.fileUrl);
            if (!res.ok) throw new AppError('error.embedFetchFailed', { status: res.status });
            return fromParsed(await parse(res.html, DOC_TYPES.WEB));
        }
        default:
            return extractFile(embed, tab);
    }
}

async function extractFile(embed, tab) {
    const sameOrigin = new URL(embed.fileUrl).origin === new URL(tab.url).origin;
    const file = await fetchFile({ url: embed.fileUrl, tabId: tab.id, sameOrigin });
    if (!file.ok) throw new AppError('error.embedFetchFailed', { status: file.status });
    if (file.byteLength > FILE_LIMITS.MAX_BYTES) {
        throw new AppError('error.embedTooLarge', { mb: Math.round(file.byteLength / 1048576) });
    }

    const type = sniffFileType(atob(file.base64.slice(0, 16)));
    if (type !== 'pdf' && type !== 'zip') {
        throw new AppError('error.embedUnsupportedType', { type: embed.ext || type || '?' });
    }

    await PipelineState.write({ phase: 'parsing' });
    const parsed = await parseFile(file.base64, type);
    return {
        title: parsed.title || fileNameOf(embed.fileUrl) || '',
        bodyHtml: parsed.bodyHtml,
        text: parsed.text,
        warnings: parsed.warnings || [],
        ole: parsed.ole || [],
        // A Word file is exported as itself, MathType swapped for Office Math.
        ...(type === 'zip' ? { docx: parsed.docx || file.base64 } : {}),
    };
}

function fromParsed(parsed) {
    return {
        title: parsed.title || '',
        bodyHtml: parsed.bodyHtml || '',
        text: parsed.text || '',
        warnings: parsed.meta?.warnings || [],
    };
}
