from __future__ import annotations

import io
import json
import os
import re
from typing import Any

import chess.pgn
from dotenv import load_dotenv
from google import genai
from google.genai import types

from src.inspector import extract_tactical_facts, verify_variation_tool
from src.models import AskMoveResponse, CriticalMoment, GameAnalysisPayload, TacticalFacts

load_dotenv()


def get_system_prompt(
    prompt_path: str | None = None,
    user_color: str | None = None,
    chess_level: str | None = None,
    goals: str | None = None,
) -> str:
    """
    Loads the system coaching prompt from disk and optionally populates
    player perspective placeholders.

    Args:
        prompt_path: Optional custom path to the system prompt file.
                     Defaults to prompts/system_coach.md relative to the project root.
        user_color: Optional player color ('White', 'Black', 'Both', or 'NOT SPECIFIED').
        chess_level: Optional chess level string (e.g. '1200 ELO').
        goals: Optional player improvement goals.

    Returns:
        The content of the system prompt markdown file with populated placeholders.
    """
    if prompt_path is None:
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        prompt_path = os.path.join(base_dir, "prompts", "system_coach.md")

    if not os.path.isfile(prompt_path):
        raise FileNotFoundError(f"System coach prompt not found at: {prompt_path}")

    with open(prompt_path, encoding="utf-8") as f:
        content = f.read().strip()

    if user_color is not None:
        norm_color = user_color.strip().upper()
        if norm_color in ("WHITE", "BLACK"):
            side_str = norm_color
        elif norm_color == "BOTH":
            side_str = "NOT SPECIFIED"
        else:
            side_str = norm_color
        content = content.replace("[WHITE / BLACK / NOT SPECIFIED]", side_str)

    if chess_level is not None:
        content = content.replace("[CHESS LEVEL]", chess_level)

    if goals is not None:
        content = content.replace("[OPTIONAL GOALS]", goals if goals.strip() else "None specified")

    return content


