# CoercionGuard API reference

Use `http://127.0.0.1:8001` locally or your deployment’s HTTPS origin. FastAPI serves interactive documentation at `/docs` and the machine-readable schema at `/openapi.json`. This reference also covers WebSocket events and response details outside the generated schema.

## Integration basics

- Send JSON with `Content-Type: application/json` unless the endpoint specifies multipart form data. All timestamps described as Unix timestamps are in seconds.
- Calendar approval uses a server-configured operator token in the `Authorization: Bearer <token>` header. Other endpoints currently have no API-key requirement. A review ID grants access to that review, so keep it private and avoid logging it.
- Errors use FastAPI’s `detail` field. It can contain a message string, a structured capture error, or an array of validation issues. Separately, a successful HTTP response from a guard, scan, or battle endpoint may contain a non-success decision or operation status.
- Capture, assessment, archive lookup, and battle creation can return `429`. Wait and retry deliberately. Review captures and battles are in memory and do not survive a restart. Reviews expire after one hour by default.

## Action guard

### POST /api/v1/guard/check

Send the trusted policy separately from the exact proposed action. The app integrating the guard must derive the policy from user authorization and verify the proposal facts before calling the guard.

```sh
curl -sS http://127.0.0.1:8001/api/v1/guard/check \
  -H 'Content-Type: application/json' \
  -d '{
    "policy": {
      "currency": "USD",
      "max_immediate_charge_minor": 4000,
      "allowed_recurring_intervals": [],
      "allowed_data_fields": ["email"]
    },
    "proposal": {
      "currency": "USD",
      "immediate_charge_minor": 4900,
      "recurring_interval": "none",
      "data_fields": ["email"]
    }
  }'
```

| Field | Contract |
| --- | --- |
| `currency` | Uppercase three-letter code on both objects. Proposal currency can be `null`. No currency conversion occurs. |
| `max_immediate_charge_minor`, `immediate_charge_minor` | Integer from 0 through 9,007,199,254,740,991 in the currency’s minor units. Use 0 for a known zero charge and `null` for an unknown proposal charge. |
| `allowed_recurring_intervals`, `recurring_interval` | Supported intervals are `daily`, `weekly`, `monthly`, `quarterly`, and `yearly`. The policy accepts up to five entries. A proposal uses `"none"` for absence or `null` for unknown. |
| `allowed_data_fields`, `data_fields` | Up to 64 field identifiers matching `^[a-z][a-z0-9_.-]{0,63}$`. Send identifiers rather than personal data values. Use `[]` for no disclosure or `null` for unknown proposal scope. |

All properties are required. Extra properties and incorrect types return `422`. The example returns HTTP `200`:

```json
{
  "decision": "block",
  "checks": [
    {"key": "charge", "status": "violation", "code": "over_budget", "unauthorized_fields": []},
    {"key": "renewal", "status": "pass", "code": "recurrence_allowed", "unauthorized_fields": []},
    {"key": "data", "status": "pass", "code": "disclosure_allowed", "unauthorized_fields": []}
  ]
}
```

| Check | Pass | Block | Requires review |
| --- | --- | --- | --- |
| `charge` | `within_budget` | `over_budget` | `charge_unknown`, `currency_unknown`, `currency_mismatch` |
| `renewal` | `recurrence_allowed` | `recurrence_disallowed` | `recurrence_unknown` |
| `data` | `disclosure_allowed` | `disclosure_disallowed` | `disclosure_unknown` |

A violation takes precedence over unknowns. Otherwise, unknowns yield `review_required` and all passes yield `allow`. Only `disclosure_disallowed` includes identifiers in `unauthorized_fields`. Execute the exact checked tool call only after `allow`, recheck changes, and pause on errors or timeouts. The guard checks the supplied terms and leaves recurring amounts, recipients, and other authorization dimensions to the caller. See [the runnable example](examples/guard_client.py).

## Page reviews

| Method and path | Request and result |
| --- | --- |
| `POST /api/reviews` | `{"url":"https://www.dropbox.com/terms","goal":"No automatic renewal"}` or replace `url` with an uploaded `page_id`. Goal length is 3–500 characters. Returns `201` with the review. `no_controls` still supports an assessment. |
| `GET /api/reviews/{id}` | Read current state. Use `?screenshot=false` to return a null screenshot and reduce response size. |
| `PATCH /api/reviews/{id}/selections` | `{"selections":{"c1":false,"c2":"c2o1"}}`. Find the actual IDs in the returned controls. Use booleans for checkboxes and option IDs for other controls. |
| `POST /api/reviews/{id}/reset` | Restore captured defaults. |
| `POST /api/reviews/{id}/check` | Send `{}` to check saved choices or supply a `selections` patch. Returns updated state and the assessment. |
| `POST /api/pages` | Upload saved public HTML as multipart field `file`. Returns `201` with `page_id`, `name`, and `title`. Treat the returned ID as private. |
| `GET /api/archive?url=...` | URL-encode the source URL. Returns an archive URL, timestamp, and date. `404` means no copy was found. `502` means the archive lookup failed. |

