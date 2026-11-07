#!/usr/bin/env python3
"""
Compiles the official lichess-org/chess-openings TSV files into a compact,
deterministic, gzipped tab-separated dataset: src/data/openings.tsv.gz.

Columns:
  eco   - Canonical ECO code (A00-E99)
  name  - Standardized English opening name
  pgn   - Canonical Standard Algebraic Notation move sequence
  uci   - Space-separated Universal Chess Interface move sequence
  epd   - Extended Position Description (FEN without clocks)
"""

from __future__ import annotations

import gzip
import io
import sys
from pathlib import Path

import chess
import chess.pgn


def compile_openings(source_dir: Path, output_file: Path) -> int:
    tsv_files = sorted(source_dir.glob("*.tsv"))
    if not tsv_files:
        raise FileNotFoundError(f"No TSV files found in {source_dir}")

    entries: list[tuple[str, str, str, str, str]] = []
    seen_epds: set[str] = set()

    for tsv_path in tsv_files:
        with open(tsv_path, encoding="utf-8") as f:
            header = next(f, None)
            if not header:
                continue
            for line_no, raw_line in enumerate(f, start=2):
                line = raw_line.strip()
                if not line:
                    continue
                parts = line.split("\t")
                if len(parts) < 3:
                    continue
                eco, name, pgn = parts[0].strip(), parts[1].strip(), parts[2].strip()

                try:
                    game = chess.pgn.read_game(io.StringIO(pgn))
                except Exception as err:
                    print(
                        f"Error parsing PGN {pgn!r} at {tsv_path}:{line_no}: {err}", file=sys.stderr
                    )
                    continue

                if not game:
                    continue

                board = game.board()
                uci_moves: list[str] = []
                for move in game.mainline_moves():
                    uci_moves.append(move.uci())
                    board.push(move)

                clean_pgn = chess.Board().variation_san(game.mainline_moves())
                epd = board.epd()

                if epd in seen_epds:
                    # In rare cases where two opening aliases produce identical positions,
                    # keep the first canonical entry
                    continue

                seen_epds.add(epd)
                entries.append((eco, name, clean_pgn, " ".join(uci_moves), epd))

    # Sort deterministically by (ECO, name)
    entries.sort(key=lambda item: (item[0], item[1]))

    output_file.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output_file, "wt", encoding="utf-8") as out:
        out.write("eco\tname\tpgn\tuci\tepd\n")
        for eco, name, pgn, uci, epd in entries:
            out.write(f"{eco}\t{name}\t{pgn}\t{uci}\t{epd}\n")

    return len(entries)


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    source_dir = Path("/tmp/lichess_openings")
    output_file = repo_root / "src" / "data" / "openings.tsv.gz"

    if not source_dir.exists():
        print(f"Source directory {source_dir} does not exist.", file=sys.stderr)
        sys.exit(1)

    count = compile_openings(source_dir, output_file)
    size_kb = output_file.stat().st_size / 1024
    print(f"Successfully compiled {count} openings into {output_file} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
