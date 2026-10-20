"""Structural check of an exported .docx against the source it was read from."""
import collections
import hashlib
import re
import sys
import xml.dom.minidom
import zipfile

out_path, src_path = sys.argv[1], sys.argv[2]
out = zipfile.ZipFile(out_path)
src = zipfile.ZipFile(src_path)
names = set(out.namelist())
problems = []

# Every XML part parses.
for name in names:
    if name.endswith('.xml') or name.endswith('.rels'):
        try:
            xml.dom.minidom.parseString(out.read(name))
        except Exception as e:
            problems.append(f'{name}: not well-formed: {e}')

doc = out.read('word/document.xml').decode('utf-8')
rels = out.read('word/_rels/document.xml.rels').decode('utf-8')
ctypes = out.read('[Content_Types].xml').decode('utf-8')

# Every r:id in document.xml resolves, and every target exists.
rel_map = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
for rid in set(re.findall(r'r:id="([^"]+)"', doc)):
    if rid not in rel_map:
        problems.append(f'r:id {rid} has no relationship')
for rid, target in rel_map.items():
    if 'word/' + target not in names:
        problems.append(f'{rid} -> {target} missing from the package')
for leftover in ('__OLE_BIN_RID__', '__OLE_PREVIEW_RID__'):
    if leftover in doc:
        problems.append(f'placeholder {leftover} left in document.xml')

# Every binary extension has a content type.
for ext in {n.rsplit('.', 1)[-1] for n in names if '/media/' in n or '/embeddings/' in n}:
    if f'Extension="{ext}"' not in ctypes:
        problems.append(f'no content type for .{ext}')

# The shapetype is defined once, before any shape names it.
st = doc.find('<v:shapetype id="_x0000_t75"')
first_ref = doc.find('type="#_x0000_t75"')
if doc.count('<v:shapetype') != 1 or st < 0 or st > first_ref:
    problems.append(f'shapetype count {doc.count("<v:shapetype")}, defined at {st}, first used at {first_ref}')


def digests(z, prefix):
    return collections.Counter(hashlib.sha1(z.read(n)).hexdigest() for n in z.namelist() if n.startswith(prefix))


src_bins, out_bins = digests(src, 'word/embeddings/'), digests(out, 'word/embeddings/')
src_doc = src.read('word/document.xml').decode('utf-8')
src_wmf_ids = set(re.findall(r'<v:imagedata r:id="([^"]+)"', src_doc))
src_rels = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', src.read('word/_rels/document.xml.rels').decode('utf-8')))
src_previews = collections.Counter(hashlib.sha1(src.read('word/' + src_rels[r])).hexdigest() for r in src_wmf_ids if r in src_rels)
out_previews = digests(out, 'word/media/ole')

print('objects       src', src_doc.count('<w:object'), '/ out', doc.count('<w:object'))
print('ProgIDs       out', collections.Counter(re.findall(r'ProgID="([^"]+)"', doc)))
print('OLE .bin      identical to source:', src_bins == out_bins, f'({sum(out_bins.values())} parts)')
print('previews      identical to source:', src_previews == out_previews, f'({sum(out_previews.values())} parts)')
print('problems     ', problems or 'none')
