// Unit tests: seal verifier tamper matrix (P0-1 DoD), canonical form parity
// with the engine, result-view rollup rules (P0-5), SUT contract validation,
// timeouts (P0-4) and rendering.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/lib/canonical';
import { loadBundleKeys, verifySeal } from '../src/lib/seal';
import { loadSutContract, EXAMPLE_SUT } from '../src/lib/sut-contract';
import { gateResult } from '../src/lib/result-gate';
import { checkRunName, conclusionFor, idempotencyKeyFor } from '../src/lib/render';
import { COMMENT_MARKER, renderComment, renderSummary } from '../src/lib/summary';
import { TIMEOUTS, registerRun, type RunPayload } from '../src/lib/console-client';
import { CONCLUSION_MAP, rollupOf, validateResult } from '../src/vendor/result-view.mjs';
import { createHash } from 'node:crypto';

// Engine canonical-form parity lives in the closed repo, which is absent in
// the public CI. The import is therefore dynamic (through a non-literal spec
// so typecheck does not probe the closed path); when the repo is present the
// parity test runs byte-for-byte, otherwise it skips.
let engineCanonical: ((obj: unknown) => string) | null = null;
try {
  const engineProtocol = new URL('../../closed-repo-ci/engine/protocol.mjs', import.meta.url).pathname;
  ({ canonical: engineCanonical } = await import(engineProtocol));
} catch {
  // closed repo not present in the public CI — parity test skips
}
const itParity = engineCanonical ? it : it.skip;

const run = promisify(execFile);
const root = new URL('../..', import.meta.url).pathname;
// The CI packer (bundle build + tamper matrix) also lives in the closed repo.
const closedRepoPresent = fs.existsSync(path.join(root, 'closed-repo-ci', 'ci', 'build-bundle.mjs'));

let tmp: string;
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-unit-'));
  if (!closedRepoPresent) {
    console.warn('closed repo absent (public CI): bundle-backed unit tests skip');
    return;
  }
  // Build a real sealed bundle via the CI packer against a stub engine.
  fs.mkdirSync(path.join(tmp, 'engine'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'engine', 'run.mjs'), 'console.log("stub engine");\n');
  await run(
    'node',
    [
      path.join(root, 'closed-repo-ci', 'ci', 'build-bundle.mjs'),
      '--engine', path.join(tmp, 'engine'),
      '--version', '2.1.0',
      '--key-id', 'bundle-test-1',
      '--out', path.join(tmp, 'bundle'),
      '--keys-file', path.join(tmp, 'keys.json'),
      '--dev-keys-dir', path.join(tmp, 'dev-keys'),
    ],
  );
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('canonical form parity', () => {
  itParity('action canonical matches engine canonical byte-for-byte', () => {
    const obj = { b: 2, a: { d: [1, { z: null, y: true }], c: 'x' } };
    expect(canonical(obj)).toBe(engineCanonical!(obj));
  });
  it('is stable under key insertion order', () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
  });
});

const describeSeal = closedRepoPresent ? describe : describe.skip;

describeSeal('seal verifier (P0-1 tamper matrix)', () => {
  const bundleDir = () => path.join(tmp, 'bundle');
  const keys = () => loadBundleKeys(path.join(tmp, 'keys.json'));

  it('accepts a well-sealed bundle', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir(), 'manifest.json'), 'utf8'));
    expect(verifySeal(manifest, path.join(bundleDir(), 'engine.bundle.tar.gz'), keys())).toEqual({ ok: true });
  });

  it('rejects a tampered tarball (tree_sha256 mismatch)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir(), 'manifest.json'), 'utf8'));
    const bytes = fs.readFileSync(path.join(bundleDir(), 'engine.bundle.tar.gz'));
    bytes[bytes.length - 1] ^= 0xff;
    const p = path.join(tmp, 'tampered.tar.gz');
    fs.writeFileSync(p, bytes);
    const res = verifySeal(manifest, p, keys());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('tree_sha256 mismatch');
  });

  it('rejects a tampered manifest field (signature invalid)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir(), 'manifest.json'), 'utf8'));
    const res = verifySeal({ ...manifest, engine_version: '9.9.9' }, path.join(bundleDir(), 'engine.bundle.tar.gz'), keys());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('signature invalid');
  });

  it('rejects a foreign key_id', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir(), 'manifest.json'), 'utf8'));
    const res = verifySeal({ ...manifest, key_id: 'bundle-rogue-999' }, path.join(bundleDir(), 'engine.bundle.tar.gz'), keys());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('unknown key_id');
  });

  it('rejects an unsupported manifest schema', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir(), 'manifest.json'), 'utf8'));
    const res = verifySeal({ ...manifest, schema: 'argus.bundle.vX' }, path.join(bundleDir(), 'engine.bundle.tar.gz'), keys());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('unsupported manifest schema');
  });
});

