from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from api.main import app
from src.github_sync import GitHubSyncClient
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
        assert "payload.json" in mock_sync.call_args.kwargs["files"]
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


def test_github_pull_endpoint(test_setup):
    client, test_db = test_setup

    from api.games_db import find_pending_game, save_pending_game
    from src.github_sync import GitHubSyncClient
    from src.storage import find_analysis_by_github_path

    # 1. Missing settings -> 400
    res = client.post("/api/github/pull")
    assert res.status_code == 400
    assert "GitHub token and repository must be configured" in res.json()["detail"]

    # 2. Configure GitHub settings
    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_pull_test",
            "github_repo": "alice/chess-repo",
            "github_branch": "main",
        },
    )

    # 3. Remote has no analyses
    with patch.object(GitHubSyncClient, "list_remote_games_summary", return_value=[]):
        res = client.post("/api/github/pull")
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["imported_count"] == 0
        assert data["total_remote"] == 0

    # 4. Remote has an analyzed game that is also currently sitting in pending_games
    pgn_text = (
        '[Event "Live Chess"]\n'
        '[Site "Chess.com"]\n'
        '[Date "2026.10.25"]\n'
        '[White "Alice"]\n'
        '[Black "Bob"]\n'
        '[Result "1-0"]\n\n'
        "1. e4 e5 1-0"
    )
    save_pending_game(
        pgn_text=pgn_text,
        platform="chesscom",
        white="Alice",
        black="Bob",
        result="1-0",
        db_path=test_db,
    )
    assert find_pending_game(pgn_text=pgn_text, db_path=test_db) is not None

    folder_path = "chess.com/blitz/2026-10/25-0930-alice-bob-white"
    payload_obj = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="1-0",
        time_control="180+2",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
    )
    remote_games = [
        {
            "folder": folder_path,
            "report_blob_sha": "rep_sha_1",
            "pgn_blob_sha": "pgn_sha_1",
            "payload_blob_sha": "pay_sha_1",
        }
    ]

    def fake_get_blob_text(sha: str) -> str:
        if sha == "rep_sha_1":
            return "## Remote Analysis Report\nStrong opening play."
        elif sha == "pgn_sha_1":
            return pgn_text
        elif sha == "pay_sha_1":
            return payload_obj.model_dump_json()
        return ""

    with (
        patch.object(GitHubSyncClient, "list_remote_games_summary", return_value=remote_games),
        patch.object(GitHubSyncClient, "get_blob_text", side_effect=fake_get_blob_text),
    ):
        # Pull from remote
        res = client.post("/api/github/pull")
        assert res.status_code == 200
        pull_data = res.json()
        assert pull_data["ok"] is True
        assert pull_data["imported_count"] == 1
        assert pull_data["purged_pending_count"] == 1

        # Assert pending game was purged
        assert find_pending_game(pgn_text=pgn_text, db_path=test_db) is None

        # Assert game was imported into game_analyses
        imported_rec = find_analysis_by_github_path(folder_path, db_path=test_db)
        assert imported_rec is not None
        assert imported_rec["white_player"] == "Alice"
        assert imported_rec["github_path"] == folder_path

        # 5. Immediate second pull -> skips because already synced locally
        res2 = client.post("/api/github/pull")
        assert res2.status_code == 200
        data2 = res2.json()
        assert data2["imported_count"] == 0
        assert data2["skipped_count"] == 1

        # 6. Force pull -> updates existing game
        res3 = client.post("/api/github/pull?force=true")
        assert res3.status_code == 200
        data3 = res3.json()
        assert data3["updated_count"] == 1


