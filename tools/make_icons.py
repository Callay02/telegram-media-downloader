#!/usr/bin/env python3
"""生成扩展图标（蓝色圆角方块 + 白色下载箭头 + 托盘）。

用法：python3 tools/make_icons.py
依赖：Pillow
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "icons"
S = 1024  # 超采样画布


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def build_master() -> Image.Image:
    top = (78, 164, 246)     # #4ea4f6
    bottom = (47, 122, 214)  # #2f7ad6

    # 垂直渐变
    grad = Image.new("RGB", (1, S))
    for y in range(S):
        grad.putpixel((0, y), lerp(top, bottom, y / (S - 1)))
    grad = grad.resize((S, S))

    # 圆角遮罩
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    w = int(S * 0.115)          # 箭头杆宽
    cx = S // 2
    head_y = int(S * 0.60)      # 箭头尖端
    stem_top = int(S * 0.20)
    head_w = int(S * 0.34)

    # 箭头杆
    d.rounded_rectangle(
        [cx - w // 2, stem_top, cx + w // 2, head_y - w // 2],
        radius=w // 2,
        fill=(255, 255, 255, 255),
    )
    # 箭头（三角）
    d.polygon(
        [(cx - head_w // 2, head_y - int(S * 0.16)), (cx + head_w // 2, head_y - int(S * 0.16)), (cx, head_y)],
        fill=(255, 255, 255, 255),
    )
    # 托盘
    tray_h = int(S * 0.085)
    tray_y = int(S * 0.745)
    d.rounded_rectangle(
        [int(S * 0.22), tray_y, int(S * 0.78), tray_y + tray_h],
        radius=tray_h // 2,
        fill=(255, 255, 255, 255),
    )
    return img


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = build_master()
    for size in (16, 32, 48, 128):
        master.resize((size, size), Image.LANCZOS).save(OUT_DIR / f"icon{size}.png")
        print("wrote", OUT_DIR / f"icon{size}.png")


if __name__ == "__main__":
    main()