def build_coach_user_prompt(payload: GameAnalysisPayload) -> str:
    """
    Constructs the user message containing instructions and the
    verified GameAnalysisPayload JSON for Gemini / OpenAI agents.

    Args:
        payload: The GameAnalysisPayload object to serialize and include.

    Returns:
        The prompt string formatted for the coaching agent.
    """
    payload_json = payload.model_dump_json(indent=2)
    user_color_norm = (payload.user_color or "Both").strip().capitalize()

    platform_name = payload.platform or "Casual / Over-the-Board"
    date_str = payload.date or "Unknown date"
    tc_str = payload.time_control
    if payload.time_control_category:
        tc_str += f" ({payload.time_control_category})"

    w_str = f"{payload.white_player}" + (f" ({payload.white_elo})" if payload.white_elo else "")
    b_str = f"{payload.black_player}" + (f" ({payload.black_elo})" if payload.black_elo else "")

    match_facts_block = (
        "### DETERMINISTIC MATCH FACTS (USE THESE EXACT VALUES FOR SECTION 1 'Game Overview'):\n"
        f"- **Platform:** {platform_name} (DO NOT guess or write 'Platform Game', use '{platform_name}')\n"
        f"- **White Player:** {w_str}\n"
        f"- **Black Player:** {b_str}\n"
        f"- **Date:** {date_str}\n"
        f"- **Time Control:** {tc_str}\n"
        f"- **Result:** {payload.result}\n"
    )
    if payload.game_url:
        match_facts_block += f"- **Game Link:** {payload.game_url}\n"

    if user_color_norm in ("White", "Black"):
        student = payload.white_player if user_color_norm == "White" else payload.black_player
        opponent = payload.black_player if user_color_norm == "White" else payload.white_player
        opp_color = "Black" if user_color_norm == "White" else "White"
        student_rating = payload.white_elo if user_color_norm == "White" else payload.black_elo
        opp_rating = payload.black_elo if user_color_norm == "White" else payload.white_elo
        student_disp = f"{student} ({student_rating})" if student_rating else student
        opp_disp = f"{opponent} ({opp_rating})" if opp_rating else opponent

        perspective_block = (
            f"### COACHED PLAYER PERSPECTIVE (CRITICAL — YOU ARE COACHING {student.upper()} PLAYING AS {user_color_norm.upper()}):\n"
            f"- **Student / You:** {student_disp} ({user_color_norm})\n"
            f"- **Opponent:** {opp_disp} ({opp_color})\n"
            f"- **Student's Color:** {user_color_norm}\n\n"
            f"**MANDATORY PERSPECTIVE DIRECTIVES:**\n"
            f"1. **Address the student directly as 'you' / 'your'.** Refer to the opponent as '{opponent}' or 'your opponent'. Never refer to the student in the third person.\n"
            f"2. **Personalized Coaching Narrative:** Walk through the game from your student's perspective ({user_color_norm}). Explain what you did well, where your plans succeeded, where you hesitated or lost the initiative, and where you made mistakes or missed sharper tactical lines.\n"
            f'3. **Board Diagram Orientations & FENs:** Every `:::board` diagram MUST specify `orientation="{user_color_norm.lower()}"` so the student views the board from their own side. Furthermore, you MUST copy the `fen` attribute verbatim from the payload (`facts_before_move.fen` or `facts_after_played_move.fen`). NEVER modify or construct FEN strings by hand.\n'
            f"4. **Section 5 (Practical Lessons) MUST BE FOR THE USER:** Every lesson must be personal advice for YOU ({student} playing {user_color_norm}). Do NOT give lessons for the opponent's blunders! If your opponent made mistakes, teach YOU how to spot and punish those errors faster. If you made mistakes or missed wins, teach YOU how to calculate and avoid those errors in future games.\n"
            f"5. **Section 6 (What to Work on Next) MUST BE FOR THE USER:** Provide actionable training goals specifically for YOUR chess development as {user_color_norm}.\n"
        )
    else:
        perspective_block = (
            "### COACHED PLAYER PERSPECTIVE:\n"
            "- Perspective: Both sides / neutral analysis. Analyze the game objectively for both White and Black.\n"
        )

    return (
        "Please analyze the following chess game and generate the comprehensive narrative coaching report "
        "strictly adhering to your system instructions and report structure.\n\n"
        f"{match_facts_block}\n"
        f"{perspective_block}\n"
        "### Deterministically Verified Game Analysis Payload (JSON):\n"
        f"```json\n{payload_json}\n```\n\n"
        "### Instructions:\n"
        "1. Rely strictly on the verified ground truth facts provided in this payload and the match metadata above.\n"
        "2. In Section 1 'Game Overview', format the Match Details bullet using the provided Platform, players, date, time control, and result. Include the Game Link bullet: - **Game Link:** [View Game](<URL>) if a link is provided.\n"
        "3. MANDATORY CHAPTER DIAGRAMS: Every single chapter in Section 3 'Chapter-by-Chapter Analysis' MUST contain at least one `:::board` diagram block. Copy the exact `fen` verbatim from the payload (e.g. `facts_before_move.fen` or `facts_after_played_move.fen`) or `verify_variation`.\n"
        "4. MANDATORY NUMBERED MOVES: Always wrap individual chess moves and variations in backticks, "
        "and ALWAYS include the move number (e.g. `1. e4`, `3. Nc3`, `6... e5`, `19. Re6+`, `4... Nc6 5. Bb5 Bd7 6. O-O`). "
        "NEVER write bare moves without move numbers (e.g. never write `Nc3` or `e5`). "
        "Never wrap bare chessboard squares in backticks (e.g. write 'the e5 square', not `e5`). "
        "Always use ASCII dots (e.g. `4... Nc6`, never unicode ellipsis) and ASCII castling `O-O` / `O-O-O`.\n"
        "5. Whenever you discuss, recommend, or analyze any tactical defense or alternative move variation "
        "that is not already explicitly expanded in `pv_san`, you MUST call the `verify_variation_tool(fen, san_moves)` "
        "tool to verify move legality and check resulting attackers and defenders before writing about it.\n"
        "6. CONCRETE TACTICAL REFUTATIONS OVER OPENING PLATITUDES: When explaining inaccuracies, mistakes, or blunders, use `refutation_san` from the payload to explain the opponent's concrete threat or reply. NEVER recite generic opening rules (like 'blocks the c-pawn' or 'develop bishop before second knight') without checking `piece_placement` to confirm the pieces actually exist on the board!\n"
        "7. EDITORIAL APPROVAL OF MOVE CLASSIFICATIONS: In Section 4 'Critical Moments', you have final editorial authority to approve, refine, or demote classifications (Checkmate, Brilliant, Great Move, Missed Tactic, Missed Win, Blunder, Mistake, Inaccuracy, Good Move). Only moves you explicitly approve as Brilliant or Great Move in the table will receive celebratory badges on the board.\n"
        "8. MANDATORY 1-TO-1 TAG EXPLANATION & STUDENT PERSPECTIVE: In Section 7 'Game Tags & Tactical Patterns', EVERY SINGLE TAG that is assigned to this game MUST be listed and explained by you with a concrete 1-2 sentence justification citing exact move numbers (e.g. `20... Ne3`, `32... Rae8`) or clock numbers. Order them chronologically by move number. When coaching a specific player, ALL tags must strictly reflect the coached student's play (never explain opponent blunders or opponent missed wins). Remember to use `tactic:hung-piece` when the player leaves their OWN piece hanging, and `tactic:missed-hanging-piece` when the player overlooks the opponent's free piece. Use `time:time-sink` for spending > 45s with clock > 60s without a brilliant/great move. Any tag that you do not explain here will NOT be assigned to the game!\n"
        "9. Ensure all sections of the Required Report Structure are fully generated with concrete analysis tailored to the coached player."
    )


