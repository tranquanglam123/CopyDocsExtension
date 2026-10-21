import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { MiniUnzip } from '../src/lib/unzip.js';
import { MiniZip } from '../src/lib/zip.js';

/** A one-entry DEFLATE archive, built by hand: MiniZip only writes STORE. */
function deflatedZip(name, text) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 42);
    const cdOffset = local.length + nameBytes.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + nameBytes.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    return new Uint8Array(Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]));
}

describe('MiniUnzip', () => {

    test('reads a DEFLATE entry', async () => {
        const zip = new MiniUnzip(deflatedZip('word/document.xml', '<w:document>Xin chào</w:document>'));
        assert.deepEqual(zip.names(), ['word/document.xml']);
        assert.equal(await zip.readText('word/document.xml'), '<w:document>Xin chào</w:document>');
    });

    test('reads what MiniZip writes (STORE), and returns null for a missing entry', async () => {
        const writer = new MiniZip();
        writer.addFile('a.txt', 'một');
        writer.addFile('b/c.xml', '<c/>');
        const bytes = new Uint8Array(await writer.toBlob().arrayBuffer());
        const zip = new MiniUnzip(bytes);
        assert.equal(await zip.readText('a.txt'), 'một');
        assert.equal(await zip.readText('b/c.xml'), '<c/>');
        assert.equal(zip.has('nope'), false);
        assert.equal(await zip.read('nope'), null);
    });

    test('refuses something that is not a ZIP', () => {
        assert.throws(() => new MiniUnzip(new TextEncoder().encode('%PDF-1.6 not a zip at all, long enough')), /Not a ZIP/);
    });
});
