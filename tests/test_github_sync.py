from __future__ import annotations

import json

import httpx

from src.github_sync import (
    GitHubSyncClient,
    build_game_repo_files,
    format_game_folder_path,
)


def test_format_game_folder_path_standard():
    # User's example: chess.com/blitz/2026-10/25-0930-tuxitop-keswic-white
    path = format_game_folder_path(
        platform="chesscom",
        time_control="180+2",
        played_at="2026-10-25 09:30:15",
        date_str="2026.10.25",
        white_player="tuxitop",
        black_player="keswic",
        result="1-0",
    )
    assert path == "chess.com/blitz/2026-10/25-0930-tuxitop-keswic-white"


def test_format_game_folder_path_lichess_rapid_draw():
    path = format_game_folder_path(
        platform="lichess",
        time_control="600+0",
        played_at="2026-09-04 14:15:00",
        date_str="2026.09.04",
        white_player="Dr. Nykterstein",
        black_player="Magnus Carlsen",
        result="1/2-1/2",
    )
    assert path == "lichess.org/rapid/2026-09/04-1415-dr_nykterstein-magnus_carlsen-draw"


def test_format_game_folder_path_black_win_no_time():
    path = format_game_folder_path(
        platform="chess.com",
        time_control="60",
        played_at=None,
        date_str="2026-05-09",
        white_player="Alice",
        black_player="Bob",
        result="0-1",
    )
    assert path == "chess.com/bullet/2026-05/09-0000-alice-bob-black"


def test_build_game_repo_files():
    report_md = """# Analysis Report

:::board{fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" caption="Move 1: e4"}:::

Some coach narrative here.
"""
    pgn_text = """[Event "Casual Game"]
[Site "Chess.com"]
1. e4 e5 *"""

    files = build_game_repo_files(report_md=report_md, pgn_text=pgn_text)

    # Must contain report.md, game.pgn, report.pdf, and diagram svg
    assert "report.md" in files
    assert "game.pgn" in files
    assert "report.pdf" in files
    assert "assets/diagram_1.svg" in files

    # Verify report.md links to the svg in assets
    assert "./assets/diagram_1.svg" in files["report.md"]
    assert ":::board" not in files["report.md"]

    # Verify game.pgn content
    assert "1. e4 e5" in files["game.pgn"]

    # Verify report.pdf is bytes (PDF magic bytes %PDF)
    assert isinstance(files["report.pdf"], bytes)
    assert files["report.pdf"].startswith(b"%PDF")


def test_github_client_test_connection():
    # 1. Missing credentials
    c1 = GitHubSyncClient(token="", repo="user/repo")
    ok, msg = c1.test_connection()
    assert not ok
    assert "Token is required" in msg

    c2 = GitHubSyncClient(token="ghp_123", repo="invalidrepo")
    ok, msg = c2.test_connection()
    assert not ok
    assert "owner/repo" in msg

    # 2. Mock success
    def success_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"permissions": {"push": True}, "default_branch": "main"})

    client_mock = httpx.Client(transport=httpx.MockTransport(success_handler))
    c3 = GitHubSyncClient(token="ghp_123", repo="alice/my-chess", client=client_mock)
    ok, msg = c3.test_connection()
    assert ok
    assert "Connected to 'alice/my-chess'" in msg

    # 3. Mock 401 unauthorized
    def unauth_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "Bad credentials"})

    client_unauth = httpx.Client(transport=httpx.MockTransport(unauth_handler))
    c4 = GitHubSyncClient(token="ghp_bad", repo="alice/my-chess", client=client_unauth)
    ok, msg = c4.test_connection()
    assert not ok
    assert "Invalid GitHub token" in msg


