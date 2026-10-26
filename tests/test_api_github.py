from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from api.main import app
from src.models import GameAnalysisPayload
from src.storage import get_all_analyses, get_analysis_by_id, save_analysis, update_analysis_report


@pytest.fixture
def test_setup(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_api_gh.db")

    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.games_db.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.settings_db.DEFAULT_DB_PATH", test_db)

    # Re-wire api.main functions to use test_db
    monkeypatch.setattr("api.main.get_all_analyses", lambda: get_all_analyses(test_db))
    monkeypatch.setattr("api.main.get_analysis_by_id", lambda aid: get_analysis_by_id(aid, test_db))

    client = TestClient(app)
    return client, test_db


def test_github_test_connection(test_setup):
    client, _ = test_setup

    # 1. No token or repo
    res = client.post("/api/github/test-connection", json={})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False

    # 2. Mocked successful connection
    with patch(
        "api.main.GitHubSyncClient.test_connection", return_value=(True, "Connected to owner/repo")
    ):
        res = client.post(
            "/api/github/test-connection",
            json={
                "token": "ghp_12345",
                "repo": "user/chess-games",
                "branch": "main",
            },
        )
        assert res.status_code == 200
        assert res.json() == {"ok": True, "message": "Connected to owner/repo"}


def test_github_sync_single_game(test_setup, monkeypatch):
    client, test_db = test_setup

    # Create an analysis record
    pgn = '[Date "2026.10.25"]\n[UTCTime "09:30:00"]\n[White "tuxitop"]\n[Black "keswic"]\n[Result "1-0"]\n[TimeControl "180+2"]\n\n1. e4 e5 1-0'
    payload = GameAnalysisPayload(
        white_player="tuxitop",
        black_player="keswic",
        user_color="White",
        result="1-0",
        time_control="180+2",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
    )
    analysis_id = save_analysis(
        pgn_text=pgn,
        payload=payload,
        report_md="## Game Coaching Analysis\nGreat play!",
        model_name="test-model",
        platform="chesscom",
        db_path=test_db,
    )

    # 1. Without github settings -> 400
    res = client.post(f"/api/github/sync/{analysis_id}")
    assert res.status_code == 400
    assert "GitHub token and repository must be configured" in res.json()["detail"]

    # 2. Configure github settings
    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_test_token",
            "github_repo": "tuxitop/chess-sync",
            "github_branch": "main",
        },
    )

    # 3. Non-existent game -> 404
    res = client.post("/api/github/sync/99999")
    assert res.status_code == 404

    # 4. Successful sync
    with patch("api.main.GitHubSyncClient.sync_game", return_value="abc123commitsha") as mock_sync:
        res = client.post(f"/api/github/sync/{analysis_id}")
        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is True
        assert body["commit_sha"] == "abc123commitsha"
        assert "chess.com/blitz/2026-10/25-0930-tuxitop-keswic-white" in body["folder_path"]
        mock_sync.assert_called_once()
        call_files = mock_sync.call_args.kwargs["files"]
        assert "Great play!" in call_files["report.md"]
        assert len(call_files["game.pgn"]) > 0
        assert len(call_files["report.pdf"]) > 0

        # Verify DB was updated with github_path
        updated = get_analysis_by_id(analysis_id, db_path=test_db)
        assert updated["github_path"] == body["folder_path"]


def test_github_sync_all(test_setup):
    client, test_db = test_setup

    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_test_token",
            "github_repo": "tuxitop/chess-sync",
            "github_branch": "main",
        },
    )

    # Save two games
    for i in range(2):
        pgn = f'[Date "2026.10.2{i}"]\n[UTCTime "14:00:00"]\n[White "player{i}"]\n[Black "opp{i}"]\n[Result "1-0"]\n\n1. e4 e5 1-0'
        payload = GameAnalysisPayload(
            white_player=f"player{i}",
            black_player=f"opp{i}",
            user_color="White",
            result="1-0",
            time_control="300",
            pgn_moves_summary="1. e4 e5",
            total_plies=2,
            critical_moments=[],
        )
        save_analysis(
            pgn_text=pgn,
            payload=payload,
            report_md="## Coaching Report",
            model_name="test-model",
            platform="lichess",
            db_path=test_db,
        )

    with patch("api.main.GitHubSyncClient.sync_game", return_value="commit_sha_all") as mock_sync:
        res = client.post("/api/github/sync-all")
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["synced_count"] == 2
        assert mock_sync.call_count == 2
        for call_item in mock_sync.call_args_list:
            files_arg = call_item.kwargs.get("files")
            assert files_arg is not None
            assert files_arg["report.md"].strip().startswith("## Coaching Report")
            assert len(files_arg["report.md"]) > 0
            assert len(files_arg["game.pgn"]) > 0
            assert len(files_arg["report.pdf"]) > 0


