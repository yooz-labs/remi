#!/usr/bin/env python3
"""Generate owned, deterministic fixtures; never read or overwrite owner files."""
import hashlib
import io
import json
import random
import sys
from pathlib import Path
from PIL import Image, __version__ as pillow_version

out = Path(sys.argv[1]).resolve()
out.mkdir(mode=0o700, parents=True, exist_ok=True)
if any(out.iterdir()):
    raise SystemExit('refusing nonempty corpus directory')
records = {}
def save(name, data):
    path = out / name
    with path.open('xb') as f:
        f.write(data)
    records[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    return data

def encode(im, fmt, **kwargs):
    b = io.BytesIO()
    im.save(b, format=fmt, **kwargs)
    return b.getvalue()

# Reproducible synthetic noise, not a user image. 18 million RGB bytes.
rng = random.Random(1711)
im = Image.frombytes('RGB', (3000, 2000), rng.randbytes(3000 * 2000 * 3))
jpg = save('noise.jpg', encode(im, 'JPEG', quality=100, subsampling=0))
save('noise.bmp', encode(im, 'BMP'))
# Small fixtures include alpha for output policy evaluation.
alpha = Image.new('RGBA', (640, 480), (5, 80, 200, 100))
save('alpha.png', encode(alpha, 'PNG'))
save('truncated.jpg', jpg[:len(jpg)//2])
save('mismatched.png', jpg[:4096])
# Exact huge PNG header: decoder and admission must refuse, not allocate.
save('giant.png', b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR' + (0x7fffffff).to_bytes(4, 'big') * 2 + b'\x08\x02\x00\x00\x00' + b'\0\0\0\0')
# Hand-built PDF includes real selectable text on two pages and embeds the large
# owned JPEG; explicit xref offsets make this stable and independently inspectable.
def stream(attrs, data):
    return b'<< ' + attrs + b' /Length ' + str(len(data)).encode() + b' >>\nstream\n' + data + b'\nendstream'
def pdf_string(s):
    return s.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
lines = [(16, 'Synthetic PDF qualification - page 1'), (12, 'Twelve point: the quick brown fox 0123456789.'), (10, 'Ten point: source text must remain readable when previewed.'), (8, 'Eight point: accessibility zoom and fine details matter.')]
commands = ['BT /F1 16 Tf 50 750 Td']
for idx, (size, text) in enumerate(lines):
    if idx: commands.append('0 -30 Td')
    commands.append(f'/F1 {size} Tf ({pdf_string(text)}) Tj')
commands.extend(['ET', 'q 500 0 0 333 50 320 cm /Im1 Do Q'])
p1 = ('\n'.join(commands) + '\n').encode()
p2 = b'BT /F1 16 Tf 50 750 Td (Synthetic PDF qualification - page 2) Tj 0 -30 Td /F1 10 Tf (Page navigation must use the same captured source.) Tj ET\n'
objects = [
 b'<< /Type /Catalog /Pages 2 0 R >>',
 b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
 b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 7 0 R >>',
 b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 8 0 R >>',
 b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
 stream(b'/Type /XObject /Subtype /Image /Width 3000 /Height 2000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', jpg),
 stream(b'', p1), stream(b'', p2),
]
pdf = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
offsets = [0]
for n, obj in enumerate(objects, 1):
    offsets.append(len(pdf)); pdf.extend(f'{n} 0 obj\n'.encode() + obj + b'\nendobj\n')
xref = len(pdf); pdf.extend(f'xref\n0 {len(offsets)}\n'.encode()); pdf.extend(b'0000000000 65535 f \n')
for off in offsets[1:]: pdf.extend(f'{off:010} 00000 n \n'.encode())
pdf.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
save('text-multipage.pdf', bytes(pdf))
save('truncated.pdf', bytes(pdf[:len(pdf)//2]))
manifest = {'python': sys.version, 'pillow': pillow_version, 'seed': 1711,
            'source_bytes_eligible': 0 < len(pdf) <= 67108864 and len(pdf) > 10485760,
            'image_dimensions': [3000, 2000], 'pdf_pages': 2, 'pdf_text_points': [16,12,10,8],
            'files': records}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
