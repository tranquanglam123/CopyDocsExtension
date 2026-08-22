/** The popup's only way to reach the service worker. */

import { MSG } from './contract.js';

const send = (message) => chrome.runtime.sendMessage(message);

/** @returns {Promise<{success:boolean, data?:object}>} */
export const checkTab = () => send({ action: MSG.CHECK_TAB });

/** @returns {Promise<{success:boolean, data?:object, error?:string, code?:string, params?:object}>} */
export const startExtraction = () => send({ action: MSG.START_EXTRACTION });

/** @returns {Promise<{success:boolean, data?:object, status?:string, error?:object}>} */
export const getExtractionStatus = () => send({ action: MSG.EXTRACTION_STATUS });

/** @returns {Promise<{success:boolean}>} */
export const openNewDoc = () => send({ action: MSG.OPEN_NEW_DOC });

/** Drop the finished result so the popup offers the current tab again. */
export const resetExtraction = () => send({ action: MSG.RESET });

/**
 * @param {string} text
 * @param {string} filename
 * @param {string} [mimeType]
 * @returns {Promise<{success:boolean, downloadId?:number, error?:string}>}
 */
export const downloadText = (text, filename, mimeType) =>
    send({ action: MSG.DOWNLOAD, text, filename, mimeType });
