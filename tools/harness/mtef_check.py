"""Checks the dumped equations: OMML well-formed, and their letters and digits
equal to what MathType drew into each object's WMF preview."""
import collections
import json
import re
import struct
import sys
import xml.dom.minidom

dump_path, word_dir = sys.argv[1], sys.argv[2]
rows = json.load(open(dump_path, encoding='utf-8'))

doc = open(word_dir + '/document.xml', encoding='utf-8').read()
rels = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', open(word_dir + '/_rels/document.xml.rels', encoding='utf-8').read()))
preview_of = {}
for obj in re.findall(r'<w:object\b.*?</w:object>', doc, re.S):
    img = re.search(r'<v:imagedata r:id="([^"]+)"', obj)
    ole = re.search(r'<o:OLEObject[^>]*r:id="([^"]+)"', obj)
    if img and ole:
        n = int(re.search(r'oleObject(\d+)\.bin', rels[ole.group(1)]).group(1))
        preview_of[n] = word_dir + '/' + rels[img.group(1)]


def wmf_text(path):
    """Text drawn in non-symbol fonts: (font face, string) per text record."""
    data = open(path, 'rb').read()
    pos = 22 if data[:4] == b'\xd7\xcd\xc6\x9a' else 0
    pos += struct.unpack_from('<H', data, pos + 2)[0] * 2
    objects, current, out = {}, None, []

    def alloc(obj):
        i = 0
        while i in objects:
            i += 1
        objects[i] = obj

    while pos + 6 <= len(data):
        size, func = struct.unpack_from('<IH', data, pos)
        if size < 3:
            break
        p = pos + 6
        if func == 0x02FB:  # CreateFontIndirect
            face = data[p + 18:p + 50].split(b'\0')[0].decode('latin-1')
            alloc(('font', face))
        elif func in (0x02FA, 0x02FC, 0x00F7, 0x01F9, 0x0142, 0x06FF):
            alloc(('other', None))
        elif func == 0x012D:  # SelectObject
            obj = objects.get(struct.unpack_from('<H', data, p)[0])
            if obj and obj[0] == 'font':
                current = obj[1]
        elif func == 0x01F0:  # DeleteObject
            objects.pop(struct.unpack_from('<H', data, p)[0], None)
        elif func == 0x0521:  # TextOut
            n = struct.unpack_from('<H', data, p)[0]
            out.append((current, data[p + 2:p + 2 + n].decode('latin-1')))
        elif func == 0x0A32:  # ExtTextOut
            n, opts = struct.unpack_from('<hH', data, p + 4)
            q = p + 8 + (8 if opts & 0x0006 else 0)
            out.append((current, data[q:q + n].decode('latin-1')))
        if func == 0:
            break
        pos += size * 2
    return out


def alnum(text):
    return collections.Counter(c for c in text if c.isascii() and c.isalnum())


bad_xml, mismatch, errors, ok = [], [], [], 0
for row in rows:
    if row.get('error'):
        errors.append((row['i'], row['error']))
        continue
    try:
        xml.dom.minidom.parseString(
            '<w xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' + row['omml'] + '</w>')
    except Exception as e:
        bad_xml.append((row['i'], str(e)))
        continue
    drawn = ''.join(s for face, s in wmf_text(preview_of[row['i']]) if face and not re.search(r'symbol|extra', face, re.I))
    if alnum(drawn) != alnum(row['chars']):
        mismatch.append((row['i'], row['linear'], drawn))
    else:
        ok += 1

print(f'equations {len(rows)}  match WMF {ok}  mismatch {len(mismatch)}  bad OMML {len(bad_xml)}  unsupported {len(errors)}')
for m in mismatch[:8]:
    print('  MISMATCH', m)
for e in (bad_xml + errors)[:8]:
    print('  ', e)
