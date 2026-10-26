"""
GitHub synchronization service for analyzed chess games.
Pushes reports, PGNs, PDFs, and board diagrams to a user-configured GitHub repository
using the GitHub Git Data API (atomic commits via Blobs, Trees, and Commits).
"""

from __future__ import annotations

import base64
import datetime
import re

import httpx

from api.board_renderer import (
    _BOARD_TAG_RE,
    _parse_attrs,
    render_board_tag,
    replace_board_tags_with_html,
)
from api.time_control import classify_time_control
from src.exporter import BOARD_MARKER_RE, export_to_pdf


def _slugify(text: str) -> str:
    """Sanitizes text to safe URL/path characters."""
    cleaned = re.sub(r"[^a-zA-Z0-9_\-]", "_", text.strip())
    cleaned = re.sub(r"_+", "_", cleaned)
    return cleaned.strip("_").lower() or "unknown"


def format_game_folder_path(
    platform: str,
    time_control: str,
    played_at: str | None,
    date_str: str | None,
    white_player: str,
    black_player: str,
    result: str,
) -> str:
    """
    Builds the standardized folder path for storing game assets in the repository:
    [PLATFORM]/[SPEED]/[YEAR]-[MONTH]/[DAY]-[TIME]-[PLAYER WHITE]-[PLAYER BLACK]-[WINNING SIDE]/

    Example:
        chess.com/blitz/2026-10/25-0930-tuxitop-keswic-white
    """
    # 1. Platform
    plat_lower = platform.lower()
    if "chesscom" in plat_lower or "chess.com" in plat_lower:
        platform_slug = "chess.com"
    elif "lichess" in plat_lower:
        platform_slug = "lichess.org"
    else:
        platform_slug = _slugify(platform) or "manual"

    # 2. Speed / Time Control category
    classified = classify_time_control(time_control or "", platform)
    speed_slug = (classified.get("label") or "unknown").lower()

    # 3. Date & Time
    # Expected formats: 'YYYY-MM-DD HH:MM:SS' or 'YYYY.MM.DD' or 'YYYY-MM-DD'
    year = "0000"
    month = "00"
    day = "00"
    time_part = "0000"

    raw_dt = played_at or date_str or ""
    date_match = re.search(r"(\d{4})[./-](\d{1,2})[./-](\d{1,2})", raw_dt)
    if date_match:
        year = date_match.group(1)
        month = f"{int(date_match.group(2)):02d}"
        day = f"{int(date_match.group(3)):02d}"
    else:
        now = datetime.datetime.now(datetime.UTC)
        year = str(now.year)
        month = f"{now.month:02d}"
        day = f"{now.day:02d}"

    time_match = re.search(r"(\d{1,2}):(\d{1,2})", raw_dt)
    if time_match:
        hour = int(time_match.group(1))
        minute = int(time_match.group(2))
        time_part = f"{hour:02d}{minute:02d}"

    year_month = f"{year}-{month}"

    # 4. Players
    white_slug = _slugify(white_player)
    black_slug = _slugify(black_player)

    # 5. Winning side
    res_clean = result.strip()
    if res_clean == "1-0":
        winner = "white"
    elif res_clean == "0-1":
        winner = "black"
    elif res_clean in ("1/2-1/2", "draw"):
        winner = "draw"
    else:
        winner = "unknown"

    folder_name = f"{day}-{time_part}-{white_slug}-{black_slug}-{winner}"
    return f"{platform_slug}/{speed_slug}/{year_month}/{folder_name}"


