from __future__ import annotations

import json
import logging
import os
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI

from src.coach_agent import (
    build_coach_user_prompt,
    generate_deterministic_summary,
    get_system_prompt,
)
from src.inspector import inspect_square, verify_variation_tool
from src.models import GameAnalysisPayload

load_dotenv()

logger = logging.getLogger("chess_coach.openai_agent")

PROVIDER_NAME = "openai-compat"

DEFAULT_OPENAI_COMPAT_BASE_URL = os.environ.get(
    "OPENAI_COMPAT_BASE_URL", "https://api.openai.com/v1"
)
DEFAULT_OPENAI_COMPAT_MODEL = os.environ.get("OPENAI_COMPAT_MODEL", "gpt-4o-mini")

DEFAULT_TEMPERATURE = 0.2
DEFAULT_MAX_TURNS = 8

# Hand-written OpenAI function-calling schemas mirroring the python tool
# signatures in src/inspector.py so that any OpenAI-compatible endpoint can
# execute the exact same zero-hallucination verification tools as Gemini.
OPENAI_COMPAT_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "verify_variation_tool",
            "description": (
                "Validates a sequence of chess moves from a given board position (FEN). "
                "Verifies whether each move in san_moves is legal in turn. If all moves are "
                "legal, returns the deterministic tactical facts (attackers, defenders, pins, "
                "material count, hanging pieces) of the resulting final position. If any move "
                "is illegal, stops immediately and returns the illegal move plus a sample of "
                "legal candidate moves. ALWAYS call this tool before describing any variation "
                "line that is not already explicitly expanded in the provided pv_san data."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "fen": {
                        "type": "string",
                        "description": (
                            "The FEN string of the starting chess board position, "
                            "e.g. the fen of facts_before_move from a CriticalMoment."
                        ),
                    },
                    "san_moves": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Moves in Standard Algebraic Notation (SAN, e.g. "
                            '["e4", "e5", "Nf3"]) to be executed sequentially.'
                        ),
                    },
                },
                "required": ["fen", "san_moves"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inspect_square",
            "description": (
                "Inspects a specific chess square, returning piece info, attackers, "
                "defenders, pin status and whether the piece is hanging. Use this to "
                "double-check any square-specific claim before writing it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "board_or_fen": {
                        "type": "string",
                        "description": "A FEN string of the position to inspect.",
                    },
                    "square_name": {
                        "type": "string",
                        "description": "Algebraic square name, e.g. 'e4' or 'h8'.",
                    },
                },
                "required": ["board_or_fen", "square_name"],
            },
        },
    },
]

TOOL_REGISTRY: dict[str, Any] = {
    "verify_variation_tool": verify_variation_tool,
    "inspect_square": inspect_square,
}


class _ToolsRejectedError(Exception):
    """Raised internally when the server rejects a request containing tools."""


class _MaxTurnsExceededError(Exception):
    """Raised internally when the model keeps calling tools without finishing."""


def _resolve_base_url(base_url: str | None) -> str:
    return (
        base_url or os.environ.get("OPENAI_COMPAT_BASE_URL") or DEFAULT_OPENAI_COMPAT_BASE_URL
    ).strip()


def _resolve_api_key(api_key: str | None) -> str:
    return (
        api_key
        or os.environ.get("OPENAI_COMPAT_API_KEY")
        or "EMPTY"  # Required non-null by most local OpenAI-compatible servers.
    )


def _build_client(
    base_url: str | None = None,
    api_key: str | None = None,
    client: OpenAI | None = None,
) -> OpenAI:
    if client is not None:
        return client
    return OpenAI(
        base_url=_resolve_base_url(base_url),
        api_key=_resolve_api_key(api_key),
    )


def _create_chat_completion(
    client: OpenAI,
    model_name: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    temperature: float = DEFAULT_TEMPERATURE,
) -> Any:
    """Single non-streaming chat completion request."""
    kwargs: dict[str, Any] = {
        "model": model_name,
        "messages": messages,
        "temperature": temperature,
    }
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"
    return client.chat.completions.create(**kwargs)