def get_coach_config(
    system_prompt: str | None = None,
    temperature: float = 0.2,
) -> types.GenerateContentConfig:
    """
    Creates the GenerateContentConfig with verify_variation_tool and system instruction.

    Args:
        system_prompt: Optional system prompt string. Defaults to get_system_prompt().
        temperature: Model temperature (default: 0.2).

    Returns:
        types.GenerateContentConfig configured for the coaching agent.
    """
    if system_prompt is None:
        system_prompt = get_system_prompt()

    return types.GenerateContentConfig(
        tools=[verify_variation_tool],
        system_instruction=system_prompt,
        temperature=temperature,
    )


def generate_deterministic_summary(
    payload: GameAnalysisPayload,
    note: str | None = None,
) -> str:
    """
    Generates a 100% verified ground-truth narrative report directly from
    the GameAnalysisPayload (Stockfish evaluations and python-chess tactical facts).
    Ensures a rich, readable report is always available even if Gemini is offline.
    """
    lines = []
    lines.append(f"# Chess Coaching Report: {payload.white_player} vs {payload.black_player}")
    lines.append("")
    if note:
        lines.append(f"> ⚠️ **Note:** {note}")
        lines.append("")

    lines.append("## 1. Game Overview")
    plat_disp = payload.platform or "Casual / Over-the-Board"
    lines.append(f"- **Platform:** {plat_disp}")
    w_line = f"{payload.white_player}" + (f" ({payload.white_elo})" if payload.white_elo else "")
    b_line = f"{payload.black_player}" + (f" ({payload.black_elo})" if payload.black_elo else "")
    lines.append(f"- **White:** {w_line}")
    lines.append(f"- **Black:** {b_line}")
    if payload.date:
        lines.append(f"- **Date:** {payload.date}")
    tc_line = payload.time_control
    if payload.time_control_category:
        tc_line += f" ({payload.time_control_category})"
    lines.append(f"- **Time Control:** {tc_line}")
    lines.append(f"- **Result:** {payload.result}")
    if payload.game_url:
        lines.append(f"- **Game Link:** [View on {plat_disp}]({payload.game_url})")
    if payload.opening_name:
        lines.append(f"- **Opening:** {payload.opening_name}")
    lines.append(f"- **Total Plies:** {payload.total_plies}")
    lines.append(f"- **Critical Moments Detected:** {len(payload.critical_moments)}")
    lines.append("")

    lines.append("## 2. Mainline Game Moves")
    lines.append(f"```text\n{payload.pgn_moves_summary}\n```")
    lines.append("")

    lines.append("## 3. Critical Moments Analysis")
    if not payload.critical_moments:
        lines.append(
            "No major blunders, mistakes, or inaccuracies (>= 80cp loss or mate changes) were detected. Solid play throughout!"
        )
    else:
        lines.append(
            "| Move | Ply | Color | Move Played | Evaluation Change | Classification | Best Move | Engine PV |"
        )
        lines.append("|---|---|---|---|---|---|---|---|")
        for m in payload.critical_moments:
            before_str = (
                f"{m.eval_before_cp / 100:+.2f}"
                if m.eval_before_cp is not None
                else (f"M{m.mate_before:+d}" if m.mate_before else "Mate")
            )
            after_str = (
                f"{m.eval_after_cp / 100:+.2f}"
                if m.eval_after_cp is not None
                else (f"M{m.mate_after:+d}" if m.mate_after else "Mate")
            )
            eval_change = f"{before_str} → {after_str}"
            pv_str = " ".join(m.pv_san[:4]) if m.pv_san else "-"
            lines.append(
                f"| {m.move_number} | {m.ply} | {m.color} | **{m.move_played_san}** | {eval_change} | **{m.classification}** | `{m.best_move_san}` | `{pv_str}` |"
            )
        lines.append("")

        lines.append("## 4. Concrete Tactical Breakdown")
        for i, m in enumerate(payload.critical_moments, start=1):
            before_eval = (
                f"{m.eval_before_cp / 100:+.2f}" if m.eval_before_cp is not None else "Mate"
            )
            after_eval = f"{m.eval_after_cp / 100:+.2f}" if m.eval_after_cp is not None else "Mate"
            lines.append(
                f"### Moment {i}: Move {m.move_number} ({m.color}) — {m.classification} (`{m.move_played_san}`)"
            )
            lines.append(
                f"- **Move Played:** `{m.move_played_san}` (Evaluation shifted from {before_eval} to {after_eval})"
            )
            lines.append(
                f"- **Stockfish Best Move:** `{m.best_move_san}` (Continuation: `{' '.join(m.pv_san)}`)"
            )
            if m.facts_before_move.hanging_pieces:
                lines.append(
                    f"- **Hanging pieces before move:** {', '.join(m.facts_before_move.hanging_pieces)}"
                )
            if m.facts_after_played_move.hanging_pieces:
                lines.append(
                    f"- **Hanging pieces created after move:** {', '.join(m.facts_after_played_move.hanging_pieces)}"
                )

            attacked = [
                p.piece for p in m.facts_after_played_move.attacked_or_pinned_pieces if p.attackers
            ]
            if attacked:
                lines.append(f"- **Pieces under attack after move:** {', '.join(attacked[:4])}")
            lines.append("")

    lines.append("## 5. Practical Lessons")
    if payload.critical_moments:
        lines.append(
            "1. **Calculate forcing opponent responses:** Before playing an aggressive move, ensure your king and key defenders are secure."
        )
        lines.append(
            "2. **Look for hanging pieces:** Check whether candidate moves leave friendly pieces undefended."
        )
        lines.append(
            "3. **Compare actual move with engine best move:** Analyze why Stockfish prioritizes alternative development or defensive resources."
        )
    else:
        lines.append(
            "1. Maintain tactical vigilance and continue practicing disciplined piece coordination."
        )

    return "\n".join(lines)


