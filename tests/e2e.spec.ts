// End-to-end: real orchestrator run against the demo SUT/buyer, the mock
// console and a genuinely sealed (and tampered) engine bundle.
//
// Scenarios:
//   A  happy path, seller role   — 9 BC sessions, ledgers, run report link
//   B  tamper matrix             — sha256 / signature / foreign key_id -> no execution
//   C  missing argus.sut.json    — action_required + onboarding example
//   D  idempotency               — job restart never debits twice
//   E  zero balance              — 402 + top-up messaging, conclusion failure
//   F  SUT never ready           — HARNESS_ERROR -> action_required
//   G  leaky SUT                 — naive seller serves replays -> FAIL -> failure
//   H  client role, correct buyer — 6 S-BS scenarios DOCUMENTED
//   I  client role, naive buyer  — pays poisoned offers -> FAIL -> failure
//   J  payment.rail "base-sepolia" — rejected before any session (deferred to v2.1)
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runArgus } from '../src/lib/orchestrator';
import { buildLocalPorts } from './helpers/local-ports';

const run = promisify(execFile);
const root = new URL('../..', import.meta.url).pathname; // argus tree root
const actionRoot = path.join(root, 'argus-action');
const ciDir = path.join(root, 'closed-repo-ci', 'ci');
const consoleDir = path.join(root, 'mock-console');
const labDir = path.join(root, 'lab-repo');