def test_api_delete_game_removes_from_github(test_setup):
    client, test_db = test_setup

    # Save an analysis with github_path
    pgn = '[Date "2026.10.25"]\n[UTCTime "09:30:00"]\n[White "player"]\n[Black "opp"]\n[Result "1-0"]\n\n1. e4 e5 1-0'
    payload = GameAnalysisPayload(
        white_player="player",
        black_player="opp",
        user_color="White",
        result="1-0",
        time_control="180",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
    )
    analysis_id = save_analysis(
        pgn_text=pgn,
        payload=payload,
        report_md="## Report",
        model_name="test-model",
        platform="chesscom",
        github_path="chess.com/blitz/2026-10/25-0930-player-opp-white",
        db_path=test_db,
    )

    # 1. Delete without github enabled: delete_game is not called
    with patch("api.main.GitHubSyncClient.delete_game") as mock_del:
        res = client.delete(f"/api/games/{analysis_id}")
        assert res.status_code == 200
        mock_del.assert_not_called()

    # Save another game
    analysis_id_2 = save_analysis(
        pgn_text=pgn,
        payload=payload,
        report_md="## Report 2",
        model_name="test-model",
        platform="chesscom",
        github_path="chess.com/blitz/2026-10/25-0930-player-opp-white-2",
        db_path=test_db,
    )

    # Enable github
    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_test_token",
            "github_repo": "tuxitop/chess-sync",
        },
    )

    # 2. Delete with github enabled: delete_game is called
    with patch("api.main.GitHubSyncClient.delete_game", return_value=True) as mock_del:
        res = client.delete(f"/api/games/{analysis_id_2}")
        assert res.status_code == 200
        mock_del.assert_called_once_with(
            folder_path="chess.com/blitz/2026-10/25-0930-player-opp-white-2",
            commit_message="Delete analysis: player vs opp (chess.com/blitz/2026-10/25-0930-player-opp-white-2)",
        )


@pytest.mark.anyio
async def test_run_analysis_job_auto_syncs_to_github(test_setup):
    client, test_db = test_setup
    import uuid

    from api.main import _jobs, _run_analysis_job

    # Configure github enabled
    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_auto_token",
            "github_repo": "owner/repo",
            "github_branch": "main",
        },
    )

    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "running", "events": [], "analysis_id": None}

    pgn = '[Date "2026.10.25"]\n[White "player"]\n[Black "opp"]\n[Result "1-0"]\n\n1. e4 e5 1-0'

    with (
        patch("api.main.analyze_pgn") as mock_an,
        patch("api.main.generate_narrative_report", return_value="## Analysis\nWell done!"),
        patch("api.main.GitHubSyncClient.sync_game", return_value="auto_commit_sha") as mock_sync,
    ):
        mock_an.return_value = GameAnalysisPayload(
            white_player="player",
            black_player="opp",
            user_color="White",
            result="1-0",
            time_control="300",
            pgn_moves_summary="1. e4 e5",
            total_plies=2,
            critical_moments=[],
        )

        await _run_analysis_job(
            job_id=job_id,
            pgn=pgn,
            side="white",
            platform="lichess",
            existing_id=None,
            pending_game_id=None,
        )

        assert _jobs[job_id]["status"] == "done"
        analysis_id = _jobs[job_id]["analysis_id"]
        assert analysis_id is not None
        mock_sync.assert_called_once()
        saved = get_analysis_by_id(analysis_id, db_path=test_db)
        assert saved["github_path"] is not None
        assert "lichess" in saved["github_path"]
        assert saved["github_synced_hash"] is not None


