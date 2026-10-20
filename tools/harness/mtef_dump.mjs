// Dumps every fixture equation's OMML, linear text and character list as JSON.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [REPO, DIR, OUT] = process.argv.slice(2);
const { readCfbStream } = await import(pathToFileURL(REPO + '/src/lib/cfb.js'));
const { parseEquationNative } = await import(pathToFileURL(REPO + '/src/lib/mtef.js'));
const { toOmml, toLinear } = await import(pathToFileURL(REPO + '/src/lib/math-render.js'));

const chars = (nodes, out = []) => {
    for (const n of nodes) {
        if (n.type === 'char') out.push(n.code);
        if (n.items) chars(n.items, out);
    }
    return out;
};

const numbers = readdirSync(DIR)
    .map((name) => Number(name.match(/^oleObject(\d+)\.bin$/)?.[1]))
    .filter(Boolean)
    .sort((a, b) => a - b);

const rows = [];
for (const i of numbers) {
    const row = { i };
    try {
        const eq = parseEquationNative(readCfbStream(new Uint8Array(readFileSync(`${DIR}/oleObject${i}.bin`)), 'Equation Native'));
        row.chars = String.fromCodePoint(...chars(eq.items).filter((c) => c && !(c >= 0xE000 && c <= 0xF8FF)));
        row.omml = toOmml(eq);
        row.linear = toLinear(eq);
    } catch (err) {
        row.error = err.message;
    }
    rows.push(row);
}
writeFileSync(OUT, JSON.stringify(rows));
console.log('dumped', rows.length, 'errors', rows.filter((r) => r.error).length);
