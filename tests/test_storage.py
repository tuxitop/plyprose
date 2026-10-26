import os

import pytest

from src.models import GameAnalysisPayload
from src.storage import (
    clear_all_analyses,
    compute_analysis_hash,
    delete_analysis,
    find_analysis,
    get_all_analyses,
    get_analysis_by_id,
    init_db,
    save_analysis,
    update_analysis_github_sync,
    update_analysis_report,
)


@pytest.fixture
def sample_payload() -> GameAnalysisPayload:
    return GameAnalysisPayload(
        white_player="Magnus Carlsen",
        black_player="Hikaru Nakamura",
        user_color="Both",
        result="1-0",
        time_control="180+2",
        opening_name="C20: King Pawn Game",
        pgn_moves_summary="1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#",
        total_plies=7,
        critical_moments=[],
    )


def test_init_and_save_analysis(tmp_path, sample_payload: GameAnalysisPayload):
    db_file = str(tmp_path / "test_history.db")
    init_db(db_file)
    assert os.path.exists(db_file)

    pgn = "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0"
    report = "# Coaching Report\n\nWhite exploited f7 vulnerability."
    model = "gemini-3.8-flash"

    record_id = save_analysis(
        pgn_text=pgn,
        payload=sample_payload,
        report_md=report,
        model_name=model,
        db_path=db_file,
    )
    assert record_id == 1

    # Fetch back
    data = get_analysis_by_id(record_id, db_path=db_file)
    assert data is not None
    assert data["id"] == 1
    assert data["white_player"] == "Magnus Carlsen"
    assert data["black_player"] == "Hikaru Nakamura"
    assert data["model_name"] == "gemini-3.8-flash"
    assert data["report_md"] == report
    assert data["pgn_text"] == pgn
    assert data["total_plies"] == 7

    # Verify deserialized payload
    assert isinstance(data["payload"], GameAnalysisPayload)
    assert data["payload"].white_player == "Magnus Carlsen"


def test_get_all_analyses(tmp_path, sample_payload: GameAnalysisPayload):
    db_file = str(tmp_path / "test_multi.db")

    id1 = save_analysis("pgn1", sample_payload, "report1", "gemini-3.8-flash", db_path=db_file)
    id2 = save_analysis("pgn2", sample_payload, "report2", "gemini-3.7-flash", db_path=db_file)

    items = get_all_analyses(db_path=db_file)
    assert len(items) == 2
    # Newest first
    assert items[0]["id"] == id2
    assert items[0]["model_name"] == "gemini-3.7-flash"
    assert items[1]["id"] == id1
    assert items[1]["model_name"] == "gemini-3.8-flash"


def test_get_all_analyses_sorted_by_played_at(tmp_path, sample_payload: GameAnalysisPayload):
    db_file = str(tmp_path / "test_played_at_order.db")

    pgn_earlier = '[Date "2026.10.20"]\n[UTCTime "10:00:00"]\n\n1. e4 e5 *'
    pgn_later = '[Date "2026.10.24"]\n[UTCTime "15:30:00"]\n\n1. d4 d5 *'

    # Save earlier played game after later played game
    id_later = save_analysis(
        pgn_later, sample_payload, "rep_later", "gemini-3.8-flash", db_path=db_file
    )
    id_earlier = save_analysis(
        pgn_earlier, sample_payload, "rep_earlier", "gemini-3.8-flash", db_path=db_file
    )

    items = get_all_analyses(db_path=db_file)
    assert len(items) == 2
    # Game played on Oct 24 must come before game played on Oct 20
    assert items[0]["id"] == id_later
    assert items[0]["played_at"] == "2026-10-24 15:30:00"
    assert items[1]["id"] == id_earlier
    assert items[1]["played_at"] == "2026-10-20 10:00:00"