def test_github_pull_without_payload_json(test_setup):
    client, test_db = test_setup

    from src.github_sync import GitHubSyncClient
    from src.storage import find_analysis_by_github_path

    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_pull_test",
            "github_repo": "alice/chess-repo",
            "github_branch": "main",
        },
    )

    folder_path = "lichess.org/rapid/2026-09/04-1415-charlie-dana-draw"
    pgn_text = (
        '[Event "Rated Rapid game"]\n'
        '[Site "https://lichess.org/abcd1234"]\n'
        '[Date "2026.09.04"]\n'
        '[White "Charlie"]\n'
        '[Black "Dana"]\n'
        '[Result "1/2-1/2"]\n'
        '[TimeControl "600+0"]\n'
        '[Opening "Sicilian Defense"]\n\n'
        "1. e4 c5 1/2-1/2"
    )

    remote_games = [
        {
            "folder": folder_path,
            "report_blob_sha": "rep_sha_2",
            "pgn_blob_sha": "pgn_sha_2",
            "payload_blob_sha": None,
        }
    ]

    def fake_get_blob_text(sha: str) -> str:
        if sha == "rep_sha_2":
            return "# Coach Analysis Report for Charlie vs Dana"
        elif sha == "pgn_sha_2":
            return pgn_text
        return ""

    with (
        patch.object(GitHubSyncClient, "list_remote_games_summary", return_value=remote_games),
        patch.object(GitHubSyncClient, "get_blob_text", side_effect=fake_get_blob_text),
    ):
        res = client.post("/api/github/pull")
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["imported_count"] == 1

        rec = find_analysis_by_github_path(folder_path, db_path=test_db)
        assert rec is not None
        assert rec["white_player"] == "Charlie"
        assert rec["black_player"] == "Dana"
        assert rec["result"] == "1/2-1/2"
        assert rec["time_control"] == "600+0"
        assert rec["opening_name"] == "Sicilian Defense"

        # Verify evaluations were reconstructed so charts are never lost
        rec_detail = get_analysis_by_id(rec["id"], db_path=test_db)
        assert rec_detail is not None
        assert rec_detail["ply_evals"] is not None
        assert len(rec_detail["ply_evals"]) >= 2


def test_github_pull_restores_missing_evals_on_existing_game(test_setup):
    client, test_db = test_setup

    from src.github_sync import GitHubSyncClient

    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_pull_test",
            "github_repo": "alice/chess-repo",
            "github_branch": "main",
        },
    )

    folder_path = "chess.com/blitz/2026-10/25-0930-alice-bob-white"
    pgn_text = (
        '[Event "Live Chess"]\n'
        '[Site "Chess.com"]\n'
        '[Date "2026.10.25"]\n'
        '[White "Alice"]\n'
        '[Black "Bob"]\n'
        '[Result "1-0"]\n\n'
        "1. e4 e5 1-0"
    )

    # 1. Existing local game that has NO ply_evals (simulating older pull or missing payload)
    old_payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="1-0",
        time_control="180+2",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
        ply_evals=None,
    )
    aid = save_analysis(
        pgn_text=pgn_text,
        payload=old_payload,
        report_md="## Initial Incomplete Report",
        model_name="old",
        github_path=folder_path,
        github_synced_hash="old_incomplete_hash",
        db_path=test_db,
    )

    # Remote now has full payload.json containing dense ply_evals
    remote_payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="1-0",
        time_control="180+2",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
        ply_evals=[20, 45, 60],
        tags=["kingside_attack"],
    )

    remote_games = [
        {
            "folder": folder_path,
            "report_blob_sha": "rep_sha_full",
            "pgn_blob_sha": "pgn_sha_full",
            "payload_blob_sha": "pay_sha_full",
        }
    ]

    def fake_get_blob_text(sha: str) -> str:
        if sha == "rep_sha_full":
            return "## Full Analysis Report with Dense Evals"
        elif sha == "pgn_sha_full":
            return pgn_text
        elif sha == "pay_sha_full":
            return remote_payload.model_dump_json()
        return ""

    with (
        patch.object(GitHubSyncClient, "list_remote_games_summary", return_value=remote_games),
        patch.object(GitHubSyncClient, "get_blob_text", side_effect=fake_get_blob_text),
    ):
        # Pull without force=True!
        res = client.post("/api/github/pull")
        assert res.status_code == 200
        pull_data = res.json()
        assert pull_data["ok"] is True
        assert pull_data["updated_count"] == 1

        # Assert local game was updated and now has ply_evals and tags
        updated_rec = get_analysis_by_id(aid, db_path=test_db)
        assert updated_rec is not None
        assert updated_rec["ply_evals"] == [20, 45, 60]
        assert updated_rec["tags"] == ["kingside_attack"]
        assert updated_rec["report_md"] == "## Full Analysis Report with Dense Evals"

        # Assert /api/games returns the restored evaluations for chart display
        games_res = client.get("/api/games")
        assert games_res.status_code == 200
        games = games_res.json()["games"]
        matching = next(g for g in games if g["id"] == aid)
        assert matching["ply_evals"] == [20, 45, 60]