let consoleUrl = '';
let consoleProc: ReturnType<typeof spawn> | null = null;
let storageDir = '';
let dataFile = '';
let bundleKeysPath = '';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function adminPost(pathname: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${consoleUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-console-storage-'));
  dataFile = path.join(storageDir, 'state.json');

  // 1. Build + publish the sealed bundle and the tampered variants.
  await run('node', [
    path.join(ciDir, 'build-bundle.mjs'),
    '--engine', path.join(root, 'closed-repo-ci', 'engine'),
    '--version', '2.1.0',
    '--key-id', 'bundle-test-1',
    '--out', path.join(storageDir, 'bundles', 'x402-core'),
    '--keys-file', path.join(labDir, 'keys', 'bundle-keys.json'),
    '--dev-keys-dir', path.join(root, 'closed-repo-ci', 'dev-keys'),
  ]);
  bundleKeysPath = path.join(labDir, 'keys', 'bundle-keys.json');
  await run('node', [
    path.join(ciDir, 'tamper-bundle.mjs'),
    '--bundle-dir', path.join(storageDir, 'bundles', 'x402-core'),
    '--out', path.join(storageDir, 'tampered'),
  ]);
  for (const [from, to] of [
    ['sha256-mismatch', 'x402-tamper-sha'],
    ['signature-invalid', 'x402-tamper-sig'],
    ['foreign-key-id', 'x402-tamper-key'],
  ] as const) {
    fs.cpSync(path.join(storageDir, 'tampered', from), path.join(storageDir, 'bundles', to), { recursive: true });
  }

  // 2. Start the mock console on a free port.
  const port = await freePort();
  consoleProc = spawn('node', [path.join(consoleDir, 'server.mjs')], {
    env: { ...process.env, PORT: String(port), STORAGE_DIR: storageDir, DATA_FILE: dataFile, CONSOLE_SECRET: 'e2e-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  consoleUrl = `http://127.0.0.1:${port}`;

  // 3. Test keys.
  await adminPost('/admin/keys', { key: 'k-main', balance: 100, welcome_remaining: 3 });
  await adminPost('/admin/keys', { key: 'k-idem', balance: 10, welcome_remaining: 0 });
  await adminPost('/admin/keys', { key: 'k-empty', balance: -3, welcome_remaining: 0 });
  await adminPost('/admin/keys', { key: 'k-leaky', balance: 100, welcome_remaining: 0 });
  await adminPost('/admin/keys', { key: 'k-buyer', balance: 100, welcome_remaining: 0 });
  await adminPost('/admin/keys', { key: 'k-buyer-vuln', balance: 100, welcome_remaining: 0 });
}, 300_000);

afterAll(() => {
  consoleProc?.kill('SIGTERM');
});

// ---- fixture helpers ----

async function makeSellerFixture(
  opts: { battery?: string; sutEnv?: Record<string, string>; paymentRail?: string } = {},
) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-repo-'));
  const port = await freePort();
  const facPort = await freePort();
  const contract = {
    schema: 'argus.sut.v0',
    start: `node ${path.join(labDir, 'demo-sut', 'server.mjs')}`,
    ready: { url: `http://127.0.0.1:${port}/health`, timeout_ms: 15000 },
    env: { PORT: String(port), FACILITATOR_URL: `http://127.0.0.1:${facPort}`, ...(opts.sutEnv ?? {}) },
    battery: opts.battery ?? 'x402-core',
    ...(opts.paymentRail ? { payment: { rail: opts.paymentRail } } : {}),
  };
  fs.writeFileSync(path.join(repo, 'argus.sut.json'), JSON.stringify(contract, null, 2));
  return { repo, port, facPort };
}

async function makeBuyerFixture(opts: { buyerEnv?: Record<string, string> } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-repo-'));
  const port = await freePort();
  const facPort = await freePort();
  const sellerPort = await freePort();
  const contract = {
    schema: 'argus.sut.v0',
    role: 'client',
    start: `node ${path.join(labDir, 'demo-buyer', 'server.mjs')}`,
    ready: { url: `http://127.0.0.1:${port}/health`, timeout_ms: 15000 },
    env: {
      PORT: String(port),
      FACILITATOR_URL: `http://127.0.0.1:${facPort}`,
      SELLER_URL: `http://127.0.0.1:${sellerPort}`,
      ...(opts.buyerEnv ?? {}),
    },
    battery: 'x402-core',
  };
  fs.writeFileSync(path.join(repo, 'argus.sut.json'), JSON.stringify(contract, null, 2));
  return { repo, port, facPort, sellerPort };
}

function workspaceFor(repo: string): string {
  const ws = path.join(repo, 'argus-run');
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

function portsFor(repo: string, apiKey: string, extra: Record<string, unknown> = {}) {
  const ws = workspaceFor(repo);
  const built = buildLocalPorts({
    repoRoot: repo,
    workspace: ws,
    inputs: {
      consoleUrl,
      consoleApiKey: apiKey,
      bundleKeysPath,
      // unique repo/commit per fixture keeps idempotency keys isolated between scenarios
      repo: `acme/${path.basename(repo)}`,
      commit: 'f'.repeat(40),
      ...extra,
    },
  });
  if (process.env.ARGUS_DEBUG) {
    built.ports.log = (m) => console.log('[action]', m);
  }
  return built;
}

// ---- scenarios ----

describe('e2e', () => {
  it('A: happy path — 9 BC sessions over real local traffic, ledgers attached', async () => {
    const f = await makeSellerFixture();
    const { ports, capture } = portsFor(f.repo, 'k-main');
    const outcome = await runArgus(ports);

    expect(outcome.conclusion).toBe('neutral');
    expect(outcome.rollup).toBe('DOCUMENTED');
    expect(capture.conclusions).toEqual(['neutral']);
    expect(outcome.engineVersion).toBe('2.1.0');

    const result = JSON.parse(fs.readFileSync(path.join(f.repo, 'argus-run', 'argus-result.json'), 'utf8'));
    expect(result.verdicts).toHaveLength(9);
    expect(result.verdicts.every((v: { family: string }) => v.family === 'BC')).toBe(true);
    expect(result.verdicts.find((v: { session_id: string }) => v.session_id === 'bc-03').refusal.code).toBe('nonce_reused');
    expect(result.rollup).toBe('DOCUMENTED');
    expect(result.seal.sealed).toBe(false);
    expect(result.ci_local_notice).toContain('ci-local run');

    // ledgers really exist as JSONL
    for (const ledger of result.ledgers) {
      const p = path.join(f.repo, 'argus-run', ledger);
      expect(fs.existsSync(p)).toBe(true);
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    }

    // summary: run link + ci-local line + seal policy + footer
    const summary = capture.summaries.join('\n');
    expect(outcome.runUrl).toMatch(/\/runs\/r-/);
    expect(summary).toContain(String(outcome.runUrl));
    expect(summary).toContain('ci-local run — evidence: ledgers attached; not a registry seal');
    expect(summary).toContain('Seal-eligible: candidate');
    expect(summary).toContain('argus-lab.tech');
    expect(summary).toContain('Engine: v2.1.0');

    // artifact staging holds result + ledgers
    const staging = capture.artifactDirs[0];
    expect(fs.existsSync(path.join(staging, 'argus-result.json'))).toBe(true);
    expect(fs.existsSync(path.join(staging, result.ledgers[0]))).toBe(true);

    // console registered the run exactly once
    const state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const runs = Object.values(state.runs) as { battery: string; mode: string }[];
    expect(runs.filter((r) => r.battery === 'x402-core' && r.mode === 'ci-local').length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['x402-tamper-sha', 'tree_sha256 mismatch'],
    ['x402-tamper-sig', 'signature invalid'],
    ['x402-tamper-key', 'unknown key_id'],
  ])('B: tampered bundle %s is not executed (action_required)', async (battery, expectedReason) => {
    const f = await makeSellerFixture({ battery });
    const { ports, capture } = portsFor(f.repo, 'k-main');
    const outcome = await runArgus(ports);

    expect(outcome.conclusion).toBe('action_required');
    expect(capture.conclusions).toEqual(['action_required']);
    expect(outcome.rollup).toBeUndefined();
    expect(capture.annotations.some((a) => a.message.includes(expectedReason))).toBe(true);
    // no engine execution, no run registration
    expect(fs.existsSync(path.join(f.repo, 'argus-run', 'engine-run.log'))).toBe(false);
    expect(fs.existsSync(path.join(f.repo, 'argus-run', 'argus-result.json'))).toBe(false);
    const summary = capture.summaries.join('\n');
    expect(summary).toContain('seal verification failed');
    expect(summary).toContain(expectedReason);
  });

  it('C: missing argus.sut.json -> action_required with onboarding example', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-repo-'));
    const { ports, capture } = portsFor(repo, 'k-main');
    const outcome = await runArgus(ports);
    expect(outcome.conclusion).toBe('action_required');
    const summary = capture.summaries.join('\n');
    expect(summary).toContain('onboarding required');
    expect(summary).toContain('"schema": "argus.sut.v0"');
    expect(summary).toContain('npm run start:sut');
    expect(capture.annotations.some((a) => a.title === 'argus.sut.json')).toBe(true);
  });

  it('D: idempotency — a job restart does not debit twice', async () => {
    const f = await makeSellerFixture();
    const inputs = { repo: 'acme/idem-check', commit: 'i'.repeat(40) };
    const first = portsFor(f.repo, 'k-idem', inputs);
    const firstOutcome = await runArgus(first.ports);
    const second = portsFor(f.repo, 'k-idem', inputs);
    const secondOutcome = await runArgus(second.ports);

    expect(firstOutcome.runId).toBeTruthy();
    expect(secondOutcome.runId).toBe(firstOutcome.runId);

    const state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    expect(state.keys['k-idem'].balance).toBe(9); // charged exactly once
    expect(state.keys['k-idem'].welcome_remaining).toBe(0);
  });

  it('E: zero balance -> 402, top-up messaging, conclusion action_required', async () => {
    const f = await makeSellerFixture();
    const { ports, capture } = portsFor(f.repo, 'k-empty');
    const outcome = await runArgus(ports);
    expect(outcome.conclusion).toBe('action_required');
    const summary = capture.summaries.join('\n');
    expect(summary).toContain('insufficient credits');
    expect(summary).toContain('/topup');
    expect(summary).toContain('one credit is one core battery run');
    expect(capture.annotations.some((a) => a.title === 'Argus billing')).toBe(true);
  });

  it('F: SUT never ready -> HARNESS_ERROR -> action_required', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-repo-'));
    const facPort = await freePort();
    fs.writeFileSync(
      path.join(repo, 'argus.sut.json'),
      JSON.stringify({
        schema: 'argus.sut.v0',
        start: 'node /nonexistent/demo-sut.cjs',
        ready: { url: 'http://127.0.0.1:59999/health', timeout_ms: 3000 },
        env: { FACILITATOR_URL: `http://127.0.0.1:${facPort}` },
        battery: 'x402-core',
      }),
    );
    const { ports, capture } = portsFor(repo, 'k-main');
    const outcome = await runArgus(ports);
    expect(outcome.conclusion).toBe('action_required');
    const result = JSON.parse(fs.readFileSync(path.join(repo, 'argus-run', 'argus-result.json'), 'utf8'));
    expect(result.rollup).toBe('HARNESS_ERROR');
    expect(result.harness_error.message).toContain('did not become ready');
    expect(capture.summaries.join('\n')).toContain('HARNESS_ERROR');
  });

  it('G: leaky SUT — replays and bad amounts get served -> FAIL -> failure', async () => {
    const f = await makeSellerFixture({ sutEnv: { SUT_VULN_TRUST_CLIENT: '1' } });
    const { ports, capture } = portsFor(f.repo, 'k-leaky');
    const outcome = await runArgus(ports);
    expect(outcome.conclusion).toBe('failure');
    expect(outcome.rollup).toBe('FAIL');
    const result = JSON.parse(fs.readFileSync(path.join(f.repo, 'argus-run', 'argus-result.json'), 'utf8'));
    const failed = result.verdicts.filter((v: { verdict: string }) => v.verdict === 'FAIL').map((v: { session_id: string }) => v.session_id);
    expect(failed).toEqual(expect.arrayContaining(['bc-03', 'bc-05', 'bc-06', 'bc-07', 'bc-08', 'bc-09']));
    expect(capture.annotations.filter((a) => a.level === 'error').length).toBeGreaterThanOrEqual(6);
  });

  it('H: client role — correct buyer refuses all poisoned offers (6 S-BS DOCUMENTED)', async () => {
    const f = await makeBuyerFixture();
    const { ports, capture } = portsFor(f.repo, 'k-buyer');
    const outcome = await runArgus(ports);
    expect(outcome.conclusion).toBe('neutral');
    expect(outcome.rollup).toBe('DOCUMENTED');
    const result = JSON.parse(fs.readFileSync(path.join(f.repo, 'argus-run', 'argus-result.json'), 'utf8'));
    expect(result.verdicts).toHaveLength(6);
    expect(result.verdicts.every((v: { family: string }) => v.family === 'S-BS')).toBe(true);
    expect(result.verdicts.every((v: { verdict: string }) => v.verdict === 'DOCUMENTED')).toBe(true);
    expect(result.verdicts.find((v: { session_id: string }) => v.session_id === 'bs-04').refusal.code).toBe('untrusted_facilitator');
    expect(capture.summaries.join('\n')).toContain('bs-05 forged-receipt-unaccepted');
  });

  it('I: client role — naive buyer pays poisoned offers -> FAIL -> failure', async () => {
    const f = await makeBuyerFixture({ buyerEnv: { BUYER_VULN_SKIP_VALIDATION: '1' } });
    const { ports, capture } = portsFor(f.repo, 'k-buyer-vuln');
    const outcome = await runArgus(ports);
    expect(outcome.conclusion).toBe('failure');
    expect(outcome.rollup).toBe('FAIL');
    const result = JSON.parse(fs.readFileSync(path.join(f.repo, 'argus-run', 'argus-result.json'), 'utf8'));
    const failed = result.verdicts.filter((v: { verdict: string }) => v.verdict === 'FAIL').map((v: { session_id: string }) => v.session_id);
    expect(failed).toEqual(expect.arrayContaining(['bs-01', 'bs-02', 'bs-03', 'bs-04', 'bs-05', 'bs-06']));
    expect(capture.conclusions).toEqual(['failure']);
  });

  it('J: payment.rail "base-sepolia" -> rejected before any session (deferred to v2.1)', async () => {
    const f = await makeSellerFixture({ paymentRail: 'base-sepolia' });
    const { ports, capture } = portsFor(f.repo, 'k-main');
    const outcome = await runArgus(ports);

    expect(outcome.conclusion).toBe('action_required');
    const result = JSON.parse(fs.readFileSync(path.join(f.repo, 'argus-run', 'argus-result.json'), 'utf8'));
    expect(result.rollup).toBe('HARNESS_ERROR');
    expect(result.payment_rail).toBe('base-sepolia');
    expect(result.verdicts).toHaveLength(0);
    expect(result.ledgers).toEqual([]);
    expect(result.harness_error.message).toContain('not wired into ci-local runs');
    expect(result.harness_error.message).toContain('base-sepolia');
    expect(capture.summaries.join('\n')).toContain('HARNESS_ERROR');
    // the SUT was spawned, but zero protocol sessions ran against it
    expect(fs.existsSync(path.join(f.repo, 'argus-run', 'ledgers'))).toBe(false);
  });
});
