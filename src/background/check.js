/** What the popup is told about the active tab when it opens. */
import { DOC_TYPES } from '../lib/const.js';
import { UrlTransformer } from '../lib/url.js';
import { getActiveTab } from '../bridge/chrome/tabs.js';
import { findEmbeds } from './extract/via-embed.js';

/**
 * A web tab is scanned now, so the popup can say what it found and ask for
 * any host permission inside the click that starts extraction.
 * @returns {Promise<object>}
 */
export async function checkTab() {
    const tab = await getActiveTab();
    const { isValid, type } = UrlTransformer.identify(tab.url);
    const info = {
        isValid,
        type,
        typeLabel: isValid ? UrlTransformer.getTypeLabel(tab.url) : null,
        url: tab.url,
        title: tab.title,
        docId: isValid ? UrlTransformer.getDocId(tab.url) : null,
    };
    if (type !== DOC_TYPES.WEB) return info;

    try {
        const { embeds, origins } = await findEmbeds(tab);
        return {
            ...info,
            embeds: embeds.map(({ kind, ext, via, fileUrl }) => ({ kind, ext, via, fileUrl })),
            origins,
        };
    } catch (err) {
        // chrome:// pages and the Web Store refuse injection.
        console.warn('[background] web tab scan failed:', err.message);
        return { ...info, isValid: false, docId: null };
    }
}
