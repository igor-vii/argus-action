# Argus Action

[![GitHub Marketplace — Argus battery](https://img.shields.io/badge/Install-GitHub%20Marketplace-blue)](https://github.com/marketplace/actions/argus-battery) [![CI](https://github.com/igor-vii/argus-action/actions/workflows/ci.yml/badge.svg)](https://github.com/igor-vii/argus-action/actions/workflows/ci.yml) [![Verify the proof registry](https://img.shields.io/badge/Proof_registry-verify_in_one_command-green)](https://github.com/igor-vii/Argus-Agent-Test-Lab) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/igor-vii/argus-action/badge)](https://scorecard.dev/viewer/?uri=github.com/igor-vii/argus-action)

Runs the **real Argus engine** (delivered as a sealed, signed bundle) against
your SUT in CI: **real protocol sessions, real refusal points**. No mocks, no
stub traffic — the engine drives your system under test over `127.0.0.1`,
records JSONL ledgers and issues registry-verdicts (`PASS` / `FAIL` /
`DOCUMENTED` / `HARNESS_ERROR`).

## What it does, in order

1. Reads `argus.sut.json` (missing or invalid → `action_required` + onboarding
   example in the step summary).
2. Fetches the sealed engine bundle from the console:
   `GET /api/v1/engine/bundle?battery=<id>` → `302` signed URL (TTL 10 min),
   `X-Argus-Engine-Version` header. Bundle caching via `@actions/cache` keyed
   by `argus-engine-<version>`.
3. Verifies the seal **locally**: manifest schema → `key_id` against the lab
   public keys → Ed25519 signature over the canonical manifest →
   `tree_sha256` of the tarball. A broken seal means `action_required` and
   **zero execution**.
4. Extracts the bundle, spawns your SUT, waits for the readiness endpoint,
   then runs the engine: the facilitator counterpart is raised from the
   bundle, real sessions run against your SUT, JSONL ledgers land in the
   workspace, bundle matchers produce verdicts.
5. Validates the engine result client-side (vendored `result-view.mjs`:
   schema, rollup rules, evidence paths, seal invariants).
6. Registers the run with the console (**idempotent debit**: one commit + one
   battery = one charge; job restarts never debit twice). Zero balance →
   `402` + top-up messaging.
7. Renders everything: annotations per session, `GITHUB_STEP_SUMMARY`
   markdown table, `argus-evidence` artifact (`argus-result.json` + ledgers),
   the `argus-battery (<battery>) by Argus Lab` check run, and — opt-in — a
   single PR comment that updates on re-runs.

## Scenario families (lab registry)

| Alias | Family | Argus plays | Your SUT is | Sessions |
| --- | --- | --- | --- | --- |
| s9 | **BC** | bad client / buyer | seller (default) | 9 |
| s8 | **S-BS** | bad service / seller | buyer (`role: "client"`) | 6 |
| s1–s7 | facilitator / orchestrator family | — | — | hosted Block B only |

A correct SUT still shows `DOCUMENTED` on refusal probes — that is by design:
`DOCUMENTED` is evidence, not failure. A resource served despite an invalid
payment is always `FAIL`.

## Usage

Minimal workflow (drop this into `.github/workflows/argus.yml` — the only
prerequisite is the `argus.sut.json` contract in your repo root):

```yaml
name: Argus battery

on:
  push:
    branches: [main]
  workflow_dispatch: {}

jobs:
  argus:
    runs-on: ubuntu-latest
    permissions:
      checks: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: igor-vii/argus-action@v2
        with:
          console-url: https://console.argus-lab.tech
          console-api-key: ${{ secrets.ARGUS_API_KEY }}
          public-run: true        # publish the run report page
          comment: false          # opt-in PR comment
```

One-time setup: issue an api-key in the console (Settings → API keys) and
store it as the `ARGUS_API_KEY` Actions secret. Every run is billed
idempotently — see [Billing](#billing).

Pin a specific release instead of the floating major if you want freeze:
`igor-vii/argus-action@v2.1.3`.

```yaml
- uses: igor-vii/argus-action@v2.1.3
  with:
    console-url: https://console.argus-lab.tech
    console-api-key: ${{ secrets.ARGUS_API_KEY }}
```

### Inputs

| input | default | description |
| --- | --- | --- |
| `console-url` | — (required) | Argus console base URL |
| `console-api-key` | — (required) | Argus API key (one key, one balance) |
| `battery` | from `argus.sut.json` | battery id override |
| `sut-contract-path` | `argus.sut.json` | SUT contract location |
| `bundle-keys-path` | bundled with the action | override for bundle public keys — **never from the SUT repo** (see Security model) |
| `public-run` | `false` | publish the `/runs/<id>` report page |
| `comment` | `false` | post/update a single PR comment with the session table |
| `baseline-fixture` | — | repo-relative path to a previous `argus-result.json` — enables drift annotations (P1-6) |
| `github-token` | `github.token` | token for the check-run billboard and the comment |

### Outputs

`run-id`, `run-url`, `rollup`, `engine-version`.

## SUT contract (`argus.sut.json`)

```json
{
  "schema": "argus.sut.v0",
  "start": "npm run start:sut",
  "ready": { "url": "http://127.0.0.1:5071/health", "timeout_ms": 30000 },
  "env": { "PORT": "5071", "FACILITATOR_URL": "http://127.0.0.1:5070" },
  "battery": "x402-core"
}
```

v0.1 extensions (backward compatible, optional): `role` (`seller` | `client`),
`payment.rail` (`local`; `base-sepolia` is planned — the engine rejects it in
ci-local runs with a clear HARNESS_ERROR until the on-chain CI wiring lands),
`env.SELLER_URL` (required for `role: "client"`).

## Verdict semantics

| verdict | conclusion | annotation |
| --- | --- | --- |
| `PASS` | success | — |
| `FAIL` | failure | error |
| `DOCUMENTED` | neutral | warning (refusal code) |
| `HARNESS_ERROR` | action_required | error |

`rollup` = max severity. The job exit status approximates the mapping
(failure on `FAIL`); the authoritative conclusion lives on the Argus
check run. Billing/rig/contract problems (402, unreachable console, broken
seal, missing contract) conclude `action_required` — the agent was not
measured, so it must not read as a red agent failure — while the workflow
step still exits non-zero so the pipeline does not pretend all is fine.

## Drift and flaky (P1-6)

Pass `baseline-fixture: path/to/previous-argus-result.json` and the action
annotates every session whose verdict changed vs that run (`drift: bc-03
PASS → FAIL (worse)`). Separately, the action keeps the last 20 verdict
maps per repo+battery in the Actions cache: a session that flapped ≥ 3 times
is annotated `flaky` and gets a `flaky` marker in the summary drift table.

## Security model

| | seal-key | bundle-key |
| --- | --- | --- |
| signs | verdicts → registry seals | engine bundles |
| storage | offline, maintainer-only | closed-repo Actions secrets |
| mode | manual, one at a time | automatic, every build |
| leak | catastrophic (registry forgery) | rotate, registry unaffected |

The action never sees any private key. **The bundle public keys are pinned
inside the action** (`keys/bundle-keys.json`, committed at the action version)
and verified locally. A keys file from the SUT repo must never be used as the
trust root: an untrusted PR could swap it and verify an attacker-signed bundle
on your runner. `manifest.key_id` selects the verification key. Seal policy:
the registry is appended only with manually reviewed, offline-signed live
runs — CI and console runs are never sealed automatically; `seal-eligible`
marks a candidate, not a seal.

## Billing

- 3 welcome runs free (CI + console share one balance — one key, one balance).
- $3 single-run SKU (pay-as-you-go, credit never expires); $29 / $49 / $79
  packages grant 30 / 50 / 90 credits — the full SKU table lives in
  [docs/api-contract.md](docs/api-contract.md) v0.2.
- Idempotent debits: `idempotency_key = sha256("argus.idem.v1:" + commit + ":" + battery)`
  per api-contract-v0 — one commit + one battery = one charge per account,
  restarts are free; replays are scoped per-account.
- Zero balance → `402` + explicit top-up messaging; overdraft floor −3 per
  contract. No silent charges: the first paid run shows the price and balance.

## Timeouts (P0-4)

Console/bundle endpoints 30 s and 120 s (`AbortSignal.timeout`); Checks API
and other GitHub calls 10 s.

## Local development

```bash
npm ci
npm run build           # esbuild -> dist/index.js (committed; CI guards it is fresh)
npm run typecheck       # src only (works in the public CI)
npm run typecheck:tests # src + tests — needs the closed sibling repo
npx vitest run tests/unit.spec.ts   # public unit suite (bundle tests skip without the closed repo)
npm test                # unit (25) + e2e (12 scenarios A–J) — needs the closed sibling repo
npm run check:language  # zero mentions of the retired mode in live paths
```

The e2e suite boots the mock console, builds a genuinely sealed bundle via the
CI packer (Ed25519), generates the tamper matrix and runs the orchestrator
against the lab demo SUT (seller role) and demo buyer (client role).

Contract reference: `docs/api-contract.md` in this repo (canonical, live)
and `docs/ci/result-contract-v0.md` in the lab repo.
