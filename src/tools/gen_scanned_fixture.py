# Generates sample/scanned.pdf: a synthetic stand-in for a real-world
# scanned document (a page-per-image scanner export). The real report
# file cannot be redistributed, so this fixture mirrors its structure
# exactly:
#   - 52 pages, MediaBox 595.2 x 841.92 (A4), PDF 1.4
#   - every page is ONE full-page image, 2480 x 3508 (A4 at 300 dpi),
#     drawn by the same content stream a scanner emits
#     ("0.24 0 0 0.24 0 0 cm" then "/ImN Do")
#   - pages 1 and 12 are DCTDecode (JPEG, 8 bpc, DeviceRGB); the other
#     50 are CCITTFaxDecode group 4 (K -1, 1 bpc, DeviceGray, DecodeParms
#     with Columns/Rows, no BlackIs1 or other quirks)
# Each page's image encodes the PAGE NUMBER machine-readably so the e2e
# probe can verify from canvas pixels that every page rendered its OWN
# content (not blank, not another page's): a solid anchor bar near the
# top plus six binary cells (cell i black iff bit i of the page number
# is set). Probe coordinates, as fractions of the image box:
#   anchor center (0.5, 0.10); cell i center ((248 + 372*i) / 2480, 0.25);
#   always-white control point (0.5, 0.60).
# The generator self-verifies every stream before writing the PDF: the
# G4 payloads round-trip bit-exactly through Pillow's decoder, and the
# JPEG payloads decode to the expected pattern at the probe points.
# Requires Pillow (pip install pillow). Usage:
#   python src/tools/gen_scanned_fixture.py [--force]

import io
import pathlib
import sys

from PIL import Image, ImageDraw, TiffImagePlugin

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "sample" / "scanned.pdf"

PAGES = 52
JPEG_PAGES = {1, 12}  # 1-based, mirroring the report file
W, H = 2480, 3508  # A4 at 300 dpi
BOX_W, BOX_H = "595.20000", "841.92000"

# Pattern geometry (image pixels, origin top-left). Kept in sync with
# the probe in src/test/scannedBlank.ts via the fractions documented
# above.
ANCHOR = (124, 175, 2356, 526)
CELL_Y = (702, 1052)
CELL_X0, CELL_STEP, CELL_W = 124, 372, 248
BITS = 6


def pattern(page_number: int) -> Image.Image:
    """1-bit page image: white background, black anchor + binary cells."""
    img = Image.new("1", (W, H), 1)  # 1 = white
    d = ImageDraw.Draw(img)
    d.rectangle(ANCHOR, fill=0)
    for i in range(BITS):
        if (page_number >> i) & 1:
            x0 = CELL_X0 + i * CELL_STEP
            d.rectangle((x0, CELL_Y[0], x0 + CELL_W, CELL_Y[1]), fill=0)
    return img


def g4_stream(img: Image.Image) -> bytes:
    """Raw single-block CCITT G4 payload for a 1-bit image, verified.

    Pillow has no bare-G4 encoder, so encode via a TIFF container forced
    to a single strip (a G4 coder restarts per strip, so only a single
    strip is a valid PDF CCITTFaxDecode payload) and extract the strip.
    """
    TiffImagePlugin.STRIP_SIZE = 1 << 30  # force one strip
    buf = io.BytesIO()
    img.save(buf, format="TIFF", compression="group4")
    buf.seek(0)
    tif = Image.open(buf)
    offsets = tif.tag_v2[273]  # StripOffsets
    counts = tif.tag_v2[279]  # StripByteCounts
    if len(offsets) != 1:
        raise SystemExit(f"expected a single G4 strip, got {len(offsets)}")
    if tif.tag_v2[262] != 0:  # PhotometricInterpretation: MinIsWhite
        raise SystemExit("G4 TIFF is not MinIsWhite; PDF default mapping breaks")
    # Bit-exact round trip through Pillow's G4 decoder.
    if tif.convert("1").tobytes() != img.tobytes():
        raise SystemExit("G4 round-trip mismatch")
    data = buf.getvalue()
    return data[offsets[0]:offsets[0] + counts[0]]