The review contains `id`, `url`, `final_url`, `title`, `goal`, `status`, `notes`, `expires_at`, `controls`, `defaults`, `selections`, `changed`, `totals`, `prices`, `links`, `findings`, `linked_page`, `assessment`, and `screenshot`. The screenshot is raw base64 JPEG. Updates return it as null. Totals can be unavailable even when an individual adjustment has a price.

An assessment includes `analysis_mode` (`vultr`, `rules`, or `rules_fallback`), `engine`, `checked_at`, `checked_selections`, and `verdict` (`conflicts`, `unclear`, or `fits_goal`). Verified conflicts carry evidence with an excerpt and source URL. Unverified claims are separate. Read `recommendation`, `next_step`, `price_change`, and any `follow_up` alongside the verdict. If `assessment_stale` is true, check the current choices before relying on the assessment.

Capture failures can return `422` with `detail.status`, `detail.message`, and `detail.hint`. Statuses include `blocked`, `login_required`, `unreachable`, and `rejected`. An unknown or expired review returns `404`.

## Renewal reminders

Check the review first. Reminder endpoints require a current assessment with a cited renewal follow-up. Preview and approval accept:

```json
{"trial_end_date":"2027-01-15","timezone":"America/New_York","days_before":2}
```

Choose the actual trial end date in `YYYY-MM-DD` format, an IANA time zone, and an optional lead time from 0 to 30 days. The default is two days.

| Method and path | Result |
| --- | --- |
| `POST /api/reviews/{id}/reminder/preview` | Returns `event` and `ics_url`. Display the event before the user approves it. |
| `GET /api/reviews/{id}/reminder.ics` | Pass the same fields as query parameters or follow `ics_url`. Returns a `text/calendar` attachment. |
| `POST /api/reviews/{id}/reminder/approve` | Send the previewed body and operator bearer token. Returns `status` such as `created`, `already_created`, or `restored`, with an event link when available. |

Approval can return `401` for an invalid operator token, `404` for an expired review, `422` for invalid reminder details or a stale assessment, and `503` when the calendar integration is unavailable. The same source, date, time zone, and lead time produce a stable event ID for retries.

## Scanner, comparisons, and discovery

| Method and path | Request and result |
| --- | --- |
| `GET /api/health` | Service status, agent mode, queue depth, and pattern and sandbox counts. |
| `GET /api/patterns` | Pattern catalogue keyed by pattern identifier. |
| `GET /api/sandboxes` | Bundled sandbox IDs and goals. |
| `POST /api/scan` | Supply exactly one of `{"sandbox_id":"streamflix_trial"}` or `{"url":"https://example.com/"}`. Check body `status` for `ok`, `blocked`, or `unreachable`. A successful scan includes findings, fixes, risk, viewport data, and before/after base64 JPEGs. |
| `POST /api/battles` | Supply one of `sandbox_id`, `url`, or `page_id`. Live and uploaded targets require a goal. Returns `202` with the battle summary, `id`, and `ws` path. |
| `GET /api/battles/{id}` | Retrieve status and results. Use `?include_events=true` for the event history. Unknown IDs return `404`. |
| `GET /sandbox/{sandbox_id}/` | Bundled sandbox HTML. `GET` or `POST` to `/sandbox/{sandbox_id}/submit` returns a synthetic HTML receipt. |

### Battle WebSocket

Connect to the `ws` path returned by battle creation, using `ws://` locally or `wss://` on an HTTPS deployment. The server replays buffered events, then streams updates and closes after `battle_finished`. An unknown battle receives an `error` event before closure.

Events carry `type`, `battle_id`, and `ts`. Lane events identify `unprotected` or `protected`. Expect `battle_started`, `page_loaded` with a screenshot, `detected` with findings, `sanitized` with fixes and a screenshot, `step` with a decision, `lane_finished` with a receipt or error, and `battle_finished` with status and results. Handle standalone `error` events and missing lane receipts. Use `data:image/jpeg;base64,` as the prefix when rendering screenshots.
