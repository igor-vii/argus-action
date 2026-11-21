# Argus CI API contract — v0.1 (canonical)

> This is the **canonical, implementation-current** document. The lab copy
> (`Argus-Agent-Test-Lab`, `docs/ci/api-contract-v0.md`) freezes the original
> v0 interface as history; this file tracks what the live console implements.
> The payload contract (`argus.result.v0`) lives in the lab repo:
> `docs/ci/result-contract-v0.md`.

Status: **implemented — console live**. Verified end-to-end by the public
dogfood (`igor-vii/argus-ci-dogfood`): the action fetches the sealed bundle,
registers the run and the debit, and the console answers every edge the
contract prescribes (402 on empty balance, 409 on replay, 401 without a key).

v0.1 is a strict **superset of v0**: v0 clients (synchronous engine runs
hosted by the console) are unaffected. v0.1 adds `mode: "ci-local"` — the
GitHub Action executes the engine in CI and the console registers the
already-completed run and debits.

## Fixed decisions (v0, carried through v0.1)

- **Unit of balance**: 1 credit = 1 battery run = 1 full battery. Credits are
  integers end-to-end — no conversion layer.
- **Key scope**: one api-key per account, one shared balance (CI + console).
  The key format leaves room for per-repo/per-team keys post-v0 without a
  breaking change.
- **Overdraft**: an advisory credit of 3 runs. A run is allowed while the
  pre-debit balance is ≥ `-2` (the balance may dip to `-3`); below the floor
  the API returns `402 insufficient_balance`. A zeroed balance must not
  hard-break a live pipeline mid-day; the debt is reported in the affected
  check-run annotations and console history.

## Authentication

`Authorization: Bearer <api-key>` on every call. The key maps 1:1 to an
account and resolves server-side to `account_id` + current balance. Keys are
issued and rotated in the console (Settings → API keys); consumers store them
as GitHub Actions secrets (`ARGUS_API_KEY`). A leaked key is revoked, not
re-scoped. **Calls without a valid key get `401`** — including
`GET /api/v1/engine/bundle` (probed by the scheduled dogfood workflow).

## `POST /api/v1/runs`

Accepted fields (both spellings work): `commit` | `commit_sha` (40-hex),
`battery` | `battery_id`; `idempotency_key` in the body or `idempotency-key`
in the request header (an explicit key wins — needed for custom batteries on
the same commit).

- `mode: "ci-local"` (v0.1): registers an already-executed CI run + debits;
  the console does not host the engine for this mode.
- Responses:
  - `201` (ci-local) — `{ "run": { "id", "url", "charged_credits", "balance",
    "welcome_remaining" } }`; `run.url` is the report page link rendered into
    the job summary and check run.
  - `201` (v0 sync) — the full `argus.result.v0` object, header
    `X-Argus-Balance: <int>` (unchanged from v0).
  - `409` — idempotent replay: prior `COMPLETED` → the original body,
    `X-Argus-Replayed: 1`, **no re-debit**; prior `INFRA_FAILED` → reset in
    place and retry **without a second debit**; in-flight → `409
    run_in_progress` (a run stuck in-flight > 10 minutes counts as
    `INFRA_FAILED` and retries free).
  - `402` — `{ "error": "insufficient_balance", "balance": <int>,
    "topup_url": "https://console.argus-lab.tech/billing" }`. A refused
    attempt persists nothing. The action maps it to `action_required` with
    the top-up link.
  - `401` — unknown or revoked key → `action_required`.
  - `5xx` / network failure — rig failure → `action_required`; charge once,
    free retry (the prepaid idempotency key re-flies at zero cost).

## Idempotency (debit semantics)

- `idempotency_key = sha256("argus.idem.v1:" + commit + ":" + battery)` —
  mirrors the CI seed formula by design.
- Scope: **per-account** (`unique (userId, idempotencyKey)`); the same
  commit+battery from a different account is a different paid run.
- One commit + one battery = one charge; job restarts and replays never
  debit twice. Debit is atomic with the anchor run row, serialized per
  account; idempotent replays never touch the ledger.
- A `FAIL` verdict is not a rig failure — the battery ran, the agent lost,
  the debit stays.

## `GET /api/v1/engine/bundle`

- `GET /api/v1/engine/bundle?battery=<id>` with a Bearer key.
- `302` → `location`: signed storage URL (TTL 10 min); the response body
  carries the bundle manifest JSON; header
  `X-Argus-Engine-Version: <semver>`.
- Without a key → `401` (never `404`/`500` — a regression here is caught by
  the scheduled dogfood probe).
- The consumer verifies the seal locally before executing anything (manifest
  schema → pinned `key_id` → Ed25519 signature → `tree_sha256`); see the
  Security model in the action README.

## `GET /api/v1/balance` (v0)

```json
{ "balance": 12, "runs_used_this_month": 38, "overdraft_floor": -3 }
```

## Billing

- Welcome: 3 free runs (CI + console share one balance — one key, one
  balance).
- Single run: **$3** per core battery run.
- Packages: **$29 / $49 / $79** — planned pricing; the detailed SKU table and
  the SKU-to-ledger wiring ship with api-contract **v0.2**.
- No silent charges: the first paid run surfaces price and balance; credits
  do not expire; top-ups are crypto-paid and credited instantly.

## Battery ids

`x402-core` (engine battery, the ci-local default), `client-standard` /
`client-engine` (console ENGINE mirror). Unknown ids → `400` (v0 sync path).
