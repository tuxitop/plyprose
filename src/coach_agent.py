from __future__ import annotations

import os

from dotenv import load_dotenv
from google import genai
from google.genai import types

from src.inspector import verify_variation_tool
from src.models import GameAnalysisPayload

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
        "4. MONOSPACE MOVES: Always wrap individual chess moves, candidate moves, and variations in backticks (e.g. `1. e4`, `Nf3`, `12... cxd4`, `O-O`) so they render in distinct monospace font.\n"
        "5. Whenever you discuss, recommend, or analyze any tactical defense or alternative move variation "
        "that is not already explicitly expanded in `pv_san`, you MUST call the `verify_variation_tool(fen, san_moves)` "
        "tool to verify move legality and check resulting attackers and defenders before writing about it.\n"
        "6. CONCRETE TACTICAL REFUTATIONS OVER OPENING PLATITUDES: When explaining inaccuracies, mistakes, or blunders, use `refutation_san` from the payload to explain the opponent's concrete threat or reply. NEVER recite generic opening rules (like 'blocks the c-pawn' or 'develop bishop before second knight') without checking `piece_placement` to confirm the pieces actually exist on the board!\n"
        "7. Ensure all sections of the Required Report Structure are fully generated with concrete analysis tailored to the coached player."
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


__all__ = [
    "DEFAULT_GEMINI_MODELS",
    "PRIORITY_GEMINI_MODELS",
    "build_coach_user_prompt",
    "generate_deterministic_summary",
    "generate_narrative_report",
    "get_available_gemini_models",
    "get_coach_config",
    "get_system_prompt",
]
