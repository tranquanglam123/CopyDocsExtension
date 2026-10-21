/**
 * What an iframe, object or link on a web page points at. content/scan.js
 * collects the candidates from the live DOM; this decides what each one is,
 * from its URL alone, so every rule is testable under Node.
 */
import { EMBED_KINDS, FILE_LIMITS } from './const.js';

/** Extensions worth offering as the original file. Only pdf/docx are parsed. */
const FILE_EXT = /\.(pdf|docx?|pptx?|xlsx?)$/i;

/** Below this many square pixels a frame is a widget, not a document. */
const MIN_FRAME_AREA = 150 * 150;

/** Already granted by the manifest; never asked for again. */
const GRANTED_HOSTS = new Set(['docs.google.com']);

const DRIVE_ORIGINS = ['https://drive.google.com/*', 'https://drive.usercontent.google.com/*'];

/**
 * @typedef {{
 *   kind: string,          EMBED_KINDS value.
 *   fileUrl: string,       What gets fetched and parsed.
 *   downloadUrl: string|null,  The original file, for "download original".
 *   ext: string|null,      'pdf' | 'docx' | … when the URL says so.
 *   via: string,           Which viewer it was found behind.
 *   origins: string[],     Host patterns a cross-origin fetch needs.
 * }} Embed
 */

/**
 * @param {string} raw      An src/href/data value as written in the page.
 * @param {string} baseUrl  The page (or viewer) it is relative to.
 * @returns {Embed|null}
 */
