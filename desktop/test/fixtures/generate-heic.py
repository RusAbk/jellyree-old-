"""Generate synthetic HEIC fixtures. Optional tools: Pillow and pillow-heif.

Generation tested with Pillow 13.0.0 and pillow-heif 1.8.1 (libheif 1.23.6).
These tools are not required by the application or its tests.
"""
from pathlib import Path
from PIL import Image, ImageDraw
import pillow_heif

output = Path(__file__).parent
image = Image.new("RGB", (960, 640), (35, 75, 215))
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 479, 319), fill=(230, 35, 35))
draw.rectangle((480, 0, 959, 319), fill=(35, 200, 65))
draw.rectangle((480, 320, 959, 639), fill=(235, 205, 30))
draw.rectangle((40, 40, 100, 100), fill="white")
pillow_heif.from_pillow(image).save(output / "preview.heic", quality=90)

rotated = pillow_heif.from_pillow(image)
exif = image.getexif()
exif[274] = 6
rotated.info["exif"] = exif.tobytes()
rotated.save(output / "rotated.heic", quality=90)

collection = pillow_heif.from_pillow(Image.new("RGB", (128, 96), (230, 30, 210)))
collection.add_from_pillow(image)
collection.save(output / "collection.heic", primary_index=1, quality=90, save_all=True)
