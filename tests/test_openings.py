from __future__ import annotations

from pathlib import Path

import chess
import chess.pgn
import pytest
from starlette.testclient import TestClient

from api.main import app
from src.openings import (
    OpeningsTree,
    detect_opening,
    get_opening_by_epd,
    get_opening_continuations,
    get_openings_tree,
    search_openings,
)


@pytest.fixture
def tree() -> OpeningsTree:
    return get_openings_tree()


def test_openings_tree_initialization(tree: OpeningsTree) -> None:
    assert len(tree.all_entries) == 3865
    assert len(tree.by_epd) == 3865
    assert len(tree.by_eco) >= 500
    assert tree.root is not None


def test_openings_tree_missing_file() -> None:
    with pytest.raises(FileNotFoundError):
        OpeningsTree(Path("/nonexistent/path/to/openings.tsv.gz"))


def test_epd_lookup(tree: OpeningsTree) -> None:
    # 1. e4 c5 EPD: rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -
    board = chess.Board()
    board.push_san("e4")
    board.push_san("c5")
    epd = board.epd()

    entry = tree.get_by_epd(epd)
    assert entry is not None
    assert entry.eco == "B20"
    assert "Sicilian Defense" in entry.name
    assert get_opening_by_epd(epd) == entry


def test_detect_opening_najdorf() -> None:
    pgn = "1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be2 e5 7. Nb3 Be7"
    match = detect_opening(pgn)
    assert match is not None
    assert match.eco == "B92"
    assert "Najdorf Variation" in match.name
    assert "Opocensky Variation" in match.name
    assert match.ply == 11
    assert match.full_name == f"{match.eco}: {match.name}"


def test_detect_opening_italian_game() -> None:
    pgn = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5"
    match = detect_opening(pgn)
    assert match is not None
    assert match.eco == "C50"
    assert "Italian Game" in match.name
    assert match.ply == 6


def test_detect_opening_ruy_lopez() -> None:
    pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6"
    match = detect_opening(pgn)
    assert match is not None
    assert match.eco == "C70"
    assert "Ruy Lopez" in match.name


def test_detect_opening_queens_gambit_declined() -> None:
    pgn = "1. d4 d5 2. c4 e6 3. Nc3 Nf6"
    match = detect_opening(pgn)
    assert match is not None
    assert match.eco == "D35"
    assert "Queen's Gambit Declined" in match.name


def test_detect_opening_caro_kann() -> None:
    pgn = "1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5"
    match = detect_opening(pgn)
    assert match is not None
    assert match.eco == "B18"
    assert "Caro-Kann Defense" in match.name


def test_detect_opening_transposition() -> None:
    # Nimzo-Indian standard: 1. d4 Nf6 2. c4 e6 3. Nc3 Bb4
    # Transposed via English: 1. c4 e6 2. d4 Nf6 3. Nc3 Bb4
    transposed_pgn = "1. c4 e6 2. d4 Nf6 3. Nc3 Bb4"
    match = detect_opening(transposed_pgn)
    assert match is not None
    assert match.eco.startswith("E")
    assert "Nimzo-Indian" in match.name


def test_detect_opening_empty_or_invalid() -> None:
    assert detect_opening("") is None
    assert detect_opening("   ") is None
    assert detect_opening("invalid chess moves that make no sense") is None


def test_detect_opening_out_of_book() -> None:
    # Play 4 book moves, then an absurd king walk
    pgn = "1. e4 e5 2. Nf3 Nc6 3. Ke2 Ke7 4. Ke1 Ke8"
    match = detect_opening(pgn)
    assert match is not None
    # Deepest book match was 2... Nc6 (King's Knight Opening / King's Pawn Game)
    assert match.ply in (3, 4)
    assert match.eco in ("C40", "C44", "C20")


def test_get_opening_continuations_after_e4() -> None:
    conts = get_opening_continuations("1. e4")
    assert len(conts) >= 10
    sans = [c.san for c in conts]
    assert "c5" in sans  # Sicilian
    assert "e5" in sans  # King's Pawn
    assert "e6" in sans  # French
    assert "c6" in sans  # Caro-Kann
    assert "d5" in sans  # Scandinavian

    c5_cont = next(c for c in conts if c.san == "c5")
    assert c5_cont.eco == "B20"
    assert "Sicilian" in c5_cont.name


def test_get_opening_continuations_initial_board() -> None:
    board = chess.Board()
    conts = get_opening_continuations(board)
    sans = [c.san for c in conts]
    assert "e4" in sans
    assert "d4" in sans
    assert "c4" in sans
    assert "Nf3" in sans


def test_search_openings() -> None:
    results_sicilian = search_openings("Sicilian", limit=5)
    assert len(results_sicilian) == 5
    for r in results_sicilian:
        assert "Sicilian" in r.name or "Sicilian" in r.eco

    results_eco = search_openings("B90", limit=10)
    assert len(results_eco) > 0
    assert any(r.eco == "B90" for r in results_eco)

    assert search_openings("NonExistentOpeningXYZ12345") == []


def test_api_identify_opening_endpoint() -> None:
    client = TestClient(app)

    # 1. Test via PGN string
    resp = client.post(
        "/api/openings/identify",
        json={"pgn": "1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["matched"] is True
    assert data["eco"] == "B90"
    assert "Najdorf Variation" in data["name"]
    assert len(data["continuations"]) > 0

    # 2. Test via moves array
    resp_moves = client.post(
        "/api/openings/identify",
        json={"moves": ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]},
    )
    assert resp_moves.status_code == 200
    data_moves = resp_moves.json()
    assert data_moves["matched"] is True
    assert data_moves["eco"] == "C50"
    assert "Italian Game" in data_moves["name"]

    # 3. Test empty input
    resp_empty = client.post("/api/openings/identify", json={})
    assert resp_empty.status_code == 200
    assert resp_empty.json()["matched"] is False


def test_api_openings_continuations_endpoint() -> None:
    client = TestClient(app)
    resp = client.get("/api/openings/continuations", params={"moves": "1. e4"})
    assert resp.status_code == 200
    conts = resp.json()
    assert isinstance(conts, list)
    assert len(conts) >= 10
    sans = [c["san"] for c in conts]
    assert "c5" in sans


def test_api_openings_search_endpoint() -> None:
    client = TestClient(app)
    resp = client.get("/api/openings/search", params={"q": "French Defense", "limit": 3})
    assert resp.status_code == 200
    results = resp.json()
    assert len(results) == 3
    for r in results:
        assert "French" in r["name"] or "French" in r["eco"]
