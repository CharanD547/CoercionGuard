from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Browser pool
    max_concurrent_contexts: int = 4  # caps RAM on a small Vultr VM
    page_timeout_ms: int = 20_000
    headless: bool = True

    # Agent
    agent_mode: str = "heuristic"  # "heuristic" | "llm"
    agent_max_steps: int = 6
    step_delay_ms: int = 600  # slows the battle down so judges can watch it

    # Vultr Serverless Inference (OpenAI-compatible)
    vultr_inference_api_key: str = ""
    vultr_inference_base_url: str = "https://api.vultrinference.com/v1"
    vultr_inference_model: str = "llama-3.1-70b-instruct-fp8"

    # Abuse protection
    rate_limit_per_minute: int = 20
    allow_private_urls: bool = False

    # Live page reviews
    review_ttl_seconds: int = 3600
    capture_timeout_seconds: int = 35
    capture_max_bytes: int = 15_000_000  # total response bytes per capture

    # Reminder approval: operator token and the team calendar (service account JSON, inline or a file path)
    operator_token: str = ""
    google_calendar_id: str = ""
    google_service_account_json: str = ""
    receipts_path: str = "data/receipts.json"

    cors_origins: str = "*"


@lru_cache
def get_settings() -> Settings:
    return Settings()
