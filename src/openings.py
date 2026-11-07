from __future__ import annotations

import functools
import gzip
import io
import re
from collections.abc import Sequence
from pathlib import Path

import chess
import chess.pgn
from pydantic import BaseModel, Field


class OpeningEntry(BaseModel):
    """Represents a canonical chess opening variation from the Lichess dataset."""

    eco: str
    name: str
    pgn: str
    uci: str
    epd: str

    @property
    def full_name(self) -> str:
        return f"{self.eco}: {self.name}"


class OpeningMatch(BaseModel):
    """Represents the deepest opening matched along a game's move sequence."""

    eco: str
    name: str
    ply: int
    uci: str
    pgn: str
    epd: str

    @property
    def full_name(self) -> str:
        return f"{self.eco}: {self.name}"


class OpeningContinuation(BaseModel):
    """Represents a candidate opening continuation branch from a board position."""

    uci: str
    san: str
    eco: str
    name: str

    @property
    def full_name(self) -> str:
        return f"{self.eco}: {self.name}"


class IdentifyOpeningRequest(BaseModel):
    """Request payload for identifying an opening from PGN text or move sequence."""

    pgn: str | None = None
    moves: list[str] = Field(default_factory=list)


class IdentifyOpeningResponse(BaseModel):
    """Response payload with identified opening and candidate continuations."""

    matched: bool
    eco: str | None = None
    name: str | None = None
    full_name: str | None = None
    ply: int | None = None
    pgn: str | None = None
    uci: str | None = None
    epd: str | None = None
    continuations: list[OpeningContinuation] = Field(default_factory=list)


class TrieNode:
    """Memory-efficient node in the move trie."""

    __slots__ = ("children", "entry")

    def __init__(self) -> None:
        self.children: dict[str, TrieNode] = {}
        self.entry: OpeningEntry | None = None


