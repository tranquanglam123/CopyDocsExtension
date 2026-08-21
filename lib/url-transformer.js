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
   * Build the extraction target for a Google Workspace URL (fixes D1 —
   * `/mobilebasic` does not exist for Sheets or Slides, only for Docs).
   *
   * - docs   → `/document/d/{id}/mobilebasic`, parsed as HTML, fetched
   *            directly (`fetch` — T1 `swFetch` then T2 `csFetch`, spec
   *            §3.2, pulled forward from P3). No tab navigation, no DNR
   *            rule. `background/service-worker.js` falls back to the
   *            legacy `tabNav` pipeline only if every fetch tier fails.
   * - sheets → the `gviz` CSV export endpoint, parsed as CSV, fetched
   *            directly from the service worker (`swFetch` — no tab
   *            navigation, no DNR rule). P1 reads `gid=0` only; the
   *            caller must surface `warnings: ['single_sheet_only']`.
   * - slides → no working server-rendered path exists yet (see spec
   *            §3.3) — returns `null`, unsupported in P1.
   *
   * @param {string} url
   * @returns {{ url: string, parser: 'html'|'csv', mode: 'fetch'|'swFetch' } | null}
   */
  static toExtractionTarget(url) {
    const { isValid, type } = UrlTransformer.identify(url);
    if (!isValid) return null;

    const docId = UrlTransformer.getDocId(url);
    if (!docId) return null;

    switch (type) {
      case 'docs':
        return {
          url: `https://docs.google.com/document/d/${docId}/mobilebasic`,
          parser: 'html',
          mode: 'fetch',
        };
      case 'sheets':
        return {
          url: `https://docs.google.com/spreadsheets/d/${docId}/gviz/tq?tqx=out:csv&gid=0`,
          parser: 'csv',
          mode: 'swFetch',
        };
      case 'slides':
        // Unsupported in P1 — no reliable server-rendered path exists.
        return null;
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