def _execute_tool_call(name: str, raw_arguments: str) -> dict[str, Any]:
    """
    Safely executes a registered verification tool.

    Returns a JSON-serializable dict in every scenario (bad JSON args, unknown
    tool, raised exception) so the model can self-correct instead of the
    application crashing.
    """
    try:
        args = json.loads(raw_arguments or "{}")
    except json.JSONDecodeError as exc:
        return {"error": f"Invalid JSON arguments for tool '{name}': {exc}"}

    if not isinstance(args, dict):
        return {"error": f"Tool '{name}' arguments must decode to a JSON object."}

    fn = TOOL_REGISTRY.get(name)
    if fn is None:
        return {"error": f"Unknown tool '{name}'. Available tools: {sorted(TOOL_REGISTRY)}."}

    try:
        result = fn(**args)
    except TypeError as exc:
        return {"error": f"Tool '{name}' received invalid arguments: {exc}"}
    except Exception as exc:
        return {"error": f"Tool '{name}' execution failed: {exc}"}

    if not isinstance(result, dict):
        return {"error": f"Tool '{name}' returned non-dict result: {result!r}"}
    return result


def _assistant_tool_call_message(message: Any, tool_calls: list[Any]) -> dict[str, Any]:
    """Converts an assistant message with tool_calls into an OpenAI dict payload."""
    serialized_calls = []
    for tc in tool_calls:
        fn = getattr(tc, "function", None)
        serialized_calls.append(
            {
                "id": getattr(tc, "id", "") or "",
                "type": "function",
                "function": {
                    "name": getattr(fn, "name", "") or "",
                    "arguments": getattr(fn, "arguments", "") or "{}",
                },
            }
        )
    return {
        "role": "assistant",
        "content": getattr(message, "content", None) or "",
        "tool_calls": serialized_calls,
    }


def _extract_text(message: Any) -> str:
    """
    Extracts assistant text from a chat completion message.

    Handles the standard `content: str` shape plus servers that return content
    as a list of text parts (or plain dicts).
    """
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
                continue
            text = getattr(part, "text", None)
            if isinstance(text, str):
                parts.append(text)
                continue
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "\n".join(parts)
    return ""


def _run_conversation(
    client: OpenAI,
    model_name: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    max_turns: int,
    temperature: float,
    tools_enabled: bool,
) -> str:
    """
    Manual tool-calling conversation loop. Returns the first non-empty
    assistant text, or empty string when the model returns an empty response.

    Raises:
        _ToolsRejectedError: when tools were offered and the request failed, so
            the caller can retry once without tools.
        _MaxTurnsExceededError: when the model kept requesting tool calls
            without ever producing a final report.
    """
    try:
        for _ in range(max_turns):
            response = _create_chat_completion(
                client=client,
                model_name=model_name,
                messages=messages,
                tools=tools,
                temperature=temperature,
            )

            choices = getattr(response, "choices", None) or []
            if not choices:
                logger.warning(
                    "OpenAI-compatible endpoint returned no choices (model=%s)", model_name
                )
                return ""
            message = choices[0].message

            tool_calls = getattr(message, "tool_calls", None) or []
            if tool_calls:
                messages.append(_assistant_tool_call_message(message, tool_calls))
                for tc in tool_calls:
                    fn = getattr(tc, "function", None)
                    name = getattr(fn, "name", "") or ""
                    raw_args = getattr(fn, "arguments", "") or "{}"
                    result = _execute_tool_call(name, raw_args)
                    logger.info("Tool %s executed -> %s", name, str(result)[:200])
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": getattr(tc, "id", "") or "",
                            "content": json.dumps(result, default=str),
                        }
                    )
                continue

            content = _extract_text(message)
            if content.strip():
                return content.strip()
            logger.warning(
                "OpenAI-compatible endpoint returned an empty message (model=%s)",
                model_name,
            )
            return ""

        raise _MaxTurnsExceededError(
            f"model kept requesting tool calls for {max_turns} turns without "
            f"producing a final report (model={model_name})"
        )
    except (_ToolsRejectedError, _MaxTurnsExceededError):
        raise
    except Exception as exc:
        if tools_enabled:
            # Cannot reliably distinguish tool-specific 400s from other errors
            # across heterogeneous servers; treat any failure with tools
            # attached as a rejection signal and retry once without tools.
            logger.warning(
                "OpenAI-compatible request failed with tools attached: %s: %s",
                type(exc).__name__,
                exc,
            )
            raise _ToolsRejectedError(f"{type(exc).__name__}: {exc}") from exc
        logger.exception("OpenAI-compatible request failed")
        raise