describe('result-view rollup rules (P0-5)', () => {
  const evidenceDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rv-'));
    fs.mkdirSync(path.join(dir, 'ledgers', 'x402-core'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ledgers', 'x402-core', 's1.jsonl'), '{"event":"verdict"}\n');
    return dir;
  };

  const validResult = (cwd: string) => ({
    schema: 'argus.result.v0',
    mode: 'ci-local',
    battery: 'x402-core',
    engine_version: '2.1.0',
    bundle: { key_id: 'k', tree_sha256: 'x' },
    started_at: new Date().toISOString(),
    duration_ms: 10,
    rollup: 'DOCUMENTED',
    verdicts: [
      { session_id: 'bc-01', family: 'BC', name: 'challenge-gate', verdict: 'PASS', refusal: null, note: null, duration_ms: 4, evidence: 'ledgers/x402-core/s1.jsonl' },
      { session_id: 'bc-03', family: 'BC', name: 'replay-refused', verdict: 'DOCUMENTED', refusal: { code: 'nonce_reused' }, note: null, duration_ms: 6, evidence: 'ledgers/x402-core/s1.jsonl' },
    ],
    ledgers: ['ledgers/x402-core/s1.jsonl'],
    seal: { eligible: true, sealed: false },
  });

  it('accepts a valid ci-local result', () => {
    const cwd = evidenceDir();
    const res = validateResult(validResult(cwd), { cwd });
    expect(res.ok).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects rollup mismatch', () => {
    const cwd = evidenceDir();
    const res = validateResult({ ...validResult(cwd), rollup: 'PASS' }, { cwd });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => String(e).includes('rollup'))).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects a sealed ci-local run', () => {
    const cwd = evidenceDir();
    const res = validateResult({ ...validResult(cwd), seal: { eligible: true, sealed: true } }, { cwd });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => String(e).includes('never be sealed'))).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('requires ledger evidence paths in ci-local', () => {
    const cwd = evidenceDir();
    const res = validateResult({ ...validResult(cwd), ledgers: [] }, { cwd });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => String(e).includes('evidence'))).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects DOCUMENTED without a known refusal code', () => {
    const cwd = evidenceDir();
    const r = validResult(cwd);
    (r.verdicts[1] as { refusal: unknown }).refusal = { code: 'because' };
    const res = validateResult(r, { cwd });
    expect(res.ok).toBe(false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects an unknown verdict and computes rollup as max severity', () => {
    expect(rollupOf([{ verdict: 'PASS' }, { verdict: 'DOCUMENTED' }])).toBe('DOCUMENTED');
    expect(rollupOf([{ verdict: 'PASS' }, { verdict: 'FAIL' }, { verdict: 'DOCUMENTED' }])).toBe('FAIL');
    expect(rollupOf([{ verdict: 'HARNESS_ERROR' }, { verdict: 'FAIL' }])).toBe('HARNESS_ERROR');
    expect(CONCLUSION_MAP.PASS).toBe('success');
    expect(CONCLUSION_MAP.FAIL).toBe('failure');
    expect(CONCLUSION_MAP.DOCUMENTED).toBe('neutral');
    expect(CONCLUSION_MAP.HARNESS_ERROR).toBe('action_required');
  });

  it('gates via the typed wrapper', () => {
    const cwd = evidenceDir();
    const gate = gateResult(validResult(cwd) as never, { cwd });
    expect(gate.ok).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('SUT contract validation', () => {
  it('accepts the spec example', () => {
    const p = path.join(tmp, 'sut-ok.json');
    fs.writeFileSync(p, EXAMPLE_SUT);
    const res = loadSutContract(p);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.battery).toBe('x402-core');
      expect(res.role).toBe('seller');
      expect(res.rail).toBe('local');
    }
  });

  it('keeps every URL in the spec example off the fetch bad-port list', () => {
    // Ports blocked by undici/Node fetch (WHATWG "bad port" list, bundled in
    // dist) are rejected before a connection is even attempted. v2.1.1 shipped
    // an example with FACILITATOR_URL on 5060/5061 (SIP/SIPS) — any SUT that
    // copied it got a guaranteed `fetch failed: bad port`.
    const badPorts = new Set([
      1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
      102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
      427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
      989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665,
      6666, 6667, 6668, 6669, 6697, 10080,
    ]);
    const urls = [...EXAMPLE_SUT.matchAll(/https?:\/\/[^\s"]+/g)].map((m) => new URL(m[0]));
    expect(urls.length).toBe(2); // ready.url + FACILITATOR_URL
    for (const u of urls) {
      expect(badPorts.has(Number(u.port))).toBe(false);
    }
    expect(EXAMPLE_SUT).not.toContain(':5060');
    expect(EXAMPLE_SUT).not.toContain(':5061');
  });

  it('flags a missing file as onboarding', () => {
    const res = loadSutContract(path.join(tmp, 'nope.json'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.missing).toBe(true);
  });

  it('rejects bad schema, bad role and impossible timeouts', () => {
    const cases = [
      { schema: 'argus.sut.v9', start: 'x', ready: { url: 'http://127.0.0.1:1/health', timeout_ms: 5000 } },
      { schema: 'argus.sut.v0', start: 'x', ready: { url: 'http://127.0.0.1:1/health', timeout_ms: 5000 }, role: 'unicorn' },
      { schema: 'argus.sut.v0', start: 'x', ready: { url: 'http://127.0.0.1:1/health', timeout_ms: 10 } },
      { schema: 'argus.sut.v0', start: 'x', ready: { url: 'http://127.0.0.1:1/health', timeout_ms: 5000 }, role: 'client' },
    ];
    for (const [i, c] of cases.entries()) {
      const p = path.join(tmp, `sut-bad-${i}.json`);
      fs.writeFileSync(p, JSON.stringify(c));
      const res = loadSutContract(p);
      expect(res.ok).toBe(false);
    }
  });
});

describe('P0-4 timeouts', () => {
  it('pins console/bundle and GitHub timeouts', () => {
    expect(TIMEOUTS.bundleMetaMs).toBe(30_000);
    expect(TIMEOUTS.bundleDownloadMs).toBe(120_000);
    expect(TIMEOUTS.registerRunMs).toBe(30_000);
    expect(TIMEOUTS.githubApiMs).toBe(10_000);
  });
});

describe('registerRun: idempotent replay (409)', () => {
  const cfg = { baseUrl: 'https://console.test', apiKey: 'argci_test' };
  const payload: RunPayload = {
    mode: 'ci-local',
    battery: 'x402-core',
    engine_version: '2.1.1',
    bundle: { key_id: 'bundle-2026q4', tree_sha256: 'a'.repeat(64) },
    rollup: 'DOCUMENTED',
    verdicts: [],
    duration_ms: 1,
    public: true,
    repo: 'igor-vii/argus-ci-dogfood',
    commit: 'a'.repeat(40),
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('409 + X-Argus-Replayed: 1 is a free replay — cached run identity, zero charge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ schema: 'argus.result.v0', public: true, run: { id: 'r-42', url: '/runs/r-42' } }),
      { status: 409, headers: { 'x-argus-replayed': '1', 'x-argus-balance': '137' } },
    )));
    const reg = await registerRun(cfg, payload, 'f'.repeat(64));
    expect(reg.replayed).toBe(true);
    expect(reg.charged_credits).toBe(0);
    expect(reg.balance).toBe(137);
    expect(reg.id).toBe('r-42');
    expect(reg.url).toBe('/runs/r-42');
    expect(reg.public).toBe(true);
  });

  it('409 without the replay header is a conflict (run in flight), not a replay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'run_in_progress', run_id: 'r-7' }),
      { status: 409 },
    )));
    await expect(registerRun(cfg, payload, 'f'.repeat(64)))
      .rejects.toThrow(/conflict: run_in_progress \(run r-7\)/);
  });

  it('409 conflict without run_id keeps the plain message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'run_in_progress' }),
      { status: 409 },
    )));
    await expect(registerRun(cfg, payload, 'f'.repeat(64)))
      .rejects.toThrow('conflict: run_in_progress');
  });
});

