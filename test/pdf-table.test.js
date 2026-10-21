import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rulesOf, findTables } from '../src/lib/pdf-table.js';

const rect = (x0, y0, x1, y1, fill = '#000000') => ({ x0, y0, x1, y1, fill, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true });
const line = (x0, y0, x1, y1, lineWidth = 0.5) => ({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), points: [[x0, y0], [x1, y1]], stroke: true, lineWidth });

/** The rules of a grid: horizontal lines at `ys` across, vertical at `xs` down. */
const grid = (xs, ys, t = 0.5) => [
    ...ys.map((y) => rect(xs[0], y, xs[xs.length - 1] + t, y + t)),
    ...xs.map((x) => rect(x, ys[0], x + t, ys[ys.length - 1] + t)),
];

describe('rulesOf', () => {

    test('thin filled rectangles and stroked straight segments are rules; shading and curves are not', () => {
        const rules = rulesOf([
            rect(0, 0, 100, 0.5), rect(0, 0, 0.5, 50),
            line(0, 60, 100, 60), line(10, 0, 10, 40, 1),
            rect(0, 0, 100, 50, '#d9d9d9'),
            { ...line(0, 0, 50, 50), curved: true },
        ]);
        assert.deepEqual(rules.map((r) => [r.dir, r.at, r.from, r.to]), [
            ['h', 0.25, 0, 100], ['v', 0.25, 0, 50], ['h', 60, 0, 100], ['v', 10, 0, 40],
        ]);
        assert.equal(rules[3].width, 1);
    });
});

describe('findTables', () => {

    test('crossing rules form a grid of cells, each with the sides drawn around it', () => {
        const { tables } = findTables(rulesOf(grid([0, 100, 200], [0, 20, 40])));
        assert.equal(tables.length, 1);
        const [t] = tables;
        assert.equal(t.cells.length, 4);
        assert.deepEqual(t.cells.map((c) => [c.row, c.col, c.rows, c.cols]), [[0, 0, 1, 1], [0, 1, 1, 1], [1, 0, 1, 1], [1, 1, 1, 1]]);
        assert.deepEqual(t.cells[0].borders, { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 });
    });

    test('a header row with no column rules is one cell across the columns', () => {
        const shapes = [
            rect(0, 0, 300, 0.5), rect(0, 20, 300, 20.5), rect(0, 40, 300, 40.5),
            rect(0, 0, 0.5, 40), rect(300, 0, 300.5, 40),
            rect(100, 20, 100.5, 40), rect(200, 20, 200.5, 40),
        ];
        const { tables } = findTables(rulesOf(shapes));
        assert.deepEqual(tables[0].cells.map((c) => [c.row, c.col, c.rows, c.cols]), [[0, 0, 1, 3], [1, 0, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1]]);
    });

    test('a rowspan where the rule between two rows is drawn only beside it', () => {
        const shapes = [
            rect(0, 0, 200, 0.5), rect(100, 20, 200, 20.5), rect(0, 40, 200, 40.5),
            rect(0, 0, 0.5, 40), rect(100, 0, 100.5, 40), rect(200, 0, 200.5, 40),
        ];
        const { tables } = findTables(rulesOf(shapes));
        assert.deepEqual(tables[0].cells.map((c) => [c.row, c.col, c.rows, c.cols]), [[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1]]);
    });

    test('a shaded cell carries its fill', () => {
        const { tables } = findTables(rulesOf(grid([0, 100, 200], [0, 20])), [rect(0, 0, 100, 20, '#d9d9d9')]);
        assert.equal(tables[0].cells[0].fill, '#d9d9d9');
        assert.equal(tables[0].cells[1].fill, null);
    });

    test('a frame around one box is no table, and rules that do not cross are none either', () => {
        assert.equal(findTables(rulesOf(grid([0, 200], [0, 40]))).tables.length, 0);
        assert.equal(findTables(rulesOf([rect(0, 0, 100, 0.5), rect(0, 50, 100, 50.5)])).tables.length, 0);
    });

    test('the rules a table drew are reported as used', () => {
        const rules = rulesOf([...grid([0, 100, 200], [0, 20, 40]), rect(0, 300, 50, 300.5)]);
        const { used } = findTables(rules);
        assert.equal(used.size, rules.length - 1);
    });
});