def extract_upfront_annotations_from_report(report_md: str) -> dict[str, str]:
    """
    Extracts move-specific annotations from the coaching report.
    Looks for bullets like:
      - `12. a3`: Prophylactic move preventing Black's ...Nb4 jump.
      - `14... Rxe5`: Premature sacrifice; better was 14... Be6.
    """
    annotations: dict[str, str] = {}
    if not report_md:
        return annotations

    pattern = re.compile(
        r"^[ \t]*-[ \t]*`([0-9]+\.{1,3}\s*[A-Za-z0-9+#=\-]+)`:[ \t]*(.+)$",
        re.MULTILINE,
    )
    for match in pattern.finditer(report_md):
        move_key = match.group(1).strip()
        comment = match.group(2).strip()
        comment = comment.strip("\"*'")
        if move_key and comment:
            norm_key = re.sub(r"([0-9]+(?:\.{1,3}))\s*", r"\1 ", move_key)
            annotations[norm_key] = comment
            annotations[move_key] = comment

    return annotations


def inject_annotations_into_pgn(pgn_str: str, annotations: dict[str, str]) -> str:
    """
    Injects move annotations into the PGN as standard comments prefixed with ✨.
    Preserves existing [%clk ...] or [%eval ...] comments cleanly.
    """
    if not pgn_str or not annotations:
        return pgn_str

    try:
        game = chess.pgn.read_game(io.StringIO(pgn_str))
    except Exception:
        return pgn_str

    if not game:
        return pgn_str

    node: chess.pgn.GameNode = game
    board = game.board()
    while node.variations:
        next_node = node.variation(0)
        move_num = board.fullmove_number
        is_black = board.turn == chess.BLACK
        san = next_node.san()
        san_key_spaced = f"{move_num}. {san}" if not is_black else f"{move_num}... {san}"
        san_key_tight = f"{move_num}.{san}" if not is_black else f"{move_num}...{san}"

        comment = annotations.get(san_key_spaced) or annotations.get(san_key_tight)
        if comment:
            clean_comment = comment.strip()
            if not clean_comment.startswith("✨"):
                clean_comment = f"✨ {clean_comment}"
            existing = (next_node.comment or "").strip()
            if clean_comment not in existing:
                if existing:
                    next_node.comment = f"{existing} {clean_comment}"
                else:
                    next_node.comment = clean_comment

        board.push(next_node.move)
        node = next_node

    exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
    return str(game.accept(exporter)).strip()