class OpeningsTree:
    """
    Compact deterministic opening tree built from the official Lichess openings dataset.
    Provides O(1) EPD lookup, move trie traversal, transposition-aware opening detection,
    and continuation branching.
    """

    def __init__(self, data_path: Path | str | None = None) -> None:
        if data_path is None:
            resolved_path = Path(__file__).resolve().parent / "data" / "openings.tsv.gz"
        else:
            resolved_path = Path(data_path)

        if not resolved_path.exists():
            raise FileNotFoundError(
                f"Openings dataset not found at '{resolved_path}'. "
                "Run scripts/build_openings.py to compile the bundled dataset."
            )

        self.root = TrieNode()
        self.by_epd: dict[str, OpeningEntry] = {}
        self.by_eco: dict[str, list[OpeningEntry]] = {}
        self.all_entries: list[OpeningEntry] = []

        self._load_dataset(resolved_path)

    def _load_dataset(self, data_path: Path) -> None:
        with gzip.open(data_path, "rt", encoding="utf-8") as f:
            header = next(f, None)
            if not header:
                return

            for raw_line in f:
                line = raw_line.strip()
                if not line:
                    continue
                parts = line.split("\t")
                if len(parts) < 5:
                    continue
                eco, name, pgn, uci, epd = parts[0], parts[1], parts[2], parts[3], parts[4]
                entry = OpeningEntry(
                    eco=eco,
                    name=name,
                    pgn=pgn,
                    uci=uci,
                    epd=epd,
                )

                self.all_entries.append(entry)
                self.by_epd[epd] = entry

                if eco not in self.by_eco:
                    self.by_eco[eco] = []
                self.by_eco[eco].append(entry)

                # Insert into move trie
                curr = self.root
                for m_uci in uci.split():
                    if m_uci not in curr.children:
                        curr.children[m_uci] = TrieNode()
                    curr = curr.children[m_uci]
                curr.entry = entry

    def get_by_epd(self, epd: str) -> OpeningEntry | None:
        """Finds an opening entry matching an Extended Position Description (EPD)."""
        clean_epd = epd.strip()
        return self.by_epd.get(clean_epd)

    def get_by_board(self, board: chess.Board) -> OpeningEntry | None:
        """Finds an opening entry matching a chess.Board instance."""
        return self.get_by_epd(board.epd())

    def detect_opening(
        self,
        game_or_pgn_or_moves: str | chess.pgn.Game | chess.Board | Sequence[str | chess.Move],
    ) -> OpeningMatch | None:
        """
        Detects the deepest theoretical opening reached along the game's mainline.
        Accurately handles transpositions by checking board EPD at each ply.
        """
        board = chess.Board()
        moves_to_play: list[chess.Move] = []

        if isinstance(game_or_pgn_or_moves, chess.pgn.Game):
            if game_or_pgn_or_moves.headers.get("SetUp") == "1" or (
                "FEN" in game_or_pgn_or_moves.headers
                and game_or_pgn_or_moves.headers.get("FEN") != chess.STARTING_FEN
            ):
                return None
            board = game_or_pgn_or_moves.board()
            moves_to_play = list(game_or_pgn_or_moves.mainline_moves())
        elif isinstance(game_or_pgn_or_moves, chess.Board):
            # Evaluate current board state directly
            entry = self.get_by_board(game_or_pgn_or_moves)
            if entry:
                return OpeningMatch(
                    eco=entry.eco,
                    name=entry.name,
                    ply=len(game_or_pgn_or_moves.move_stack),
                    uci=entry.uci,
                    pgn=entry.pgn,
                    epd=entry.epd,
                )
            return None
        elif isinstance(game_or_pgn_or_moves, str):
            cleaned = game_or_pgn_or_moves.strip()
            if not cleaned:
                return None
            try:
                parsed_game = chess.pgn.read_game(io.StringIO(cleaned))
                if parsed_game:
                    moves_to_play = list(parsed_game.mainline_moves())
            except Exception:
                moves_to_play = []

            # If read_game found no mainline moves, check if it's space-separated moves
            if not moves_to_play:
                token_moves = [
                    t for t in re.split(r"[\s,]+", cleaned) if t and not re.match(r"^\d+\.+$", t)
                ]
                for tok in token_moves:
                    try:
                        m = board.parse_san(tok)
                        moves_to_play.append(m)
                        board.push(m)
                    except ValueError:
                        try:
                            m = chess.Move.from_uci(tok)
                            if m in board.legal_moves:
                                moves_to_play.append(m)
                                board.push(m)
                            else:
                                break
                        except ValueError:
                            break
                # Reset board for the step-by-step traversal
                board.reset()
        elif isinstance(game_or_pgn_or_moves, Sequence):
            for item in game_or_pgn_or_moves:
                if isinstance(item, chess.Move):
                    if item in board.legal_moves:
                        moves_to_play.append(item)
                        board.push(item)
                    else:
                        break
                elif isinstance(item, str):
                    try:
                        m = board.parse_san(item)
                        moves_to_play.append(m)
                        board.push(m)
                    except ValueError:
                        try:
                            m = chess.Move.from_uci(item)
                            if m in board.legal_moves:
                                moves_to_play.append(m)
                                board.push(m)
                            else:
                                break
                        except ValueError:
                            break
            board.reset()

        if not moves_to_play:
            return None

        best_match: OpeningMatch | None = None

        # Play moves one by one, checking EPD at every ply (max 40 plies for openings)
        max_opening_ply = min(len(moves_to_play), 40)
        for ply_idx in range(max_opening_ply):
            m = moves_to_play[ply_idx]
            board.push(m)
            ply = ply_idx + 1
            epd = board.epd()
            if epd in self.by_epd:
                entry = self.by_epd[epd]
                best_match = OpeningMatch(
                    eco=entry.eco,
                    name=entry.name,
                    ply=ply,
                    uci=entry.uci,
                    pgn=entry.pgn,
                    epd=entry.epd,
                )

        return best_match

    def get_continuations(
        self,
        board_or_moves: chess.Board | str | Sequence[str | chess.Move],
    ) -> list[OpeningContinuation]:
        """
        Returns all known opening continuations from the current board position.
        Checks both trie children and transposed legal moves.
        """
        board = chess.Board()
        uci_moves: list[str] = []

        if isinstance(board_or_moves, chess.Board):
            board = board_or_moves.copy()
            uci_moves = [m.uci() for m in board.move_stack]
        elif isinstance(board_or_moves, str):
            cleaned = board_or_moves.strip()
            if cleaned:
                try:
                    game = chess.pgn.read_game(io.StringIO(cleaned))
                    if game:
                        for m in game.mainline_moves():
                            uci_moves.append(m.uci())
                            board.push(m)
                except Exception:
                    pass
        elif isinstance(board_or_moves, Sequence):
            for item in board_or_moves:
                if isinstance(item, chess.Move):
                    if item in board.legal_moves:
                        uci_moves.append(item.uci())
                        board.push(item)
                elif isinstance(item, str):
                    try:
                        m = board.parse_san(item)
                        uci_moves.append(m.uci())
                        board.push(m)
                    except ValueError:
                        try:
                            m = chess.Move.from_uci(item)
                            if m in board.legal_moves:
                                uci_moves.append(m.uci())
                                board.push(m)
                        except ValueError:
                            pass

        continuations: list[OpeningContinuation] = []
        seen_moves: set[str] = set()

        # 1. Walk trie from root
        curr = self.root
        in_trie = True
        for m_uci in uci_moves:
            if m_uci in curr.children:
                curr = curr.children[m_uci]
            else:
                in_trie = False
                break

        if in_trie:
            for child_uci, child_node in curr.children.items():
                try:
                    move_obj = chess.Move.from_uci(child_uci)
                except ValueError:
                    continue

                if move_obj not in board.legal_moves:
                    continue

                san = board.san(move_obj)
                seen_moves.add(child_uci)

                entry = child_node.entry
                if not entry:
                    # Find closest descendant entry
                    stack = [child_node]
                    while stack:
                        top = stack.pop(0)
                        if top.entry:
                            entry = top.entry
                            break
                        stack.extend(top.children.values())

                eco = entry.eco if entry else ""
                name = entry.name if entry else "Opening variation"
                continuations.append(
                    OpeningContinuation(
                        uci=child_uci,
                        san=san,
                        eco=eco,
                        name=name,
                    )
                )

        # 2. Check legal moves for transposed positions in by_epd
        for legal_m in board.legal_moves:
            m_uci = legal_m.uci()
            if m_uci in seen_moves:
                continue

            board.push(legal_m)
            epd = board.epd()
            board.pop()

            if epd in self.by_epd:
                entry = self.by_epd[epd]
                san = board.san(legal_m)
                seen_moves.add(m_uci)
                continuations.append(
                    OpeningContinuation(
                        uci=m_uci,
                        san=san,
                        eco=entry.eco,
                        name=entry.name,
                    )
                )

        # Sort continuations alphabetically by SAN
        continuations.sort(key=lambda c: c.san)
        return continuations

    def search(self, query: str, limit: int = 20) -> list[OpeningEntry]:
        """Searches openings by ECO code or opening name."""
        q = query.strip().lower()
        if not q:
            return self.all_entries[:limit]

        results: list[OpeningEntry] = []
        # Check exact or prefix ECO match first
        eco_upper = query.strip().upper()
        if eco_upper in self.by_eco:
            results.extend(self.by_eco[eco_upper])

        for entry in self.all_entries:
            if len(results) >= limit:
                break
            if q in entry.name.lower() or q in entry.eco.lower():
                if entry not in results:
                    results.append(entry)

        return results[:limit]


@functools.lru_cache(maxsize=1)
def get_openings_tree() -> OpeningsTree:
    """Returns the cached singleton instance of OpeningsTree."""
    return OpeningsTree()


def detect_opening(
    game_or_pgn_or_moves: str | chess.pgn.Game | chess.Board | Sequence[str | chess.Move],
) -> OpeningMatch | None:
    """Convenience helper to detect the deepest opening variation reached."""
    tree = get_openings_tree()
    return tree.detect_opening(game_or_pgn_or_moves)


def get_opening_by_epd(epd: str) -> OpeningEntry | None:
    """Convenience helper to look up an opening by position EPD."""
    tree = get_openings_tree()
    return tree.get_by_epd(epd)


def get_opening_continuations(
    board_or_moves: chess.Board | str | Sequence[str | chess.Move],
) -> list[OpeningContinuation]:
    """Convenience helper to query opening continuation branches."""
    tree = get_openings_tree()
    return tree.get_continuations(board_or_moves)


def search_openings(query: str, limit: int = 20) -> list[OpeningEntry]:
    """Convenience helper to search openings by name or ECO code."""
    tree = get_openings_tree()
    return tree.search(query=query, limit=limit)