def test_github_client_sync_game_flow():
    called_endpoints = []

    def sync_handler(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        method = request.method
        called_endpoints.append((method, url_str))

        if method == "GET" and url_str.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "commit_sha_1"}})
        elif method == "GET" and url_str.endswith("/git/commits/commit_sha_1"):
            return httpx.Response(200, json={"tree": {"sha": "base_tree_sha_1"}})
        elif method == "POST" and url_str.endswith("/git/blobs"):
            return httpx.Response(201, json={"sha": "blob_sha_xyz"})
        elif method == "POST" and url_str.endswith("/git/trees"):
            return httpx.Response(201, json={"sha": "new_tree_sha_2"})
        elif method == "POST" and url_str.endswith("/git/commits"):
            return httpx.Response(201, json={"sha": "new_commit_sha_3"})
        elif method == "PATCH" and url_str.endswith("/git/refs/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "new_commit_sha_3"}})
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(sync_handler))
    gh = GitHubSyncClient(token="ghp_test", repo="alice/chess", branch="main", client=client)

    files = {
        "report.md": "# Analysis",
        "game.pgn": "1. e4 e5 *",
    }
    commit_sha = gh.sync_game(folder_path="chess.com/blitz/2026-10/25-0930-a-b-white", files=files)
    assert commit_sha == "new_commit_sha_3"

    # Verify all Git Data API endpoints were reached
    methods = [m for m, u in called_endpoints]
    assert "GET" in methods
    assert "POST" in methods
    assert "PATCH" in methods


def test_github_client_delete_game_flow():
    tree_items = [
        {
            "path": "chess.com/blitz/2026-10/25-0930-a-b-white/report.md",
            "mode": "100644",
            "type": "blob",
            "sha": "111",
        },
        {
            "path": "chess.com/blitz/2026-10/25-0930-a-b-white/game.pgn",
            "mode": "100644",
            "type": "blob",
            "sha": "222",
        },
        {
            "path": "chess.com/blitz/2026-10/26-1100-c-d-black/report.md",
            "mode": "100644",
            "type": "blob",
            "sha": "333",
        },
    ]

    posted_trees = []

    def del_handler(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        method = request.method
        if method == "GET" and url_str.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "latest_commit_sha"}})
        elif method == "GET" and "recursive=1" in url_str:
            return httpx.Response(200, json={"tree": tree_items})
        elif method == "POST" and url_str.endswith("/git/trees"):
            posted_trees.append(request.read())
            return httpx.Response(201, json={"sha": "deleted_tree_sha"})
        elif method == "POST" and url_str.endswith("/git/commits"):
            return httpx.Response(201, json={"sha": "del_commit_sha"})
        elif method == "PATCH" and url_str.endswith("/git/refs/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "del_commit_sha"}})
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(del_handler))
    gh = GitHubSyncClient(token="ghp_test", repo="alice/chess", branch="main", client=client)

    ok = gh.delete_game("chess.com/blitz/2026-10/25-0930-a-b-white")
    assert ok is True
    assert len(posted_trees) == 1
    new_tree = json.loads(posted_trees[0].decode("utf-8"))
    # Only the game for 26-1100 should remain in the tree!
    assert len(new_tree["tree"]) == 1
    assert "26-1100" in new_tree["tree"][0]["path"]


def test_build_game_repo_files_with_payload():
    report_md = "# Report"
    pgn_text = "1. e4 e5"
    payload_json = '{"total_plies": 2, "critical_moments": []}'

    files = build_game_repo_files(report_md=report_md, pgn_text=pgn_text, payload_json=payload_json)
    assert "payload.json" in files
    assert files["payload.json"].strip() == payload_json


