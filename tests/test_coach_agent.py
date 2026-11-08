import json
from unittest.mock import MagicMock, patch

import pytest
from google.genai import types

from src.coach_agent import (
    annotate_single_move_gemini,
    build_coach_user_prompt,
    build_move_annotation_prompt,
    extract_move_qa_context,
    extract_upfront_annotations_from_report,
    generate_narrative_report,
    get_coach_config,
    get_system_prompt,
    inject_annotations_into_pgn,
    probe_gemini_connection,
)
from src.inspector import verify_variation_tool
from src.models import CriticalMoment, GameAnalysisPayload


@pytest.fixture
def sample_payload() -> GameAnalysisPayload:
    return GameAnalysisPayload(
        white_player="Magnus Carlsen",
        black_player="Hikaru Nakamura",
        user_color="Both",
        result="1-0",
        time_control="180+2",
        opening_name="B01: Scandinavian Defense",
        pgn_moves_summary="1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5",
        total_plies=6,
        critical_moments=[],
    )


def test_get_system_prompt():
    prompt = get_system_prompt()
    assert isinstance(prompt, str)
    assert len(prompt) > 100
    assert "Role: Verified Chess Analyst and Narrative Coach" in prompt
    assert "verify_variation_tool" in prompt
    assert "## Non-Negotiable Verification Rules" in prompt
    assert "## Required Report Structure" in prompt


def test_get_system_prompt_with_side_and_level():
    prompt = get_system_prompt(
        user_color="White", chess_level="1500 ELO", goals="Master endgame conversion"
    )
    assert "- **My playing color:** `WHITE`" in prompt
    assert "- **My chess level:** `1500 ELO`" in prompt
    assert "- **My improvement goals:** `Master endgame conversion`" in prompt


def test_build_coach_user_prompt(sample_payload: GameAnalysisPayload):
    user_prompt = build_coach_user_prompt(sample_payload)
    assert isinstance(user_prompt, str)
    assert "Magnus Carlsen" in user_prompt
    assert "Hikaru Nakamura" in user_prompt
    assert "Scandinavian Defense" in user_prompt
    assert "verify_variation_tool(fen, san_moves)" in user_prompt

    # Verify JSON structure is valid inside the prompt
    start_tag = "```json\n"
    end_tag = "\n```"
    assert start_tag in user_prompt
    assert end_tag in user_prompt
    json_chunk = user_prompt.split(start_tag)[1].split(end_tag)[0]
    parsed = json.loads(json_chunk)
    assert parsed["white_player"] == "Magnus Carlsen"
    assert parsed["black_player"] == "Hikaru Nakamura"
    assert parsed["total_plies"] == 6


def test_build_coach_user_prompt_side_perspective(sample_payload: GameAnalysisPayload):
    # Test White perspective
    sample_payload.user_color = "White"
    white_prompt = build_coach_user_prompt(sample_payload)
    assert "COACHED PLAYER PERSPECTIVE" in white_prompt
    assert "YOU ARE COACHING MAGNUS CARLSEN PLAYING AS WHITE" in white_prompt
    assert "Address the student directly as 'you' / 'your'" in white_prompt
    assert "Section 5 (Practical Lessons) MUST BE FOR THE USER" in white_prompt
    assert 'orientation="white"' in white_prompt

    # Test Black perspective
    sample_payload.user_color = "Black"
    black_prompt = build_coach_user_prompt(sample_payload)
    assert "COACHED PLAYER PERSPECTIVE" in black_prompt
    assert "YOU ARE COACHING HIKARU NAKAMURA PLAYING AS BLACK" in black_prompt
    assert 'orientation="black"' in black_prompt


def test_get_coach_config():
    config = get_coach_config()
    assert isinstance(config, types.GenerateContentConfig)
    assert config.temperature == 0.2
    assert config.tools is not None
    assert verify_variation_tool in config.tools
    assert "Role: Verified Chess Analyst" in str(config.system_instruction)


def test_generate_narrative_report_with_mock_client(sample_payload: GameAnalysisPayload):
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = (
        "# Narrative Coaching Report\n\nMagnus capitalized on black's passive setup."
    )
    mock_chat = MagicMock()
    mock_chat.send_message.return_value = mock_response
    mock_client.chats.create.return_value = mock_chat

    report = generate_narrative_report(
        payload=sample_payload,
        model_name="gemini-2.5-pro",
        client=mock_client,
    )

    assert report == "# Narrative Coaching Report\n\nMagnus capitalized on black's passive setup."
    mock_client.chats.create.assert_called_once()
    mock_chat.send_message.assert_called_once()
    call_kwargs = mock_client.chats.create.call_args.kwargs
    assert call_kwargs["model"] == "gemini-2.5-pro"
    config = call_kwargs["config"]
    assert isinstance(config, types.GenerateContentConfig)
    assert config.temperature == 0.2
    assert verify_variation_tool in config.tools


