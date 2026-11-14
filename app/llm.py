"""Thin client for Vultr Serverless Inference (OpenAI-compatible chat completions)."""

import json
import re

import httpx

from .config import get_settings


def enabled() -> bool:
    return bool(get_settings().vultr_inference_api_key)


async def chat_json(system: str, user: str) -> dict:
    s = get_settings()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{s.vultr_inference_base_url}/chat/completions",
            headers={"Authorization": f"Bearer {s.vultr_inference_api_key}"},
            json={
                "model": s.vultr_inference_model,
                "temperature": 0,
                "max_tokens": 300,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            },
        )
        resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    match = re.search(r"\{.*\}", content, re.S)
    if not match:
        raise ValueError(f"LLM returned no JSON: {content[:200]}")
    return json.loads(match.group(0))
