"""Writes static/icons/icon-{16,32,48,128}.png from the eCash Cat logo, each at its real size."""
import pathlib
import sys
from PIL import Image

here = pathlib.Path(__file__).resolve().parent.parent
src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here.parent.parent.parent / 'ecash-cat-site' / 'assets' / 'logo.png'
logo = Image.open(src).convert('RGBA')
for size in (16, 32, 48, 128):
    out = here / 'static' / 'icons' / f'icon-{size}.png'
    logo.resize((size, size), Image.LANCZOS).save(out, optimize=True)
    print(f'{out.relative_to(here)} {Image.open(out).size}')