def generate_narrative_report(
    payload: GameAnalysisPayload,
    model_name: str = "gemini-2.5-pro",
    api_key: str | None = None,
    client: genai.Client | None = None,
    system_prompt: str | None = None,
) -> str:
    """
    Generates a narrative coaching report for the given GameAnalysisPayload using Gemini.
    Uses Chat.send_message for Automatic Function Calling (AFC) support so verify_variation_tool
    is automatically executed and incorporated by Gemini.

    Falls back to a verified deterministic coaching report if Gemini is unreachable or returns empty text.

    Args:
        payload: GameAnalysisPayload containing deterministic game facts and critical moments.
        model_name: Gemini model name (default: "gemini-2.5-pro").
        api_key: Optional Gemini API key. If not provided, reads from environment variable.
        client: Optional pre-configured genai.Client instance (useful for testing and injection).
        system_prompt: Optional customized system prompt string.

    Returns:
        The generated markdown coaching narrative report string.
    """
    if client is None:
        key = api_key or os.environ.get("GEMINI_API_KEY")
        if not key:
            raise ValueError(
                "GEMINI_API_KEY is not set. Please provide api_key or set the "
                "GEMINI_API_KEY environment variable."
            )
        client = genai.Client(api_key=key)

    if system_prompt is None:
        side_label = (
            payload.user_color.upper()
            if payload.user_color in ("White", "Black")
            else "NOT SPECIFIED"
        )
        system_prompt = get_system_prompt(user_color=side_label)

    config = get_coach_config(system_prompt=system_prompt)
    user_prompt = build_coach_user_prompt(payload)

    try:
        # Use Chat.send_message for automatic multi-turn function calling (AFC)
        if hasattr(client, "chats") and hasattr(client.chats, "create"):
            chat = client.chats.create(model=model_name, config=config)
            response = chat.send_message(user_prompt)
        else:
            response = client.models.generate_content(
                model=model_name,
                contents=user_prompt,
                config=config,
            )

        # Extract text from response or candidates
        report_text = getattr(response, "text", None) or ""
        if isinstance(report_text, str) and report_text.strip():
            return report_text.strip()

        for cand in getattr(response, "candidates", []) or []:
            content = getattr(cand, "content", None)
            if content:
                for part in getattr(content, "parts", []) or []:
                    txt = getattr(part, "text", "")
                    if txt and isinstance(txt, str) and not getattr(part, "thought", False):
                        report_text += txt

        if isinstance(report_text, str) and report_text.strip():
            return report_text.strip()

        # If model returned no text (e.g. AFC tool call loop without final turn), fallback to deterministic summary
        return generate_deterministic_summary(
            payload,
            note="Gemini generated an empty narrative; falling back to 100% verified Stockfish & tactical facts report.",
        )

    except Exception as exc:
        # Graceful fallback: return deterministic verified report with note
        return generate_deterministic_summary(
            payload,
            note=f"Gemini API narrative generation unavailable ({exc}). Displaying verified Stockfish analysis & tactical facts.",
        )


PRIORITY_GEMINI_MODELS: list[str] = [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.1-pro-preview",
]

DEFAULT_GEMINI_MODELS: list[str] = [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
]

NON_TEXT_KEYWORDS: set[str] = {
    "embedding",
    "tts",
    "imagen",
    "image",
    "live",
    "audio",
    "realtime",
    "aqa",
    "whisper",
}


