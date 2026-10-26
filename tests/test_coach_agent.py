import json
from unittest.mock import MagicMock, patch

import pytest
from google.genai import types

from src.coach_agent import (
    build_coach_user_prompt,
    generate_narrative_report,
    get_coach_config,
    get_system_prompt,
)
from src.inspector import verify_variation_tool
from src.models import GameAnalysisPayload


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
