#!/usr/bin/env python3
# Take a screenshot on DISPLAY using xwd (X11) and convert to PNG.
import subprocess, sys, os

out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/nova-shots/shoot.png"
os.makedirs(os.path.dirname(out) or "/tmp/nova-shots", exist_ok=True)
# NOTE: prefer `import -window root` (imagemagick); this script is a fallback.

proc = subprocess.run(["xwd", "-root", "-silent"], capture_output=True, env=os.environ)
if proc.returncode != 0:
    print("xwd failed", file=sys.stderr)
    sys.exit(1)

try:
    from PIL import Image
    # PIL cannot read XWD directly; use xwdtoppm
    ppm = subprocess.run(["xwdtoppm"], input=proc.stdout, capture_output=True)
    if ppm.returncode != 0:
        print("xwdtoppm failed", file=sys.stderr); sys.exit(1)
    img = Image.open(__import__("io").BytesIO(ppm.stdout)).convert("RGB")
    img.save(out)
    print("saved", out, img.size)
except Exception as e:
    print("convert failed:", e); sys.exit(1)
