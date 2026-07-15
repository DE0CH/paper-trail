# Verifies the regenerated app-icon masters against their plate grids
# and produces the small-size review renders. Run by the icon
# regeneration workflow after `node build-node/tools/icons.js` has
# written the 1024px masters into a renders directory (PT_ICON_RENDERS).
#
# Checks (all measured on the alpha channel, so they hold regardless of
# the art inside the plate):
#   icon-mac-1024.png  - the macOS HIG grid: an 824x824 plate centered
#                        on the 1024 canvas, i.e. a 100px gutter on all
#                        four sides (+/- 2px for antialiasing).
#   icon-win-1024.png  - the Windows bleed: 896x896, 64px margins.
#   icon-ptl/pdf/installer-1024.png - render non-empty and canvas-sized
#                        (a broken art extraction would blank them).
#
# Also writes 128/64/32/16px downscales of both app-icon masters for
# human review, since geometry checks cannot judge how the icon reads
# at Dock/Explorer sizes.
#
# Usage: python check_icon_geometry.py <renders-dir>

import sys

from PIL import Image

TOLERANCE = 2
REVIEW_SIZES = [128, 64, 32, 16]

failures: list[str] = []


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    left, top, right, bottom = image.convert("RGBA").getchannel("A").getbbox()
    # PIL's right/bottom are exclusive; report inclusive margins below.
    return left, top, right, bottom


def check_plate(renders: str, name: str, margin: int, size: int) -> None:
    image = Image.open(f"{renders}/{name}")
    if image.size != (1024, 1024):
        failures.append(f"{name}: canvas is {image.size}, expected 1024x1024")
        return
    left, top, right, bottom = alpha_bbox(image)
    width, height = right - left, bottom - top
    margins = (left, top, 1024 - right, 1024 - bottom)
    print(f"{name}: opaque bbox {width}x{height}, margins (l,t,r,b) = {margins}")
    for label, value in [("width", width), ("height", height)]:
        if abs(value - size) > TOLERANCE:
            failures.append(f"{name}: {label} {value} is not {size} +/- {TOLERANCE}")
    for side, value in zip(("left", "top", "right", "bottom"), margins):
        if abs(value - margin) > TOLERANCE:
            failures.append(f"{name}: {side} margin {value} is not {margin} +/- {TOLERANCE}")


def check_nonempty(renders: str, name: str) -> None:
    image = Image.open(f"{renders}/{name}")
    left, top, right, bottom = alpha_bbox(image)
    width, height = right - left, bottom - top
    print(f"{name}: opaque bbox {width}x{height}")
    if width < 512 or height < 512:
        failures.append(f"{name}: opaque bbox {width}x{height} is implausibly small")


def write_reviews(renders: str, name: str, tag: str) -> None:
    image = Image.open(f"{renders}/{name}")
    for size in REVIEW_SIZES:
        image.resize((size, size), Image.LANCZOS).save(f"{renders}/icon-{tag}-{size}.png")


def main() -> None:
    renders = sys.argv[1]
    check_plate(renders, "icon-mac-1024.png", margin=100, size=824)
    check_plate(renders, "icon-win-1024.png", margin=64, size=896)
    for name in ["icon-ptl-1024.png", "icon-pdf-1024.png", "icon-installer-1024.png"]:
        check_nonempty(renders, name)
    write_reviews(renders, "icon-mac-1024.png", "mac")
    write_reviews(renders, "icon-win-1024.png", "win")
    if failures:
        print("\nGEOMETRY CHECK FAILED:")
        for failure in failures:
            print(f"  - {failure}")
        sys.exit(1)
    print("\nGeometry check passed.")


if __name__ == "__main__":
    main()
