"""Generate niCode app icons: white "Ni" (Poppins Bold) on black.
Usage (from app/): python scripts/make-icons.py . [preview.png]"""
import sys
from PIL import Image, ImageDraw, ImageFont
app = sys.argv[1]
FONT = f'{app}/node_modules/@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf'
IMG = f'{app}/assets/images'

def ni(size, text_frac, fg=(255, 255, 255, 255), bg=None):
    """'Ni' centered (by ink bounds) with its height = text_frac of the canvas."""
    im = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
    probe = ImageFont.truetype(FONT, 1000)
    l, t, r, b = probe.getbbox('Ni')
    scale = text_frac * size / (b - t)
    f = ImageFont.truetype(FONT, round(1000 * scale))
    l, t, r, b = f.getbbox('Ni')
    d = ImageDraw.Draw(im)
    d.text(((size - (r - l)) / 2 - l, (size - (b - t)) / 2 - t), 'Ni', font=f, fill=fg)
    return im

black = (0, 0, 0, 255)
ni(1024, 0.40, bg=black).save(f'{IMG}/icon.png')
# Adaptive icon: the launcher masks to the inner ~61%, so keep the letters well inside it.
ni(512, 0.30).save(f'{IMG}/android-icon-foreground.png')
Image.new('RGBA', (512, 512), black).save(f'{IMG}/android-icon-background.png')
ni(432, 0.30).save(f'{IMG}/android-icon-monochrome.png')
ni(512, 0.36).save(f'{IMG}/splash-icon.png')
ni(48, 0.5, bg=black).save(f'{IMG}/favicon.png')
if len(sys.argv) > 2:  # optional preview
    ni(512, 0.3, bg=black).save(sys.argv[2])
