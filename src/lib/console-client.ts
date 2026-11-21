// Console client. P0-4 timeouts: console/bundle endpoints 30 s and 120 s
// (AbortSignal.timeout); GitHub API timeouts live in github/ports.ts (Checks
// API 10 s).
import fs from 'node:fs';

export const TIMEOUTS = {
  bundleMetaMs: 30_000,
  bundleDownloadMs: 120_000,
  registerRunMs: 30_000,
  githubApiMs: 10_000,
};

export interface ConsoleConfig {
  baseUrl: string;
  apiKey: string;
}

export class BillingError extends Error {
  body: Record<string, unknown>;
  constructor(body: Record<string, unknown>) {
    super(`insufficient credits: balance ${String(body.balance)} (floor ${String(body.overdraft_floor)})`);
    this.name = 'BillingError';
    this.body = body;
  }
}

export interface BundleMeta {
  manifest: Record<string, unknown>;
  tarballUrl: string;
  engineVersion: string;
}

export interface RunRegistration {
  id: string;
  url: string;
  public: boolean;
  charged_credits: number;
  balance: number;
  welcome_remaining: number;
  access_token?: string | null;
  /** Console answered 409 + X-Argus-Replayed: 1 — the idempotency key was
   *  already paid and COMPLETED; the cached result is authoritative and
   *  nothing was re-debited (charge once, free retry). */
  replayed?: boolean;
}

export async function fetchBundleMeta(cfg: ConsoleConfig, battery: string): Promise<BundleMeta> {
  const res = await fetch(
    `${cfg.baseUrl.replace(/\/$/, '')}/api/v1/engine/bundle?battery=${encodeURIComponent(battery)}`,
    { headers: { authorization: `Bearer ${cfg.apiKey}` }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUTS.bundleMetaMs) },
  );
  if (res.status !== 302) {
    throw new Error(`bundle endpoint returned HTTP ${res.status} (expected 302 signed URL)`);
  }
  const engineVersion = res.headers.get('x-argus-engine-version') ?? 'unknown';
  const location = res.headers.get('location');
  if (!location) throw new Error('bundle endpoint did not return a signed URL location');
  const manifest = (await res.json()) as Record<string, unknown>;
  return { manifest, tarballUrl: new URL(location, cfg.baseUrl).toString(), engineVersion };
}

export async function downloadBundle(tarballUrl: string, destPath: string): Promise<void> {
  const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(TIMEOUTS.bundleDownloadMs) });
  if (!res.ok) throw new Error(`bundle download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, bytes);
}

export interface RunPayload {
  mode: string;
  battery: string;
  role?: string;
  engine_version: string;
  bundle: { key_id: string; tree_sha256: string };
  rollup: string;
  verdicts: unknown[];
  duration_ms: number;
  public: boolean;
  repo: string;
  commit: string;
}

export async function registerRun(
  cfg: ConsoleConfig,
  payload: RunPayload,
  idempotencyKey: string,
): Promise<RunRegistration> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/api/v1/runs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUTS.registerRunMs),
  });
  if (res.status === 402) {
    throw new BillingError((await res.json()) as Record<string, unknown>);
  }
  if (res.status === 409) {
    // Two documented 409s (api-contract v0): an idempotent replay of an
    // already-COMPLETED run (body = the cached argus.result.v0 doc, headers
    // X-Argus-Replayed: 1 + X-Argus-Balance) and a concurrent run still in
    // flight (body { error: "run_in_progress", run_id }). Only the replay is
    // a success path: charge once, free retry — the debit never doubles.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.headers.get('x-argus-replayed') === '1') {
      const run = (body.run ?? {}) as { id?: unknown; url?: unknown };
      return {
        id: String(run.id ?? ''),
        url: String(run.url ?? ''),
        public: Boolean(body.public),
        charged_credits: 0,
        balance: Number(res.headers.get('x-argus-balance') ?? '0'),
        welcome_remaining: 0,
        replayed: true,
      };
    }
    const inFlight = body.run_id ? ` (run ${String(body.run_id)})` : '';
    throw new Error(`run registration conflict: ${String(body.error ?? 'HTTP 409')}${inFlight}`);
  }
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`run registration failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { run: RunRegistration };
  return body.run;
}
