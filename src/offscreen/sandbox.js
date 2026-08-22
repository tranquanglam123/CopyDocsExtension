import { TIMING } from '../lib/const.js';

/**
 * `allow-same-origin` without `allow-scripts` is deliberate: the DOM stays
 * readable while no script in the fetched HTML can ever run.
 */
const SANDBOX_ATTR = 'allow-same-origin';

/** Fixed width so any computed value that leaks through is not near-zero. */
const WIDTH_PX = 1000;

const LOAD_TIMEOUT_MS = TIMING.SANDBOX_LOAD_TIMEOUT_MS;

/** @returns {HTMLIFrameElement} */
export function createSandbox() {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', SANDBOX_ATTR);
    iframe.style.cssText = `position:absolute; width:${WIDTH_PX}px; height:0; border:0; visibility:hidden;`;
    return iframe;
}

/**
 * Load HTML into the iframe via `srcdoc` and wait for it to finish.
 * @param {HTMLIFrameElement} iframe
 * @param {string} html
 * @returns {Promise<void>}
 */
export function loadSrcdoc(iframe, html) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Sandboxed iframe did not finish loading within ${LOAD_TIMEOUT_MS}ms.`));
        }, LOAD_TIMEOUT_MS);

        function cleanup() {
            clearTimeout(timer);
            iframe.removeEventListener('load', onLoad);
            iframe.removeEventListener('error', onError);
        }
        function onLoad() { cleanup(); resolve(); }
        function onError() { cleanup(); reject(new Error('Sandboxed iframe failed to load.')); }

        iframe.addEventListener('load', onLoad);
        iframe.addEventListener('error', onError);
        iframe.srcdoc = html;
    });
}