def generate_narrative_report(
    payload: GameAnalysisPayload,
    model_name: str,
    base_url: str | None = None,
    api_key: str | None = None,
    client: OpenAI | None = None,
    tools_enabled: bool = True,
    max_turns: int = DEFAULT_MAX_TURNS,
    temperature: float = DEFAULT_TEMPERATURE,
    system_prompt: str | None = None,
) -> str:
    """
    Generates a narrative coaching report using any OpenAI-compatible endpoint
    (OpenAI, Ollama /v1, LM Studio, llama.cpp, vLLM, OpenRouter, Groq, ...).

    Implements a manual function-calling loop against the same deterministic
    verification tools used by the Gemini agent (verify_variation_tool,
    inspect_square), preserving the zero-hallucination contract.

    If the server rejects requests containing tools (common on minimal local
    servers), the report is retried once without tools and carries a note that
    model-initiated variation verification was disabled. If the model never
    produces text or the endpoint is unreachable, falls back to the verified
    deterministic summary.

    Args:
        payload: The GameAnalysisPayload containing deterministic game facts.
        model_name: Model id to request from the endpoint.
        base_url: OpenAI-compatible base URL (must end with /v1 for most servers).
        api_key: Optional bearer token; local servers accept any value.
        client: Optional pre-configured OpenAI client (injection/testing).
        tools_enabled: Whether to offer the verification tools to the model.
        max_turns: Safety cap on assistant/tool round trips.
        temperature: Sampling temperature (default 0.2, mirrors Gemini config).
        system_prompt: Optional custom system prompt string.

    Returns:
        The generated markdown coaching narrative report string.
    """
    if system_prompt is None:
        side_label = (
            payload.user_color.upper()
            if payload.user_color in ("White", "Black")
            else "NOT SPECIFIED"
        )
        system_prompt = get_system_prompt(user_color=side_label)
    user_prompt = build_coach_user_prompt(payload)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    client = _build_client(base_url=base_url, api_key=api_key, client=client)
    resolved_base_url = str(getattr(client, "base_url", base_url or ""))

    logger.info(
        "Generating narrative via OpenAI-compatible endpoint (base_url=%s, model=%s, tools=%s)",
        resolved_base_url,
        model_name,
        tools_enabled,
    )

    last_error: str | None = None
    tools_rejected = False
    report_text = ""
    try:
        report_text = _run_conversation(
            client=client,
            model_name=model_name,
            messages=messages,
            tools=OPENAI_COMPAT_TOOLS if tools_enabled else None,
            max_turns=max_turns,
            temperature=temperature,
            tools_enabled=tools_enabled,
        )
    except _ToolsRejectedError as exc:
        # Server does not support function calling: retry once without tools.
        logger.warning(
            "OpenAI-compatible endpoint rejected function calling (%s); retrying without tools",
            exc,
        )
        tools_rejected = True
        last_error = f"function calling rejected by endpoint ({exc})"
        try:
            report_text = _run_conversation(
                client=client,
                model_name=model_name,
                messages=messages,
                tools=None,
                max_turns=max_turns,
                temperature=temperature,
                tools_enabled=False,
            )
        except _MaxTurnsExceededError as retry_exc:
            last_error = f"{last_error}; retry without tools failed: {retry_exc}"
            logger.exception("OpenAI-compatible retry without tools failed")
        except Exception as retry_exc:
            last_error = (
                f"{last_error}; retry without tools failed: {type(retry_exc).__name__}: {retry_exc}"
            )
            logger.exception("OpenAI-compatible retry without tools failed")
        report_text = report_text or ""
    except _MaxTurnsExceededError as exc:
        last_error = str(exc)
        logger.warning("OpenAI-compatible tool loop exceeded max turns: %s", exc)
    except Exception as exc:
        last_error = f"{type(exc).__name__}: {exc}"
        logger.exception("OpenAI-compatible narrative generation failed")

    if not report_text or not report_text.strip():
        if not last_error:
            last_error = "endpoint returned an empty response"
        logger.error("OpenAI-compatible narrative generation produced no text: %s", last_error)
        return generate_deterministic_summary(
            payload,
            note=(
                "OpenAI-compatible endpoint produced no narrative"
                f" [base_url={resolved_base_url}, model={model_name}]"
                f" — {last_error}. Falling back to 100% verified Stockfish analysis "
                "& tactical facts."
            ),
        )

    report_text = report_text.strip()
    if tools_rejected:
        note = (
            "> ⚠️ **Note:** The OpenAI-compatible endpoint rejected function calling "
            "(`tools` unsupported). Model-initiated variation verification was disabled; "
            "all facts below remain grounded in the deterministic analysis payload.\n\n"
        )
        report_text = note + report_text
    return report_text