def test_generate_narrative_report_fallback_generate_content(sample_payload: GameAnalysisPayload):
    mock_client = MagicMock()
    del mock_client.chats
    mock_response = MagicMock()
    mock_response.text = "# Narrative Coaching Report from generate_content"
    mock_client.models.generate_content.return_value = mock_response

    report = generate_narrative_report(
        payload=sample_payload,
        model_name="gemini-2.5-pro",
        client=mock_client,
    )

    assert report == "# Narrative Coaching Report from generate_content"
    mock_client.models.generate_content.assert_called_once()


def test_generate_narrative_report_empty_text_fallback(sample_payload: GameAnalysisPayload):
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = ""
    mock_response.candidates = []
    mock_chat = MagicMock()
    mock_chat.send_message.return_value = mock_response
    mock_client.chats.create.return_value = mock_chat

    report = generate_narrative_report(
        payload=sample_payload,
        model_name="gemini-2.5-pro",
        client=mock_client,
    )

    assert "Magnus Carlsen" in report
    assert "Hikaru Nakamura" in report
    assert "Game Overview" in report


def test_generate_narrative_report_exception_fallback(sample_payload: GameAnalysisPayload):
    mock_client = MagicMock()
    mock_client.chats.create.side_effect = RuntimeError("API quota exceeded")
    mock_client.models.generate_content.side_effect = RuntimeError("API quota exceeded")

    report = generate_narrative_report(
        payload=sample_payload,
        model_name="gemini-2.5-pro",
        client=mock_client,
    )

    assert "Gemini API narrative generation unavailable" in report
    assert "Magnus Carlsen" in report


def test_generate_narrative_report_missing_api_key(sample_payload: GameAnalysisPayload):
    with patch.dict("os.environ", {}, clear=True):
        with pytest.raises(ValueError, match="GEMINI_API_KEY is not set"):
            generate_narrative_report(sample_payload, api_key=None, client=None)


def test_get_available_gemini_models_fallback():
    from src.coach_agent import PRIORITY_GEMINI_MODELS, get_available_gemini_models

    models = get_available_gemini_models(api_key="invalid_test_key")
    assert isinstance(models, list)
    assert len(models) >= 3
    # Priority models must be at the top
    assert models[:3] == PRIORITY_GEMINI_MODELS


def test_get_available_gemini_models_filtering():
    from src.coach_agent import get_available_gemini_models

    mock_client = MagicMock()

    # Create dummy Model objects
    class DummyModel:
        def __init__(self, name, supported_actions=None, display_name=""):
            self.name = name
            self.supported_actions = supported_actions or ["generateContent"]
            self.display_name = display_name

    mock_models = [
        DummyModel("models/gemini-2.5-pro"),
        DummyModel("models/text-embedding-004", supported_actions=["embedContent"]),
        DummyModel("models/imagen-3.0", display_name="Image generation"),
        DummyModel("models/gemini-3.8-flash"),
        DummyModel("models/gemini-2.5-flash-tts", display_name="TTS Model"),
        DummyModel("models/gemini-3.7-flash"),
        DummyModel("models/gemini-2.5-flash"),
    ]
    mock_client.models.list.return_value = mock_models

    models = get_available_gemini_models(client=mock_client)

    # Priority models must be at the very top
    assert models[0] == "gemini-3.8-flash"
    assert models[1] == "gemini-3.7-flash"
    assert models[2] == "gemini-3.1-pro-preview"

    # Non-text models must be filtered out
    for m in models:
        assert "embedding" not in m
        assert "imagen" not in m
        assert "tts" not in m

    # Remaining models included
    assert "gemini-2.5-pro" in models
    assert "gemini-2.5-flash" in models