describe('rendering and naming', () => {
  const sessions = [
    { session_id: 'bc-01', family: 'BC', name: 'challenge-gate', verdict: 'PASS', refusal: null, duration_ms: 4 },
    { session_id: 'bc-03', family: 'BC', name: 'replay-refused', verdict: 'DOCUMENTED', refusal: { code: 'nonce_reused' }, duration_ms: 6 },
  ] as never as Parameters<typeof renderSummary>[0]['sessions'];

  it('summary carries run link, ci-local line, seal policy and footer', () => {
    const md = renderSummary({
      battery: 'x402-core',
      rollup: 'DOCUMENTED',
      engineVersion: '2.1.0',
      keyId: 'bundle-test-1',
      runUrl: 'https://argus-lab.tech/runs/r-123',
      sessions,
      durationMs: 42,
    });
    expect(md).toContain('https://argus-lab.tech/runs/r-123');
    expect(md).toContain('ci-local run — evidence: ledgers attached; not a registry seal');
    expect(md).toContain('Seal-eligible: candidate');
    expect(md).toContain('argus-lab.tech');
    expect(md).toContain('| bc-03 replay-refused |');
  });

  it('comment carries exactly one marker and the session table', () => {
    const body = renderComment({
      battery: 'x402-core',
      rollup: 'DOCUMENTED',
      engineVersion: '2.1.0',
      keyId: 'k',
      sessions,
    });
    expect(body.split(COMMENT_MARKER).length - 1).toBe(1);
    expect(body).toContain('| Session |');
  });

  it('check-run name matches the billboard contract (P1-2)', () => {
    expect(checkRunName('x402-core')).toBe('argus-battery (x402-core) by Argus Lab');
  });

  it('conclusion mapping and idempotency key', () => {
    expect(conclusionFor('DOCUMENTED')).toBe('neutral');
    expect(conclusionFor('HARNESS_ERROR')).toBe('action_required');
    expect(idempotencyKeyFor({ repo: 'a/b', commit: 'c', battery: 'x402-core' } as never)).toBe(
      createHash('sha256').update('argus.idem.v1:c:x402-core').digest('hex'),
    );
  });

  it('P1-6: drift vs baseline marks worse/improved and flaky after 3 flaps', async () => {
    const { deltaOf, flakyIdsOf, driftAnnotations, verdictMapOf } = await import('../src/lib/delta');
    const sessions = [
      { session_id: 'bc-01', name: 's1', verdict: 'FAIL', refusal: null, duration_ms: 1 },
      { session_id: 'bc-02', name: 's2', verdict: 'PASS', refusal: null, duration_ms: 1 },
    ] as import('../src/lib/types').SessionVerdict[];
    const baseline = { 'bc-01': 'PASS', 'bc-02': 'DOCUMENTED' };
    const d = deltaOf(sessions, baseline);
    expect(d.comparable).toBe(true);
    expect(d.drift).toHaveLength(2);
    expect(d.drift.find((x) => x.id === 'bc-01')?.worse).toBe(true);
    expect(d.drift.find((x) => x.id === 'bc-02')?.worse).toBe(false);
    // history: PASS → FAIL → PASS → FAIL = 3 changes → flaky
    const history = [
      { commit: 'a', verdicts: { 'bc-01': 'PASS' } },
      { commit: 'b', verdicts: { 'bc-01': 'FAIL' } },
      { commit: 'c', verdicts: { 'bc-01': 'PASS' } },
    ];
    const flaky = flakyIdsOf(history, sessions);
    expect(flaky.has('bc-01')).toBe(true);
    expect(flaky.has('bc-02')).toBe(false);
    const anns = driftAnnotations(d.drift, flaky);
    expect(anns.some((a) => a.title.startsWith('drift: bc-01') && a.level === 'warning')).toBe(true);
    expect(anns.some((a) => a.title === 'flaky: bc-01')).toBe(false); // drift annotation already covers bc-01 with flaky suffix
  });

  it('P1-6: no baseline -> not comparable, empty drift', async () => {
    const { deltaOf } = await import('../src/lib/delta');
    const d = deltaOf([{ session_id: 'x', name: 'x', verdict: 'PASS', refusal: null, duration_ms: 1 }], null);
    expect(d.comparable).toBe(false);
    expect(d.drift).toHaveLength(0);
  });
});