def test_github_pull_extracts_tags_from_report_md(test_setup):
    import json

    client, test_db = test_setup

    from src.github_sync import GitHubSyncClient
    from src.storage import find_analysis_by_github_path

    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_pull_test",
            "github_repo": "alice/chess-repo",
            "github_branch": "main",
        },
    )

    folder_path = "chess.com/blitz/2026-10/25-1030-alice-bob-white"
    pgn_text = (
        '[Event "Live Chess"]\n'
        '[Site "Chess.com"]\n'
        '[Date "2026.10.25"]\n'
        '[White "Alice"]\n'
        '[Black "Bob"]\n'
        '[Result "1-0"]\n\n'
        "1. e4 e5 1-0"
    )

    report_md_with_tags = (
        "## Analysis Report\n\n"
        "### Section 7: Key Coaching Themes & Tactical Patterns\n"
        "- tactic:pin - Pinning the knight on f6\n"
        "- tactic:fork - Queen fork on c7\n"
        "- strategy:outpost - Outpost on d5\n"
    )

    # Remote payload has empty tags (older schema or missing tags in payload.json)
    remote_payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="1-0",
        time_control="180+2",
        pgn_moves_summary="1. e4 e5",
        total_plies=2,
        critical_moments=[],
        ply_evals=[20, 50],
        tags=[],
    )

    remote_games = [
        {
            "folder": folder_path,
            "report_blob_sha": "rep_sha_tags",
            "pgn_blob_sha": "pgn_sha_tags",
            "payload_blob_sha": "pay_sha_tags",
        }
    ]

    def fake_get_blob_text(sha: str) -> str:
        if sha == "rep_sha_tags":
            return report_md_with_tags
        elif sha == "pgn_sha_tags":
            return pgn_text
        elif sha == "pay_sha_tags":
            return remote_payload.model_dump_json()
        return ""

    with (
        patch.object(GitHubSyncClient, "list_remote_games_summary", return_value=remote_games),
        patch.object(GitHubSyncClient, "get_blob_text", side_effect=fake_get_blob_text),
    ):
        res = client.post("/api/github/pull")
        assert res.status_code == 200
        pull_data = res.json()
        assert pull_data["ok"] is True
        assert pull_data["imported_count"] == 1

        rec = find_analysis_by_github_path(folder_path, db_path=test_db)
        assert rec is not None
        assert rec["tags"] is not None
        tags_list = json.loads(rec["tags"]) if isinstance(rec["tags"], str) else rec["tags"]
        assert "tactic:found-pin" in tags_list
        assert "tactic:found-fork" in tags_list

        # Immediate second pull should skip cleanly
        res2 = client.post("/api/github/pull")
        assert res2.status_code == 200
        assert res2.json()["skipped_count"] == 1


def test_api_github_smart_pull(test_setup):
    client, _ = test_setup

    # 1. When GitHub sync is disabled
    client.put("/api/settings", json={"github_enabled": False})
    res = client.post("/api/github/smart-pull")
    assert res.status_code == 200
    assert res.json()["status"] == "disabled"

    # 2. When enabled but no token/repo
    client.put(
        "/api/settings",
        json={"github_enabled": True, "github_token": "", "github_repo": ""},
    )
    res = client.post("/api/github/smart-pull")
    assert res.status_code == 200
    assert res.json()["status"] == "disabled"

    # 3. Enabled and configured, remote SHA matches local SHA -> up_to_date
    client.put(
        "/api/settings",
        json={
            "github_enabled": True,
            "github_token": "ghp_valid",
            "github_repo": "user/chess-games",
            "github_branch": "main",
            "github_last_synced_sha": "sha_111",
        },
    )
    with patch.object(
        GitHubSyncClient, "get_latest_commit_sha", return_value="sha_111"
    ) as mock_sha:
        res = client.post("/api/github/smart-pull")
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["status"] == "up_to_date"
        assert data["remote_sha"] == "sha_111"
        mock_sha.assert_called_once()

    # 4. Remote SHA differs -> pulls and updates github_last_synced_sha
    remote_games = [
        {
            "folder": "chess.com/blitz/2026-10/25-0930-a-b-white",
            "report_blob_sha": "sha_rep",
            "pgn_blob_sha": "sha_pgn",
            "payload_blob_sha": None,
        }
    ]

    def fake_get_blob(sha: str) -> str:
        if sha == "sha_rep":
            return "# Coach Report"
        if sha == "sha_pgn":
            return "1. e4 e5 1-0"
        return ""

    with (
        patch.object(GitHubSyncClient, "get_latest_commit_sha", return_value="sha_222_new"),
        patch.object(GitHubSyncClient, "list_remote_games_summary", return_value=remote_games),
        patch.object(GitHubSyncClient, "get_blob_text", side_effect=fake_get_blob),
    ):
        res = client.post("/api/github/smart-pull")
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["status"] == "pulled"
        assert data["imported_count"] == 1
        assert data["remote_sha"] == "sha_222_new"

    # Verify settings was updated with new SHA
    st_res = client.get("/api/settings")
    assert st_res.json()["github_last_synced_sha"] == "sha_222_new"
