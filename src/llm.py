from __future__ import annotations

from src.coach_agent import (
    annotate_single_move_gemini,
    ask_move_question_gemini,
    extract_move_qa_context,
    generate_deterministic_summary,
    generate_narrative_report as _generate_gemini_report,
)
from src.models import AskMoveResponse, GameAnalysisPayload
from src.openai_agent import (
    annotate_single_move_openai,
    ask_move_question_openai,
    generate_narrative_report as _generate_openai_compat_report,
)

PROVIDER_GEMINI = "gemini"
PROVIDER_OPENAI_COMPAT = "openai-compat"

AVAILABLE_PROVIDERS: list[str] = [PROVIDER_GEMINI, PROVIDER_OPENAI_COMPAT]


def model_label(provider: str, model_name: str) -> str:
    """
    Builds the provenance-prefixed label stored in history, e.g.
    "gemini:gemini-2.5-pro" or "openai-compat:gpt-4o-mini".
    """
    return f"{provider}:{model_name}"


def generate_narrative_report(
    payload: GameAnalysisPayload,
    provider: str = PROVIDER_GEMINI,
    model_name: str = "gemini-2.5-pro",
    api_key: str | None = None,
    base_url: str | None = None,
    client: object | None = None,
    system_prompt: str | None = None,
) -> str:
    """
    Provider dispatcher for narrative coaching report generation.

    Routes to the Google Gemini agent (google-genai SDK with automatic function
    calling) or to any OpenAI-compatible endpoint (manual tool-calling loop),
    sharing the same system prompt, user prompt, deterministic verification
    tools, and deterministic fallback contract.

    Args:
        payload: The GameAnalysisPayload containing deterministic game facts.
        provider: "gemini" or "openai-compat".
        model_name: Model id to request from the provider.
        api_key: Optional API key override for the selected provider.
        base_url: OpenAI-compatible base URL (ignored for Gemini).
        client: Optional pre-configured provider client (injection/testing).
        system_prompt: Optional custom system prompt string.

    Returns:
        The generated markdown coaching narrative report string.
    """
    if provider == PROVIDER_OPENAI_COMPAT:
        return _generate_openai_compat_report(
            payload=payload,
            model_name=model_name,
            base_url=base_url,
            api_key=api_key,
            client=client,  # type: ignore[arg-type]
            system_prompt=system_prompt,
        )
    return _generate_gemini_report(
        payload=payload,
        model_name=model_name,
        api_key=api_key,
        client=client,  # type: ignore[arg-type]
        system_prompt=system_prompt,
    )


def ask_move_question(
    pgn_text: str,
    payload: GameAnalysisPayload | None,
    question: str,
    ply: int | None = None,
    move_number: int | None = None,
    color: str | None = None,
    provider: str = PROVIDER_GEMINI,
    model_name: str = "gemini-2.5-pro",
    api_key: str | None = None,
    base_url: str | None = None,
    client: object | None = None,
) -> AskMoveResponse:
    """
    Provider dispatcher for move-level coaching Q&A.
    """
    context = extract_move_qa_context(
        pgn_text=pgn_text,
        payload=payload,
        ply=ply,
        move_number=move_number,
        color=color,
    )
    if provider == PROVIDER_OPENAI_COMPAT:
        return ask_move_question_openai(
            context=context,
            user_question=question,
            base_url=base_url,
            model_name=model_name,
            api_key=api_key,
            client=client,  # type: ignore[arg-type]
        )
    return ask_move_question_gemini(
        context=context,
        user_question=question,
        model_name=model_name,
        api_key=api_key,
        client=client,
    )


def annotate_single_move(
    pgn_text: str,
    payload: GameAnalysisPayload | None,
    ply: int,
    san: str,
    provider: str = PROVIDER_GEMINI,
    model_name: str = "gemini-2.5-flash",
    api_key: str | None = None,
    base_url: str | None = None,
    client: object | None = None,
) -> str:
    """Provider dispatcher for generating an insightful AI move annotation.

    Raises an exception if the AI provider or API key is not available.
    """
    context = extract_move_qa_context(
        pgn_text=pgn_text,
        payload=payload,
        ply=ply,
    )

    if provider == PROVIDER_OPENAI_COMPAT:
        raw_annotation = annotate_single_move_openai(
            context=context,
            base_url=base_url,
            model_name=model_name,
            api_key=api_key,
            client=client,  # type: ignore[arg-type]
        )
    else:
        raw_annotation = annotate_single_move_gemini(
            context=context,
            model_name=model_name,
            api_key=api_key,
            client=client,  # type: ignore[arg-type]
        )

    if not raw_annotation.startswith("✨"):
        raw_annotation = f"✨ {raw_annotation}"
    return raw_annotation


__all__ = [
    "AVAILABLE_PROVIDERS",
    "PROVIDER_GEMINI",
    "PROVIDER_OPENAI_COMPAT",
    "annotate_single_move",
    "ask_move_question",
    "generate_deterministic_summary",
    "generate_narrative_report",
    "model_label",
]
