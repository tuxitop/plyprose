from __future__ import annotations

from src.coach_agent import (
    generate_deterministic_summary,
    generate_narrative_report as _generate_gemini_report,
)
from src.models import GameAnalysisPayload
from src.openai_agent import (
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


__all__ = [
    "AVAILABLE_PROVIDERS",
    "PROVIDER_GEMINI",
    "PROVIDER_OPENAI_COMPAT",
    "generate_deterministic_summary",
    "generate_narrative_report",
    "model_label",
]
