#!/usr/bin/env python3
"""Subset the notice-bubble display fonts into src/fonts/*.woff2.

The source TTFs are not committed (the CJK ones are 1.5 MB and 8.3 MB). Fetch
them from https://github.com/google/fonts (ofl/zcoolkuaile, ofl/zcoolqingkehuangyou,
ofl/silkscreen) and pass their directory:

    python scripts/build-notice-fonts.py <dir-with-ttfs>

Needs fonttools and brotli (woff2). All three fonts are SIL OFL 1.1 with no
Reserved Font Name, so the subsets keep their names; see NOTICE.md.

The CJK subset is GB2312 level 1 (3755 hanzi, derived from the codec rather than
a word list) plus ASCII and common CJK punctuation. Anything outside it falls
back to the system CJK face listed after the display face in the CSS stack.
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "fonts"
TOTAL_CAP_BYTES = int(1.5 * 1024 * 1024)

PUNCT = "，。！？、；：“”‘’（）《》【】…—·～「」"
ASCII = "".join(chr(c) for c in range(0x20, 0x7F))


def gb2312_level1():
    chars = []
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            if hi == 0xD7 and lo > 0xF9:
                break
            try:
                chars.append(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return "".join(chars)


FONTS = [
    # (source ttf, output woff2, text to keep)
    ("ZCOOLKuaiLe-Regular.ttf", "zcool-kuaile.woff2", ASCII + PUNCT + gb2312_level1()),
    ("ZCOOLQingKeHuangYou-Regular.ttf", "zcool-qingke-huangyou.woff2", ASCII + PUNCT + gb2312_level1()),
    ("Silkscreen-Regular.ttf", "silkscreen.woff2", ASCII),
]


def main(src_dir):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    for src, out, text in FONTS:
        font = TTFont(Path(src_dir) / src)
        opts = subset.Options()
        opts.flavor = "woff2"
        opts.layout_features = ["*"]
        opts.name_IDs = ["*"]
        sub = subset.Subsetter(opts)
        sub.populate(text=text)
        sub.subset(font)
        font.flavor = "woff2"
        dest = OUT_DIR / out
        font.save(dest)
        size = dest.stat().st_size
        total += size
        print(f"{out:32} {size / 1024:7.0f} KiB")
    print(f"{'total':32} {total / 1024:7.0f} KiB  (cap {TOTAL_CAP_BYTES / 1024:.0f} KiB)")
    if total > TOTAL_CAP_BYTES:
        sys.exit("over the size cap: shrink the CJK subset before committing")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
