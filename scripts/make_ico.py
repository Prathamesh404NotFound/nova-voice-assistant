#!/usr/bin/env python3
"""Write a multi-layer Windows .ico with guaranteed 256x256 entry (raw ICO format)."""
import io
import struct

from PIL import Image


def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw = None  # placeholder
    from PIL import ImageDraw as _D
    d = _D.Draw(img)
    d.ellipse([1, 1, size - 2, size - 2], fill=(6, 8, 13, 255))
    r = int(size * 0.30)
    d.ellipse([size // 2 - r, size // 2 - r, size // 2 + r, size // 2 + r], fill=(70, 215, 255, 255))
    return img


def main():
    from PIL import Image, ImageDraw  # noqa: E402

    master = Image.open("/home/ubuntu/nova/assets/icon.png").convert("RGBA")

    sizes = [16, 32, 48, 64, 128, 256]
    layers = []
    for s in sizes:
        if s == 256:
            layers.append(master.resize((256, 256), Image.LANCZOS))
        else:
            layers.append(make_icon(s))

    # ICO dir + PNG-compressed entries (modern ICO allows PNG inside)
    entries = []
    data_blocks = []
    for s, layer in zip(sizes, layers):
        buf = io.BytesIO()
        layer.save(buf, format="PNG")
        png_bytes = buf.getvalue()
        entries.append((len(png_bytes), 0 if s == 256 else s))  # 0 => 256
        data_blocks.append(png_bytes)

    dir_size = 6 + 16 * len(entries)
    offset = dir_size
    out = io.BytesIO()
    out.write(struct.pack("<HHH", 0, 1, len(entries)))  # reserved, type=ICO, count
    for (data_len, dim), block in zip(entries, data_blocks):
        out.write(struct.pack("<BBBBHHII", dim, 0, 0, 0, 1, 32, data_len, offset))
        offset += data_len
    for block in data_blocks:
        out.write(block)

    with open("/home/ubuntu/nova/assets/icon.ico", "wb") as f:
        f.write(out.getvalue())

    # Verify
    import io as _io
    raw = out.getvalue()
    n = struct.unpack("<H", raw[4:6])[0]
    print(f"ico written: {n} entries")
    for i in range(n):
        b = 6 + i * 16
        w, h = struct.unpack("<BB", raw[b:b + 2])
        print(f"  entry {i}: {w if w else 256}x{h if h else 256}")


if __name__ == "__main__":
    main()
