"""
FastAPI application — REST + SSE backend for the PlyProse UI.
"""

from __future__ import annotations

import asyncio
import datetime
import io
import json
import logging
import os
import re
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import chess.pgn
import markdown as _md
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from api.board_renderer import (
    build_markdown_zip,
    reconcile_report_fens,
    replace_board_tags_with_html,
)
from api.games_db import (
    delete_pending_game,
    delete_pending_game_by_external_id_or_pgn,
    find_pending_game,
    get_pending_games,
    save_pending_game,
    update_pending_game_platform,
)
from api.ratings import get_detected_ratings
from api.settings_db import get_settings, update_settings
from api.time_control import classify_time_control
from src.analyzer import analyze_pgn
from src.evals import extract_ply_evals_from_pgn, interpolate_ply_evals
from src.exporter import export_to_pdf
from src.fetcher import (
    FetchError,
    RateLimitError,
    UserNotFoundError,
    extract_game_url,
    extract_played_at,
    fetch_chesscom_games,
    fetch_lichess_games,
    parse_raw_pgn_metadata,
)
from src.github_sync import (
    GitHubSyncClient,
    build_game_repo_files,
    format_game_folder_path,
)
from src.llm import (
    PROVIDER_GEMINI,
    ask_move_question,
    generate_deterministic_summary,
    generate_narrative_report,
    model_label,
)
from src.models import (
    AppendQARequest,
    AppendQAResponse,
    AskMoveRequest,
    AskMoveResponse,
    GameAnalysisPayload,
    GitHubPullResult,
)
from src.openai_agent import list_openai_compat_models, probe_openai_compat_connection
from src.storage import (
    compute_analysis_hash,
    delete_analysis,
    find_analysis,
    find_analysis_by_github_path,
    get_all_analyses,
    get_analysis_by_id,
    save_analysis,
    update_analysis_github_sync,
    update_analysis_payload,
    update_analysis_platform,
    update_analysis_report,
)
from src.tags import reconcile_move_classifications, resolve_game_tags