def jpeg_stream(img: Image.Image) -> bytes:
    """Baseline RGB JPEG payload for DCTDecode, verified at probe points."""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=85)
    buf.seek(0)
    back = Image.open(buf).convert("L")
    probes = [((124 + 2356) // 2, (175 + 526) // 2, 0)]
    probes += [(CELL_X0 + i * CELL_STEP + CELL_W // 2,
                (CELL_Y[0] + CELL_Y[1]) // 2,
                0 if img.getpixel((CELL_X0 + i * CELL_STEP + CELL_W // 2,
                                   (CELL_Y[0] + CELL_Y[1]) // 2)) == 0 else 255)
               for i in range(BITS)]
    probes.append((W // 2, int(H * 0.6), 255))
    for x, y, want in probes:
        got = back.getpixel((x, y))
        if abs(got - want) > 60:
            raise SystemExit(f"JPEG probe mismatch at ({x},{y}): {got} vs {want}")
    return buf.getvalue()


def build_pdf() -> bytes:
    objects: list[bytes] = []  # 1-based object bodies, in order

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    page_refs: list[int] = []
    kids_placeholder = add(b"")  # obj 1: Pages tree, filled in below
    catalog = add(b"<< /Type /Catalog /Pages 1 0 R >>")
    assert catalog == 2

    for n in range(1, PAGES + 1):
        img = pattern(n)
        if n in JPEG_PAGES:
            data = jpeg_stream(img)
            image_dict = (
                b"<< /Type /XObject /Subtype /Image"
                b" /Width 2480 /Height 3508 /BitsPerComponent 8"
                b" /ColorSpace /DeviceRGB /Filter /DCTDecode"
                b" /Length " + str(len(data)).encode() + b" >>"
            )
        else:
            data = g4_stream(img)
            image_dict = (
                b"<< /Type /XObject /Subtype /Image"
                b" /Width 2480 /Height 3508 /BitsPerComponent 1"
                b" /ColorSpace /DeviceGray /Filter /CCITTFaxDecode"
                b" /DecodeParms << /Columns 2480 /Rows 3508 /K -1 >>"
                b" /Length " + str(len(data)).encode() + b" >>"
            )
        img_ref = add(image_dict + b"\nstream\n" + data + b"\nendstream")
        content = (
            b"0.24000 0 0 0.24000 0 0 cm\n"
            b"q 2480 0 0 3508 0 0 cm /Im" + str(n).encode() + b" Do Q"
        )
        content_ref = add(
            b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n"
            + content + b"\nendstream"
        )
        page_refs.append(add(
            b"<< /Type /Page /Parent 1 0 R"
            b" /MediaBox [0 0 " + BOX_W.encode() + b" " + BOX_H.encode() + b"]"
            b" /Resources << /XObject << /Im" + str(n).encode() + b" "
            + str(img_ref).encode() + b" 0 R >> >>"
            b" /Contents " + str(content_ref).encode() + b" 0 R >>"
        ))

    kids = b" ".join(b"%d 0 R" % r for r in page_refs)
    objects[kids_placeholder - 1] = (
        b"<< /Type /Pages /Kids [" + kids + b"] /Count "
        + str(PAGES).encode() + b" >>"
    )

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]  # object 0 is the free head
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += b"%010d 00000 n \n" % off
    out += (
        b"trailer\n<< /Size " + str(len(objects) + 1).encode()
        + b" /Root 2 0 R >>\nstartxref\n" + str(xref_at).encode()
        + b"\n%%EOF\n"
    )
    return bytes(out)


def main() -> None:
    if OUT.exists() and "--force" not in sys.argv:
        print(f"fixture exists: {OUT}")
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    pdf = build_pdf()
    OUT.write_bytes(pdf)
    print(f"wrote {OUT} ({len(pdf) // 1024}KB, {PAGES} pages, "
          f"{PAGES - len(JPEG_PAGES)} G4 + {len(JPEG_PAGES)} JPEG)")


if __name__ == "__main__":
    main()
