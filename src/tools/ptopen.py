#!/usr/bin/env python3
"""Open a reading session (.ptl) and its PDF together in Paper Trail.

Usage: ptopen SESSION.ptl PAPER.pdf   (either order; one file alone works too)

Hands the files to the installed app through LaunchServices exactly as a
Finder open would: the session claims a fresh window, the PDF joins it,
and the pair appears on screen ready to read.
"""

import argparse
import pathlib
import shlex
import subprocess
import sys

APP = "Paper Trail"


def warn(msg: str) -> None:
    print(f"ptopen: {msg}", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog="Files may be given in either order.",
    )
    ap.add_argument("files", nargs="+", metavar="FILE", help=".ptl and/or .pdf")
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="print the open command instead of running it",
    )
    args = ap.parse_args()

    paths = [pathlib.Path(f).expanduser().resolve() for f in args.files]
    for p in paths:
        if not p.exists():
            sys.exit(f"ptopen: no such file: {p}")
        if p.suffix.lower() not in (".ptl", ".pdf"):
            sys.exit(f"ptopen: not a .ptl or .pdf: {p}")
    ptls = [p for p in paths if p.suffix.lower() == ".ptl"]
    pdfs = [p for p in paths if p.suffix.lower() == ".pdf"]
    if len(ptls) > 1 or len(pdfs) > 1:
        sys.exit("ptopen: give at most one .ptl and one .pdf")

    # The session records its PDF's name; a different one would raise the
    # app's mismatch banner. Warn early, still open — adopting the PDF
    # ("Use this PDF") is a valid path.
    if ptls and pdfs:
        try:
            for line in ptls[0].read_text().splitlines():
                if line.startswith("pdf.name "):
                    want = line[len("pdf.name "):].strip()
                    if want and want != pdfs[0].name:
                        warn(
                            f"session names '{want}' but got '{pdfs[0].name}'"
                            " — the app will show its mismatch banner"
                        )
                    break
        except OSError as e:
            warn(f"could not read {ptls[0]}: {e}")

    cmd = ["open", "-a", APP, *map(str, paths)]
    if args.dry_run:
        print(shlex.join(cmd))
        return
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
