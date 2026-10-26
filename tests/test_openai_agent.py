import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import chess
import pytest

from src.llm import (
    AVAILABLE_PROVIDERS,
    PROVIDER_GEMINI,
    PROVIDER_OPENAI_COMPAT,
    generate_narrative_report as dispatch_generate_narrative_report,
    model_label,
)
from src.models import GameAnalysisPayload
from src.openai_agent import (
    OPENAI_COMPAT_TOOLS,
    generate_narrative_report,
    list_openai_compat_models,
    probe_openai_compat_connection,
)


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


def make_tool_call(call_id: str, name: str, arguments: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def make_message(content=None, tool_calls=None) -> SimpleNamespace:
    return SimpleNamespace(content=content, tool_calls=tool_calls)


def make_response(message: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def make_mock_client(side_effect: list) -> MagicMock:
    client = MagicMock()
    client.chat.completions.create.side_effect = side_effect
    return client


def test_tool_schemas_shape():
    names = [t["function"]["name"] for t in OPENAI_COMPAT_TOOLS]
    assert names == ["verify_variation_tool", "inspect_square"]
    for tool in OPENAI_COMPAT_TOOLS:
        assert tool["type"] == "function"
        params = tool["function"]["parameters"]
        assert params["type"] == "object"
        assert params["required"]


def test_generate_report_direct_text(sample_payload: GameAnalysisPayload):
    mock_client = make_mock_client(
        [make_response(make_message(content="# Report\n\nBlack's queenside was hanging."))]
    )

    report = generate_narrative_report(
        payload=sample_payload,
        model_name="gpt-4o-mini",
        client=mock_client,
    )

    assert report == "# Report\n\nBlack's queenside was hanging."
    mock_client.chat.completions.create.assert_called_once()
    kwargs = mock_client.chat.completions.create.call_args.kwargs
    assert kwargs["model"] == "gpt-4o-mini"
    assert kwargs["temperature"] == 0.2
    assert kwargs["tools"] == OPENAI_COMPAT_TOOLS
    assert kwargs["tool_choice"] == "auto"
    assert kwargs["messages"][0]["role"] == "system"
    assert kwargs["messages"][1]["role"] == "user"


def test_tool_call_round_trip(sample_payload: GameAnalysisPayload):
    text_response = make_response(
        make_message(content="# Verified Report\n\nAfter 1. e4 e5 the position is balanced.")
    )
    tool_call_response = make_response(
        make_message(
            content=None,
            tool_calls=[
                make_tool_call(
                    "call_1",
                    "verify_variation_tool",
                    json.dumps({"fen": chess.STARTING_FEN, "san_moves": ["e4", "e5"]}),
                )
            ],
        )
    )
    mock_client = make_mock_client([tool_call_response, text_response])

    report = generate_narrative_report(
        payload=sample_payload,
        model_name="gpt-4o-mini",
        client=mock_client,
    )

    assert report == "# Verified Report\n\nAfter 1. e4 e5 the position is balanced."
    assert mock_client.chat.completions.create.call_count == 2

    # Second request must include the assistant tool-call message and tool result
    second_kwargs = mock_client.chat.completions.create.call_args_list[1].kwargs
    roles = [m["role"] for m in second_kwargs["messages"]]
    assert roles == ["system", "user", "assistant", "tool"]
    assistant_msg = second_kwargs["messages"][2]
    assert assistant_msg["tool_calls"][0]["function"]["name"] == "verify_variation_tool"
    tool_msg = second_kwargs["messages"][3]
    assert tool_msg["role"] == "tool"
    assert tool_msg["tool_call_id"] == "call_1"
    tool_payload = json.loads(tool_msg["content"])
    assert tool_payload["valid"] is True
    assert "resulting_facts" in tool_payload
    assert tool_payload["resulting_facts"]["piece_placement"]["White"][0] == "Qd1"


def test_malformed_tool_args_return_error_to_model(sample_payload: GameAnalysisPayload):
    bad_args_response = make_response(
        make_message(
            content=None,
            tool_calls=[make_tool_call("call_1", "verify_variation_tool", "{not valid json")],
        )
    )
    text_response = make_response(make_message(content="# Recovered Report"))
    mock_client = make_mock_client([bad_args_response, text_response])

    report = generate_narrative_report(payload=sample_payload, model_name="m", client=mock_client)

    assert report == "# Recovered Report"
    tool_msg = mock_client.chat.completions.create.call_args_list[1].kwargs["messages"][3]
    assert "Invalid JSON arguments" in json.loads(tool_msg["content"])["error"]


def test_unknown_tool_name_returns_error(sample_payload: GameAnalysisPayload):
    unknown_response = make_response(
        make_message(
            content=None,
            tool_calls=[make_tool_call("call_1", "invent_moves_tool", "{}")],
        )
    )
    text_response = make_response(make_message(content="# Report"))
    mock_client = make_mock_client([unknown_response, text_response])

    report = generate_narrative_report(payload=sample_payload, model_name="m", client=mock_client)

    assert report == "# Report"
    tool_msg = mock_client.chat.completions.create.call_args_list[1].kwargs["messages"][3]
    assert "Unknown tool" in json.loads(tool_msg["content"])["error"]


def test_illegal_move_tool_result_reaches_model(sample_payload: GameAnalysisPayload):
    illegal_response = make_response(
        make_message(
            content=None,
            tool_calls=[
                make_tool_call(
                    "call_1",
                    "verify_variation_tool",
                    json.dumps({"fen": chess.STARTING_FEN, "san_moves": ["e4", "e5", "Ke3"]}),
                )
            ],
        )
    )
    text_response = make_response(make_message(content="# Report"))
    mock_client = make_mock_client([illegal_response, text_response])

    report = generate_narrative_report(payload=sample_payload, model_name="m", client=mock_client)

    assert report == "# Report"
    tool_msg = mock_client.chat.completions.create.call_args_list[1].kwargs["messages"][3]
    tool_payload = json.loads(tool_msg["content"])
    assert tool_payload["valid"] is False
    assert tool_payload["illegal_move"] == "Ke3"
    assert "legal_moves_sample" in tool_payload


def test_tools_rejected_retry_without_tools(sample_payload: GameAnalysisPayload):
    text_response = make_response(make_message(content="# Report Without Tools"))
    mock_client = make_mock_client(
        [RuntimeError("400 - tools parameter is not supported"), text_response]
    )

    report = generate_narrative_report(payload=sample_payload, model_name="m", client=mock_client)

    assert report.startswith(
        "> ⚠️ **Note:** The OpenAI-compatible endpoint rejected function calling"
    )
    assert "# Report Without Tools" in report
    assert mock_client.chat.completions.create.call_count == 2
    retry_kwargs = mock_client.chat.completions.create.call_args_list[1].kwargs
    assert retry_kwargs.get("tools") is None
    assert "tool_choice" not in retry_kwargs


def test_total_failure_falls_back_to_deterministic_summary(sample_payload: GameAnalysisPayload):
    mock_client = make_mock_client(
        [RuntimeError("connection refused"), RuntimeError("connection refused")]
    )

    report = generate_narrative_report(payload=sample_payload, model_name="m", client=mock_client)

    assert "OpenAI-compatible endpoint produced no narrative" in report
    assert "connection refused" in report
    assert "Magnus Carlsen" in report
    assert "Game Overview" in report


def test_failure_note_exposes_base_url_and_model(sample_payload: GameAnalysisPayload):
    mock_client = make_mock_client(
        [RuntimeError("401 Unauthorized"), RuntimeError("401 Unauthorized")]
    )
    mock_client.base_url = "http://localhost:11434/v1"

    report = generate_narrative_report(
        payload=sample_payload, model_name="llama3.1:8b", client=mock_client
    )

    assert "http://localhost:11434/v1" in report
    assert "llama3.1:8b" in report
    assert "401 Unauthorized" in report


def test_max_turns_error_is_reported(sample_payload: GameAnalysisPayload):
    tool_call_response = make_response(
        make_message(
            content=None,
            tool_calls=[
                make_tool_call(
                    "call_x",
                    "verify_variation_tool",
                    json.dumps({"fen": chess.STARTING_FEN, "san_moves": ["e4"]}),
                )
            ],
        )
    )
    mock_client = make_mock_client([tool_call_response, tool_call_response])

    report = generate_narrative_report(
        payload=sample_payload, model_name="m", client=mock_client, max_turns=2
    )

    assert "OpenAI-compatible endpoint produced no narrative" in report
    assert "2 turns" in report
    assert mock_client.chat.completions.create.call_count == 2


def test_connection_test_reports_failure():
    mock_client = MagicMock()
    mock_client.models.list.side_effect = RuntimeError("404 page not found")

    ok, message = probe_openai_compat_connection(client=mock_client)

    assert ok is False
    assert "404 page not found" in message


def test_connection_test_reports_success():
    mock_client = MagicMock()
    mock_client.models.list.return_value = [SimpleNamespace(id="llama3.1:8b")]

    ok, message = probe_openai_compat_connection(client=mock_client)

    assert ok is True
    assert "llama3.1:8b" in message


def test_max_turns_exhaustion_falls_back(sample_payload: GameAnalysisPayload):
    tool_call_response = make_response(
        make_message(
            content=None,
            tool_calls=[
                make_tool_call(
                    "call_x",
                    "verify_variation_tool",
                    json.dumps({"fen": chess.STARTING_FEN, "san_moves": ["e4"]}),
                )
            ],
        )
    )
    mock_client = make_mock_client([tool_call_response, tool_call_response])

    report = generate_narrative_report(
        payload=sample_payload, model_name="m", client=mock_client, max_turns=2
    )

    assert "OpenAI-compatible endpoint produced no narrative" in report
    assert mock_client.chat.completions.create.call_count == 2


def test_list_openai_compat_models():
    mock_client = MagicMock()
    mock_client.models.list.return_value = [
        SimpleNamespace(id="gpt-4o-mini"),
        SimpleNamespace(id="llama3.1:8b"),
        SimpleNamespace(id=""),  # empty ids filtered out
    ]

    models = list_openai_compat_models(client=mock_client)
    assert models == ["gpt-4o-mini", "llama3.1:8b"]


def test_list_openai_compat_models_error_returns_empty():
    mock_client = MagicMock()
    mock_client.models.list.side_effect = RuntimeError("connection refused")
    assert list_openai_compat_models(client=mock_client) == []


def test_model_label():
    assert model_label(PROVIDER_GEMINI, "gemini-2.5-pro") == "gemini:gemini-2.5-pro"
    assert model_label(PROVIDER_OPENAI_COMPAT, "gpt-4o-mini") == "openai-compat:gpt-4o-mini"
    assert PROVIDER_GEMINI in AVAILABLE_PROVIDERS
    assert PROVIDER_OPENAI_COMPAT in AVAILABLE_PROVIDERS


def test_dispatcher_routes_openai_compat(sample_payload: GameAnalysisPayload):
    mock_client = make_mock_client(
        [make_response(make_message(content="# Routed via OpenAI-compatible dispatcher"))]
    )

    report = dispatch_generate_narrative_report(
        payload=sample_payload,
        provider=PROVIDER_OPENAI_COMPAT,
        model_name="gpt-4o-mini",
        client=mock_client,
    )

    assert report == "# Routed via OpenAI-compatible dispatcher"


def test_dispatcher_routes_gemini(sample_payload: GameAnalysisPayload):
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = "# Routed via Gemini dispatcher"
    mock_chat = MagicMock()
    mock_chat.send_message.return_value = mock_response
    mock_client.chats.create.return_value = mock_chat

    report = dispatch_generate_narrative_report(
        payload=sample_payload,
        provider=PROVIDER_GEMINI,
        model_name="gemini-2.5-pro",
        client=mock_client,
    )

    assert report == "# Routed via Gemini dispatcher"
    mock_client.chats.create.assert_called_once()