def get_available_gemini_models(
    api_key: str | None = None,
    client: genai.Client | None = None,
) -> list[str]:
    """
    Dynamically fetches available text-capable Gemini models using genai.Client().models.list(),
    prioritizing gemini-3.8-flash, gemini-3.7-flash, and gemini-3.1-pro-preview at the top,
    and filtering out non-text models (embeddings, TTS, image generation, audio, live).
    Falls back gracefully to a curated default list if the API call fails or is offline.

    Args:
        api_key: Optional Gemini API key. Defaults to GEMINI_API_KEY environment variable.
        client: Optional pre-configured genai.Client instance.

    Returns:
        List of clean model name strings.
    """
    try:
        if client is None:
            key = api_key or os.environ.get("GEMINI_API_KEY")
            if not key:
                return list(DEFAULT_GEMINI_MODELS)
            client = genai.Client(api_key=key)

        discovered: list[str] = []
        for model in client.models.list():
            raw_name = getattr(model, "name", "") or ""
            clean_name = raw_name[7:] if raw_name.startswith("models/") else raw_name
            clean_name_lower = clean_name.lower()

            # Must be a Gemini model
            if "gemini" not in clean_name_lower:
                continue

            # Check supported_actions if present
            actions = getattr(model, "supported_actions", None)
            if actions and "generateContent" not in actions:
                continue

            # Filter out non-text / specialized models
            display_name = (getattr(model, "display_name", "") or "").lower()
            if any(kw in clean_name_lower or kw in display_name for kw in NON_TEXT_KEYWORDS):
                continue

            discovered.append(clean_name)

        if not discovered:
            return list(DEFAULT_GEMINI_MODELS)

        ordered: list[str] = []
        for p in PRIORITY_GEMINI_MODELS:
            ordered.append(p)

        for d in discovered:
            if d not in ordered:
                ordered.append(d)

        return ordered

    except Exception:
        return list(DEFAULT_GEMINI_MODELS)


def probe_gemini_connection(
    api_key: str | None = None,
    client: genai.Client | None = None,
) -> tuple[bool, str]:
    """
    Validates Gemini connectivity and API key validity.
    Returns (True, message) on success, (False, error_message) on failure.
    """
    key = api_key or os.environ.get("GEMINI_API_KEY")
    if not key and client is None:
        return False, "Gemini API key is required. Please enter an API key in Settings."
    try:
        if client is None:
            client = genai.Client(api_key=key)
        _ = next(iter(client.models.list()))
        return True, "Successfully connected to Google Gemini."
    except Exception as exc:
        return False, f"Google Gemini connection failed: {exc}"


def extract_move_qa_context(
    pgn_text: str,
    payload: GameAnalysisPayload | None,
    ply: int | None = None,
    move_number: int | None = None,
    color: str | None = None,
) -> dict[str, Any]:
    """
    Extracts deterministic board facts, engine critical moments, and context
    for any move in a chess game.
    """
    if not pgn_text.strip():
        raise ValueError("PGN text is empty")

    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if not game:
        raise ValueError("Could not parse PGN text")

    if ply is not None and ply > 0:
        target_ply = ply
        calc_move_num = (target_ply + 1) // 2
        calc_color = "White" if (target_ply % 2 != 0) else "Black"
    elif move_number is not None and move_number > 0:
        norm_color = (color or "White").strip().capitalize()
        target_ply = (move_number - 1) * 2 + (2 if norm_color == "Black" else 1)
        calc_move_num = move_number
        calc_color = norm_color
    else:
        raise ValueError("Either ply or move_number must be provided")

    board = game.board()
    board_before = board.copy()
    current_ply = 0
    move_played_san = ""
    target_move = None

    for move in game.mainline_moves():
        current_ply += 1
        if current_ply == target_ply:
            board_before = board.copy()
            move_played_san = board_before.san(move)
            target_move = move
            board.push(move)
            break
        board.push(move)

    if target_move is None or current_ply != target_ply:
        raise ValueError(f"Move at ply {target_ply} does not exist in this game")

    facts_before = extract_tactical_facts(board_before)
    facts_after = extract_tactical_facts(board)

    matched_cm: CriticalMoment | None = None
    if payload and payload.critical_moments:
        for cm in payload.critical_moments:
            if cm.ply == target_ply or (cm.move_number == calc_move_num and cm.color == calc_color):
                matched_cm = cm
                break

    student_color = (payload.user_color if payload else "Both") or "Both"
    if student_color == "White":
        student_name = payload.white_player if payload else "You"
        opponent_name = payload.black_player if payload else "Opponent"
    elif student_color == "Black":
        student_name = payload.black_player if payload else "You"
        opponent_name = payload.white_player if payload else "Opponent"
    else:
        student_name = "You"
        opponent_name = "Opponent"

    dot_str = "." if calc_color == "White" else "..."
    move_context = (
        f"Move {calc_move_num} ({calc_move_num}{dot_str} {move_played_san}) · {calc_color} to play"
    )

    return {
        "ply": target_ply,
        "move_number": calc_move_num,
        "color": calc_color,
        "move_played_san": move_played_san,
        "move_context": move_context,
        "fen_before": board_before.fen(),
        "fen_after": board.fen(),
        "facts_before": facts_before,
        "facts_after": facts_after,
        "critical_moment": matched_cm,
        "student_color": student_color,
        "student_name": student_name,
        "opponent_name": opponent_name,
    }


