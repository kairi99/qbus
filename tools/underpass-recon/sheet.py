"""Contact sheet of recon screenshots: python3 tools/underpass-recon/sheet.py out.png cols img1.png img2.png ...
Each tile is scaled to 320x180 and labeled with its file name."""
import sys
from PIL import Image, ImageDraw

out, cols, files = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
W, H = 320, 180
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * W, rows * (H + 14)), 'white')
d = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(f).convert('RGB').resize((W, H))
    x, y = (i % cols) * W, (i // cols) * (H + 14)
    sheet.paste(im, (x, y + 14))
    d.text((x + 2, y + 1), f.split('/')[-1][:52], fill='black')
sheet.save(out)
