/**
 * ContainerScore — Pure structural scoring for "which element on the page is
 * the actual document body" (spec §4.3).
 *
 * The fast path (known selectors like `div.doc-content`, `#contents`,
 * `[role="main"]`) lives in the offscreen parser, since it's a plain DOM
 * query with nothing to unit-test. This module holds the *fallback* scoring
 * function — used when the fast path is unavailable or yields a container
 * that looks wrong — kept dependency-free from the DOM so it can be tested
 * under plain `node --test` with hand-built measurement objects instead of
 * a real document. The parser is expected to walk the DOM, measure each
 * candidate block element (text length, link text length, paragraph count),
 * and hand the measurements to `scoreCandidate`/`pickBest` here.
 */
export class ContainerScore {

    /** Tags that are Google/site chrome, never eligible as the main container. */
    static EXCLUDED_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);

    /** Weight applied per paragraph-like descendant (p/li/tr/heading). */
    static PARAGRAPH_WEIGHT = 0.1;

    /**
     * Score one candidate element.
     *
     * `score = textLength * (1 - linkDensity) * (1 + 0.1 * paragraphCount)`
     *
     * Elements whose tag is nav/header/footer/aside are always excluded
     * (score `-Infinity`) regardless of their measured content, so they can
     * never win the fallback even if they happen to contain a lot of text.
     *
     * @param {{textLength?: number, linkTextLength?: number, paragraphCount?: number, tagName?: string}} candidate
     * @returns {number}
     */
    static scoreCandidate({ textLength = 0, linkTextLength = 0, paragraphCount = 0, tagName = '' } = {}) {
        if (ContainerScore.EXCLUDED_TAGS.has(String(tagName).toUpperCase())) {
            return -Infinity;
        }

        const safeTextLength = Math.max(0, textLength);
        const safeLinkLength = Math.max(0, Math.min(linkTextLength, safeTextLength));
        const linkDensity = safeTextLength > 0 ? safeLinkLength / safeTextLength : 0;
        const paragraphBonus = 1 + ContainerScore.PARAGRAPH_WEIGHT * Math.max(0, paragraphCount);

        return safeTextLength * (1 - linkDensity) * paragraphBonus;
    }

    /**
     * Pick the highest-scoring candidate from a list.
     * Each candidate may carry an arbitrary payload (e.g. a DOM element
     * reference) alongside the measurement fields `scoreCandidate` reads;
     * extra fields are ignored by the scorer and returned untouched.
     *
     * @template T
     * @param {Array<T & {textLength?: number, linkTextLength?: number, paragraphCount?: number, tagName?: string}>} candidates
     * @returns {{ candidate: T, score: number } | null}
     */
    static pickBest(candidates) {
        if (!Array.isArray(candidates) || candidates.length === 0) return null;

        let best = null;
        let bestScore = -Infinity;

        for (const candidate of candidates) {
            const score = ContainerScore.scoreCandidate(candidate);
            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        }

        if (best === null || bestScore === -Infinity) return null;
        return { candidate: best, score: bestScore };
    }
}
