#!/usr/bin/env python3
"""Open a reading session (.ptl) and its PDF together in Paper Trail.

Usage: ptopen SESSION.ptl [PAPER.pdf]   (either order; a lone .pdf works too)

Hands the files to the installed app through LaunchServices exactly as a
Finder open would: the session claims a fresh window, the PDF joins it,
and the pair appears on screen ready to read.

Given only the session, the PDF comes along automatically: the .ptl
records its PDF's bare filename (the pdf.name line) and the two live
side by side by format contract, so ptopen passes both files to the app
explicitly. The app itself never guesses filesystem paths.
"""

from __future__ import annotations

import argparse
import pathlib
import shlex
import subprocess
import sys

APP = "Paper Trail"


def warn(msg: str) -> None:
    print(f"ptopen: {msg}", file=sys.stderr)


def session_pdf_name(ptl: pathlib.Path) -> str | None:
    """The bare filename recorded on the session's pdf.name line, if any."""
    try:
        for line in ptl.read_text().splitlines():
            if line.startswith("pdf.name "):
                return line[len("pdf.name "):].strip() or None
    except OSError as e:
        warn(f"could not read {ptl}: {e}")
    return None


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
        want = session_pdf_name(ptls[0])
        if want and want != pdfs[0].name:
            warn(
                f"session names '{want}' but got '{pdfs[0].name}'"
                " — the app will show its mismatch banner"
            )

    # A lone session: supply its recorded PDF from the same folder, so
    # the pair appears together (the app never guesses paths; the CLI
    # hands it both files explicitly). If the companion is not there,
    # still open — pairing a PDF in later via "Use this PDF" is a valid
    # path — but say why the window will come up without one.
    if ptls and not pdfs:
        want = session_pdf_name(ptls[0])
        companion = ptls[0].parent / want if want else None
        if companion is not None and companion.is_file():
            paths.append(companion)
            warn(f"pairing with {companion}")
        elif want:
            warn(
                f"session names '{want}' but no such file beside {ptls[0]}"
                " — opening the session alone; pass the PDF explicitly to pair"
            )
        else:
            warn(
                f"{ptls[0].name} has no pdf.name line"
                " — opening the session alone"
            )

    cmd = ["open", "-a", APP, *map(str, paths)]
    if args.dry_run:
        print(shlex.join(cmd))
        return
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
