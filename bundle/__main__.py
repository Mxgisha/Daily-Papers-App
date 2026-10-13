"""CLI for building and verifying the static content bundle.

    python3 -m bundle build --out dist
    python3 -m bundle build --out dist --limit 500 --encoding int8
    python3 -m bundle inspect dist
    python3 -m bundle verify  dist          # checksums + round-trip a nearest-neighbour query
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

import numpy as np
import zstandard as zstd

from dailypapers.config import load_settings
from dailypapers.db import connect
from dailypapers.quantize import int8_scores, l2_normalize, top_k

from .builder import BundleConfig, _sha256, build, read_vectors


def _load_manifest(out: Path) -> dict:
    path = out / "manifest.json"
    if not path.exists():
        raise SystemExit(f"no manifest at {path}; run `python3 -m bundle build --out {out}` first")
    return json.loads(path.read_text())


def cmd_build(args) -> int:
    config = BundleConfig(
        out_dir=Path(args.out),
        window_days=args.window_days,
        encoding=args.encoding,
        compression_level=args.compression_level,
        with_fts=not args.no_fts,
        limit=args.limit,
        delta_since_days=args.delta_days,
    )
    with connect(load_settings().database_url) as conn:
        manifest = build(conn, config)

    total = manifest["total_bytes"]
    print("bundle built:")
    print(f"  papers            : {manifest['corpus']['papers']}")
    print(f"  with embeddings   : {manifest['corpus']['with_embeddings']}")
    print(f"  html coverage     : {100 * manifest['corpus']['html_coverage']:.1f}%")
    print(f"  encoding          : {manifest['encoding']['encoding']} "
          f"({manifest['encoding']['bytes_per_paper']} B/paper)")
    print(f"  date range        : {manifest['corpus']['date_min']} .. {manifest['corpus']['date_max']}")
    for f in manifest["files"]:
        print(f"    {f['name']:34s} {f['bytes'] / 1e6:8.2f} MB")
    print(f"  total             : {total / 1e6:.2f} MB")
    return 0


def cmd_inspect(args) -> int:
    out = Path(args.out)
    manifest = _load_manifest(out)
    print(json.dumps(manifest, indent=2))
    return 0


def cmd_verify(args) -> int:
    """Independent check: are the artifacts present, intact, and actually usable?

    Parses the vector file with the reference reader rather than the writer's in-memory
    state, then runs a real nearest-neighbour query and prints the titles it finds. If the
    format or the id mapping were wrong, this would show nonsense titles.
    """
    out = Path(args.out)
    manifest = _load_manifest(out)
    ok = True

    print("=== file integrity ===")
    for f in manifest["files"]:
        path = out / f["name"]
        if not path.exists():
            print(f"  MISSING  {f['name']}")
            ok = False
            continue
        size = path.stat().st_size
        digest = _sha256(path)
        size_ok = size == f["bytes"]
        hash_ok = digest == f["sha256"]
        ok &= size_ok and hash_ok
        print(
            f"  {'ok ' if size_ok and hash_ok else 'BAD'}  {f['name']:34s} "
            f"{size / 1e6:8.2f} MB  sha256={'match' if hash_ok else 'MISMATCH'}"
        )

    print("\n=== vector file ===")
    header, ids, scales, codes = read_vectors(out / "vectors.bin")
    print(f"  encoding={header['encoding']} count={header['count']} dim={header['dim']} "
          f"code_dtype={header['code_dtype']}")
    print(f"  ids unique : {len(set(ids.tolist())) == len(ids)}")
    print(f"  codes range: [{codes.min()}, {codes.max()}]")

    print("\n=== sqlite bundle ===")
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "bundle.db"
        dctx = zstd.ZstdDecompressor()
        with (out / "app_bundle.db.zst").open("rb") as fin, db.open("wb") as fout:
            dctx.copy_stream(fin, fout)

        con = sqlite3.connect(db)
        con.row_factory = sqlite3.Row
        n_papers = con.execute("SELECT count(*) FROM papers").fetchone()[0]
        n_topics = con.execute("SELECT count(*) FROM topics").fetchone()[0]
        n_vec = con.execute("SELECT count(*) FROM papers WHERE vec_index IS NOT NULL").fetchone()[0]
        print(f"  papers={n_papers} topics={n_topics} with_vec_index={n_vec}")
        print(f"  sqlite expands to {db.stat().st_size / 1e6:.2f} MB "
              f"({(out / 'app_bundle.db.zst').stat().st_size / db.stat().st_size:.2%} of raw)")

        # FTS sanity check.
        try:
            hits = con.execute(
                "SELECT count(*) FROM papers_fts WHERE papers_fts MATCH ?", ("learning",)
            ).fetchone()[0]
            print(f"  fts5 search 'learning' -> {hits} hits")
        except sqlite3.Error as exc:
            print(f"  fts5 unavailable: {exc}")

        # Real nearest-neighbour query against the shipped vectors.
        print("\n=== nearest-neighbour round trip ===")
        if n_vec == 0:
            print("  no vectors; skipping")
        else:
            rng = np.random.default_rng(0)
            qi = int(rng.integers(len(ids)))
            if header["encoding"] == "int8":
                scores = int8_scores(codes, scales, codes[qi].astype(np.float32) * scales[qi])
            else:
                scores = codes.astype(np.float32) @ codes[qi].astype(np.float32)
            idx, _ = top_k(scores, 5)
            print(f"  query vector row {qi} (paper id {ids[qi]})")
            for rank, i in enumerate(idx, 1):
                row = con.execute(
                    "SELECT title, primary_category FROM papers WHERE id = ?", (int(ids[i]),)
                ).fetchone()
                title = row["title"][:62] if row else "<id not found in sqlite>"
                print(f"    {rank}. [{row['primary_category'] if row else '?':8s}] {title}")
        con.close()

    print(f"\n{'PASS' if ok else 'FAIL'}: bundle verification")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="bundle", description="Build the static content bundle")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="build bundle artifacts from Postgres")
    b.add_argument("--out", default="dist")
    b.add_argument("--window-days", type=int, default=365)
    b.add_argument("--encoding", default="int8", choices=["int8", "binary"])
    b.add_argument("--compression-level", type=int, default=12)
    b.add_argument("--limit", type=int, default=None, help="cap papers (smoke runs)")
    b.add_argument("--delta-days", type=int, default=1)
    b.add_argument("--no-fts", action="store_true", help="omit the SQLite FTS5 search index")

    i = sub.add_parser("inspect", help="print the manifest")
    i.add_argument("out", nargs="?", default="dist")

    v = sub.add_parser("verify", help="verify checksums and round-trip a query")
    v.add_argument("out", nargs="?", default="dist")

    args = ap.parse_args(argv)
    if args.cmd == "build":
        return cmd_build(args)
    if args.cmd == "inspect":
        return cmd_inspect(args)
    if args.cmd == "verify":
        return cmd_verify(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