def test_generate_deterministic_summary(sample_payload: GameAnalysisPayload):
    import chess

    from src.coach_agent import generate_deterministic_summary
    from src.inspector import extract_tactical_facts
    from src.models import CriticalMoment

    # 1. Without critical moments
    summary = generate_deterministic_summary(sample_payload, note="Test Note")
    assert "Test Note" in summary
    assert sample_payload.white_player in summary
    assert sample_payload.black_player in summary
    assert "## 1. Game Overview" in summary
    assert "## 2. Mainline Game Moves" in summary
    assert "## 3. Critical Moments Analysis" in summary
    assert "## 5. Practical Lessons" in summary

    # 2. With critical moment
    board = chess.Board()
    facts = extract_tactical_facts(board)
    moment = CriticalMoment(
        ply=7,
        move_number=4,
        color="Black",
        move_played_san="Nf6",
        eval_before_cp=100,
        eval_after_cp=-900,
        mate_before=None,
        mate_after=1,
        classification="Blunder",
        best_move_san="Qe7",
        pv_san=["Qe7", "Nf3"],
        facts_before_move=facts,
        facts_after_played_move=facts,
        facts_after_best_move=facts,
        facts_at_end_of_pv=facts,
    )
    sample_payload.critical_moments = [moment]
    summary_with_moment = generate_deterministic_summary(sample_payload)
    assert "| 4 | 7 | Black | **Nf6** |" in summary_with_moment
    assert "**Blunder**" in summary_with_moment
    assert "### Moment 1: Move 4 (Black) — Blunder (`Nf6`)" in summary_with_moment


def test_system_prompt_rule_f_numbered_moves():
    prompt = get_system_prompt()
    assert "### Rule F — Mandatory Move Numbers, Monospace Styling & Square Distinction" in prompt
    assert "ALWAYS Include Move Numbers" in prompt
    assert "STRICT PROHIBITION ON BARE MOVE NAMES" in prompt
    assert "Distinguish Squares from Moves" in prompt
    assert "Standard ASCII Chess Notation" in prompt


def test_build_coach_user_prompt_numbered_moves(sample_payload: GameAnalysisPayload):
    user_prompt = build_coach_user_prompt(sample_payload)
    assert "MANDATORY NUMBERED MOVES" in user_prompt
    assert "ALWAYS include the move number" in user_prompt
    assert "NEVER write bare moves without move numbers" in user_prompt


def test_probe_gemini_connection_no_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    ok, msg = probe_gemini_connection(api_key=None)
    assert ok is False
    assert "Gemini API key is required" in msg


def test_probe_gemini_connection_success():
    mock_client = MagicMock()
    mock_model = MagicMock()
    mock_model.name = "models/gemini-2.5-flash"
    mock_client.models.list.return_value = [mock_model]

    ok, msg = probe_gemini_connection(client=mock_client)
    assert ok is True
    assert "Successfully connected" in msg


def test_probe_gemini_connection_error():
    mock_client = MagicMock()
    mock_client.models.list.side_effect = Exception("API quota exceeded")

    ok, msg = probe_gemini_connection(client=mock_client)
    assert ok is False
    assert "API quota exceeded" in msg


def test_extract_and_inject_annotations():
    report_md = """
# 4. Critical Moments
| Move | Player | Classification | What Happened | Why It Mattered | Tactical / Strategic Context |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `1. e4` | White | Best Move | Controls center | Standard opening | Normal |

### Instructive Move Annotations
- `1. e4`: Claims central space and opens lines for Queen and Bishop.
- `2. Nf3`: Develops knight with tempo toward center.
- `3... Bc5`: Italian Game active bishop setup.
"""
    ann = extract_upfront_annotations_from_report(report_md)
    assert "1. e4" in ann
    assert "Claims central space" in ann["1. e4"]
    assert "2. Nf3" in ann
    assert "3... Bc5" in ann

    raw_pgn = '[Event "Test"]\n\n1. e4 { [%clk 0:03:00] } 1... e5 2. Nf3 Nc6 3. Bc4 Bc5 *'
    annotated_pgn = inject_annotations_into_pgn(raw_pgn, ann)
    assert "[%clk 0:03:00] ✨ Claims central space" in annotated_pgn
    assert "✨ Develops knight with tempo" in annotated_pgn
    assert "✨ Italian Game active bishop setup" in annotated_pgn


def test_build_move_annotation_prompt():
    pgn = '[Event "Test"]\n\n1. e4 e5 2. Nf3 Nc6 *'
    context = extract_move_qa_context(pgn_text=pgn, payload=None, ply=1)
    prompt = build_move_annotation_prompt(context)

    assert "Move Played: 1. e4 (White)" in prompt
    assert "Explain the concrete CHESS REASONS and ideas" in prompt
    assert "DO NOT state raw engine numbers" in prompt
    assert "Instructive depth and completeness" in prompt


