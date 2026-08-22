/**
 * RFC-4180 CSV parser and HTML table renderer. Turns a `gviz` CSV response
 * into the same result shape the Docs path produces.
 */

// ─── CSV parsing (RFC 4180) ─────────────────────────────────────────────────

/**
 * Handles quoted fields with commas and newlines, `""` as an escaped quote,
 * all three line endings, a missing trailing newline, and ragged rows
 * (returned unpadded).
 *
 * @param {string} text  Raw CSV text.
 * @returns {string[][]} Array of rows, each an array of cell strings.
 */
export function parseCsv(text) {
    if (text === '' || text === null || text === undefined) return [];

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const len = text.length;

    while (i < len) {
        const char = text[i];

        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    // "" inside a quoted field is a literal "
                    field += '"';
                    i += 2;
                    continue;
                }
                // Closing quote
                inQuotes = false;
                i += 1;
                continue;
            }
            // Inside quotes, everything else is literal, newlines included.
            field += char;
            i += 1;
            continue;
        }

        if (char === '"') {
            inQuotes = true;
            i += 1;
            continue;
        }

        if (char === ',') {
            row.push(field);
            field = '';
            i += 1;
            continue;
        }

        if (char === '\r') {
            if (text[i + 1] === '\n') i += 1; // swallow the \n of \r\n
            row.push(field);
            rows.push(row);
            field = '';
            row = [];
            i += 1;
            continue;
        }

        if (char === '\n') {
            row.push(field);
            rows.push(row);
            field = '';
            row = [];
            i += 1;
            continue;
        }

        field += char;
        i += 1;
    }

    // Flush a row with no terminating line break. A file that ended on one
    // leaves field and row empty here, so nothing extra is emitted.
    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows;
}

// ─── HTML rendering ─────────────────────────────────────────────────────────

/**
 * Escape a string for safe insertion into HTML text content.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Empty cells are not numeric — an empty header cell must not disqualify a
 * header row.
 * @param {string} cell
 * @returns {boolean}
 */
function isNumericCell(cell) {
    const trimmed = String(cell).trim();
    if (trimmed === '') return false;
    return Number.isFinite(Number(trimmed));
}

/**
 * Rows to an HTML `<table>` plus flattened text. The first row is a header
 * only if every cell is non-numeric, so a numeric data row is not mistaken
 * for one.
 *
 * @param {string[][]} rows  Output of {@link parseCsv}.
 * @returns {{ bodyHtml: string, text: string, charCount: number }}
 */
export function csvToHtml(rows) {
    if (!rows || rows.length === 0) {
        return { bodyHtml: '<table></table>', text: '', charCount: 0 };
    }

    const firstRow = rows[0];
    const useHeader = firstRow.length > 0 && firstRow.every((cell) => !isNumericCell(cell));

    const headerRow = useHeader ? firstRow : null;
    const bodyRows = useHeader ? rows.slice(1) : rows;

    const rowToHtml = (cells, tag) =>
        `<tr>${cells.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join('')}</tr>`;

    let bodyHtml = '<table>\n';
    if (headerRow) {
        bodyHtml += `  <thead>\n    ${rowToHtml(headerRow, 'th')}\n  </thead>\n`;
    }
    bodyHtml += '  <tbody>\n';
    for (const row of bodyRows) {
        bodyHtml += `    ${rowToHtml(row, 'td')}\n`;
    }
    bodyHtml += '  </tbody>\n</table>';

    const text = rows.map((r) => r.join('\t')).join('\n');

    return { bodyHtml, text, charCount: text.length };
}
