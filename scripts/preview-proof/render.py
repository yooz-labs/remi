#!/usr/bin/env python3
"""Local feasibility only: system Pillow/Poppler are not a contained helper."""
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path
from PIL import Image, ImageOps

root = Path(sys.argv[1]).resolve()
corpus = root / 'corpus'
out = root / 'render-attempts'
out.mkdir(mode=0o700)
manifest = json.loads((corpus / 'manifest.json').read_text())
steps = [2048, 1536, 1024, 768]
qualities = [85, 75, 65]
rows = []
def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda: f.read(32768), b''): h.update(b)
    return h.hexdigest()

def inspect(path, kind, source, target, quality, status, stderr='', elapsed=0):
    row = {'kind':kind, 'source':source, 'target':target, 'quality':quality, 'status':status,
           'elapsed_s':round(elapsed,3), 'path':str(path), 'stderr':stderr[:1024]}
    if path.exists():
        row['bytes']=path.stat().st_size
        row['sha256']=digest(path)
        try:
            with Image.open(path) as im:
                im.verify()
            with Image.open(path) as im:
                row.update({'dimensions':list(im.size), 'mode':im.mode, 'format':im.format})
            row['size_ok'] = 1 <= row['bytes'] <= 499999
        except Exception as e: row['decode_error']=type(e).__name__+': '+str(e)
    rows.append(row)
    return row.get('size_ok', False) and status == 0 and 'decode_error' not in row

def render_image(name):
    path = corpus / name
    before = digest(path)
    with Image.open(path) as inp:
        original = ImageOps.exif_transpose(inp)
        alpha = original.mode in ('RGBA','LA') or 'transparency' in original.info
        original = original.convert('RGBA' if alpha else 'RGB')
        for target in steps:
            image = original.copy()
            image.thumbnail((target,target), Image.Resampling.LANCZOS)
            for quality in ([None] if alpha else qualities):
                dest = out / f'{name}-{target}-{quality or "alpha"}.{ "png" if alpha else "jpg"}'
                start=time.monotonic()
                with dest.open('xb') as f:
                    if alpha: image.save(f,format='PNG',optimize=True)
                    else: image.save(f,format='JPEG',quality=quality,optimize=True,progressive=True)
                if inspect(dest,'image',name,target,quality,0,elapsed=time.monotonic()-start):
                    assert digest(path)==before==manifest['files'][name]['sha256']
                    return
    assert digest(path)==before

def render_pdf(page):
    path=corpus/'text-multipage.pdf'; before=digest(path)
    for target in steps:
        for quality in qualities:
            dest=out/f'pdf-page{page}-{target}-{quality}.jpg'
            cmd=['pdftoppm','-f',str(page),'-l',str(page),'-singlefile','-scale-to',str(target),'-hide-annotations','-jpeg','-jpegopt',f'quality={quality},optimize=y,progressive=y','-']
            start=time.monotonic(); status=-1; stderr=''
            try:
                with path.open('rb') as inp, dest.open('xb') as output:
                    result=subprocess.run(cmd,stdin=inp,stdout=output,stderr=subprocess.PIPE,timeout=15,check=False)
                status=result.returncode; stderr=result.stderr.decode(errors='replace')
            except subprocess.TimeoutExpired:
                stderr='timeout after 15 seconds; subprocess killed and reaped'
            if inspect(dest,'pdf',path.name,target,quality,status,stderr,time.monotonic()-start):
                assert digest(path)==before==manifest['files'][path.name]['sha256']
                return
    assert digest(path)==before

for name in ['noise.jpg','noise.bmp','alpha.png']: render_image(name)
for page in (1,2): render_pdf(page)
report={'scope':'system Pillow/Poppler visual and size feasibility only; no sandbox, enforcement, production packaging, client transfer or held-No claim',
        'source_hashes_after':{n:digest(corpus/n) for n in manifest['files']}, 'attempts':rows}
(root/'render-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