app = FastAPI(title="PlyProse API", version="1.7.0")
logger = logging.getLogger(__name__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory SSE job registry ─────────────────────────────────────────────────
_jobs: dict[str, dict[str, Any]] = {}
_background_tasks: set[asyncio.Task[Any]] = set()
_job_tasks: dict[str, asyncio.Task[Any]] = {}
_active_game_jobs: dict[str, str] = {}


# ═══════════════════════════════════════════════════════════════════════════════
# Settings
# ═══════════════════════════════════════════════════════════════════════════════


@app.get("/api/settings")
def api_get_settings() -> dict:
    return get_settings()


@app.get("/api/settings/detected-ratings")
def api_get_detected_ratings() -> dict:
    return get_detected_ratings()


class SettingsPayload(BaseModel):
    elo: int | None = None
    elo_chesscom_blitz: int | None = None
    elo_chesscom_rapid: int | None = None
    elo_lichess_blitz: int | None = None
    elo_lichess_rapid: int | None = None
    goals: str | None = None
    chesscom_username: str | None = None
    lichess_username: str | None = None
    stockfish_path: str | None = None
    stockfish_depth: int | None = None
    stockfish_time: float | None = None
    llm_provider: str | None = None
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str | None = None
    github_enabled: bool | None = None
    github_token: str | None = None
    github_repo: str | None = None
    github_branch: str | None = None


@app.put("/api/settings")
def api_update_settings(payload: SettingsPayload) -> dict:
    data = {k: v for k, v in payload.model_dump().items() if v is not None}
    return update_settings(data)


class GitHubTestPayload(BaseModel):
    token: str | None = None
    repo: str | None = None
    branch: str | None = "main"


@app.post("/api/github/test-connection")
def api_github_test_connection(payload: GitHubTestPayload | None = None) -> dict:
    settings = get_settings()
    token = (payload.token if payload and payload.token else settings.get("github_token")) or ""
    repo = (payload.repo if payload and payload.repo else settings.get("github_repo")) or ""
    branch = (
        payload.branch if payload and payload.branch else settings.get("github_branch")
    ) or "main"

    client = GitHubSyncClient(token=token, repo=repo, branch=branch)
    ok, message = client.test_connection()
    return {"ok": ok, "message": message}


@app.post("/api/github/sync/{analysis_id}")
def api_github_sync_game(analysis_id: int, force: bool = Query(False)) -> dict:
    settings = get_settings()
    token = settings.get("github_token", "").strip()
    repo = settings.get("github_repo", "").strip()
    branch = settings.get("github_branch", "main").strip() or "main"

    if not token or not repo:
        raise HTTPException(
            status_code=400, detail="GitHub token and repository must be configured in settings."
        )

    rec = get_analysis_by_id(analysis_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Analysis not found")

    report_md = rec.get("report_md", "")
    pgn_text = rec.get("pgn_text", "")
    payload_json = rec.get("payload_json")
    if pgn_text or payload_json:
        report_md = reconcile_report_fens(report_md, pgn_text=pgn_text, payload=payload_json)

    current_hash = compute_analysis_hash(report_md, pgn_text, payload_json=payload_json)

    # Avoid redundant GitHub API calls if content has not changed
    if not force and rec.get("github_path") and rec.get("github_synced_hash") == current_hash:
        return {
            "ok": True,
            "already_synced": True,
            "commit_sha": None,
            "folder_path": rec.get("github_path"),
            "synced_hash": current_hash,
            "message": "Game is already up to date on GitHub.",
        }

    folder = rec.get("github_path") or format_game_folder_path(
        platform=rec.get("platform", "manual"),
        time_control=rec.get("time_control", ""),
        played_at=rec.get("played_at"),
        date_str=rec.get("date"),
        white_player=rec.get("white_player", "White"),
        black_player=rec.get("black_player", "Black"),
        result=rec.get("result", "*"),
    )

    files = build_game_repo_files(
        report_md=report_md,
        pgn_text=pgn_text,
        payload_json=payload_json,
    )

    gh = GitHubSyncClient(token=token, repo=repo, branch=branch)
    try:
        commit_sha = gh.sync_game(
            folder_path=folder,
            files=files,
            commit_message=f"Sync analysis: {rec.get('white_player')} vs {rec.get('black_player')} ({folder})",
        )
        update_analysis_github_sync(analysis_id, folder, current_hash)
        return {
            "ok": True,
            "commit_sha": commit_sha,
            "folder_path": folder,
            "synced_hash": current_hash,
            "already_synced": False,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/api/github/sync-all")
def api_github_sync_all(force: bool = Query(False)) -> dict:
    settings = get_settings()
    token = settings.get("github_token", "").strip()
    repo = settings.get("github_repo", "").strip()
    branch = settings.get("github_branch", "main").strip() or "main"

    if not token or not repo:
        raise HTTPException(
            status_code=400, detail="GitHub token and repository must be configured in settings."
        )

    analyses = get_all_analyses()
    if not analyses:
        return {
            "ok": True,
            "synced_count": 0,
            "skipped_count": 0,
            "message": "No analyzed games to sync.",
        }

    gh = GitHubSyncClient(token=token, repo=repo, branch=branch)
    synced = 0
    skipped = 0
    errors: list[str] = []

    for item in analyses:
        rec = get_analysis_by_id(item["id"])
        if not rec:
            continue

        report_md = rec.get("report_md", "")
        pgn_text = rec.get("pgn_text", "")
        payload_json = rec.get("payload_json")
        if pgn_text or payload_json:
            report_md = reconcile_report_fens(report_md, pgn_text=pgn_text, payload=payload_json)

        current_hash = compute_analysis_hash(report_md, pgn_text, payload_json=payload_json)

        # Smart change detection: skip unchanged games with 0 GitHub requests
        if not force and rec.get("github_path") and rec.get("github_synced_hash") == current_hash:
            skipped += 1
            continue

        try:
            folder = rec.get("github_path") or format_game_folder_path(
                platform=rec.get("platform", "manual"),
                time_control=rec.get("time_control", ""),
                played_at=rec.get("played_at"),
                date_str=rec.get("date"),
                white_player=rec.get("white_player", "White"),
                black_player=rec.get("black_player", "Black"),
                result=rec.get("result", "*"),
            )

            files = build_game_repo_files(
                report_md=report_md,
                pgn_text=pgn_text,
                payload_json=payload_json,
            )
            gh.sync_game(
                folder_path=folder,
                files=files,
                commit_message=f"Sync analysis: {rec.get('white_player')} vs {rec.get('black_player')} ({folder})",
            )
            update_analysis_github_sync(rec["id"], folder, current_hash)
            synced += 1
        except Exception as e:
            errors.append(f"Game #{rec.get('id')}: {e}")

    msg = (
        f"Synced {synced} game{'s' if synced != 1 else ''} ({skipped} already up to date)."
        if skipped > 0
        else f"Synced {synced} game{'s' if synced != 1 else ''} successfully."
    )
    if errors:
        msg = f"Synced {synced} game(s) with {len(errors)} error(s)."

    return {
        "ok": len(errors) == 0,
        "synced_count": synced,
        "skipped_count": skipped,
        "total": len(analyses),
        "errors": errors[:5],
        "message": msg,
    }


@app.post("/api/github/pull", response_model=GitHubPullResult)
def api_github_pull(force: bool = Query(False)) -> GitHubPullResult:
    """
    Pulls analyzed games from the remote GitHub repository into the local SQLite database.
    - If a remote game already exists locally with the same hash, skips it without downloading blobs.
    - If a remote game was sitting in pending_games, cleans it up from pending_games and saves it to analyses.
    - If a remote game is completely new, imports it directly.
    """
    settings = get_settings()
    token = settings.get("github_token", "").strip()
    repo = settings.get("github_repo", "").strip()
    branch = settings.get("github_branch", "main").strip() or "main"

    if not token or not repo:
        raise HTTPException(
            status_code=400,
            detail="GitHub token and repository must be configured in settings.",
        )

    gh = GitHubSyncClient(token=token, repo=repo, branch=branch)
    try:
        remote_games = gh.list_remote_games_summary()
    except Exception as e:
        logger.exception("Error listing remote GitHub games: %s", e)
        raise HTTPException(
            status_code=500, detail=f"Failed to query GitHub repository: {e}"
        ) from e

    if not remote_games:
        return GitHubPullResult(
            ok=True,
            imported_count=0,
            updated_count=0,
            skipped_count=0,
            purged_pending_count=0,
            total_remote=0,
            message="No game analyses found in remote repository.",
        )

    imported = 0
    updated = 0
    skipped = 0
    purged_pending = 0
    errors: list[str] = []

    def _record_has_evals(rec: dict[str, Any] | None) -> bool:
        if not rec:
            return False
        if rec.get("ply_evals") and len(rec["ply_evals"]) > 1:
            return True
        raw_json = rec.get("payload_json")
        if raw_json:
            try:
                p = json.loads(raw_json)
                evals = p.get("ply_evals")
                return bool(evals and len(evals) > 1)
            except Exception:
                return False
        return False

    for rg in remote_games:
        folder = rg["folder"]
        try:
            # 1. Fast check: already analyzed, tracked by github_path, and has valid ply evaluations
            existing_by_path = find_analysis_by_github_path(folder)
            if existing_by_path and not force and _record_has_evals(existing_by_path):
                # If remote does not have a newer payload blob and local is fully populated, skip
                if not rg.get("payload_blob_sha"):
                    skipped += 1
                    continue

            # 2. Fetch PGN, Report, and optional Payload blobs
            pgn_text = gh.get_blob_text(rg["pgn_blob_sha"]).strip()
            report_md = gh.get_blob_text(rg["report_blob_sha"]).strip()
            payload_json: str | None = None
            if rg.get("payload_blob_sha"):
                try:
                    payload_json = gh.get_blob_text(rg["payload_blob_sha"])
                except Exception:
                    payload_json = None

            current_hash = compute_analysis_hash(report_md, pgn_text, payload_json=payload_json)
            meta = parse_raw_pgn_metadata(pgn_text)
            ext_id = meta.get("id")

            # 3. If matched by folder:
            if existing_by_path:
                if (
                    existing_by_path.get("github_synced_hash") == current_hash
                    and _record_has_evals(existing_by_path)
                    and not force
                ):
                    skipped += 1
                    continue

            # 4. Clean up duplicate pending records for this game
            purged = delete_pending_game_by_external_id_or_pgn(
                external_id=ext_id, pgn_text=pgn_text
            )
            purged_pending += purged

            # 5. Reconstruct and ensure payload has full ply evaluations
            payload: GameAnalysisPayload | None = None
            if payload_json and payload_json.strip():
                try:
                    payload = GameAnalysisPayload.model_validate_json(payload_json)
                except Exception:
                    payload = None

            total_plies = 2
            opening_name = None
            try:
                parsed_game = chess.pgn.read_game(io.StringIO(pgn_text))
                if parsed_game:
                    opening_name = parsed_game.headers.get("Opening")
                    moves = list(parsed_game.mainline_moves())
                    if moves:
                        total_plies = len(moves)
            except Exception:
                pass

            if payload is None:
                sf_path = settings.get("stockfish_path", "/usr/sbin/stockfish")
                if os.path.exists(sf_path) and os.access(sf_path, os.X_OK):
                    try:
                        payload = analyze_pgn(
                            pgn_str=pgn_text,
                            stockfish_path=sf_path,
                            time_per_move=0.03,
                            filter_by_user_color=False,
                        )
                    except Exception as sf_err:
                        logger.warning("Could not run Stockfish on pulled game: %s", sf_err)
                        payload = None

            if payload is None:
                white_p = meta.get("white") or "White"
                black_p = meta.get("black") or "Black"
                tc = meta.get("time_control") or "unknown"
                res = meta.get("result") or "*"

                # Extract per-ply evals from PGN comments or interpolate from result
                pgn_evals = extract_ply_evals_from_pgn(pgn_text)
                reconstructed_evals: list[int | None] | None
                if pgn_evals and len(pgn_evals) > 1:
                    reconstructed_evals = pgn_evals
                else:
                    reconstructed_evals = interpolate_ply_evals(
                        [],
                        total_plies,
                        result_str=res,
                    )

                payload = GameAnalysisPayload(
                    white_player=white_p,
                    black_player=black_p,
                    user_color="White",
                    result=res,
                    time_control=tc,
                    pgn_moves_summary=f"{white_p} vs {black_p}",
                    total_plies=total_plies,
                    critical_moments=[],
                    opening_name=opening_name,
                    ply_evals=reconstructed_evals,
                )
            else:
                # Ensure ply_evals is populated on the loaded payload
                if not payload.ply_evals or len(payload.ply_evals) < 2:
                    pgn_evals = extract_ply_evals_from_pgn(pgn_text)
                    if pgn_evals and len(pgn_evals) > 1:
                        payload.ply_evals = pgn_evals
                    else:
                        payload.ply_evals = interpolate_ply_evals(
                            payload.critical_moments,
                            payload.total_plies or total_plies,
                            result_str=payload.result,
                        )

            # 6. If matched by folder, update with complete payload and report
            if existing_by_path:
                update_analysis_payload(
                    existing_by_path["id"],
                    payload=payload,
                    report_md=report_md,
                    model_name=existing_by_path.get("model_name", "github-sync"),
                )
                update_analysis_github_sync(existing_by_path["id"], folder, current_hash)
                updated += 1
                continue

            # 7. Check if game already exists by external_id or PGN (analyzed locally prior to sync)
            match_analysis = find_analysis(external_id=ext_id, pgn_text=pgn_text)
            if match_analysis:
                if (
                    force
                    or not _record_has_evals(match_analysis)
                    or match_analysis.get("github_synced_hash") != current_hash
                ):
                    update_analysis_payload(
                        match_analysis["id"],
                        payload=payload,
                        report_md=report_md,
                        model_name=match_analysis.get("model_name", "github-sync"),
                    )
                update_analysis_github_sync(match_analysis["id"], folder, current_hash)
                updated += 1
                continue

            # 8. Save brand new analysis to local SQLite database
            plat = meta.get("platform") or "manual"
            save_analysis(
                pgn_text=pgn_text,
                payload=payload,
                report_md=report_md,
                model_name="github-sync",
                platform=plat,
                external_id=ext_id,
                played_at=meta.get("played_at"),
                github_path=folder,
                github_synced_hash=current_hash,
            )
            imported += 1

        except Exception as exc:
            logger.exception("Error pulling remote game folder '%s': %s", folder, exc)
            errors.append(f"{folder}: {exc}")

    msg_parts: list[str] = []
    if imported > 0:
        msg_parts.append(f"Imported {imported} new game{'s' if imported != 1 else ''}")
    if updated > 0:
        msg_parts.append(f"updated {updated}")
    if skipped > 0:
        msg_parts.append(f"{skipped} already up to date")
    if purged_pending > 0:
        msg_parts.append(
            f"cleared {purged_pending} pending duplicate{'s' if purged_pending != 1 else ''}"
        )

    summary_msg = ", ".join(msg_parts) + "." if msg_parts else "All remote games are up to date."
    if errors:
        summary_msg += f" Encountered {len(errors)} error(s)."

    return GitHubPullResult(
        ok=len(errors) == 0,
        imported_count=imported,
        updated_count=updated,
        skipped_count=skipped,
        purged_pending_count=purged_pending,
        total_remote=len(remote_games),
        errors=errors[:5],
        message=summary_msg,
    )


@app.post("/api/settings/test-connection")
def api_test_connection() -> dict:
    settings = get_settings()
    ok, message = probe_openai_compat_connection(
        base_url=settings.get("llm_base_url"),
        api_key=settings.get("llm_api_key") or None,
    )
    return {"ok": ok, "message": message}


@app.post("/api/settings/verify-username")
def api_verify_username(platform: str = Query(...), username: str = Query(...)) -> dict:
    try:
        if platform == "lichess":
            fetch_lichess_games(username.strip(), max_games=1)
        elif platform == "chesscom":
            fetch_chesscom_games(username.strip(), max_games=1)
        else:
            return {"ok": False, "message": f"Unknown platform: {platform}"}
        return {"ok": True, "message": f"Found {username} on {platform}."}
    except UserNotFoundError:
        return {"ok": False, "message": f"User '{username}' not found on {platform}."}
    except Exception as e:
        return {"ok": False, "message": str(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# Unified games list  (pending + analyzed)
# ═══════════════════════════════════════════════════════════════════════════════


def _enrich(rec: dict, analyzed: bool, platform: str = "manual") -> dict:
    tc = rec.get("time_control", "unknown")
    plat = rec.get("platform")
    if not plat or plat == "manual":
        pgn_lower = (rec.get("pgn_text") or "").lower()
        if "chess.com" in pgn_lower:
            plat = "chesscom"
        elif "lichess.org" in pgn_lower:
            plat = "lichess"
        else:
            plat = platform or "manual"
    classified = classify_time_control(tc, plat)
    played_at = rec.get("played_at") or extract_played_at(
        rec.get("pgn_text", ""),
        fallback_date=rec.get("date"),
        fallback_created=rec.get("created_at"),
    )
    side = rec.get("side") or "both"
    white = rec.get("white_player") or rec.get("white", "White")
    black = rec.get("black_player") or rec.get("black", "Black")
    res = rec.get("result", "*")

    # Resolve user outcome taking side / player into account
    resolved_side = (side or "").lower()
    if resolved_side not in ("white", "black"):
        settings = get_settings()
        user_names = [
            settings.get("chesscom_username", "").lower(),
            settings.get("lichess_username", "").lower(),
            "tuxitop",
        ]
        user_names = [u for u in user_names if u]
        white_low = white.lower()
        black_low = black.lower()
        if any(u in white_low for u in user_names):
            resolved_side = "white"
        elif any(u in black_low for u in user_names):
            resolved_side = "black"

    if res in ("1/2-1/2", "draw"):
        user_outcome = "draw"
    elif resolved_side == "white":
        user_outcome = "win" if res == "1-0" else "loss" if res == "0-1" else "unknown"
    elif resolved_side == "black":
        user_outcome = "win" if res == "0-1" else "loss" if res == "1-0" else "unknown"
    else:
        user_outcome = "win" if res == "1-0" else "loss" if res == "0-1" else "unknown"

    total_plies = rec.get("total_plies")
    if total_plies is None or total_plies <= 0:
        ply_evals = rec.get("ply_evals")
        if ply_evals and len(ply_evals) > 1:
            total_plies = len(ply_evals) - 1
        else:
            pgn = rec.get("pgn_text")
            if pgn:
                try:
                    game = chess.pgn.read_game(io.StringIO(pgn))
                    if game:
                        total_plies = sum(1 for _ in game.mainline_moves())
                except Exception:
                    total_plies = 0
            else:
                total_plies = 0

    moves_count = (total_plies + 1) // 2 if total_plies else 0

    github_path = rec.get("github_path")
    github_synced_hash = rec.get("github_synced_hash")
    github_sync_status = None
    if analyzed:
        if not github_path:
            github_sync_status = "not_synced"
        else:
            curr_hash = compute_analysis_hash(
                rec.get("report_md") or "",
                rec.get("pgn_text") or "",
                payload_json=rec.get("payload_json"),
            )
            github_sync_status = "synced" if github_synced_hash == curr_hash else "modified"

    return {
        **rec,
        "analyzed": analyzed,
        "platform": plat,
        "played_at": played_at,
        "date": played_at or rec.get("date"),
        "side": resolved_side if resolved_side in ("white", "black") else side,
        "white_player": white,
        "black_player": black,
        "white": white,
        "black": black,
        "user_outcome": user_outcome,
        "speed_label": classified["label"],
        "speed_seconds": classified["seconds"],
        "speed_icon": classified["icon"],
        "game_url": extract_game_url(rec.get("pgn_text", ""), plat, rec.get("external_id")),
        "ply_evals": rec.get("ply_evals"),
        "total_plies": total_plies,
        "moves_count": moves_count,
        "github_sync_status": github_sync_status,
        "github_synced_hash": github_synced_hash,
    }


@app.get("/api/games")
def api_get_games(
    status: str | None = Query(None),
    result: str | None = Query(None),
    platform: str | None = Query(None),
    category: str | None = Query(None),
    tag: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
) -> dict:
    if not isinstance(status, str):
        status = None
    if not isinstance(result, str):
        result = None
    if not isinstance(platform, str):
        platform = None
    if not isinstance(category, str):
        category = None
    if not isinstance(tag, str):
        tag = None
    if not isinstance(page, int):
        page = 1
    if not isinstance(page_size, int):
        page_size = 10

    # Analyzed games from game_analyses
    analyzed = [_enrich(r, True) for r in get_all_analyses()]
    # Pending (fetched but not yet analyzed) from pending_games
    pending = [_enrich(r, False, r.get("platform", "manual")) for r in get_pending_games()]

    # Merge and sort ALL games based on the time that the game was played (latest games first)
    records: list[dict] = analyzed + pending
    records.sort(
        key=lambda r: (
            r.get("played_at") or r.get("date") or r.get("created_at") or "",
            r.get("id") or 0,
        ),
        reverse=True,
    )

    # Filter
    if status == "analyzed":
        records = [r for r in records if r.get("analyzed")]
    elif status == "unanalyzed":
        records = [r for r in records if not r.get("analyzed")]

    if result and result != "all":
        target = result.lower()
        records = [r for r in records if r.get("user_outcome") == target]

    if platform and platform != "all":
        records = [r for r in records if r.get("platform", "manual").lower() == platform.lower()]

    if category and category != "all":
        records = [r for r in records if r.get("speed_label", "").lower() == category.lower()]

    if tag and tag != "all":
        target_tag = tag.strip().lower()
        records = [
            r
            for r in records
            if any(target_tag in (t or "").lower() for t in (r.get("tags") or []))
        ]

    total = len(records)
    start = (page - 1) * page_size
    page_records = records[start : start + page_size]

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
        "games": page_records,
    }


@app.get("/api/tags")
def api_get_tags() -> dict:
    analyses = get_all_analyses()
    tag_counts: dict[str, int] = {}
    for a in analyses:
        for t in a.get("tags") or []:
            if isinstance(t, str) and t.strip():
                clean_t = t.strip()
                tag_counts[clean_t] = tag_counts.get(clean_t, 0) + 1
    sorted_tags = sorted(tag_counts.keys(), key=lambda x: (-tag_counts[x], x))
    return {"tags": sorted_tags, "counts": tag_counts}


@app.delete("/api/games/pending/{game_id}")
def api_delete_pending(game_id: int) -> dict:
    ok = delete_pending_game(game_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Pending game not found")
    return {"ok": True}


@app.delete("/api/games/{game_id}")
def api_delete_game(game_id: int) -> dict:
    rec = get_analysis_by_id(game_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Game not found")

    settings = get_settings()
    if (
        settings.get("github_enabled")
        and settings.get("github_token")
        and settings.get("github_repo")
    ):
        folder = rec.get("github_path") or format_game_folder_path(
            platform=rec.get("platform", "manual"),
            time_control=rec.get("time_control", ""),
            played_at=rec.get("played_at"),
            date_str=rec.get("date"),
            white_player=rec.get("white_player", "White"),
            black_player=rec.get("black_player", "Black"),
            result=rec.get("result", "*"),
        )
        if folder:
            try:
                gh = GitHubSyncClient(
                    token=settings.get("github_token", ""),
                    repo=settings.get("github_repo", ""),
                    branch=settings.get("github_branch", "main").strip() or "main",
                )
                gh.delete_game(
                    folder_path=folder,
                    commit_message=f"Delete analysis: {rec.get('white_player')} vs {rec.get('black_player')} ({folder})",
                )
            except Exception as gh_exc:
                logger.warning("Failed to delete game %s from GitHub: %s", game_id, gh_exc)

    ok = delete_analysis(game_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Game not found")
    return {"ok": True}


class UpdatePlatformPayload(BaseModel):
    platform: str
    is_pending: bool = False


@app.patch("/api/games/{game_id}/platform")
def api_update_game_platform(game_id: int, payload: UpdatePlatformPayload) -> dict:
    plat = payload.platform.strip().lower()
    if plat not in ("lichess", "chesscom", "manual"):
        raise HTTPException(status_code=400, detail=f"Invalid platform: {plat}")
    if payload.is_pending:
        ok = update_pending_game_platform(game_id, plat)
    else:
        ok = update_analysis_platform(game_id, plat)
    if not ok:
        raise HTTPException(status_code=404, detail="Game not found")
    return {"ok": True, "game_id": game_id, "platform": plat}


# ═══════════════════════════════════════════════════════════════════════════════
# Import game (PGN paste / file)
# ═══════════════════════════════════════════════════════════════════════════════


class ImportPayload(BaseModel):
    pgn: str
    side: str = "auto"


@app.post("/api/games/import")
def api_import_game(payload: ImportPayload) -> dict:
    pgn = payload.pgn.strip()
    if not pgn:
        raise HTTPException(status_code=400, detail="PGN cannot be empty")
    try:
        meta = parse_raw_pgn_metadata(pgn)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    settings = get_settings()
    side = payload.side
    if side == "auto":
        chesscom = (settings.get("chesscom_username") or "").lower()
        lichess = (settings.get("lichess_username") or "").lower()
        white = (meta.get("white") or "").lower()
        black = (meta.get("black") or "").lower()
        if chesscom and white == chesscom:
            side = "white"
        elif chesscom and black == chesscom:
            side = "black"
        elif lichess and white == lichess:
            side = "white"
        elif lichess and black == lichess:
            side = "black"
        else:
            side = "both"

    # Detect platform from PGN site header
    platform = "manual"
    pgn_lower = pgn.lower()
    if "chess.com" in pgn_lower:
        platform = "chesscom"
    elif "lichess.org" in pgn_lower:
        platform = "lichess"

    # Save as pending game so it appears in the games list immediately
    pending_id = save_pending_game(
        pgn_text=pgn,
        platform=platform,
        external_id=meta.get("id"),
        white=meta.get("white", "White"),
        black=meta.get("black", "Black"),
        result=meta.get("result", "*"),
        time_control=meta.get("time_control", "unknown"),
        date=meta.get("date"),
        played_at=meta.get("played_at"),
        side=side,
    )

    return {
        "pgn": pgn,
        "meta": meta,
        "resolved_side": side,
        "platform": platform,
        "pending_id": pending_id,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Platform sync — fetches games and saves them as pending
# ═══════════════════════════════════════════════════════════════════════════════


def _parse_time_boundary(val: str | None) -> datetime.datetime | None:
    if not val:
        return None
    val = str(val).strip()
    if val.isdigit():
        ts = float(val)
        if ts > 10_000_000_000:
            ts = ts / 1000.0
        return datetime.datetime.fromtimestamp(ts, tz=datetime.UTC)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%Y.%m.%d"):
        try:
            dt = datetime.datetime.strptime(val[:19], fmt)
            return dt.replace(tzinfo=datetime.UTC)
        except ValueError:
            continue
    try:
        return datetime.datetime.fromisoformat(val).astimezone(datetime.UTC)
    except Exception:
        return None


def _fetch_platform_raw_games(
    platform: str,
    max_games: int,
    since_dt: datetime.datetime | None,
    until_dt: datetime.datetime | None,
    settings: dict,
) -> list[dict[str, Any]]:
    if platform == "lichess":
        username = settings.get("lichess_username", "").strip()
        if not username:
            raise HTTPException(
                status_code=400, detail="Lichess username not configured in settings"
            )
        since_ms = int(since_dt.timestamp() * 1000) if since_dt else None
        until_ms = int(until_dt.timestamp() * 1000) if until_dt else None
        kwargs: dict[str, Any] = {}
        if since_ms is not None:
            kwargs["since"] = since_ms
        if until_ms is not None:
            kwargs["until"] = until_ms
        try:
            return fetch_lichess_games(username, max_games=max_games, **kwargs)
        except TypeError:
            return fetch_lichess_games(username, max_games=max_games)
    elif platform == "chesscom":
        username = settings.get("chesscom_username", "").strip()
        if not username:
            raise HTTPException(
                status_code=400, detail="Chess.com username not configured in settings"
            )
        since_sec = int(since_dt.timestamp()) if since_dt else None
        until_sec = int(until_dt.timestamp()) if until_dt else None
        kwargs = {}
        if since_sec is not None:
            kwargs["since"] = since_sec
        if until_sec is not None:
            kwargs["until"] = until_sec
        try:
            return fetch_chesscom_games(username, max_games=max_games, **kwargs)
        except TypeError:
            return fetch_chesscom_games(username, max_games=max_games)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown platform: {platform}")


def _enrich_preview_game(g: dict[str, Any], platform: str, my_username: str) -> dict[str, Any]:
    ext_id = str(g.get("id") or "")
    pgn = g.get("pgn", "")
    white = g.get("white", "White")
    black = g.get("black", "Black")
    result = g.get("result", "*")
    time_control = g.get("time_control", "unknown")
    played_at = g.get("played_at") or extract_played_at(pgn, fallback_date=g.get("date"))

    side = "both"
    opponent = black
    my_user_clean = my_username.strip().lower()
    if my_user_clean:
        if white.lower() == my_user_clean:
            side = "white"
            opponent = black
        elif black.lower() == my_user_clean:
            side = "black"
            opponent = white

    user_elo: int | None = None
    opponent_elo: int | None = None
    if pgn:
        try:
            import io

            import chess.pgn

            parsed = chess.pgn.read_game(io.StringIO(pgn))
            if parsed:
                w_elo = parsed.headers.get("WhiteElo")
                b_elo = parsed.headers.get("BlackElo")
                if side == "white":
                    if w_elo and str(w_elo).isdigit():
                        user_elo = int(w_elo)
                    if b_elo and str(b_elo).isdigit():
                        opponent_elo = int(b_elo)
                elif side == "black":
                    if b_elo and str(b_elo).isdigit():
                        user_elo = int(b_elo)
                    if w_elo and str(w_elo).isdigit():
                        opponent_elo = int(w_elo)
        except Exception:
            pass

    outcome = "unknown"
    if result == "1-0":
        outcome = "win" if side == "white" else "loss" if side == "black" else "draw"
    elif result == "0-1":
        outcome = "win" if side == "black" else "loss" if side == "white" else "draw"
    elif result in ("1/2-1/2", "draw"):
        outcome = "draw"

    classified = classify_time_control(time_control, platform)

    is_analyzed = bool(find_analysis(external_id=ext_id, pgn_text=pgn))
    is_pending = bool(find_pending_game(external_id=ext_id, pgn_text=pgn))
    already_imported = is_analyzed or is_pending

    source = g.get("source") or ""
    detected_platform = platform

    return {
        "id": ext_id,
        "platform": detected_platform,
        "detected_platform": detected_platform,
        "selected_platform": detected_platform,
        "source": source,
        "played_at": played_at,
        "date": g.get("date"),
        "white": white,
        "black": black,
        "side": side,
        "opponent": opponent,
        "user_elo": user_elo,
        "opponent_elo": opponent_elo,
        "result": result,
        "outcome": outcome,
        "time_control": time_control,
        "speed_label": classified["label"],
        "speed_icon": classified["icon"],
        "already_imported": already_imported,
        "already_analyzed": is_analyzed,
        "already_pending": is_pending,
        "pgn": pgn,
    }


def _sync_single_platform(
    platform: str,
    max_games: int,
    since_dt: datetime.datetime | None,
    until_dt: datetime.datetime | None,
    settings: dict,
) -> list[int]:
    games = _fetch_platform_raw_games(platform, max_games, since_dt, until_dt, settings)

    chesscom_user = settings.get("chesscom_username", "").lower()
    lichess_user = settings.get("lichess_username", "").lower()
    my_user = lichess_user if platform == "lichess" else chesscom_user

    saved_ids: list[int] = []
    for g in games:
        ext_id = g.get("id")
        pgn = g.get("pgn", "")

        # 1. Skip if already analyzed in game_analyses
        if find_analysis(external_id=ext_id, pgn_text=pgn):
            continue

        # 2. Skip if already in pending_games
        if find_pending_game(external_id=ext_id, pgn_text=pgn):
            continue

        white = (g.get("white") or "").lower()
        black = (g.get("black") or "").lower()
        if my_user and white == my_user:
            side = "white"
        elif my_user and black == my_user:
            side = "black"
        else:
            side = "both"

        game_platform = platform

        pid = save_pending_game(
            pgn_text=pgn,
            platform=game_platform,
            external_id=ext_id,
            white=g.get("white", "White"),
            black=g.get("black", "Black"),
            result=g.get("result", "*"),
            time_control=g.get("time_control", "unknown"),
            date=g.get("date"),
            played_at=g.get("played_at"),
            side=side,
        )
        saved_ids.append(pid)

    return saved_ids


@app.get("/api/games/fetch-platform-games")
def api_fetch_platform_games(
    platform: str = Query(...),
    max_games: int = Query(50, ge=1, le=200),
    time_range: str | None = Query(None),
    since: str | None = Query(None),
    until: str | None = Query(None),
) -> dict:
    settings = get_settings()
    now = datetime.datetime.now(datetime.UTC)
    since_dt: datetime.datetime | None = None
    until_dt: datetime.datetime | None = None

    if time_range == "1d":
        since_dt = now - datetime.timedelta(days=1)
    elif time_range == "1w":
        since_dt = now - datetime.timedelta(days=7)
    elif time_range == "1month":
        since_dt = now - datetime.timedelta(days=30)
    elif time_range == "custom" or since is not None:
        since_dt = _parse_time_boundary(since)
        until_dt = _parse_time_boundary(until)

    try:
        raw_games = _fetch_platform_raw_games(platform, max_games, since_dt, until_dt, settings)
    except UserNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except RateLimitError as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    my_user = (
        settings.get("lichess_username", "")
        if platform == "lichess"
        else settings.get("chesscom_username", "")
    )
    preview_games = [_enrich_preview_game(g, platform, my_user) for g in raw_games]

    return {
        "platform": platform,
        "count": len(preview_games),
        "games": preview_games,
    }


class BatchGameItem(BaseModel):
    pgn: str
    platform: str = "manual"
    external_id: str | None = None
    white: str = "White"
    black: str = "Black"
    result: str = "*"
    time_control: str = "unknown"
    date: str | None = None
    played_at: str | None = None
    side: str = "both"


class BatchImportPayload(BaseModel):
    games: list[BatchGameItem]


@app.post("/api/games/import-batch")
def api_import_batch_games(payload: BatchImportPayload) -> dict:
    saved_ids: list[int] = []
    for item in payload.games:
        pgn = item.pgn.strip()
        if not pgn:
            continue
        ext_id = item.external_id

        # If already in database, update platform tag if provided and skip insertion
        existing_an = find_analysis(external_id=ext_id, pgn_text=pgn)
        if existing_an:
            if item.platform and item.platform != existing_an.get("platform"):
                update_analysis_platform(existing_an["id"], item.platform)
            continue
        existing_pend = find_pending_game(external_id=ext_id, pgn_text=pgn)
        if existing_pend:
            if item.platform and item.platform != existing_pend.get("platform"):
                update_pending_game_platform(existing_pend["id"], item.platform)
            continue

        pid = save_pending_game(
            pgn_text=pgn,
            platform=item.platform or "manual",
            external_id=ext_id,
            white=item.white,
            black=item.black,
            result=item.result,
            time_control=item.time_control,
            date=item.date,
            played_at=item.played_at,
            side=item.side,
        )
        saved_ids.append(pid)

    return {"imported_count": len(saved_ids), "pending_ids": saved_ids}


@app.post("/api/games/sync")
def api_sync_games(
    platform: str = Query(...),
    max_games: int = Query(50, ge=1, le=200),
    time_range: str | None = Query(None),
    since: str | None = Query(None),
    until: str | None = Query(None),
) -> dict:
    settings = get_settings()
    now = datetime.datetime.now(datetime.UTC)
    since_dt: datetime.datetime | None = None
    until_dt: datetime.datetime | None = None

    if time_range == "1d":
        since_dt = now - datetime.timedelta(days=1)
    elif time_range == "1w":
        since_dt = now - datetime.timedelta(days=7)
    elif time_range == "1month":
        since_dt = now - datetime.timedelta(days=30)
    elif time_range == "custom" or since is not None:
        since_dt = _parse_time_boundary(since)
        until_dt = _parse_time_boundary(until)

    try:
        if platform == "all":
            all_saved: list[int] = []
            plat_counts: dict[str, int] = {}
            cc_user = settings.get("chesscom_username", "").strip()
            li_user = settings.get("lichess_username", "").strip()
            if not cc_user and not li_user:
                raise HTTPException(
                    status_code=400,
                    detail="Neither Chess.com nor Lichess username is configured in settings",
                )

            if li_user:
                li_ids = _sync_single_platform("lichess", max_games, since_dt, until_dt, settings)
                all_saved.extend(li_ids)
                plat_counts["lichess"] = len(li_ids)
            if cc_user:
                cc_ids = _sync_single_platform("chesscom", max_games, since_dt, until_dt, settings)
                all_saved.extend(cc_ids)
                plat_counts["chesscom"] = len(cc_ids)

            return {
                "platform": "all",
                "count": len(all_saved),
                "pending_ids": all_saved,
                "details": plat_counts,
            }

        elif platform in ("lichess", "chesscom"):
            saved_ids = _sync_single_platform(platform, max_games, since_dt, until_dt, settings)
            return {"platform": platform, "count": len(saved_ids), "pending_ids": saved_ids}
        else:
            raise HTTPException(status_code=400, detail=f"Unknown platform: {platform}")

    except UserNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except RateLimitError as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


# ═══════════════════════════════════════════════════════════════════════════════
# Analysis jobs (SSE streaming)
# ═══════════════════════════════════════════════════════════════════════════════


class AnalyzePayload(BaseModel):
    pgn: str
    side: str = "both"
    platform: str = "manual"
    existing_analysis_id: int | None = None
    pending_game_id: int | None = None  # remove from pending table on success
    skip_engine: bool = False


def _resolve_user_color(side: str) -> str:
    s = side.lower()
    if s == "white":
        return "White"
    if s == "black":
        return "Black"
    return "Both"


async def _run_analysis_job(
    job_id: str,
    pgn: str,
    side: str,
    platform: str,
    existing_id: int | None,
    pending_game_id: int | None,
    skip_engine: bool = False,
) -> None:
    job = _jobs[job_id]
    settings = get_settings()

    game_key = (
        f"a-{existing_id}"
        if existing_id
        else f"p-{pending_game_id}"
        if pending_game_id
        else f"pgn-{abs(hash(pgn.strip()))}"
    )

    def _emit(event: str, data: Any) -> None:
        job["events"].append({"event": event, "data": data})

    try:
        loop = asyncio.get_event_loop()

        # Auto-resolve playing side from user accounts if not explicitly set
        chesscom = (settings.get("chesscom_username") or "").strip().lower()
        lichess = (settings.get("lichess_username") or "").strip().lower()
        active_side = (side or "both").strip().lower()

        if active_side in ("auto", "both", ""):
            w_player = ""
            b_player = ""
            try:
                import io

                import chess.pgn

                parsed_g = chess.pgn.read_game(io.StringIO(pgn))
                if parsed_g:
                    w_player = (parsed_g.headers.get("White") or "").strip().lower()
                    b_player = (parsed_g.headers.get("Black") or "").strip().lower()
            except Exception:
                pass
            if chesscom and w_player == chesscom:
                active_side = "white"
            elif chesscom and b_player == chesscom:
                active_side = "black"
            elif lichess and w_player == lichess:
                active_side = "white"
            elif lichess and b_player == lichess:
                active_side = "black"

        user_color = _resolve_user_color(active_side)

        resolved_platform = platform or "manual"
        if resolved_platform == "manual":
            pgn_low = pgn.lower()
            if "chess.com" in pgn_low:
                resolved_platform = "chesscom"
            elif "lichess.org" in pgn_low:
                resolved_platform = "lichess"

        payload: GameAnalysisPayload | None = None
        if skip_engine and existing_id:
            existing_rec = get_analysis_by_id(existing_id)
            if existing_rec and existing_rec.get("payload_json"):
                try:
                    payload = GameAnalysisPayload.model_validate_json(existing_rec["payload_json"])
                    _emit(
                        "step",
                        {
                            "step": 1,
                            "message": "Loaded cached Stockfish analysis…",
                            "progress": 50,
                        },
                    )
                except Exception:
                    payload = None

        if payload is None:

            def _sf_progress(current_ply: int, total_plies: int) -> None:
                pct = int(10 + (current_ply / max(1, total_plies)) * 40)
                _emit(
                    "step",
                    {
                        "step": 1,
                        "message": f"Stockfish evaluating move {current_ply}/{total_plies}…",
                        "progress": pct,
                    },
                )

            _emit(
                "step",
                {"step": 1, "message": "Running Stockfish engine analysis…", "progress": 10},
            )

            payload = await loop.run_in_executor(
                None,
                lambda: analyze_pgn(
                    pgn_str=pgn,
                    stockfish_path=settings.get("stockfish_path", "/usr/sbin/stockfish"),
                    user_color=user_color,
                    time_per_move=float(settings.get("stockfish_time", 0.15)),
                    platform=resolved_platform,
                    filter_by_user_color=False,
                    progress_callback=_sf_progress,
                ),
            )

        _emit("step", {"step": 2, "message": "Generating LLM coaching narrative…", "progress": 50})

        # Determine effective player Elo for this game:
        # 1. First, check if the game's PGN headers specify the player's rating directly
        game_elo: int | None = None
        try:
            import io

            import chess.pgn

            pgn_game = chess.pgn.read_game(io.StringIO(pgn))
            if pgn_game:
                w_elo = pgn_game.headers.get("WhiteElo")
                b_elo = pgn_game.headers.get("BlackElo")
                if active_side == "white" and w_elo and str(w_elo).isdigit():
                    game_elo = int(w_elo)
                elif active_side == "black" and b_elo and str(b_elo).isdigit():
                    game_elo = int(b_elo)
        except Exception:
            pass

        # 2. If not found in PGN, check settings for (platform, time control)
        tc_info = classify_time_control(payload.time_control or "", platform)
        speed_cat = tc_info.get("label", "").lower()
        plat_key = (
            "chesscom"
            if platform in ("chesscom", "chess.com")
            else "lichess"
            if platform == "lichess"
            else None
        )

        if game_elo is None or game_elo <= 0:
            if plat_key and speed_cat in ("blitz", "rapid"):
                game_elo = settings.get(f"elo_{plat_key}_{speed_cat}")
            elif plat_key:
                game_elo = settings.get(f"elo_{plat_key}_rapid") or settings.get(
                    f"elo_{plat_key}_blitz"
                )

        # 3. Fallback to general elo setting
        if not game_elo:
            game_elo = settings.get("elo", 1200)

        goals = settings.get("goals", "")
        side_label = {"white": "WHITE", "black": "BLACK"}.get(active_side, "NOT SPECIFIED")

        from src.coach_agent import get_system_prompt

        custom_system_prompt = get_system_prompt(
            user_color=side_label,
            chess_level=f"{game_elo} ELO",
            goals=goals,
        )

        llm_start_time = asyncio.get_event_loop().time()

        async def _llm_ticker() -> None:
            try:
                while True:
                    await asyncio.sleep(3)
                    elapsed = int(asyncio.get_event_loop().time() - llm_start_time)
                    progress_val = min(89, 50 + elapsed)
                    _emit(
                        "step",
                        {
                            "step": 2,
                            "message": f"Generating LLM coaching narrative ({elapsed}s elapsed)…",
                            "progress": progress_val,
                        },
                    )
            except asyncio.CancelledError:
                pass

        ticker_task = asyncio.create_task(_llm_ticker())
        try:
            report: str = await loop.run_in_executor(
                None,
                lambda: generate_narrative_report(
                    payload=payload,
                    provider=settings.get("llm_provider", "openai-compat"),
                    model_name=settings.get("llm_model", "gpt-4o-mini"),
                    api_key=settings.get("llm_api_key") or None,
                    base_url=settings.get("llm_base_url") or None,
                    system_prompt=custom_system_prompt,
                ),
            )
        finally:
            ticker_task.cancel()

        if not report or not report.strip():
            report = generate_deterministic_summary(payload, note="LLM returned empty response.")

        # Reconcile any hallucinated or malformed FENs in board tags
        report = reconcile_report_fens(report, pgn_text=pgn, payload=payload)

        _emit("step", {"step": 3, "message": "Saving analysis…", "progress": 90})

        active_model = model_label(
            settings.get("llm_provider", "openai-compat"),
            settings.get("llm_model", "gpt-4o-mini"),
        )

        # Resolve platform if it's manual/unspecified
        resolved_platform = platform or "manual"
        if resolved_platform == "manual":
            pgn_low = pgn.lower()
            if "chess.com" in pgn_low:
                resolved_platform = "chesscom"
            elif "lichess.org" in pgn_low:
                resolved_platform = "lichess"

        # Resolve standardized coaching tags
        ai_tags = re.findall(
            r"\b(?:tactic|opening|strategy|endgame|general|time):[a-z0-9\-]+\b",
            report,
            re.IGNORECASE,
        )
        payload.tags = resolve_game_tags(ai_tags, payload, report_md=report)
        reconcile_move_classifications(payload, report_md=report)

        if existing_id:
            update_analysis_payload(
                existing_id,
                payload=payload,
                report_md=report,
                model_name=active_model,
            )
            analysis_id = existing_id
        else:
            analysis_id = save_analysis(
                pgn_text=pgn,
                payload=payload,
                report_md=report,
                model_name=active_model,
                platform=resolved_platform,
            )

        # Remove from pending table now that it's fully analyzed
        if pending_game_id:
            delete_pending_game(pending_game_id)
        # Also clean up any lingering duplicate pending rows for this game
        delete_pending_game_by_external_id_or_pgn(pgn_text=pgn)

        # Auto-sync to GitHub if enabled
        if (
            settings.get("github_enabled")
            and settings.get("github_token")
            and settings.get("github_repo")
        ):
            try:
                _emit("step", {"step": 4, "message": "Syncing analysis to GitHub…", "progress": 95})
                fresh_rec = get_analysis_by_id(analysis_id)
                if fresh_rec:
                    folder = fresh_rec.get("github_path") or format_game_folder_path(
                        platform=fresh_rec.get("platform", "manual"),
                        time_control=fresh_rec.get("time_control", ""),
                        played_at=fresh_rec.get("played_at"),
                        date_str=fresh_rec.get("date"),
                        white_player=fresh_rec.get("white_player", "White"),
                        black_player=fresh_rec.get("black_player", "Black"),
                        result=fresh_rec.get("result", "*"),
                    )
                    report_md = fresh_rec.get("report_md", "")
                    pgn_text = fresh_rec.get("pgn_text", "")
                    payload_json = fresh_rec.get("payload_json")
                    if pgn_text or payload_json:
                        report_md = reconcile_report_fens(
                            report_md, pgn_text=pgn_text, payload=payload_json
                        )
                    files = build_game_repo_files(
                        report_md=report_md,
                        pgn_text=pgn_text,
                        payload_json=payload_json,
                    )
                    gh = GitHubSyncClient(
                        token=settings.get("github_token", ""),
                        repo=settings.get("github_repo", ""),
                        branch=settings.get("github_branch", "main").strip() or "main",
                    )
                    gh.sync_game(
                        folder_path=folder,
                        files=files,
                        commit_message=f"Sync analysis: {fresh_rec.get('white_player')} vs {fresh_rec.get('black_player')} ({folder})",
                    )
                    current_hash = compute_analysis_hash(
                        report_md, pgn_text, payload_json=payload_json
                    )
                    update_analysis_github_sync(analysis_id, folder, current_hash)
            except Exception as gh_exc:
                logger.warning("Failed to auto-sync game %s to GitHub: %s", analysis_id, gh_exc)

        job["status"] = "done"
        job["analysis_id"] = analysis_id
        _emit(
            "done",
            {"analysis_id": analysis_id, "progress": 100, "message": "Analysis complete"},
        )

    except asyncio.CancelledError:
        job["status"] = "cancelled"
        _emit("error", {"message": "Analysis cancelled by user."})
        raise
    except Exception as exc:
        job["status"] = "error"
        _emit("error", {"message": str(exc)})
    finally:
        _active_game_jobs.pop(game_key, None)
        _job_tasks.pop(job_id, None)


@app.post("/api/games/analyze")
async def api_start_analysis(payload: AnalyzePayload) -> dict:
    pgn = payload.pgn.strip()
    if not pgn:
        raise HTTPException(status_code=400, detail="PGN cannot be empty")

    settings = get_settings()
    sf_path = settings.get("stockfish_path", "")
    if not os.path.isfile(sf_path) and not payload.skip_engine:
        raise HTTPException(status_code=400, detail=f"Stockfish binary not found at '{sf_path}'")

    game_key = (
        f"a-{payload.existing_analysis_id}"
        if payload.existing_analysis_id
        else f"p-{payload.pending_game_id}"
        if payload.pending_game_id
        else f"pgn-{abs(hash(pgn))}"
    )

    # If an analysis is already running for this game, cancel the older job to prevent duplicates
    if game_key in _active_game_jobs:
        old_job_id = _active_game_jobs[game_key]
        old_task = _job_tasks.get(old_job_id)
        if old_task and not old_task.done():
            old_task.cancel()
        if old_job_id in _jobs:
            _jobs[old_job_id]["status"] = "cancelled"
            _jobs[old_job_id]["events"].append(
                {"event": "error", "data": {"message": "Cancelled by newer analysis request."}}
            )

    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "running", "events": [], "analysis_id": None}
    _active_game_jobs[game_key] = job_id

    task = asyncio.create_task(
        _run_analysis_job(
            job_id,
            pgn,
            payload.side,
            payload.platform,
            payload.existing_analysis_id,
            payload.pending_game_id,
            payload.skip_engine,
        )
    )
    _job_tasks[job_id] = task
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return {"job_id": job_id}


@app.post("/api/jobs/{job_id}/cancel")
async def api_cancel_job(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    task = _job_tasks.get(job_id)
    if task and not task.done():
        task.cancel()
    job["status"] = "cancelled"
    job["events"].append({"event": "error", "data": {"message": "Analysis cancelled by user."}})
    return {"status": "cancelled", "job_id": job_id}


@app.get("/api/jobs/{job_id}/stream")
async def api_stream_job(job_id: str) -> StreamingResponse:
    if job_id not in _jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    async def _generate() -> AsyncGenerator[str, None]:
        sent = 0
        while True:
            job = _jobs.get(job_id)
            if job is None:
                break
            while sent < len(job["events"]):
                ev = job["events"][sent]
                yield f"event: {ev['event']}\ndata: {json.dumps(ev['data'])}\n\n"
                sent += 1
            if job["status"] in ("done", "error", "cancelled"):
                break
            await asyncio.sleep(0.3)

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/jobs/{job_id}")
def api_get_job(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, "status": job["status"], "analysis_id": job["analysis_id"]}


# ═══════════════════════════════════════════════════════════════════════════════
# Analysis report
# ═══════════════════════════════════════════════════════════════════════════════


@app.get("/api/analysis/{analysis_id}")
def api_get_analysis(analysis_id: int) -> dict:
    rec = get_analysis_by_id(analysis_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Analysis not found")
    rec.pop("payload", None)
    total_plies = rec.get("total_plies", 0)
    rec["total_plies"] = total_plies
    rec["moves_count"] = (total_plies + 1) // 2 if total_plies else 0
    rec["game_url"] = extract_game_url(
        rec.get("pgn_text", ""),
        rec.get("platform", ""),
        rec.get("external_id"),
    )
    if not rec.get("ply_evals") and rec.get("payload_json"):
        try:
            pj = json.loads(rec["payload_json"])
            rec["ply_evals"] = pj.get("ply_evals")
        except Exception:
            rec["ply_evals"] = None

    github_path = rec.get("github_path")
    github_synced_hash = rec.get("github_synced_hash")
    if not github_path:
        rec["github_sync_status"] = "not_synced"
    else:
        curr_hash = compute_analysis_hash(
            rec.get("report_md") or "",
            rec.get("pgn_text") or "",
            payload_json=rec.get("payload_json"),
        )
        rec["github_sync_status"] = "synced" if github_synced_hash == curr_hash else "modified"
    return rec


@app.get("/api/analysis/{analysis_id}/report-html")
def api_get_report_html(analysis_id: int) -> dict:
    """
    Pipeline:
      1. Reconcile board FENs against ground-truth game positions if needed
      2. Replace :::board{...}::: and {{BOARD:...}} markers with inline <figure> HTML
      3. Convert remaining Markdown to HTML
    """
    rec = get_analysis_by_id(analysis_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Analysis not found")
    report_md = rec.get("report_md", "")
    pgn_text = rec.get("pgn_text", "")
    payload_json = rec.get("payload_json")
    if pgn_text or payload_json:
        report_md = reconcile_report_fens(report_md, pgn_text=pgn_text, payload=payload_json)
    # Step 1: board markers → inline HTML figures (data-URI SVG)
    md_with_boards = replace_board_tags_with_html(report_md, size=380)
    # Step 2: markdown → HTML
    report_html = _md.markdown(
        md_with_boards,
        extensions=["extra", "tables", "fenced_code", "toc"],
    )
    return {"report_html": report_html, "report_md": report_md}


def append_qa_to_report_markdown(
    report_md: str,
    formal_question: str,
    answer_markdown: str,
    move_context: str,
) -> str:
    """
    Appends or creates a 'Follow-up Coaching & Deep Dives' section in report_md.
    """
    qa_block = (
        f"### Q: {formal_question.strip()}\n"
        f"**Context:** {move_context.strip()}\n\n"
        f"{answer_markdown.strip()}\n"
    )

    section_pattern = re.compile(
        r"(#+\s*(?:\d+\.\s*)?Follow-up Coaching & Deep Dives[\s\S]*?)(?=(?:\n---|\n#+\s*(?:\d+\.\s*)?Verification Report|$))",
        re.IGNORECASE,
    )
    match = section_pattern.search(report_md)
    if match:
        existing_section = match.group(1)
        updated_section = existing_section.rstrip() + "\n\n" + qa_block
        return report_md[: match.start(1)] + updated_section + report_md[match.end(1) :]

    # Find Verification Report to insert right before it
    verif_pattern = re.compile(
        r"(?:\n---\s*)?\n(#+\s*(?:\d+\.\s*)?Verification Report[\s\S]*)$", re.IGNORECASE
    )
    verif_match = verif_pattern.search(report_md)
    if verif_match:
        verif_part = verif_match.group(1)
        insertion = f"\n---\n\n# Follow-up Coaching & Deep Dives\n\n{qa_block}\n---\n\n"
        return report_md[: verif_match.start()] + insertion + verif_part

    # Fallback: append at the end
    return report_md.rstrip() + "\n\n---\n\n# Follow-up Coaching & Deep Dives\n\n" + qa_block


@app.post("/api/analysis/{analysis_id}/ask-move", response_model=AskMoveResponse)
def api_ask_move(analysis_id: int, req: AskMoveRequest) -> AskMoveResponse:
    rec = get_analysis_by_id(analysis_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Analysis not found")

    pgn_text = rec.get("pgn_text", "")
    payload_json = rec.get("payload_json")
    payload = None
    if payload_json:
        try:
            payload = GameAnalysisPayload.model_validate_json(payload_json)
        except Exception:
            pass

    settings = get_settings()
    provider = req.provider or settings.get("provider", PROVIDER_GEMINI)
    model_name = req.model_name or settings.get("model_name", "gemini-2.5-pro")

    gemini_key = settings.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    openai_key = settings.get("openai_api_key") or os.environ.get("OPENAI_API_KEY")
    openai_url = settings.get("openai_base_url")

    api_key = gemini_key if provider == PROVIDER_GEMINI else openai_key

    try:
        ans = ask_move_question(
            pgn_text=pgn_text,
            payload=payload,
            question=req.question,
            ply=req.ply,
            move_number=req.move_number,
            color=req.color,
            provider=provider,
            model_name=model_name,
            api_key=api_key,
            base_url=openai_url,
        )
        return ans
    except Exception as exc:
        logger.exception("Error in api_ask_move: %s", exc)
        raise HTTPException(status_code=400, detail=f"Failed to generate answer: {exc}") from exc


@app.post("/api/analysis/{analysis_id}/append-qa", response_model=AppendQAResponse)
def api_append_qa(analysis_id: int, req: AppendQARequest) -> AppendQAResponse:
    rec = get_analysis_by_id(analysis_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Analysis not found")

    report_md = rec.get("report_md", "")
    model_name = rec.get("model_name", "gemini-2.5-pro")

    new_report_md = append_qa_to_report_markdown(
        report_md=report_md,
        formal_question=req.formal_question,
        answer_markdown=req.answer_markdown,
        move_context=req.move_context,
    )

    # Re-render HTML with board tags and reconcile FENs
    pgn_text = rec.get("pgn_text", "")
    payload_json = rec.get("payload_json")
    if pgn_text or payload_json:
        new_report_md = reconcile_report_fens(
            new_report_md, pgn_text=pgn_text, payload=payload_json
        )

    update_analysis_report(analysis_id, new_report_md, model_name)
    md_with_boards = replace_board_tags_with_html(new_report_md, size=380)
    report_html = _md.markdown(
        md_with_boards,
        extensions=["extra", "tables", "fenced_code", "toc"],
    )

    return AppendQAResponse(
        ok=True,
        report_html=report_html,
        report_md=new_report_md,
        section_heading="Follow-up Coaching & Deep Dives",
    )


@app.get("/api/analysis/{analysis_id}/export/pdf")
def api_export_pdf(analysis_id: int) -> Response:
    rec = get_analysis_by_id(analysis_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Analysis not found")
    report_md = rec.get("report_md", "")
    pgn_text = rec.get("pgn_text", "")
    payload_json = rec.get("payload_json")
    if pgn_text or payload_json:
        report_md = reconcile_report_fens(report_md, pgn_text=pgn_text, payload=payload_json)
    pdf_bytes = export_to_pdf(replace_board_tags_with_html(report_md, size=500))
    white = rec.get("white_player", "white").replace(" ", "_")
    black = rec.get("black_player", "black").replace(" ", "_")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="chess_report_{white}_vs_{black}.pdf"'
        },
    )


@app.get("/api/analysis/{analysis_id}/export/zip")
def api_export_zip(analysis_id: int) -> Response:
    rec = get_analysis_by_id(analysis_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Analysis not found")
    report_md = rec.get("report_md", "")
    pgn_text = rec.get("pgn_text", "")
    payload_json = rec.get("payload_json")
    if pgn_text or payload_json:
        report_md = reconcile_report_fens(report_md, pgn_text=pgn_text, payload=payload_json)
    zip_bytes = build_markdown_zip(report_md, png_size=560)
    white = rec.get("white_player", "white").replace(" ", "_")
    black = rec.get("black_player", "black").replace(" ", "_")
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="chess_report_{white}_vs_{black}.zip"'
        },
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Board SVG
# ═══════════════════════════════════════════════════════════════════════════════


@app.get("/api/board")
def api_render_board(
    fen: str = Query(...),
    orientation: str = Query("white"),
    arrows: str = Query(""),
    circles: str = Query(""),
    size: int = Query(380, ge=100, le=800),
) -> Response:
    from api.board_renderer import render_board_tag

    svg = render_board_tag(
        {"fen": fen, "orientation": orientation, "arrows": arrows, "circles": circles},
        size=size,
    )
    if not svg:
        raise HTTPException(status_code=422, detail="Invalid FEN")
    return Response(content=svg, media_type="image/svg+xml")


# ═══════════════════════════════════════════════════════════════════════════════
# LLM models
# ═══════════════════════════════════════════════════════════════════════════════


@app.get("/api/llm/models")
def api_list_models() -> dict:
    settings = get_settings()
    models = list_openai_compat_models(
        base_url=settings.get("llm_base_url"),
        api_key=settings.get("llm_api_key") or None,
    )
    return {"models": models}
