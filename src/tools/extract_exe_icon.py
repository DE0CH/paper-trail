"""Extract the primary icon group from a Windows executable.

Writes the reassembled .ico plus PNG renders of its largest and 32px
images, so a workflow can prove visually which icon an exe carries.

Usage: python extract_exe_icon.py <exe> <outdir>
"""

import struct
import sys
from io import BytesIO
from pathlib import Path

import pefile
from PIL import Image

RT_ICON = pefile.RESOURCE_TYPE["RT_ICON"]
RT_GROUP_ICON = pefile.RESOURCE_TYPE["RT_GROUP_ICON"]


def resource_entries(pe: pefile.PE, rt: int):
    for top in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if top.id == rt:
            return top.directory.entries
    raise SystemExit(f"no resource type {rt} in {pe.path}")


def resource_bytes(pe: pefile.PE, entry) -> bytes:
    leaf = entry.directory.entries[0].data
    return pe.get_data(leaf.struct.OffsetToData, leaf.struct.Size)


def main() -> None:
    exe, outdir = sys.argv[1], Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    pe = pefile.PE(exe)
    pe.path = exe

    group = resource_bytes(pe, resource_entries(pe, RT_GROUP_ICON)[0])
    count = struct.unpack_from("<H", group, 4)[0]
    icons_by_id = {e.id: resource_bytes(pe, e) for e in resource_entries(pe, RT_ICON)}

    # Reassemble: GRPICONDIR (14-byte entries ending in an icon id) into a
    # plain ICONDIR (16-byte entries ending in a file offset).
    header = struct.pack("<HHH", 0, 1, count)
    entries, blobs = b"", b""
    offset = 6 + 16 * count
    for i in range(count):
        w, h, colors, res, planes, bpp, size, icon_id = struct.unpack_from(
            "<BBBBHHIH", group, 6 + 14 * i
        )
        data = icons_by_id[icon_id]
        entries += struct.pack("<BBBBHHII", w, h, colors, res, planes, bpp, len(data), offset)
        blobs += data
        offset += len(data)
    ico = header + entries + blobs

    ico_path = outdir / "uninstaller-embedded.ico"
    ico_path.write_bytes(ico)

    img = Image.open(BytesIO(ico))
    sizes = sorted(img.info.get("sizes", {img.size}))
    print("embedded icon sizes:", sizes)
    for label, size in (("largest", sizes[-1]), ("32px", (32, 32))):
        frame = Image.open(BytesIO(ico))
        if size in getattr(frame, "info", {}).get("sizes", set()):
            frame.size = size
        frame.load()
        frame.convert("RGBA").save(outdir / f"uninstaller-icon-{label}.png")


if __name__ == "__main__":
    main()