def test_github_sync_single_game_skips_unchanged_and_force(test_setup):
    client, test_db = test_setup

    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_test_token",
            "github_repo": "tuxitop/chess-sync",
            "github_branch": "main",
        },
    )

    pgn = '[Date "2026.10.25"]\n[White "player"]\n[Black "opp"]\n[Result "1-0"]\n\n1. e4 e5 1-0'
    payload = GameAnalysisPayload(
        white_player="player",
        black_player="opp",
        user_color="White",
        result="1-0",
        time_control="180",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
    )
    analysis_id = save_analysis(
        pgn_text=pgn,
        payload=payload,
        report_md="## Original Report",
        model_name="test-model",
        platform="chesscom",
        db_path=test_db,
    )

    # 1. First sync calls GitHub
    with patch("api.main.GitHubSyncClient.sync_game", return_value="sha1") as mock_sync:
        res = client.post(f"/api/github/sync/{analysis_id}")
        assert res.status_code == 200
        assert res.json()["ok"] is True
        assert res.json().get("already_synced") is not True
        assert mock_sync.call_count == 1

    # 2. Second sync with identical content: should skip without calling GitHub
    with patch("api.main.GitHubSyncClient.sync_game", return_value="sha2") as mock_sync:
        res = client.post(f"/api/github/sync/{analysis_id}")
        assert res.status_code == 200
        assert res.json()["ok"] is True
        assert res.json()["already_synced"] is True
        mock_sync.assert_not_called()

    # 3. Third sync with force=true: should push even if unchanged
    with patch("api.main.GitHubSyncClient.sync_game", return_value="sha3") as mock_sync:
        res = client.post(f"/api/github/sync/{analysis_id}?force=true")
        assert res.status_code == 200
        assert res.json()["ok"] is True
        assert res.json().get("already_synced") is not True
        mock_sync.assert_called_once()


def test_github_sync_all_smart_skips_unchanged_and_syncs_modified(test_setup):
    client, test_db = test_setup

    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_test_token",
            "github_repo": "tuxitop/chess-sync",
            "github_branch": "main",
        },
    )

    payload = GameAnalysisPayload(
        white_player="p1",
        black_player="p2",
        user_color="White",
        result="1-0",
        time_control="300",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
    )
    id1 = save_analysis("1. e4 e5 1-0", payload, "Report 1", "test-model", db_path=test_db)
    save_analysis("1. d4 d5 1-0", payload, "Report 2", "test-model", db_path=test_db)

    # 1. Initial sync-all: syncs both games
    with patch("api.main.GitHubSyncClient.sync_game", return_value="sha_all_1") as mock_sync:
        res = client.post("/api/github/sync-all")
        assert res.status_code == 200
        data = res.json()
        assert data["synced_count"] == 2
        assert data["skipped_count"] == 0
        assert mock_sync.call_count == 2

    # 2. Immediate second sync-all: skips both games (0 calls to GitHub!)
    with patch("api.main.GitHubSyncClient.sync_game", return_value="sha_all_2") as mock_sync:
        res = client.post("/api/github/sync-all")
        assert res.status_code == 200
        data = res.json()
        assert data["synced_count"] == 0
        assert data["skipped_count"] == 2
        mock_sync.assert_not_called()

    # 3. Update report for id1
    update_analysis_report(id1, "Report 1 Modified", "new-model", db_path=test_db)

    # 4. Third sync-all: only id1 is synced, id2 is skipped
    with patch("api.main.GitHubSyncClient.sync_game", return_value="sha_all_3") as mock_sync:
        res = client.post("/api/github/sync-all")
        assert res.status_code == 200
        data = res.json()
        assert data["synced_count"] == 1
        assert data["skipped_count"] == 1
        assert mock_sync.call_count == 1

    # 5. Force sync-all: both are synced
    with patch("api.main.GitHubSyncClient.sync_game", return_value="sha_all_4") as mock_sync:
        res = client.post("/api/github/sync-all?force=true")
        assert res.status_code == 200
        data = res.json()
        assert data["synced_count"] == 2
        assert data["skipped_count"] == 0
        assert mock_sync.call_count == 2


def test_enrich_github_sync_status(test_setup):
    client, test_db = test_setup

    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_test_token",
            "github_repo": "tuxitop/chess-sync",
            "github_branch": "main",
        },
    )

    payload = GameAnalysisPayload(
        white_player="p1",
        black_player="p2",
        user_color="White",
        result="1-0",
        time_control="300",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
    )
    aid = save_analysis("1. e4 e5 1-0", payload, "Report", "test-model", db_path=test_db)

    # Initially: not_synced
    res = client.get("/api/games")
    games = res.json()["games"]
    g = next(item for item in games if item["id"] == aid)
    assert g["github_sync_status"] == "not_synced"

    # After sync: synced
    with patch("api.main.GitHubSyncClient.sync_game", return_value="sha"):
        client.post(f"/api/github/sync/{aid}")

    res = client.get("/api/games")
    games = res.json()["games"]
    g = next(item for item in games if item["id"] == aid)
    assert g["github_sync_status"] == "synced"

    # Detail endpoint also reports status
    detail = client.get(f"/api/analysis/{aid}").json()
    assert detail["github_sync_status"] == "synced"

    # Modify report: modified
    update_analysis_report(aid, "Updated Report Content", "test-model", db_path=test_db)
    res = client.get("/api/games")
    games = res.json()["games"]
    g = next(item for item in games if item["id"] == aid)
    assert g["github_sync_status"] == "modified"