def build_game_repo_files(
    report_md: str,
    pgn_text: str,
    size: int = 400,
) -> dict[str, str | bytes]:
    """
    Transforms the coaching narrative report and game assets into a dictionary of files
    ready for committing to the repository:
      - report.md: Markdown with diagrams converted to relative SVG links (./assets/diagram_N.svg)
      - report.pdf: Complete PDF export with boards
      - game.pgn: Raw PGN string
      - assets/diagram_N.svg: Standalone SVG boards
    """
    diagram_counter = [0]
    diagram_files: dict[str, str] = {}

    def _replace_new(match: re.Match) -> str:
        attrs = _parse_attrs(match.group(1))
        caption = attrs.get("caption", "").strip()
        n = diagram_counter[0] + 1
        diagram_counter[0] = n
        filename = f"diagram_{n}.svg"

        svg_content = render_board_tag(attrs, size=size)
        if svg_content:
            diagram_files[f"assets/{filename}"] = svg_content
            alt = caption or f"Diagram {n}"
            md_ref = f"![{alt}](./assets/{filename})"
            if caption:
                md_ref += f"\n\n*{caption}*"
            return md_ref
        return f"*[Board diagram {n} unavailable]*"

    def _replace_legacy(match: re.Match) -> str:
        fen = match.group(1).strip()
        label = match.group(2).strip()
        n = diagram_counter[0] + 1
        diagram_counter[0] = n
        filename = f"diagram_{n}.svg"

        svg_content = render_board_tag({"fen": fen}, size=size)
        if svg_content:
            diagram_files[f"assets/{filename}"] = svg_content
            alt = label or f"Diagram {n}"
            md_ref = f"![{alt}](./assets/{filename})"
            if label:
                md_ref += f"\n\n*{label}*"
            return md_ref
        return f"*[Board diagram {n} unavailable]*"

    converted_md = _BOARD_TAG_RE.sub(_replace_new, report_md)
    converted_md = BOARD_MARKER_RE.sub(_replace_legacy, converted_md)

    # Generate PDF
    html_for_pdf = replace_board_tags_with_html(report_md, size=500)
    pdf_bytes = export_to_pdf(html_for_pdf)

    files: dict[str, str | bytes] = {
        "report.md": converted_md,
        "game.pgn": pgn_text.strip() + "\n",
        "report.pdf": pdf_bytes,
        **diagram_files,
    }
    return files


class GitHubSyncError(Exception):
    """Raised when GitHub synchronization fails."""