def test_update_analysis_report(tmp_path, sample_payload: GameAnalysisPayload):
    db_file = str(tmp_path / "test_update.db")
    rec_id = save_analysis(
        "pgn", sample_payload, "original report", "gemini-2.5-pro", db_path=db_file
    )

    updated = update_analysis_report(
        rec_id, "brand new report", "gemini-3.8-flash", db_path=db_file
    )
    assert updated is True

    data = get_analysis_by_id(rec_id, db_path=db_file)
    assert data["report_md"] == "brand new report"
    assert data["model_name"] == "gemini-3.8-flash"

    # Non-existent ID returns False
    assert update_analysis_report(999, "new", "model", db_path=db_file) is False


def test_delete_and_clear_analyses(tmp_path, sample_payload: GameAnalysisPayload):
    db_file = str(tmp_path / "test_delete.db")
    id1 = save_analysis("pgn1", sample_payload, "r1", "m1", db_path=db_file)
    save_analysis("pgn2", sample_payload, "r2", "m2", db_path=db_file)

    deleted = delete_analysis(id1, db_path=db_file)
    assert deleted is True
    assert get_analysis_by_id(id1, db_path=db_file) is None
    assert delete_analysis(id1, db_path=db_file) is False

    assert len(get_all_analyses(db_path=db_file)) == 1

    clear_all_analyses(db_path=db_file)
    assert len(get_all_analyses(db_path=db_file)) == 0


def test_get_nonexistent_analysis(tmp_path):
    db_file = str(tmp_path / "empty.db")
    assert get_analysis_by_id(12345, db_path=db_file) is None


def test_platform_and_find_analysis(tmp_path, sample_payload: GameAnalysisPayload):
    db_file = str(tmp_path / "test_platform.db")
    chesscom_pgn = (
        '[Site "Chess.com"]\n[Link "https://www.chess.com/game/live/987654321"]\n\n1. e4 e5 *'
    )

    rec_id = save_analysis(
        pgn_text=chesscom_pgn,
        payload=sample_payload,
        report_md="Report",
        model_name="test-model",
        db_path=db_file,
    )

    data = get_analysis_by_id(rec_id, db_path=db_file)
    assert data["platform"] == "chesscom"
    assert data["external_id"] == "987654321"

    # Verify find_analysis by external_id and by pgn
    found_by_id = find_analysis(external_id="987654321", db_path=db_file)
    assert found_by_id is not None
    assert found_by_id["id"] == rec_id

    found_by_pgn = find_analysis(pgn_text=chesscom_pgn, db_path=db_file)
    assert found_by_pgn is not None
    assert found_by_pgn["id"] == rec_id

    not_found = find_analysis(external_id="unknown_123", pgn_text="unknown", db_path=db_file)
    assert not_found is None


def test_compute_analysis_hash_and_github_sync(tmp_path, sample_payload: GameAnalysisPayload):
    db_file = str(tmp_path / "test_hash.db")
    rec_id = save_analysis("1. e4 e5", sample_payload, "Report A", "model", db_path=db_file)

    rec = get_analysis_by_id(rec_id, db_path=db_file)
    assert rec["github_synced_hash"] is None
    assert rec["github_path"] is None

    hash1 = compute_analysis_hash("Report A", "1. e4 e5")
    assert isinstance(hash1, str)
    assert len(hash1) == 64

    # Identical content yields identical hash, ignoring leading/trailing whitespace
    assert compute_analysis_hash("  Report A\n", "1. e4 e5  ") == hash1
    # Different content yields different hash
    assert compute_analysis_hash("Report B", "1. e4 e5") != hash1

    # Update github sync info
    ok = update_analysis_github_sync(rec_id, "chess.com/blitz/folder", hash1, db_path=db_file)
    assert ok is True

    rec_updated = get_analysis_by_id(rec_id, db_path=db_file)
    assert rec_updated["github_path"] == "chess.com/blitz/folder"
    assert rec_updated["github_synced_hash"] == hash1
