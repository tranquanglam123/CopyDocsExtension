"""Structural checks on a .docx DocxGenerator wrote: XML, relationships, schema order, table grids, sections."""
import collections
import re
import sys
import zipfile
from xml.dom import minidom

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
z = zipfile.ZipFile(sys.argv[1])
problems = []
for n in z.namelist():
    if n.endswith(('.xml', '.rels')):
        try:
            minidom.parseString(z.read(n))
        except Exception as e:
            problems.append(f'{n}: {e}')
doc_xml = z.read('word/document.xml').decode()
rels = z.read('word/_rels/document.xml.rels').decode()
ids = set(re.findall(r'Id="([^"]+)"', rels))
for rid in set(re.findall(r'r:(?:id|embed)="([^"]+)"', doc_xml)):
    if rid not in ids:
        problems.append(f'unresolved {rid}')

RPR = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'color', 'position', 'sz', 'szCs', 'highlight', 'u', 'shd', 'vertAlign']
PPR = ['pStyle', 'keepNext', 'numPr', 'pBdr', 'shd', 'tabs', 'spacing', 'ind', 'jc', 'rPr', 'sectPr']
TCPR = ['tcW', 'gridSpan', 'vMerge', 'tcBorders', 'shd', 'tcMar', 'vAlign']

doc = minidom.parseString(z.read('word/document.xml'))


def kids(el):
    return [c for c in el.childNodes if c.nodeType == 1]


def order(el, seq, label):
    names = [c.localName for c in kids(el)]
    idx = [seq.index(n) if n in seq else -1 for n in names]
    if -1 in idx or idx != sorted(idx):
        problems.append(f'{label} order {names}')


for tag, seq in (('rPr', RPR), ('pPr', PPR), ('tcPr', TCPR)):
    for el in doc.getElementsByTagNameNS(W, tag):
        if el.parentNode.localName in ('r', 'p', 'tc'):
            order(el, seq, tag)

stats = collections.Counter()
for tbl in doc.getElementsByTagNameNS(W, 'tbl'):
    stats['tables'] += 1
    grid = len([c for c in kids(kids(tbl)[1])])
    for tr in [c for c in kids(tbl) if c.localName == 'tr']:
        total = 0
        for tc in [c for c in kids(tr) if c.localName == 'tc']:
            span = tc.getElementsByTagNameNS(W, 'gridSpan')
            total += int(span[0].getAttributeNS(W, 'val')) if span else 1
            last = kids(tc)[-1]
            if last.localName != 'p':
                problems.append('cell not ending in p')
            if tc.getElementsByTagNameNS(W, 'vMerge'):
                stats['vMerge'] += 1
            if span:
                stats['gridSpan'] += 1
        if total != grid:
            problems.append(f'row spans {total} != grid {grid}')
for name in ('p', 'numPr', 'hyperlink', 'vertAlign', 'sz', 'color', 'rFonts', 'jc', 'drawing'):
    stats[name] = len(doc.getElementsByTagNameNS(W, name))
stats['oMath'] = doc_xml.count('<m:oMath>')
stats['sectPr'] = doc_xml.count('<w:sectPr>')
stats['anchor'] = doc_xml.count('<wp:anchor')
stats['tabs'] = doc_xml.count('<w:tabs>')
body = kids(doc.getElementsByTagNameNS(W, 'body')[0])
if body[-1].localName != 'sectPr':
    problems.append('body does not end in sectPr')
for sp in doc.getElementsByTagNameNS(W, 'sectPr'):
    if sp.parentNode.localName not in ('pPr', 'body'):
        problems.append('sectPr in ' + sp.parentNode.localName)
print('pages', collections.Counter(re.findall(r'<w:pgSz w:w="(\d+)" w:h="(\d+)"', doc_xml)))
print(dict(stats))
print('vertAlign vals', collections.Counter(re.findall(r'w:vertAlign w:val="(\w+)"', doc_xml)))
print('sizes', collections.Counter(re.findall(r'<w:sz w:val="(\d+)"', doc_xml)).most_common(6))
print('problems', problems[:15] or 'none', len(problems))
