/**
 * What the popup shows when it opens. A finished result lives in session
 * storage until the browser closes, so it must be matched to the tab it
 * came from or it hides every later document.
 */
import { DOC_TYPES, EXTRACTION_STATUS, VIEWS } from './const.js';

/**
 * @param {{
 *   status: string,
 *   storedResult: object|null,
 *   tab: {isValid?: boolean, type?: string, docId?: string, url?: string, title?: string}|null,
 * }} state
 * @returns {{view: string, result?: object, tab?: object}}
 */
export function decideInitialView({ status, storedResult, tab }) {
    // An extraction in flight outranks the tab: the popup may have been
    // closed by the tabnav fallback navigating away.
    if (status === EXTRACTION_STATUS.RUNNING) return { view: VIEWS.RECOVERY_RUNNING };

    const doc = tab && tab.isValid ? tab : null;

    if (status === EXTRACTION_STATUS.COMPLETE && doc && belongsTo(storedResult, doc.docId)) {
        return { view: VIEWS.RESULT, result: storedResult, tab: doc };
    }

    if (!doc) return { view: VIEWS.NOT_A_DOC };
    if (doc.type === DOC_TYPES.SLIDES) return { view: VIEWS.SLIDES_UNSUPPORTED, tab: doc };
    return { view: VIEWS.DOC_DETECTED, tab: doc };
}

/** A result stored before docIds were stamped has none, and is not trusted. */
function belongsTo(result, docId) {
    const stored = result?.meta?.docId;
    return Boolean(stored) && Boolean(docId) && stored === docId;
}
