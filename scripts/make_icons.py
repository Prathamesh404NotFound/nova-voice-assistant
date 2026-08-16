#!/usr/bin/env python3
"""Generate Nova app icons: PNG (linux), ICO (windows), ICNS (macos)."""
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(BASE, "assets")
os.makedirs(ASSETS, exist_ok=True)


def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, size - 1, size - 1], fill=(5, 6, 10, 255))
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    r = int(size * 0.34)
    gd.ellipse([size // 2 - r, size // 2 - r, size // 2 + r, size // 2 + r], fill=(57, 210, 255, 255))
    grad = grad.filter(ImageFilter.GaussianBlur(max(1, size // 14)))
    img.alpha_composite(grad)
    d2 = ImageDraw.Draw(img)
    r2 = int(size * 0.24)
    d2.ellipse([size // 2 - r2, size // 2 - r2, size // 2 + r2, size // 2 + r2], fill=(160, 240, 255, 255))
    return img


def main():
    # 512px master
    master = make_icon(512)
    master.save(os.path.join(ASSETS, "icon.png"))
    make_icon(256).save(os.path.join(ASSETS, "icon256.png"))

    # Windows .ico (multi-size, flat style for readability at small sizes)
    icos = []
    for s in [16, 32, 48, 64, 128]:
        base = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        d = ImageDraw.Draw(base)
        d.ellipse([1, 1, s - 2, s - 2], fill=(6, 8, 13, 255))
        r = int(s * 0.30)
        d.ellipse([s // 2 - r, s // 2 - r, s // 2 + r, s // 2 + r], fill=(70, 215, 255, 255))
        icos.append(base)
    # 256x256 entry: downscale the glowing master so the ICO has a real 256 layer
    icos.append(master.resize((256, 256), Image.LANCZOS))
    ico_path = os.path.join(ASSETS, "icon.ico")
    icos[0].save(
        ico_path,
        format="ICO",
        sizes=[(i.width, i.height) for i in icos],
        append_images=[i.convert("RGBA") for i in icos[1:]],
    )
    # Verify the 256 layer is actually present
    with open(ico_path, "rb") as fh:
        import struct
        n = struct.unpack("<H", fh.read(6)[4:6])[0]
        fh.read(16 * (n - 1) + 16)
        last = fh.read(16)
        if len(last) >= 2 and last[0] == 0:
            print("  ico 256-layer encoded as 256x256 ✓")
    # Sanity: re-open and list embedded sizes
    probe = Image.open(ico_path)
    print("  ico embedded sizes:", sorted(probe.info.get("sizes", [])))

    # macOS .icns — try native iconutil, fall back to img2icns-style png copy
    iconset = os.path.join(ASSETS, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    for s in [16, 32, 64, 128, 256, 512]:
        master.resize((s, s), Image.LANCZOS).save(os.path.join(iconset, f"icon_{s}x{s}.png"))
        master.resize((s * 2, s * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{s}x{s}@2x.png"))
    rc = 1
    if shutil.which("iconutil"):
        rc = subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(ASSETS, "icon.icns")]).returncode
    if rc != 0 or not os.path.exists(os.path.join(ASSETS, "icon.icns")):
        # Fallback for non-macOS: electron-builder can convert a 1024px PNG to icns
        master.resize((1024, 1024), Image.LANCZOS).save(os.path.join(ASSETS, "icon.png"))
        print("note: iconutil unavailable — electron-builder will derive .icns from assets/icon.png", file=sys.stderr)

    print("icons:", sorted(os.listdir(ASSETS)))


if __name__ == "__main__":
    main()