def build_move_qa_prompt(context: dict[str, Any], user_question: str) -> str:
    move_num = context["move_number"]
    color = context["color"]
    played_san = context["move_played_san"]
    dot_str = "." if color == "White" else "..."
    cm: CriticalMoment | None = context.get("critical_moment")
    facts_before: TacticalFacts = context["facts_before"]
    facts_after: TacticalFacts = context["facts_after"]

    cm_details = ""
    if cm:
        cm_details = (
            f"- Move Classification: {cm.classification}\n"
            f"- Evaluation shift: {cm.eval_before_cp} -> {cm.eval_after_cp} centipawns\n"
            f"- Engine Best Move: {cm.best_move_san}\n"
            f"- Engine Recommended Continuation (PV): {' '.join(cm.pv_san)}\n"
            f"- Opponent Refutation: {' '.join(cm.refutation_san)}\n"
        )

    return (
        f"You are the verified chess coach analyzing a student's game. Student: {context['student_name']} ({context['student_color']}).\n"
        f"The student is examining Move {move_num}{dot_str} {played_san} and asking for coaching clarification.\n\n"
        f"### GROUND TRUTH POSITION FACTS:\n"
        f"- Move Examined: {move_num}{dot_str} {played_san} ({color})\n"
        f"- FEN Before Move: {context['fen_before']}\n"
        f"- FEN After Move: {context['fen_after']}\n"
        f"{cm_details}"
        f"- Hanging pieces before move: {', '.join(facts_before.hanging_pieces) or 'None'}\n"
        f"- Hanging pieces after move: {', '.join(facts_after.hanging_pieces) or 'None'}\n\n"
        f"### STUDENT'S QUESTION:\n"
        f'"{user_question}"\n\n'
        f"### COACHING DIRECTIVES:\n"
        f"1. Address the student directly as 'you' / 'your'. Explain what happened concretely on the board.\n"
        f"2. MANDATORY RULE F: ALWAYS include move numbers in backticks for EVERY move mentioned (e.g. `{move_num}{dot_str} {played_san}`, `{move_num}{dot_str} ...`). NEVER write bare moves without move numbers. Do NOT wrap bare squares in backticks (write 'the e5 square', 'on d4'). Use standard ASCII dots and O-O castling.\n"
        f"3. Generate an educational question title in `formal_question` that concisely phrases the question for coaching notes.\n"
        f"4. Provide the thorough coaching answer in `answer_markdown` with clear bullet points explaining the tactical mechanism, the better alternative, and the key calculation/pattern takeaway for future games.\n"
        f"5. RETURN ONLY A VALID JSON OBJECT with these exact keys:\n"
        f'{{\n  "formal_question": "...",\n  "answer_markdown": "..."\n}}'
    )


def _parse_qa_json_block(
    raw_text: str, context: dict[str, Any], user_question: str
) -> AskMoveResponse:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    cleaned = cleaned.strip()

    try:
        data = json.loads(cleaned)
        formal_q = str(data.get("formal_question") or "").strip()
        answer = str(data.get("answer_markdown") or "").strip()
        if formal_q and answer:
            return AskMoveResponse(
                formal_question=formal_q,
                answer_markdown=answer,
                move_context=context["move_context"],
                ply=context["ply"],
                move_number=context["move_number"],
                color=context["color"],
            )
    except Exception:
        pass

    return generate_deterministic_move_answer(context, user_question)