class GitHubSyncClient:
    """
    Client for syncing analyzed games to GitHub via the GitHub Git Data API.
    Handles atomic commits, branch creation, and file tree deletions.
    """

    def __init__(
        self,
        token: str,
        repo: str,
        branch: str = "main",
        client: httpx.Client | None = None,
        timeout: float = 15.0,
    ) -> None:
        self.token = token.strip()
        self.repo = repo.strip().strip("/")
        self.branch = branch.strip() or "main"
        self._external_client = client
        self.timeout = timeout
        self.base_url = f"https://api.github.com/repos/{self.repo}"
        self.headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "ChessNarrativeCoach/1.0",
        }

    def _get_client(self) -> httpx.Client:
        if self._external_client is not None:
            return self._external_client
        return httpx.Client(timeout=self.timeout, headers=self.headers)

    def test_connection(self) -> tuple[bool, str]:
        """
        Tests if the repository exists and the token has push access.
        """
        if not self.token:
            return False, "GitHub Personal Access Token is required."
        if not self.repo or "/" not in self.repo:
            return False, "Repository must be in 'owner/repo' format."

        with self._get_client() as c:
            try:
                resp = c.get(self.base_url, headers=self.headers)
            except Exception as e:
                return False, f"Network error connecting to GitHub: {e}"

            if resp.status_code == 200:
                data = resp.json()
                perms = data.get("permissions", {})
                if perms.get("push") is False:
                    return (
                        False,
                        f"Repository '{self.repo}' found, but token lacks push/write permissions.",
                    )
                return (
                    True,
                    f"Connected to '{self.repo}' (default branch: {data.get('default_branch', 'main')}).",
                )
            elif resp.status_code == 401:
                return False, "Invalid GitHub token or token has expired."
            elif resp.status_code == 404:
                return (
                    False,
                    f"Repository '{self.repo}' not found. Check repository name and token permissions.",
                )
            else:
                return False, f"GitHub returned status {resp.status_code}: {resp.text[:150]}"

    def _ensure_branch_exists(self, c: httpx.Client) -> str:
        """
        Returns the latest commit SHA on the target branch.
        If the repo is empty or branch doesn't exist, initializes it.
        """
        ref_url = f"{self.base_url}/git/ref/heads/{self.branch}"
        resp = c.get(ref_url, headers=self.headers)

        if resp.status_code == 200:
            return str(resp.json()["object"]["sha"])

        if resp.status_code in (404, 409):
            # Repository might be empty or branch doesn't exist; initialize with README
            init_url = f"{self.base_url}/contents/README.md"
            content_bytes = (
                b"# Chess Analyses Archive\n\nAutomated coaching reports generated by PlyProse.\n"
            )
            init_body = {
                "message": "Initialize PlyProse archive repository",
                "content": base64.b64encode(content_bytes).decode("ascii"),
                "branch": self.branch,
            }
            init_resp = c.put(init_url, json=init_body, headers=self.headers)
            if init_resp.status_code not in (200, 201):
                raise GitHubSyncError(
                    f"Failed to initialize repository branch '{self.branch}': {init_resp.status_code} {init_resp.text[:200]}"
                )

            # Re-fetch ref
            ref_resp2 = c.get(ref_url, headers=self.headers)
            if ref_resp2.status_code == 200:
                return str(ref_resp2.json()["object"]["sha"])
            raise GitHubSyncError(
                f"Could not retrieve branch reference after initializing: {ref_resp2.text[:200]}"
            )

        raise GitHubSyncError(
            f"Failed to query branch '{self.branch}': {resp.status_code} {resp.text[:200]}"
        )

    def _create_blob(self, c: httpx.Client, content: str | bytes) -> str:
        """Creates a Git blob and returns its SHA."""
        blobs_url = f"{self.base_url}/git/blobs"
        if isinstance(content, str):
            body = {"content": content, "encoding": "utf-8"}
        else:
            body = {
                "content": base64.b64encode(content).decode("ascii"),
                "encoding": "base64",
            }
        resp = c.post(blobs_url, json=body, headers=self.headers)
        if resp.status_code not in (200, 201):
            raise GitHubSyncError(f"Failed to create blob: {resp.status_code} {resp.text[:200]}")
        return str(resp.json()["sha"])

    def sync_game(
        self,
        folder_path: str,
        files: dict[str, str | bytes],
        commit_message: str | None = None,
    ) -> str:
        """
        Commits all files under folder_path atomically.
        Returns the new commit SHA.
        """
        clean_folder = folder_path.strip().strip("/")
        if not commit_message:
            commit_message = f"Add analysis: {clean_folder}"

        with self._get_client() as c:
            latest_commit_sha = self._ensure_branch_exists(c)

            # Get base tree
            commit_data_resp = c.get(
                f"{self.base_url}/git/commits/{latest_commit_sha}", headers=self.headers
            )
            if commit_data_resp.status_code != 200:
                raise GitHubSyncError(
                    f"Failed to fetch commit {latest_commit_sha}: {commit_data_resp.text[:200]}"
                )
            base_tree_sha = commit_data_resp.json()["tree"]["sha"]

            # Create blobs for all files
            tree_entries: list[dict[str, str]] = []
            for rel_path, content in files.items():
                blob_sha = self._create_blob(c, content)
                tree_entries.append(
                    {
                        "path": f"{clean_folder}/{rel_path}",
                        "mode": "100644",
                        "type": "blob",
                        "sha": blob_sha,
                    }
                )

            # Create tree with base_tree
            tree_resp = c.post(
                f"{self.base_url}/git/trees",
                json={"base_tree": base_tree_sha, "tree": tree_entries},
                headers=self.headers,
            )
            if tree_resp.status_code not in (200, 201):
                raise GitHubSyncError(
                    f"Failed to create tree: {tree_resp.status_code} {tree_resp.text[:200]}"
                )
            new_tree_sha = tree_resp.json()["sha"]

            # Create commit
            commit_resp = c.post(
                f"{self.base_url}/git/commits",
                json={
                    "message": commit_message,
                    "tree": new_tree_sha,
                    "parents": [latest_commit_sha],
                },
                headers=self.headers,
            )
            if commit_resp.status_code not in (200, 201):
                raise GitHubSyncError(
                    f"Failed to create commit: {commit_resp.status_code} {commit_resp.text[:200]}"
                )
            new_commit_sha = commit_resp.json()["sha"]

            # Update branch ref
            ref_resp = c.patch(
                f"{self.base_url}/git/refs/heads/{self.branch}",
                json={"sha": new_commit_sha, "force": False},
                headers=self.headers,
            )
            if ref_resp.status_code != 200:
                raise GitHubSyncError(
                    f"Failed to update ref '{self.branch}': {ref_resp.status_code} {ref_resp.text[:200]}"
                )

            return str(new_commit_sha)

    def delete_game(
        self,
        folder_path: str,
        commit_message: str | None = None,
    ) -> bool:
        """
        Removes all files under folder_path from the repository.
        Returns True if deleted or already absent.
        """
        clean_folder = folder_path.strip().strip("/")
        if not commit_message:
            commit_message = f"Remove analysis: {clean_folder}"

        with self._get_client() as c:
            # Check if branch exists
            ref_url = f"{self.base_url}/git/ref/heads/{self.branch}"
            ref_resp = c.get(ref_url, headers=self.headers)
            if ref_resp.status_code != 200:
                return True

            latest_commit_sha = str(ref_resp.json()["object"]["sha"])

            # Fetch recursive tree
            tree_url = f"{self.base_url}/git/trees/{latest_commit_sha}?recursive=1"
            tree_resp = c.get(tree_url, headers=self.headers)
            if tree_resp.status_code != 200:
                return True

            all_entries = tree_resp.json().get("tree", [])
            prefix = f"{clean_folder}/"
            remaining = [
                e
                for e in all_entries
                if not e["path"].startswith(prefix)
                and e["path"] != clean_folder
                and e["type"] == "blob"
            ]

            blob_count_before = len([e for e in all_entries if e["type"] == "blob"])
            if len(remaining) == blob_count_before:
                # Folder is not present in repo
                return True

            # Create replacement tree without the deleted items (no base_tree)
            new_tree_entries = [
                {"path": e["path"], "mode": e["mode"], "type": "blob", "sha": e["sha"]}
                for e in remaining
            ]
            new_tree_resp = c.post(
                f"{self.base_url}/git/trees",
                json={"tree": new_tree_entries},
                headers=self.headers,
            )
            if new_tree_resp.status_code not in (200, 201):
                raise GitHubSyncError(f"Failed to create deletion tree: {new_tree_resp.text[:200]}")
            new_tree_sha = new_tree_resp.json()["sha"]

            # Create commit
            commit_resp = c.post(
                f"{self.base_url}/git/commits",
                json={
                    "message": commit_message,
                    "tree": new_tree_sha,
                    "parents": [latest_commit_sha],
                },
                headers=self.headers,
            )
            if commit_resp.status_code not in (200, 201):
                raise GitHubSyncError(f"Failed to create deletion commit: {commit_resp.text[:200]}")
            new_commit_sha = commit_resp.json()["sha"]

            # Update ref
            ref_patch = c.patch(
                f"{self.base_url}/git/refs/heads/{self.branch}",
                json={"sha": new_commit_sha, "force": False},
                headers=self.headers,
            )
            return ref_patch.status_code == 200


__all__ = [
    "GitHubSyncClient",
    "GitHubSyncError",
    "build_game_repo_files",
    "format_game_folder_path",
]