def list_openai_compat_models(
    base_url: str | None = None,
    api_key: str | None = None,
    client: OpenAI | None = None,
    raise_on_error: bool = False,
) -> list[str]:
    """
    Lists model ids advertised by the OpenAI-compatible endpoint via
    GET {base_url}/models.

    Returns an empty list on any failure so the UI can gracefully degrade to a
    manual text-input model id. Pass raise_on_error=True to surface the
    original exception (used by the UI's "Test Connection" button so users can
    see the real HTTP error instead of a silent empty list).
    """
    try:
        client = _build_client(base_url=base_url, api_key=api_key, client=client)
        discovered: list[str] = []
        for model in client.models.list():
            model_id = getattr(model, "id", None) or ""
            if model_id.strip():
                discovered.append(model_id.strip())
        return discovered
    except Exception as exc:
        logger.warning(
            "Failed to list models from OpenAI-compatible endpoint (%s): %s",
            type(exc).__name__,
            exc,
        )
        if raise_on_error:
            raise
        return []


def probe_openai_compat_connection(
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    client: OpenAI | None = None,
) -> tuple[bool, str]:
    """
    Probes the OpenAI-compatible endpoint for reachability and credentials.

    Performs GET {base_url}/models. Returns (ok, message) where message carries
    the raw exception text on failure (status code, endpoint URL, auth error).
    """
    try:
        models = list_openai_compat_models(
            base_url=base_url, api_key=api_key, client=client, raise_on_error=True
        )
        resolved = _resolve_base_url(base_url)
        if models:
            preview = ", ".join(models[:5])
            return True, f"Connected to {resolved}. {len(models)} model(s): {preview}"
        return False, f"Connected to {resolved} but the endpoint advertised no models."
    except Exception as exc:
        logger.warning("OpenAI-compatible connection test failed: %s: %s", type(exc).__name__, exc)
        return False, f"{type(exc).__name__}: {exc}"


__all__ = [
    "DEFAULT_OPENAI_COMPAT_BASE_URL",
    "DEFAULT_OPENAI_COMPAT_MODEL",
    "OPENAI_COMPAT_TOOLS",
    "PROVIDER_NAME",
    "TOOL_REGISTRY",
    "generate_narrative_report",
    "list_openai_compat_models",
    "probe_openai_compat_connection",
]
