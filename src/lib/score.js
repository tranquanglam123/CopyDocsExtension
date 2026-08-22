/**
 * Which element on the page is the document body, when the known selectors
 * miss. The parser walks the DOM and hands measurements in; the scoring
 * itself never sees a document.
 */
export class ContainerScore {

    /** Tags that are Google/site chrome, never eligible as the main container. */
    static EXCLUDED_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);

    /** Weight applied per paragraph-like descendant (p/li/tr/heading). */
    static PARAGRAPH_WEIGHT = 0.1;

    /**
     * `score = textLength * (1 - linkDensity) * (1 + 0.1 * paragraphCount)`,
     * with nav/header/footer/aside at `-Infinity` however much text they hold.
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
     * Extra fields on a candidate — a DOM reference, say — are ignored by the
     * scorer and returned untouched.
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