def generate_deterministic_move_answer(
    context: dict[str, Any],
    user_question: str,
) -> AskMoveResponse:
    move_num = context["move_number"]
    color = context["color"]
    played_san = context["move_played_san"]
    dot_str = "." if color == "White" else "..."
    move_prefix = f"`{move_num}{dot_str} {played_san}`"
    cm: CriticalMoment | None = context.get("critical_moment")
    facts_before: TacticalFacts = context["facts_before"]
    facts_after: TacticalFacts = context["facts_after"]

    if cm and cm.best_move_san:
        classification = cm.classification or "Suboptimal"
        formal_question = (
            f"Why is {move_num}{dot_str} {played_san} considered a {classification.lower()} "
            f"instead of {cm.best_move_san}, and what pattern applies?"
        )
    else:
        formal_question = f"What are the key tactical and positional considerations behind {move_num}{dot_str} {played_san}?"

    lines: list[str] = []
    if cm:
        before_eval = f"{cm.eval_before_cp / 100:+.2f}" if cm.eval_before_cp is not None else "even"
        after_eval = f"{cm.eval_after_cp / 100:+.2f}" if cm.eval_after_cp is not None else "even"
        lines.append(
            f"- **Tactical Reality of the Move:** You played {move_prefix}, shifting the engine evaluation "
            f"from `{before_eval}` to `{after_eval}` ({cm.classification})."
        )
        if cm.best_move_san:
            pv_continuation = f" (continuation: `{' '.join(cm.pv_san[:4])}`)" if cm.pv_san else ""
            lines.append(
                f"- **The Recommended Alternative:** Stockfish prefers `{cm.move_number}{dot_str} {cm.best_move_san}`{pv_continuation}."
            )
        if cm.refutation_san:
            lines.append(
                f"- **Opponent's Tactical Punishment:** The played move allowed the opponent to respond with "
                f"`{' '.join(cm.refutation_san[:3])}`, seizing tactical counterplay."
            )
    else:
        lines.append(f"- **Move Overview:** {move_prefix} was played from `{facts_before.fen}`.")

    if facts_before.hanging_pieces:
        lines.append(f"- **Hanging Pieces Before Move:** {', '.join(facts_before.hanging_pieces)}.")
    if facts_after.hanging_pieces:
        lines.append(
            f"- **Hanging Pieces Created After Move:** {', '.join(facts_after.hanging_pieces)}."
        )

    lines.append(
        "- **Key Principle for Next Time:** When under tactical tension, look to resolve threats against your pieces first, "
        "and calculate forcing checks, captures, and opponent removals of the guard before playing committing pawn moves or piece trades."
    )

    answer_markdown = "\n\n".join(lines)

    return AskMoveResponse(
        formal_question=formal_question,
        answer_markdown=answer_markdown,
        move_context=context["move_context"],
        ply=context["ply"],
        move_number=move_num,
        color=color,
    )


def ask_move_question_gemini(
    context: dict[str, Any],
    user_question: str,
    model_name: str = "gemini-2.5-pro",
    api_key: str | None = None,
    client: object | None = None,
) -> AskMoveResponse:
    """
    Answers a question about a specific move using Gemini with ground-truth facts.
    """
    prompt = build_move_qa_prompt(context, user_question)

    if client is None:
        key = api_key or os.environ.get("GEMINI_API_KEY")
        if not key:
            return generate_deterministic_move_answer(context, user_question)
        client = genai.Client(api_key=key)

    try:
        config = get_coach_config()
        if hasattr(client, "models") and hasattr(client.models, "generate_content"):
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=config,
            )
            raw_text = getattr(response, "text", None) or ""
            if raw_text.strip():
                return _parse_qa_json_block(raw_text, context, user_question)
    except Exception:
        pass

    return generate_deterministic_move_answer(context, user_question)


__all__ = [
    "DEFAULT_GEMINI_MODELS",
    "PRIORITY_GEMINI_MODELS",
    "ask_move_question_gemini",
    "build_coach_user_prompt",
    "build_move_qa_prompt",
    "extract_move_qa_context",
    "extract_upfront_annotations_from_report",
    "generate_deterministic_move_answer",
    "generate_deterministic_summary",
    "generate_narrative_report",
    "get_available_gemini_models",
    "get_coach_config",
    "get_system_prompt",
    "inject_annotations_into_pgn",
    "probe_gemini_connection",
]
