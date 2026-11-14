# CoercionGuard

A firewall that sits between a web agent and the page it's using. It finds dark patterns in the live DOM, rewrites them so the honest choice is visible, and proves it works in a side-by-side **agent battle**.

## Run it

Build the Astro frontend with Node 24 and pnpm 11.25.0. FastAPI serves the build, API, and WebSockets on the same origin.

```bash
pnpm --dir frontrend install --frozen-lockfile
pnpm --dir frontrend build
```

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/playwright install chromium
.venv/bin/uvicorn app.main:app --reload
```

Tests: `.venv/bin/python -m pytest -q`

Docker (Vultr VM): `docker build -t coercionguard . && docker run -p 8000:8000 --env-file .env coercionguard`.
The image serves the lab UI and the API on the same port. Put Caddy or Nginx in front for HTTPS, and pass WebSocket upgrades through.
Vultr Cloud Compute can host the container and run the sandbox Chromium workload. Keep one worker while battle state lives in memory. The optional Vultr inference integration is configured separately through `.env`.

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | Status, agent mode, queue depth |
| GET | `/api/sandboxes` | Cached trap pages with their default agent goal |
| GET | `/api/patterns` | Pattern catalogue with India CCPA / EU / US mappings |
| POST | `/api/scan` | `{"url": "https://…"}` or `{"sandbox_id": "…"}` → findings, fixes, risk score, before/after screenshots (base64 JPEG) |
| POST | `/api/battles` | `{"sandbox_id": "…", "goal"?: "…"}` → `202` with `id` and `ws` path |
| GET | `/api/battles/{id}` | Summary; `?include_events=true` adds the full event log |
| WS | `/ws/battles/{id}` | Streams battle events, replaying past ones on connect |
| GET | `/sandbox/{id}/` | The raw trap page (for an iframe in the frontend) |

### Battle events (WebSocket)

Each event has a `type`, plus a `lane` (`unprotected` / `protected`) where it applies:

- `battle_started`
- `page_loaded`: `screenshot`
- `detected`: unprotected lane; `findings`, `risk_score`, `summary`, `viewport` (layout matches the `page_loaded` screenshot)
- `sanitized`: protected lane only; `findings`, `fixes`, `risk_score`, `summary`, `viewport`, `screenshot`
- `step`: `decision` `{action, id, reason}`, `screenshot`
- `lane_finished`: `receipt` (items, `monthly_recurring`, `one_time`, `privacy_leaks`, `overcharge`), `manipulated`
- `battle_finished`: `results` for both lanes, plus `results.comparison` (`overcharge_avoided`, `leaks_avoided`, and whether each lane met the goal). One lane failing does not discard the other.

Render each lane's latest `screenshot` as `data:image/jpeg;base64,…`.

## Sandboxes

| id | Traps | Unprotected agent ends with | Protected agent ends with |
|---|---|---|---|
| `streamflix_trial` | 9px "$1000/mo after trial", pre-ticked add-on, fake countdown, confirmshaming | $1,014.99/mo | Free plan |
| `skyhop_flight` | 3 pre-ticked extras, drip fee, scarcity, tiny "skip" link, disguised ad | $163 (+$56) | $107 |
| `ebook_consent` | Forced data-sharing consent, double-negative opt-out, nag modal | Data shared + subscribed | Clean download |

Sandbox pages are served by Playwright request interception (`browser.py`), so battles make no network calls and can't be blocked by CAPTCHAs.

## How it works

- `app/js/detector.js` runs in the page. It uses computed styles (font size, WCAG contrast, element area) to find 12 pattern types and tags each element with `data-cg-id`. Each finding includes a viewport `box` so a client can mark the screenshot.
- `app/js/sanitizer.js` unticks pre-selected boxes, enlarges hidden costs and copies them onto the main button, equalises decline buttons, removes fake timers and nag overlays, and labels ads.
- `app/agent.py` is the agent under test. It favours prominent, goal-matching buttons, keeps defaults and fills required fields: the behaviour DECEPTICON found dark patterns exploit. Set `AGENT_MODE=llm` and `VULTR_INFERENCE_API_KEY` to have a Vultr Serverless Inference model choose actions instead. It falls back to the heuristic if a call fails.
- Live scans: URLs that resolve to private or reserved IPs are rejected, and every sub-request is re-checked, so redirects can't reach internal hosts. Bot-check pages come back as `status: "blocked"`. Concurrency is capped by `MAX_CONCURRENT_CONTEXTS`; requests are rate-limited per IP.

## Limits

- Battles only run on sandboxes. Running an agent that clicks "buy" on a live site is unsafe.
- State is in memory: run a single worker, and battles are lost on restart.
