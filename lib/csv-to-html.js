/**
 * csv-to-html — Pure, dependency-free RFC-4180 CSV parser and HTML table
 * renderer.
 *
 * Used by the service worker (Sheets `swFetch` pipeline, see
 * background/service-worker.js) to turn a `gviz/tq?tqx=out:csv` response
 * into the same `{ title, text, html, bodyHtml, charCount }` shape the
 * rest of the extension already expects from the Docs extraction path.
 *
 * Zero DOM dependency — this file must run unmodified under both the
 * Chrome service worker (no DOM) and `node --test` (no Chrome APIs).
 */

// ─── CSV parsing (RFC 4180) ─────────────────────────────────────────────────

/**
 * Parse RFC-4180 CSV text into a 2-D array of strings.
 *
 * Handles:
 *  - quoted fields, including fields containing commas and newlines
 *  - `""` as an escaped literal quote inside a quoted field
 *  - `\r\n`, `\n`, and lone `\r` line endings
 *  - a missing trailing newline (last row is still captured)
 *  - ragged rows (rows are returned with whatever column count they had —
 *    no padding is applied)
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
                    // Escaped quote ("") inside a quoted field → literal "
                    field += '"';
                    i += 2;
                    continue;
                }
                // Closing quote
                inQuotes = false;
                i += 1;
                continue;
            }
            // Any other character (including raw newlines) is literal
            // while inside a quoted field.
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

    // Flush a trailing field/row that wasn't terminated by a line break
    // (i.e. the file doesn't end in a newline). If the file ended exactly
    // on a line break, field==='' and row is empty here, so nothing extra
    // is emitted.
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
 * A cell counts as "numeric" if, once trimmed, it parses as a finite number.
 * Empty cells are NOT numeric (an empty header cell shouldn't disqualify a
 * header row).
 * @param {string} cell
 * @returns {boolean}
 */
function isNumericCell(cell) {
    const trimmed = String(cell).trim();
    if (trimmed === '') return false;
    return Number.isFinite(Number(trimmed));
}

/**
 * Render parsed CSV rows to an HTML `<table>` plus flattened plain text.
 *
 * The first row becomes a `<thead>`/`<th>` row only if every one of its
 * cells is non-numeric (spec §4.5) — this keeps a numeric data row from
 * being mistaken for a header.
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
