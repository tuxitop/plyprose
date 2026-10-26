from __future__ import annotations

from fastapi.testclient import TestClient

from api.games_db import get_pending_games, save_pending_game
from api.main import app
from src.models import GameAnalysisPayload
from src.storage import get_all_analyses, save_analysis


def test_api_games_sorted_by_played_time(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_api_games.db")
    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.games_db.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.main.get_all_analyses", lambda: get_all_analyses(test_db))
    monkeypatch.setattr("api.main.get_pending_games", lambda: get_pending_games(test_db))

    # 1. Save an older pending game played on 2026-10-20 10:00:00
    pgn_old = '[Date "2026.10.20"]\n[UTCTime "10:00:00"]\n\n1. e4 e5 *'
    save_pending_game(
        pgn_text=pgn_old,
        white="PlayerA",
        black="PlayerB",
        side="white",
        db_path=test_db,
    )

    # 2. Save an analyzed game played on 2026-10-22 14:00:00
    pgn_mid = '[Date "2026.10.22"]\n[UTCTime "14:00:00"]\n\n1. d4 d5 *'
    payload = GameAnalysisPayload(
        white_player="PlayerC",
        black_player="PlayerD",
        user_color="Black",
        result="0-1",
        time_control="300+5",
        pgn_moves_summary="1. d4 d5",
        total_plies=2,
        critical_moments=[],
    )
    save_analysis(
        pgn_text=pgn_mid,
        payload=payload,
        report_md="# Report Mid",
        model_name="test-model",
        db_path=test_db,
    )

    # 3. Save a newest pending game played on 2026-10-24 16:30:00
    pgn_new = '[Date "2026.10.24"]\n[UTCTime "16:30:00"]\n\n1. c4 c5 *'
    save_pending_game(
        pgn_text=pgn_new,
        white="PlayerE",
        black="PlayerF",
        side="black",
        db_path=test_db,
    )

    client = TestClient(app)
    response = client.get("/api/games")
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 3
    games = data["games"]

    # Verify latest played game is shown first
    assert games[0]["played_at"] == "2026-10-24 16:30:00"
    assert games[0]["white_player"] == "PlayerE" or games[0].get("white") == "PlayerE"

    # Middle game
    assert games[1]["played_at"] == "2026-10-22 14:00:00"

    # Oldest game
    assert games[2]["played_at"] == "2026-10-20 10:00:00"
    assert games[2]["white_player"] == "PlayerA" or games[2].get("white") == "PlayerA"

    # Verify every record includes date and time in played_at
    for g in games:
        assert len(g["played_at"]) == 19
        assert " " in g["played_at"]  # contains date and time separator


def test_reconcile_report_fens():
    from api.board_renderer import reconcile_report_fens

    pgn = """[Event "Test"]
1. e4 a6 2. d4 b5 3. c4 c6 4. c5 d6 5. Nf3 dxc5 6. dxc5 Qxd1+ 7. Kxd1 *"""

    # At move 7, after 6...Qxd1+ 7. Kxd1, Black's queen on d1 was captured.
    # Suppose an LLM hallucinated a FEN where Black still has a queen or White has extra queen
    hallucinated_tag = (
        ':::board{fen="rnb1kbnr/5ppp/p1p5/1p2p3/4P3/5N2/PPP2PPP/RNBqKB1R w KQkq - 0 7" '
        'orientation="white" caption="Move 7: King recaptures."}'
    )
    report = f"# Section\n\n{hallucinated_tag}\n\nSome text."

    reconciled = reconcile_report_fens(report, pgn_text=pgn)
    # Move 7 before move is ply 12: rnb1kb1r/4pppp/p1p5/1p6/8/5N2/PPP2PPP/RNBK1B1R b kq - 0 7
    assert "rnb1kbnr/5ppp" not in reconciled
    assert "Move 7" in reconciled


def test_reconcile_report_injects_game_link():
    from api.board_renderer import reconcile_report_fens

    pgn = '[Event "Live Chess"]\n[Link "https://www.chess.com/game/live/999888777"]\n\n1. e4 e5 1-0'
    report = "# 1. Game Overview\n\n- **Match Details:** PlayerA vs PlayerB, Platform: Chess.com, Result: 1-0\n- **Opening:** Open Game\n"

    reconciled = reconcile_report_fens(report, pgn_text=pgn)
    assert (
        "- **Game Link:** [View on Chess.com](https://www.chess.com/game/live/999888777)"
        in reconciled
    )


def test_sync_games_deduplication(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_sync_dedup.db")
    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.games_db.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.main.get_all_analyses", lambda: get_all_analyses(test_db))
    monkeypatch.setattr("api.main.get_pending_games", lambda: get_pending_games(test_db))
    monkeypatch.setattr(
        "api.main.get_settings", lambda: {"chesscom_username": "tuxitop", "lichess_username": ""}
    )

    pgn_analyzed = (
        '[Site "Chess.com"]\n[Link "https://www.chess.com/game/live/111222333"]\n\n1. e4 e5 *'
    )
    payload = GameAnalysisPayload(
        white_player="tuxitop",
        black_player="OpponentA",
        user_color="White",
        result="1-0",
        time_control="600",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
    )
    save_analysis(
        pgn_text=pgn_analyzed,
        payload=payload,
        report_md="# Analyzed Game",
        model_name="test-model",
        platform="chesscom",
        external_id="111222333",
        db_path=test_db,
    )

    # Mock fetch_chesscom_games returning:
    # 1. The game 111222333 that was already analyzed
    # 2. A brand new game 444555666
    mock_games = [
        {
            "id": "111222333",
            "white": "tuxitop",
            "black": "OpponentA",
            "date": "2026.10.24",
            "played_at": "2026-10-24 12:00:00",
            "result": "1-0",
            "time_control": "600",
            "pgn": pgn_analyzed,
        },
        {
            "id": "444555666",
            "white": "OpponentB",
            "black": "tuxitop",
            "date": "2026.10.24",
            "played_at": "2026-10-24 13:00:00",
            "result": "0-1",
            "time_control": "600",
            "pgn": '[Site "Chess.com"]\n[Link "https://www.chess.com/game/live/444555666"]\n\n1. d4 d5 *',
        },
    ]
    monkeypatch.setattr("api.main.fetch_chesscom_games", lambda user, max_games: mock_games)

    client = TestClient(app)

    # First sync: 1 game already analyzed (should be skipped), 1 new game (should be saved)
    resp1 = client.post("/api/games/sync?platform=chesscom&max_games=10")
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["count"] == 1

    # Second sync: neither game should be added (1 already analyzed, 1 already pending)
    resp2 = client.post("/api/games/sync?platform=chesscom&max_games=10")
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["count"] == 0

    # Verify game list shows the analyzed game as chesscom and analyzed: True
    games_resp = client.get("/api/games")
    assert games_resp.status_code == 200
    all_games = games_resp.json()["games"]
    assert len(all_games) == 2

    analyzed_record = next(g for g in all_games if g["external_id"] == "111222333")
    assert analyzed_record["analyzed"] is True
    assert analyzed_record["platform"] == "chesscom"

    pending_record = next(g for g in all_games if g["external_id"] == "444555666")
    assert pending_record["analyzed"] is False
    assert pending_record["platform"] == "chesscom"


def test_settings_platform_and_time_control_ratings(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_settings_ratings.db")
    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.settings_db.DEFAULT_DB_PATH", test_db)

    client = TestClient(app)

    # 1. Get initial settings
    r = client.get("/api/settings")
    assert r.status_code == 200
    data = r.json()
    assert "elo_chesscom_blitz" in data
    assert "elo_chesscom_rapid" in data
    assert "elo_lichess_blitz" in data
    assert "elo_lichess_rapid" in data

    # 2. Update platform-specific ratings
    update_payload = {
        "elo": 1350,
        "elo_chesscom_blitz": 1420,
        "elo_chesscom_rapid": 1580,
        "elo_lichess_blitz": 1650,
        "elo_lichess_rapid": 1780,
    }
    r_put = client.put("/api/settings", json=update_payload)
    assert r_put.status_code == 200
    updated = r_put.json()
    assert updated["elo"] == 1350
    assert updated["elo_chesscom_blitz"] == 1420
    assert updated["elo_chesscom_rapid"] == 1580
    assert updated["elo_lichess_blitz"] == 1650
    assert updated["elo_lichess_rapid"] == 1780


def test_sync_games_with_time_range(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_sync_timerange.db")
    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.games_db.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr(
        "api.main.get_settings",
        lambda: {"chesscom_username": "tuxitop", "lichess_username": "tuxlichess"},
    )

    captured_args = {}

    def mock_fetch_chesscom(username, max_games=10, since=None, until=None):
        captured_args["chesscom"] = {
            "username": username,
            "max_games": max_games,
            "since": since,
            "until": until,
        }
        return [
            {
                "id": "cc_recent_1",
                "white": "tuxitop",
                "black": "opponent",
                "date": "2026.10.25",
                "played_at": "2026-10-25 08:00:00",
                "result": "1-0",
                "time_control": "180+2",
                "pgn": '[Site "Chess.com"]\n[WhiteElo "1450"]\n\n1. e4 e5 *',
            }
        ]

    monkeypatch.setattr("api.main.fetch_chesscom_games", mock_fetch_chesscom)

    client = TestClient(app)

    # 1. Test syncing 1d
    r1 = client.post("/api/games/sync?platform=chesscom&time_range=1d")
    assert r1.status_code == 200
    assert "chesscom" in captured_args
    assert captured_args["chesscom"]["since"] is not None

    # 2. Test syncing custom date
    r2 = client.post(
        "/api/games/sync?platform=chesscom&time_range=custom&since=2026-10-01&until=2026-10-20"
    )
    assert r2.status_code == 200
    assert captured_args["chesscom"]["since"] is not None
    assert captured_args["chesscom"]["until"] is not None


def test_detect_ratings_from_pgns(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_detect_ratings.db")
    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.games_db.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.settings_db.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.ratings.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.ratings.fetch_chesscom_ratings", lambda u: {})
    monkeypatch.setattr("api.ratings.fetch_lichess_ratings", lambda u: {})

    # Configure usernames
    from api.settings_db import update_settings

    update_settings(
        {"chesscom_username": "PlayerHero", "lichess_username": "LichessHero"}, db_path=test_db
    )

    # Save a Chess.com Blitz game: PlayerHero (White) rating 1450
    cc_blitz_pgn = """[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.10.24"]
[UTCTime "15:00:00"]
[White "PlayerHero"]
[Black "Opponent1"]
[WhiteElo "1450"]
[BlackElo "1420"]
[TimeControl "180+2"]

1. e4 e5 1-0"""
    save_pending_game(
        pgn_text=cc_blitz_pgn,
        platform="chesscom",
        white="PlayerHero",
        black="Opponent1",
        side="white",
        db_path=test_db,
    )

    # Save a Lichess Rapid game: LichessHero (Black) rating 1720
    li_rapid_pgn = """[Event "Rated Rapid game"]
[Site "https://lichess.org/abc12345"]
[Date "2026.10.23"]
[UTCTime "12:00:00"]
[White "Opponent2"]
[Black "LichessHero"]
[WhiteElo "1690"]
[BlackElo "1720"]
[TimeControl "600+0"]

1. d4 d5 0-1"""
    save_pending_game(
        pgn_text=li_rapid_pgn,
        platform="lichess",
        white="Opponent2",
        black="LichessHero",
        side="black",
        db_path=test_db,
    )

    client = TestClient(app)
    r = client.get("/api/settings/detected-ratings")
    assert r.status_code == 200
    data = r.json()
    assert "pgn_ratings" in data
    pgn_ratings = data["pgn_ratings"]

    assert "chesscom_blitz" in pgn_ratings
    assert pgn_ratings["chesscom_blitz"]["rating"] == 1450

    assert "lichess_rapid" in pgn_ratings
    assert pgn_ratings["lichess_rapid"]["rating"] == 1720

    # Suggestions should contain the detected values
    assert data["suggestions"]["elo_chesscom_blitz"] == 1450
    assert data["suggestions"]["elo_lichess_rapid"] == 1720


def test_fetch_platform_games_and_batch_import(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_preview_batch.db")
    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.games_db.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr(
        "api.main.get_settings", lambda: {"chesscom_username": "HeroPlayer", "lichess_username": ""}
    )

    # Save 1 game already in DB so it shows as already_imported = True
    already_pgn = '[Site "Chess.com"]\n[WhiteElo "1500"]\n\n1. e4 e5 *'
    save_pending_game(
        pgn_text=already_pgn, platform="chesscom", external_id="already_1", db_path=test_db
    )

    # Mock raw games returned by Chess.com
    mock_games = [
        {
            "id": "already_1",
            "white": "HeroPlayer",
            "black": "OpponentX",
            "date": "2026.10.24",
            "played_at": "2026-10-24 14:00:00",
            "result": "1-0",
            "time_control": "180+2",
            "pgn": already_pgn,
        },
        {
            "id": "new_game_2",
            "white": "OpponentY",
            "black": "HeroPlayer",
            "date": "2026.10.25",
            "played_at": "2026-10-25 10:30:00",
            "result": "0-1",
            "time_control": "600",
            "pgn": '[Site "Chess.com"]\n[WhiteElo "1580"]\n[BlackElo "1620"]\n\n1. d4 d5 0-1',
        },
    ]
    monkeypatch.setattr(
        "api.main._fetch_platform_raw_games", lambda plat, max_g, s, u, sett: mock_games
    )

    client = TestClient(app)

    # 1. Fetch preview
    r = client.get("/api/games/fetch-platform-games?platform=chesscom&time_range=1w")
    assert r.status_code == 200
    data = r.json()
    assert data["count"] == 2
    games = data["games"]

    # Game 1 is already in DB
    assert games[0]["id"] == "already_1"
    assert games[0]["already_imported"] is True
    assert games[0]["side"] == "white"
    assert games[0]["opponent"] == "OpponentX"
    assert games[0]["outcome"] == "win"

    # Game 2 is new
    assert games[1]["id"] == "new_game_2"
    assert games[1]["already_imported"] is False
    assert games[1]["side"] == "black"
    assert games[1]["opponent"] == "OpponentY"
    assert games[1]["user_elo"] == 1620
    assert games[1]["opponent_elo"] == 1580
    assert games[1]["outcome"] == "win"  # Black won 0-1

    # 2. Selectively import only the new game
    batch_payload = {
        "games": [
            {
                "pgn": games[1]["pgn"],
                "platform": "chesscom",
                "external_id": games[1]["id"],
                "white": games[1]["white"],
                "black": games[1]["black"],
                "result": games[1]["result"],
                "time_control": games[1]["time_control"],
                "date": games[1]["date"],
                "played_at": games[1]["played_at"],
                "side": games[1]["side"],
            }
        ]
    }
    r_batch = client.post("/api/games/import-batch", json=batch_payload)
    assert r_batch.status_code == 200
    batch_res = r_batch.json()
    assert batch_res["imported_count"] == 1

    # 3. Verify total games in library is now 2
    from api.games_db import get_pending_games

    pending = get_pending_games(test_db)
    assert len(pending) == 2

    # 4. Verify /api/games returns user_outcome='win' for Black win (0-1) and filters correctly
    r_list = client.get("/api/games?result=win")
    assert r_list.status_code == 200
    win_games = r_list.json()["games"]
    black_win = next((g for g in win_games if g.get("external_id") == "new_game_2"), None)
    assert black_win is not None
    assert black_win["user_outcome"] == "win"


def test_platform_toggle_endpoint(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_platform_toggle.db")
    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.games_db.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.main.get_all_analyses", lambda: get_all_analyses(test_db))
    monkeypatch.setattr("api.main.get_pending_games", lambda: get_pending_games(test_db))

    client = TestClient(app)

    # 1. Import a PGN with lichess.org in Site header
    pgn_li = (
        '[Event "Lichess Blitz"]\n'
        '[Site "https://lichess.org/game/abc12345"]\n'
        '[Date "2026.10.25"]\n'
        '[White "Magnus"]\n'
        '[Black "Tuxitop"]\n'
        '[Result "0-1"]\n'
        '[TimeControl "180+0"]\n\n'
        "1. e4 e5 2. Nf3 Nc6 0-1\n"
    )
    r_import = client.post("/api/games/import", json={"pgn": pgn_li, "side": "auto"})
    assert r_import.status_code == 200
    data = r_import.json()
    assert data["platform"] == "lichess"
    pending_id = data["pending_id"]

    # 2. Query /api/games with platform=lichess
    r_list = client.get("/api/games?platform=lichess")
    assert r_list.status_code == 200
    games = r_list.json()["games"]
    assert len(games) == 1
    assert games[0]["platform"] == "lichess"
    assert games[0]["moves_count"] == 2

    # 3. Toggle platform to chesscom via PATCH endpoint
    r_patch = client.patch(
        f"/api/games/{pending_id}/platform",
        json={"platform": "chesscom", "is_pending": True},
    )
    assert r_patch.status_code == 200
    assert r_patch.json()["platform"] == "chesscom"

    # 4. Verify the game is now under chesscom
    r_list_cc = client.get("/api/games?platform=chesscom")
    assert r_list_cc.status_code == 200
    assert len(r_list_cc.json()["games"]) == 1

    # 5. Invalid platform returns 400
    r_bad = client.patch(
        f"/api/games/{pending_id}/platform",
        json={"platform": "invalid_platform", "is_pending": True},
    )
    assert r_bad.status_code == 400


def test_batch_import_platform_tagging(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_api_games_batch.db")
    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.games_db.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.main.get_all_analyses", lambda: get_all_analyses(test_db))
    monkeypatch.setattr("api.main.get_pending_games", lambda: get_pending_games(test_db))
    monkeypatch.setattr(
        "api.main.save_pending_game", lambda **kwargs: save_pending_game(db_path=test_db, **kwargs)
    )

    client = TestClient(app)

    # 1. Batch import a game with explicit platform='lichess'
    pgn_game = (
        '[Event "rated blitz game"]\n'
        '[Site "https://lichess.org/game/xyz123"]\n'
        '[Date "2026.10.25"]\n'
        '[White "tuxitop"]\n'
        '[Black "opp"]\n'
        '[Result "1-0"]\n\n'
        "1. e4 e5 1-0\n"
    )
    payload = {
        "games": [
            {
                "pgn": pgn_game,
                "platform": "lichess",
                "external_id": "xyz123",
                "white": "tuxitop",
                "black": "opp",
                "result": "1-0",
                "time_control": "300+3",
                "side": "white",
            }
        ]
    }
    r = client.post("/api/games/import-batch", json=payload)
    assert r.status_code == 200
    assert r.json()["imported_count"] == 1

    # Verify game is tagged as lichess in games list
    r_list = client.get("/api/games?platform=lichess")
    assert r_list.status_code == 200
    assert len(r_list.json()["games"]) == 1
    assert r_list.json()["games"][0]["platform"] == "lichess"

    # 2. Re-importing same game with platform='chesscom' updates its tag
    payload["games"][0]["platform"] = "chesscom"
    r2 = client.post("/api/games/import-batch", json=payload)
    assert r2.status_code == 200

    r_list_cc = client.get("/api/games?platform=chesscom")
    assert r_list_cc.status_code == 200
    assert len(r_list_cc.json()["games"]) == 1
    assert r_list_cc.json()["games"][0]["platform"] == "chesscom"
