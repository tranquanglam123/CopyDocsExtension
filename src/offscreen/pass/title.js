/**
 * @param {Document} idoc
 * @param {Element} container
 * @returns {string}
 */
export function extractTitle(idoc, container) {
    return (
        (idoc.title || '').replace(/ - Google (Docs|Sheets|Slides).*/, '').trim() ||
        container.querySelector('h1, h2, h3')?.textContent?.trim() ||
        'Untitled Document'
    );
}