def test_github_client_sync_game_retry_on_422():
    patch_attempt = 0

    def sync_handler(request: httpx.Request) -> httpx.Response:
        nonlocal patch_attempt
        url_str = str(request.url)
        method = request.method

        if method == "GET" and url_str.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": f"commit_sha_{patch_attempt}"}})
        elif method == "GET" and "/git/commits/" in url_str:
            return httpx.Response(200, json={"tree": {"sha": "base_tree_sha"}})
        elif method == "POST" and url_str.endswith("/git/blobs"):
            return httpx.Response(201, json={"sha": "blob_sha_xyz"})
        elif method == "POST" and url_str.endswith("/git/trees"):
            return httpx.Response(201, json={"sha": "new_tree_sha"})
        elif method == "POST" and url_str.endswith("/git/commits"):
            return httpx.Response(201, json={"sha": f"new_commit_sha_{patch_attempt}"})
        elif method == "PATCH" and url_str.endswith("/git/refs/heads/main"):
            patch_attempt += 1
            if patch_attempt == 1:
                # First attempt fails with 422 non-fast-forward conflict
                return httpx.Response(
                    422, json={"message": "Reference cannot be updated", "status": "422"}
                )
            # Second attempt succeeds
            return httpx.Response(200, json={"object": {"sha": "new_commit_sha_retry_success"}})
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(sync_handler))
    gh = GitHubSyncClient(token="ghp_test", repo="alice/chess", branch="main", client=client)

    files = {"report.md": "# Analysis", "game.pgn": "1. e4 e5 *"}
    commit_sha = gh.sync_game(folder_path="chess.com/blitz/2026-10/25-0930-a-b-white", files=files)
    assert commit_sha == "new_commit_sha_1"
    assert patch_attempt == 2


def test_github_client_get_blob_text():
    import base64

    raw_text = "# Sample Chess Report\nMove 1: e4"
    b64_content = base64.b64encode(raw_text.encode("utf-8")).decode("ascii")

    def blob_handler(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        if request.method == "GET" and url_str.endswith("/git/blobs/blob_123"):
            return httpx.Response(200, json={"content": b64_content, "encoding": "base64"})
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(blob_handler))
    gh = GitHubSyncClient(token="ghp_test", repo="alice/chess", branch="main", client=client)

    text = gh.get_blob_text("blob_123")
    assert text == raw_text


def test_github_client_list_remote_games_summary():
    tree_items = [
        {
            "path": "chess.com/blitz/2026-10/25-0930-a-b-white/report.md",
            "mode": "100644",
            "type": "blob",
            "sha": "sha_report_1",
        },
        {
            "path": "chess.com/blitz/2026-10/25-0930-a-b-white/game.pgn",
            "mode": "100644",
            "type": "blob",
            "sha": "sha_pgn_1",
        },
        {
            "path": "chess.com/blitz/2026-10/25-0930-a-b-white/payload.json",
            "mode": "100644",
            "type": "blob",
            "sha": "sha_payload_1",
        },
        {
            "path": "chess.com/blitz/2026-10/25-0930-a-b-white/assets/diagram_1.svg",
            "mode": "100644",
            "type": "blob",
            "sha": "sha_svg_1",
        },
        {
            "path": "lichess.org/rapid/2026-09/04-1415-c-d-draw/report.md",
            "mode": "100644",
            "type": "blob",
            "sha": "sha_report_2",
        },
        {
            "path": "lichess.org/rapid/2026-09/04-1415-c-d-draw/game.pgn",
            "mode": "100644",
            "type": "blob",
            "sha": "sha_pgn_2",
        },
    ]

    def tree_handler(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        if request.method == "GET" and url_str.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "commit_123"}})
        elif request.method == "GET" and "recursive=1" in url_str:
            return httpx.Response(200, json={"tree": tree_items})
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(tree_handler))
    gh = GitHubSyncClient(token="ghp_test", repo="alice/chess", branch="main", client=client)

    summaries = gh.list_remote_games_summary()
    assert len(summaries) == 2

    by_folder = {item["folder"]: item for item in summaries}

    folder1 = "chess.com/blitz/2026-10/25-0930-a-b-white"
    assert folder1 in by_folder
    assert by_folder[folder1]["report_blob_sha"] == "sha_report_1"
    assert by_folder[folder1]["pgn_blob_sha"] == "sha_pgn_1"
    assert by_folder[folder1]["payload_blob_sha"] == "sha_payload_1"

    folder2 = "lichess.org/rapid/2026-09/04-1415-c-d-draw"
    assert folder2 in by_folder
    assert by_folder[folder2]["report_blob_sha"] == "sha_report_2"
    assert by_folder[folder2]["pgn_blob_sha"] == "sha_pgn_2"
    assert by_folder[folder2]["payload_blob_sha"] is None