def test_build_move_annotation_prompt_player_perspective():
    pgn = '[Event "Test"]\n\n1. e4 e5 2. Nf3 Nc6 *'

    # Student plays Black: Move 1 (White 1. e4) is Opponent's move
    opp_context = extract_move_qa_context(pgn_text=pgn, payload=None, ply=1, user_color="Black")
    opp_prompt = build_move_annotation_prompt(opp_context)

    assert "Move Actor: Opponent" in opp_prompt
    assert "CRITICAL PLAYER PERSPECTIVE (OPPONENT'S MOVE)" in opp_prompt
    assert "NEVER refer to this move as 'You played e4'" in opp_prompt
    assert "Your opponent pushed/played e4" in opp_prompt

    # Student plays Black: Move 2 (Black 1... e5) is Student's move
    stu_context = extract_move_qa_context(pgn_text=pgn, payload=None, ply=2, user_color="Black")
    stu_prompt = build_move_annotation_prompt(stu_context)

    assert "Move Actor: Student" in stu_prompt
    assert "CRITICAL PLAYER PERSPECTIVE (STUDENT'S MOVE)" in stu_prompt
    assert "Address the student: 'You played e5'" in stu_prompt


def test_build_move_annotation_prompt_missed_better_tactic(sample_payload):
    pgn = '[Event "Test"]\n\n1. e4 e5 2. Nf3 Nc6 *'
    context = extract_move_qa_context(pgn_text=pgn, payload=None, ply=1)

    # Attach critical moment where played move e4 missed best move Bxd3
    facts = context["facts_before"]
    cm = CriticalMoment(
        ply=1,
        move_number=1,
        color="White",
        move_played_san="e4",
        classification="Good Move",
        best_move_san="Bxd3",
        pv_san=["Bxd3", "Qxd3", "e4"],
        refutation_san=["Nd4", "exd3"],
        facts_before_move=facts,
        facts_after_played_move=facts,
        facts_after_best_move=facts,
        facts_at_end_of_pv=facts,
    )
    context["critical_moment"] = cm

    prompt = build_move_annotation_prompt(context)
    assert "Engine Best Move: Bxd3 (NOTE: The played move e4 was NOT the best choice" in prompt
    assert "CRITICAL TACTICAL COMPARISON (Played e4 vs Best Move Bxd3)" in prompt
    assert "Do not merely praise the move if a superior move was available!" in prompt
    assert "why Bxd3 was the stronger tactic" in prompt


def test_extract_upfront_annotations_multi_line():
    report_md = """
### Instructive Move Annotations
- `11... e4`: Exploits the paralysis of the c3 knight with an unstoppable pawn fork against d3 and f3.
  However, Black overlooked the superior tactical intermediate move `11... Bxd3!` first.
  Trading bishops first simplifies cleanly and prevents any counterplay.
- `13... Ne4`: Piles maximum pressure onto the pinned c3 knight.
"""
    ann = extract_upfront_annotations_from_report(report_md)
    assert "11... e4" in ann
    assert "Exploits the paralysis of the c3 knight" in ann["11... e4"]
    assert "However, Black overlooked the superior tactical intermediate move" in ann["11... e4"]
    assert "Trading bishops first simplifies cleanly" in ann["11... e4"]
    assert "13... Ne4" in ann
    assert ann["13... Ne4"] == "Piles maximum pressure onto the pinned c3 knight."


def test_annotate_single_move_gemini_success():
    pgn = '[Event "Test"]\n\n1. e4 e5 *'
    context = extract_move_qa_context(pgn_text=pgn, payload=None, ply=1)

    mock_client = MagicMock()
    mock_resp = MagicMock()
    mock_resp.text = (
        "1. e4 stakes an immediate claim in the center while liberating paths for both the king's bishop "
        "and queen. It directly contests the d5-square and accelerates rapid kingside development."
    )
    mock_client.models.generate_content.return_value = mock_resp

    comment = annotate_single_move_gemini(
        context=context,
        model_name="gemini-2.5-flash",
        client=mock_client,
    )
    assert "stakes an immediate claim in the center" in comment
    assert not comment.startswith("✨")  # llm dispatcher adds the sparkle


def test_annotate_single_move_gemini_no_api_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    pgn = '[Event "Test"]\n\n1. e4 e5 *'
    context = extract_move_qa_context(pgn_text=pgn, payload=None, ply=1)

    with pytest.raises(ValueError, match="Gemini API key is not configured"):
        annotate_single_move_gemini(
            context=context,
            api_key="",
            client=None,
        )


def test_annotate_single_move_gemini_empty_response():
    pgn = '[Event "Test"]\n\n1. e4 e5 *'
    context = extract_move_qa_context(pgn_text=pgn, payload=None, ply=1)

    mock_client = MagicMock()
    mock_resp = MagicMock()
    mock_resp.text = ""
    mock_client.models.generate_content.return_value = mock_resp

    with pytest.raises(ValueError, match="Gemini returned an empty response"):
        annotate_single_move_gemini(
            context=context,
            client=mock_client,
        )
