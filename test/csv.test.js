/**
 * Unit tests for lib/csv.js — RFC-4180 CSV parsing and HTML
 * rendering. Zero dependencies, run with:
 *
 *   node --test test/
 *
 * These must not require Chrome APIs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, csvToHtml } from '../src/lib/csv.js';

test('parseCsv: quoted field containing a comma', () => {
    const rows = parseCsv('a,"b,c",d\n');
    assert.deepEqual(rows, [['a', 'b,c', 'd']]);
});

test('parseCsv: quoted field containing an embedded newline', () => {
    const rows = parseCsv('a,"b\nc",d\n');
    assert.deepEqual(rows, [['a', 'b\nc', 'd']]);
});

test('parseCsv: escaped double-quote ("") inside a quoted field', () => {
    const rows = parseCsv('a,"say ""hi""",b\n');
    assert.deepEqual(rows, [['a', 'say "hi"', 'b']]);
});

test('parseCsv: ragged rows (differing column counts) are preserved as-is', () => {
    const rows = parseCsv('a,b,c\nd,e\nf,g,h,i\n');
    assert.deepEqual(rows, [
        ['a', 'b', 'c'],
        ['d', 'e'],
        ['f', 'g', 'h', 'i'],
    ]);
});

test('parseCsv: empty input returns no rows', () => {
    assert.deepEqual(parseCsv(''), []);
});

test('parseCsv: file without a trailing newline still captures the last row', () => {
    const rows = parseCsv('a,b\nc,d');
    assert.deepEqual(rows, [
        ['a', 'b'],
        ['c', 'd'],
    ]);
});

test('parseCsv: CRLF line endings', () => {
    const rows = parseCsv('a,b\r\nc,d\r\n');
    assert.deepEqual(rows, [
        ['a', 'b'],
        ['c', 'd'],
    ]);
});

test('csvToHtml: non-numeric first row becomes a <th> header', () => {
    const rows = [
        ['Name', 'Score'],
        ['Alice', '10'],
    ];
    const { bodyHtml } = csvToHtml(rows);
    assert.match(bodyHtml, /<thead>/);
    assert.match(bodyHtml, /<th>Name<\/th>/);
    assert.match(bodyHtml, /<th>Score<\/th>/);
    assert.match(bodyHtml, /<td>Alice<\/td>/);
});

test('csvToHtml: numeric first row must NOT become a <th> header', () => {
    const rows = [
        ['1', '2', '3'],
        ['4', '5', '6'],
    ];
    const { bodyHtml } = csvToHtml(rows);
    assert.doesNotMatch(bodyHtml, /<thead>/);
    assert.doesNotMatch(bodyHtml, /<th>/);
    assert.match(bodyHtml, /<td>1<\/td>/);
});

test('csvToHtml: ragged row renders whatever cell count it has, no crash', () => {
    const rows = [
        ['Name', 'Score', 'Notes'],
        ['Alice', '10'],
    ];
    const { bodyHtml } = csvToHtml(rows);
    assert.match(bodyHtml, /<td>Alice<\/td><td>10<\/td><\/tr>/);
});

test('csvToHtml: empty input produces an empty table, no throw', () => {
    const { bodyHtml, text, charCount } = csvToHtml([]);
    assert.equal(bodyHtml, '<table></table>');
    assert.equal(text, '');
    assert.equal(charCount, 0);
});

test('csvToHtml: HTML-special characters are escaped', () => {
    const rows = [
        ['Tag', 'Value'],
        ['<b>bold</b>', 'a & b'],
    ];
    const { bodyHtml } = csvToHtml(rows);
    assert.match(bodyHtml, /&lt;b&gt;bold&lt;\/b&gt;/);
    assert.match(bodyHtml, /a &amp; b/);
    assert.doesNotMatch(bodyHtml, /<b>bold<\/b>/);
});

test('csvToHtml: text output flattens rows with tabs and newlines', () => {
    const rows = [
        ['a', 'b'],
        ['c', 'd'],
    ];
    const { text, charCount } = csvToHtml(rows);
    assert.equal(text, 'a\tb\nc\td');
    assert.equal(charCount, text.length);
});
