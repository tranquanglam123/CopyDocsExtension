/** Google Docs/Sheets/Slides URL parsing, with every other http(s) page as `web`. */
export class UrlTransformer {

  /** Regex patterns for Google Workspace document URLs */
  static PATTERNS = {
    docs:   /^https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/,
    sheets: /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    slides: /^https:\/\/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/,
  };

  /** Learning material is mostly embedded in ordinary pages; those are `web`. */
  static WEB_PATTERN = /^https?:\/\/[^/]+/i;

  /**
   * Google Doc, Sheet or Slide first; any other http(s) page is `web`.
   * `/d/e/<id>` is a published copy, not a document id, so it is `web` too.
   * @param {string} url
   * @returns {{ isValid: boolean, type: string|null }}
   */
  static identify(url) {
    if (!url) return { isValid: false, type: null };

    if (!/^https:\/\/docs\.google\.com\/[a-z]+\/d\/e\//.test(url)) {
      for (const [type, pattern] of Object.entries(UrlTransformer.PATTERNS)) {
        if (pattern.test(url)) {
          return { isValid: true, type };
        }
      }
    }
    if (UrlTransformer.WEB_PATTERN.test(url)) return { isValid: true, type: 'web' };
    return { isValid: false, type: null };
  }

  /**
   * Convenience boolean check.
   * @param {string} url
   * @returns {boolean}
   */
  static isGoogleDoc(url) {
    const { type } = UrlTransformer.identify(url);
    return type !== null && type !== 'web';
  }

  /**
   * Extract the document ID from a Google Workspace URL.
   * @param {string} url
   * @returns {string|null}
   */
  static getDocId(url) {
    const { type } = UrlTransformer.identify(url);
    if (type === null) return null;
    // A page has no id; its address without the fragment is one.
    if (type === 'web') return url.split('#')[0];
    return url.match(UrlTransformer.PATTERNS[type])[1];
  }

  /**
   * Get a friendly type label.
   * @param {string} url
   * @returns {string}
   */
  static getTypeLabel(url) {
    const { type } = UrlTransformer.identify(url);
    const labels = { docs: 'Google Doc', sheets: 'Google Sheet', slides: 'Google Slides', web: 'Web page' };
    return labels[type] || 'Unknown';
  }
}
