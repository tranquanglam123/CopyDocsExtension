/**
 * UrlTransformer — Utility class for Google Docs/Sheets/Slides URL manipulation.
 */
export class UrlTransformer {

  /** Regex patterns for Google Workspace document URLs */
  static PATTERNS = {
    docs:   /^https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/,
    sheets: /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    slides: /^https:\/\/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/,
  };

  /**
   * Check whether a URL points to a Google Doc, Sheet, or Slide.
   * @param {string} url
   * @returns {{ isValid: boolean, type: string|null }}
   */
  static identify(url) {
    if (!url) return { isValid: false, type: null };

    for (const [type, pattern] of Object.entries(UrlTransformer.PATTERNS)) {
      if (pattern.test(url)) {
        return { isValid: true, type };
      }
    }
    return { isValid: false, type: null };
  }

  /**
   * Convenience boolean check.
   * @param {string} url
   * @returns {boolean}
   */
  static isGoogleDoc(url) {
    return UrlTransformer.identify(url).isValid;
  }

  /**
   * Extract the document ID from a Google Workspace URL.
   * @param {string} url
   * @returns {string|null}
   */
  static getDocId(url) {
    for (const pattern of Object.values(UrlTransformer.PATTERNS)) {
      const match = url?.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Convert a standard Google Workspace URL to the /mobilebasic variant.
   * Works for Docs (/document/d/ID/edit → /document/d/ID/mobilebasic).
   * For Sheets and Slides, converts to /export?format=txt or /export/txt.
   * @param {string} url
   * @returns {string|null}
   */
  static toMobileBasic(url) {
    const { isValid, type } = UrlTransformer.identify(url);
    if (!isValid) return null;

    const docId = UrlTransformer.getDocId(url);
    if (!docId) return null;

    switch (type) {
      case 'docs':
        return `https://docs.google.com/document/d/${docId}/mobilebasic`;
      case 'sheets':
        return `https://docs.google.com/spreadsheets/d/${docId}/mobilebasic`;
      case 'slides':
        return `https://docs.google.com/presentation/d/${docId}/mobilebasic`;
      default:
        return null;
    }
  }

  /**
   * Get a friendly type label.
   * @param {string} url
   * @returns {string}
   */
  static getTypeLabel(url) {
    const { type } = UrlTransformer.identify(url);
    const labels = { docs: 'Google Doc', sheets: 'Google Sheet', slides: 'Google Slides' };
    return labels[type] || 'Unknown';
  }
}