export function classifyEmbed(raw, baseUrl) {
    const url = toUrl(raw, baseUrl);
    if (!url) return null;

    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    if (host === 'docs.google.com') return classifyGoogle(url);

    if (host === 'drive.google.com') {
        const id = path.match(/^\/file\/d\/([\w-]+)/)?.[1] ||
            (/^\/(open|uc)$/.test(path) ? url.searchParams.get('id') : null);
        return id ? driveFile(id) : null;
    }

    // Office Online renders .docx/.pptx from a public URL passed as `src`.
    if (/(^|\.)officeapps\.live\.com$/.test(host)) {
        const src = url.searchParams.get('src');
        return src ? fileEmbed(src, url.href, 'office') : null;
    }

    // pdf.js viewers (WordPress PDF plugins, flipbooks) take the file as
    // `file`, in the query or after the hash.
    if (/\/viewer\.html?$/i.test(path) || /\/pdfjs/i.test(path)) {
        const file = url.searchParams.get('file') ||
            new URLSearchParams(url.hash.replace(/^#/, '')).get('file');
        return file ? fileEmbed(file, url.href, 'pdfjs') : null;
    }

    if (FILE_EXT.test(path)) return fileEmbed(url.href, url.href, 'direct');
    return null;
}

/**
 * Frames come first: a page embeds its material and links to everything
 * else. Links count only inside the article and only when nothing is framed.
 *
 * @param {Array<{src: string, tag: string, area?: number, inArticle?: boolean}>} candidates
 * @param {string} pageUrl
 * @returns {{embeds: Embed[], overflow: number}}
 */
export function pickEmbeds(candidates, pageUrl) {
    const page = toUrl(pageUrl, undefined)?.href.split('#')[0];
    const frames = [];
    const links = [];

    for (const c of Array.isArray(candidates) ? candidates : []) {
        const embed = classifyEmbed(c?.src, pageUrl);
        if (!embed || embed.fileUrl.split('#')[0] === page) continue;
        if (c.tag === 'a') {
            if (c.inArticle) links.push(embed);
        } else if (!(c.area > 0 && c.area < MIN_FRAME_AREA)) {
            frames.push(embed);
        }
    }

    const seen = new Set();
    const unique = (frames.length ? frames : links).filter((e) => {
        if (seen.has(e.fileUrl)) return false;
        seen.add(e.fileUrl);
        return true;
    });

    return {
        embeds: unique.slice(0, FILE_LIMITS.MAX_EMBEDS),
        overflow: Math.max(0, unique.length - FILE_LIMITS.MAX_EMBEDS),
    };
}

/**
 * Host patterns to request before extraction. A same-origin file is read
 * inside the tab, which needs nothing beyond activeTab.
 * @param {Embed[]} embeds
 * @param {string} pageUrl
 * @returns {string[]}
 */
export function originsToRequest(embeds, pageUrl) {
    const pageOrigin = toUrl(pageUrl, undefined)?.origin;
    const out = new Set();
    for (const embed of embeds || []) {
        const url = toUrl(embed.fileUrl, undefined);
        if (!url || url.origin === pageOrigin) continue;
        for (const origin of embed.origins) out.add(origin);
    }
    return [...out];
}

/**
 * Last path segment, for naming a download. Null when the URL has none
 * worth keeping, so the server's Content-Disposition decides.
 * @param {string} fileUrl
 * @returns {string|null}
 */
export function fileNameOf(fileUrl) {
    const url = toUrl(fileUrl, undefined);
    const last = url?.pathname.split('/').pop() || '';
    if (!FILE_EXT.test(last)) return null;
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

/**
 * What fetched bytes are, from their first few. A server's content-type is
 * often `application/octet-stream`, and a wall page arrives as a 200.
 * @param {string} head  The first bytes as a binary string (atob output).
 * @returns {'pdf'|'zip'|'ole'|'html'|null}  `zip` covers .docx/.xlsx/.pptx;
 *   `ole` is pre-2007 Office (.doc/.xls/.ppt).
 */
export function sniffFileType(head) {
    if (typeof head !== 'string') return null;
    if (/^\s*%PDF-/.test(head)) return 'pdf';
    if (head.startsWith('PK\x03\x04')) return 'zip';
    if (head.startsWith('\xD0\xCF\x11\xE0')) return 'ole';
    if (/^\s*</.test(head)) return 'html';
    return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toUrl(raw, base) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const url = new URL(raw.trim(), base);
        return /^https?:$/.test(url.protocol) ? url : null;
    } catch {
        return null;
    }
}

function originPattern(url) {
    return GRANTED_HOSTS.has(url.hostname) ? [] : [`${url.protocol}//${url.hostname}/*`];
}

/** A file behind a viewer. The viewer vouches for it, so no extension is required. */
function fileEmbed(raw, base, via) {
    const url = toUrl(raw, base);
    if (!url) return null;
    // A viewer pointed at Drive or Docs is that document, not a plain file.
    if (url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com') {
        return classifyEmbed(url.href, undefined);
    }
    const ext = url.pathname.match(FILE_EXT)?.[1].toLowerCase() || null;
    return { kind: EMBED_KINDS.FILE, fileUrl: url.href, downloadUrl: url.href, ext, via, origins: originPattern(url) };
}

function driveFile(id) {
    const fileUrl = `https://drive.google.com/uc?export=download&id=${id}`;
    return {
        kind: EMBED_KINDS.FILE,
        fileUrl,
        downloadUrl: fileUrl,
        ext: null,
        via: 'drive',
        origins: DRIVE_ORIGINS,
    };
}

function classifyGoogle(url) {
    const path = url.pathname;

    // The Docs viewer wraps a public URL, or a Drive file by `srcid`.
    if (/^\/(viewer|gview)$/.test(path)) {
        const inner = url.searchParams.get('url');
        if (inner) return fileEmbed(inner, url.href, 'gview');
        const srcid = url.searchParams.get('srcid');
        return srcid ? driveFile(srcid) : null;
    }

    const m = path.match(/^\/(document|spreadsheets|presentation)\/d\/(e\/)?([\w-]+)/);
    if (!m) return null;
    const [, app, published, id] = m;
    const base = `https://docs.google.com/${app}/d/`;

    if (published) {
        // Published-to-web copies are plain public HTML.
        if (app === 'document') return google(EMBED_KINDS.HTML, `${base}e/${id}/pub`, null);
        if (app === 'spreadsheets') return google(EMBED_KINDS.HTML, `${base}e/${id}/pubhtml`, `${base}e/${id}/pub?output=xlsx`);
        return null;
    }
    if (app === 'document') return google(EMBED_KINDS.GDOC, `${base}${id}/edit`, `${base}${id}/export?format=docx`);
    if (app === 'spreadsheets') return google(EMBED_KINDS.GSHEET, `${base}${id}/edit`, `${base}${id}/export?format=xlsx`);
    // Slides has no server-rendered HTML, but its PDF export reads as a PDF.
    const pdf = `${base}${id}/export/pdf`;
    return { kind: EMBED_KINDS.FILE, fileUrl: pdf, downloadUrl: pdf, ext: 'pdf', via: 'google', origins: [] };
}

function google(kind, fileUrl, downloadUrl) {
    return { kind, fileUrl, downloadUrl, ext: null, via: 'google', origins: [] };
}
