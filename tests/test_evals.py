from __future__ import annotations

import json

import chess

from src.evals import (
    extract_ply_evals_from_pgn,
    interpolate_eval_list,
    interpolate_ply_evals,
    parse_eval_token,
)
from src.inspector import extract_tactical_facts
from src.models import CriticalMoment, GameAnalysisPayload
from src.storage import (
    get_analysis_by_id,
    init_db,
    repair_missing_ply_evals,
    save_analysis,
    update_analysis_payload,
)


def test_parse_eval_token():
    assert parse_eval_token("0.25") == 25
    assert parse_eval_token("+0.50") == 50
    assert parse_eval_token("-1.50") == -150
    assert parse_eval_token("0") == 0
    assert parse_eval_token("#3") == 9997
    assert parse_eval_token("#-2") == -9998
    assert parse_eval_token("#0") == 0
    assert parse_eval_token("invalid") is None


def test_interpolate_eval_list():
    # Empty
    assert interpolate_eval_list([]) == []

    # Single known
    assert interpolate_eval_list([50]) == [50]

    # With None at start
    assert interpolate_eval_list([None, 100]) == [20, 100]

    # Linear interpolation between 20 and 80 over 3 steps
    res = interpolate_eval_list([20, None, None, 80])
    assert res == [20, 40, 60, 80]

    # Trailing None continues last known
    res_trail = interpolate_eval_list([20, 50, None])
    assert res_trail == [20, 50, 50]


def test_extract_ply_evals_from_pgn():
    pgn_with_evals = """[Event "Rated Blitz game"]
[Site "https://lichess.org/abcdef12"]
[Date "2026.11.01"]
[White "Player1"]
[Black "Player2"]
[Result "1-0"]

1. e4 { [%eval 0.25] [%clk 0:03:00] } 1... e5 { [%eval 0.30] [%clk 0:03:00] } 2. Nf3 { [%eval 0.45] [%clk 0:02:58] } 2... Nc6 { [%eval 0.40] [%clk 0:02:59] } 1-0"""

    evals = extract_ply_evals_from_pgn(pgn_with_evals)
    assert evals is not None
    assert len(evals) == 5  # ply 0..4
    assert evals[0] == 20  # standard start
    assert evals[1] == 25  # 1. e4
    assert evals[2] == 30  # 1... e5
    assert evals[3] == 45  # 2. Nf3
    assert evals[4] == 40  # 2... Nc6

    # PGN without eval annotations
    plain_pgn = "1. e4 e5 2. Nf3 Nc6 1-0"
    assert extract_ply_evals_from_pgn(plain_pgn) is None
    assert extract_ply_evals_from_pgn("") is None


def test_interpolate_ply_evals():
    empty_facts = extract_tactical_facts(chess.Board())
    cm1 = CriticalMoment(
        ply=2,
        move_number=1,
        color="Black",
        move_played_san="e5",
        eval_before_cp=25,
        eval_after_cp=30,
        mate_before=None,
        mate_after=None,
        classification="Inaccuracy",
        best_move_san="c5",
        pv_san=["c5", "Nf3"],
        facts_before_move=empty_facts,
        facts_after_played_move=empty_facts,
        facts_after_best_move=empty_facts,
        facts_at_end_of_pv=empty_facts,
    )
    cm2 = CriticalMoment(
        ply=4,
        move_number=2,
        color="Black",
        move_played_san="Nc6",
        eval_before_cp=30,
        eval_after_cp=-150,
        mate_before=None,
        mate_after=None,
        classification="Blunder",
        best_move_san="Nf6",
        pv_san=["Nf6", "Nc3"],
        facts_before_move=empty_facts,
        facts_after_played_move=empty_facts,
        facts_after_best_move=empty_facts,
        facts_at_end_of_pv=empty_facts,
    )

    evals = interpolate_ply_evals([cm1, cm2], total_plies=4, result_str="0-1")
    assert len(evals) == 5
    assert evals[0] == 20
    assert evals[2] == 30
    assert evals[4] == -150


def test_repair_missing_ply_evals(tmp_path):
    test_db = str(tmp_path / "test_repair.db")
    init_db(test_db)

    # 1. Save an analysis payload where ply_evals is explicitly None
    pgn = """[Event "Casual"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 { [%eval 0.35] } 1... e5 { [%eval 0.40] } 1-0"""

    payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="1-0",
        time_control="300",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
        ply_evals=None,
    )

    aid = save_analysis(
        pgn_text=pgn,
        payload=payload,
        report_md="# Report",
        model_name="test",
        db_path=test_db,
    )

    # Simulate legacy row with null ply_evals in payload_json
    from src.storage import get_connection

    with get_connection(test_db) as conn:
        conn.execute(
            "UPDATE game_analyses SET payload_json = json_remove(payload_json, '$.ply_evals') WHERE id = ?;",
            (aid,),
        )
        conn.commit()

    # Verify that raw payload_json in db currently has null ply_evals
    with get_connection(test_db) as conn:
        row = conn.execute(
            "SELECT payload_json FROM game_analyses WHERE id = ?;", (aid,)
        ).fetchone()
        assert row is not None
        raw_p = json.loads(row["payload_json"])
        assert raw_p.get("ply_evals") is None

    # Run repair
    repaired = repair_missing_ply_evals(test_db)
    assert repaired == 1

    # Verify that db now has ply_evals reconstructed from PGN
    rec_after = get_analysis_by_id(aid, db_path=test_db)
    assert rec_after is not None
    assert rec_after["ply_evals"] is not None
    assert len(rec_after["ply_evals"]) >= 3
    assert rec_after["ply_evals"][1] == 35
    assert rec_after["ply_evals"][2] == 40

    # Running repair a second time does nothing
    assert repair_missing_ply_evals(test_db) == 0


def test_update_analysis_payload(tmp_path):
    test_db = str(tmp_path / "test_update_payload.db")
    init_db(test_db)

    payload1 = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="1-0",
        time_control="300",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
        ply_evals=[20, 30, 40],
    )
    aid = save_analysis(
        pgn_text="1. e4 e5 1-0",
        payload=payload1,
        report_md="# Old Report",
        model_name="old-model",
        db_path=test_db,
    )

    payload2 = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="1-0",
        time_control="300",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
        ply_evals=[20, 50, 80],
        tags=["kingside_attack"],
    )

    ok = update_analysis_payload(
        aid,
        payload=payload2,
        report_md="# New Report",
        model_name="new-model",
        db_path=test_db,
    )
    assert ok is True

    rec = get_analysis_by_id(aid, db_path=test_db)
    assert rec is not None
    assert rec["report_md"] == "# New Report"
    assert rec["model_name"] == "new-model"
    assert rec["ply_evals"] == [20, 50, 80]
    assert rec["tags"] == ["kingside_attack"]
