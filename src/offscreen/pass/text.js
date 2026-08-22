const BLOCK_TAGS = ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'BR'];

/**
 * Read-only walk. Runs before the mutating passes so it has no ordering
 * dependency on them.
 * @param {Document} idoc
 * @param {Element} container
 * @returns {string}
 */
export function extractPlainText(idoc, container) {
    const textParts = [];
    const walker = idoc.createTreeWalker(
        container,
        NodeFilter.SHOW_ELEMENT,
        {
            acceptNode(node) {
                return BLOCK_TAGS.includes(node.tagName)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_SKIP;
            },
        }
    );

    let node;
    while ((node = walker.nextNode())) {
        const txt = node.textContent?.trim();
        if (txt) textParts.push(txt);
    }

    let text = textParts.join('\n\n');
    if (!text.trim()) {
        text = container.textContent || '';
    }
    return text.trim();
}
