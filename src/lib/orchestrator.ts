// Orchestrator: the whole P0 flow, wired through Ports so it runs identically
// inside GitHub Actions and in local e2e.
//
// Flow: SUT contract -> sealed bundle (cache -> download -> seal verify) ->
// extraction -> SUT spawn + ready gate -> engine run (real protocol sessions,
// JSONL ledgers) -> client-side result validation (P0-5) -> console
// registration (idempotent debit) -> verdicts, annotations, summary, artifacts,
// check-run billboard, opt-in comment.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { x as tarX } from 'tar';
import { loadBundleKeys, verifySeal } from './seal';
import { loadSutContract, EXAMPLE_SUT, type SutContract } from './sut-contract';
import { BillingError, downloadBundle, fetchBundleMeta, registerRun, type RunPayload } from './console-client';
import { gateResult } from './result-gate';
import { checkRunName, conclusionFor, evidenceFiles, idempotencyKeyFor, sessionAnnotations } from './render';
import { driftAnnotations, deltaOf, driftSummaryLines, flakyIdsOf, HISTORY_LIMIT, type DriftEntry, type HistoryEntry, verdictMapOf } from './delta';
import { renderBillingSummary, renderComment, renderOnboardingSummary, renderSealFailureSummary, renderSummary } from './summary';
import type { Annotation, ArgusResult, Conclusion, Outcome, Ports, SessionVerdict } from './types';

const CI_LOCAL_NOTICE = 'ci-local run — evidence: ledgers attached; not a registry seal';
const DOCS_URL = 'https://argus-lab.tech/docs/result-contract-v0';
const READY_POLL_MS = 500;
const RUN_BUDGET_MS = 600_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function detachSpawn(command: string, cwd: string, env: Record<string, string>, logPath: string) {
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(command, {
    shell: true,
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  return child;
}

async function killTree(pid: number): Promise<void> {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      pid && process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await sleep(1500);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

async function waitReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      /* keep polling until the deadline */
    }
    await sleep(READY_POLL_MS);
  }
  return false;
}

async function runEngine(ports: Ports, engineEntry: string, contractPath: string, workspace: string, manifest: { engine_version: string; key_id: string; tree_sha256: string }): Promise<number> {
  return new Promise((resolve) => {
    const logPath = path.join(workspace, 'engine-run.log');
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(
      process.execPath,
      [
        engineEntry,
        '--sut', contractPath,
        '--workspace', workspace,
        '--mode', 'ci-local',
        '--engine-version', manifest.engine_version,
        '--bundle-key-id', manifest.key_id,
        '--bundle-sha256', manifest.tree_sha256,
      ],
      { cwd: workspace, env: process.env, stdio: ['ignore', logFd, logFd] },
    );
    const budget = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve(124);
    }, RUN_BUDGET_MS);
    child.on('exit', (code) => {
      clearTimeout(budget);
      resolve(code ?? 1);
    });
    child.on('error', () => {
      clearTimeout(budget);
      resolve(1);
    });
    void ports;
  });
}

function syntheticHarnessResult(battery: string, message: string): ArgusResult {
  return {
    schema: 'argus.result.v0',
    mode: 'ci-local',
    battery,
    engine_version: '0.0.0',
    bundle: { key_id: '', tree_sha256: '' },
    started_at: new Date().toISOString(),
    duration_ms: 0,
    rollup: 'HARNESS_ERROR',
    verdicts: [],
    ledgers: [],
    seal: { eligible: true, sealed: false },
    harness_error: { message },
  };
}

export async function runArgus(ports: Ports): Promise<Outcome> {
  const { inputs, paths } = ports;
  fs.mkdirSync(paths.workspace, { recursive: true });

  // ---- 1. SUT contract (missing/invalid -> action_required + onboarding) ----
  const contractPath = path.resolve(paths.repoRoot, inputs.sutContractPath);
  const contract = loadSutContract(contractPath);
  if (!contract.ok) {
    ports.log(`SUT contract problem: ${contract.reason}`);
    ports.annotate({ level: 'error', title: 'argus.sut.json', message: contract.reason });
    ports.summary.add(renderOnboardingSummary(contract.reason, EXAMPLE_SUT, DOCS_URL));
    await ports.summary.write();
    await ports.conclusion('action_required');
    return { conclusion: 'action_required' };
  }
  const battery = inputs.battery?.trim() ? inputs.battery.trim() : contract.battery;
  ports.log(`argus.sut.json ok: battery=${battery} role=${contract.role} rail=${contract.rail}`);

  // ---- 2. sealed bundle: meta -> cache -> download ----
  const bundleDir = path.join(paths.workspace, 'bundle');
  fs.mkdirSync(bundleDir, { recursive: true });
  const tarPath = path.join(bundleDir, 'engine.bundle.tar.gz');
  let meta;
  try {
    meta = await fetchBundleMeta({ baseUrl: inputs.consoleUrl, apiKey: inputs.consoleApiKey }, battery);
  } catch (err) {
    ports.log(`bundle fetch failed: ${String(err)}`);
    ports.annotate({ level: 'error', title: 'engine bundle', message: `fetch failed: ${String(err)}` });
    ports.summary.add(renderSealFailureSummary(`bundle fetch failed: ${String(err)}`));
    await ports.summary.write();
    await ports.conclusion('action_required');
    return { conclusion: 'action_required' };
  }
  const manifest = meta.manifest as unknown as { engine_version: string; key_id: string; tree_sha256: string; schema: string; batteries: string[]; created_at: string; signature: string };
  ports.log(`console reported engine v${meta.engineVersion}`);

  let keys: ReturnType<typeof loadBundleKeys>;
  try {
    keys = loadBundleKeys(path.resolve(paths.repoRoot, inputs.bundleKeysPath));
  } catch (err) {
    ports.log(`bundle keys error: ${String(err)}`);
    ports.summary.add(renderSealFailureSummary(`bundle keys unreadable: ${String(err)}`));
    await ports.summary.write();
    await ports.conclusion('action_required');
    return { conclusion: 'action_required' };
  }

  let cached = false;
  if (ports.cache) {
    try {
      cached = await ports.cache.restore(`argus-engine-${manifest.engine_version}`, bundleDir);
      if (cached) ports.log(`bundle restored from cache for engine ${manifest.engine_version}`);
    } catch (err) {
      ports.log(`cache restore skipped: ${String(err)}`);
    }
  }
  if (!cached) {
    fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(meta.manifest, null, 2));
    await downloadBundle(meta.tarballUrl, tarPath);
    if (ports.cache) {
      try {
        await ports.cache.save(`argus-engine-${manifest.engine_version}`, bundleDir);
      } catch (err) {
        ports.log(`cache save skipped: ${String(err)}`);
      }
    }
  }

  // ---- 3. seal verification: broken seal -> action_required, zero execution ----
  const seal = verifySeal(manifest, tarPath, keys);
  if (!seal.ok) {
    ports.log(`seal verification failed: ${seal.reason}`);
    ports.annotate({ level: 'error', title: 'bundle seal', message: `${seal.reason} — engine not executed` });
    ports.summary.add(renderSealFailureSummary(seal.reason));
    await ports.summary.write();
    await ports.conclusion('action_required');
    return { conclusion: 'action_required' };
  }
  ports.log(`engine v${manifest.engine_version}, bundle verified (key_id=${manifest.key_id})`);

  // ---- 4. extraction ----
  const pkgDir = path.join(paths.workspace, 'pkg');
  fs.mkdirSync(pkgDir, { recursive: true });
  await tarX({ cwd: pkgDir, file: tarPath });
  const engineEntry = path.join(pkgDir, 'engine', 'run.mjs');
  if (!fs.existsSync(engineEntry)) {
    ports.summary.add(renderSealFailureSummary('bundle payload does not contain engine/run.mjs'));
    await ports.summary.write();
    await ports.conclusion('action_required');
    return { conclusion: 'action_required' };
  }

  // ---- 5. SUT spawn + ready gate ----
  const sutLogPath = path.join(paths.workspace, 'sut.log');
  const sutChild = detachSpawn(contract.contract.start, paths.repoRoot, contract.contract.env ?? {}, sutLogPath);
  let sutReady = false;
  let harnessMessage = '';
  try {
    sutReady = await waitReady(contract.contract.ready.url, contract.contract.ready.timeout_ms);
    if (!sutReady) harnessMessage = `SUT did not become ready at ${contract.contract.ready.url} within ${contract.contract.ready.timeout_ms} ms`;
  } catch (err) {
    harnessMessage = `SUT readiness probe failed: ${String(err)}`;
  }

  let result: ArgusResult;
  if (!sutReady) {
    await killTree(sutChild.pid ?? 0);
    ports.annotate({ level: 'error', title: 'SUT readiness', message: harnessMessage || 'SUT did not become ready' });
    result = syntheticHarnessResult(battery, harnessMessage || 'SUT did not become ready');
  } else {
    // ---- 6. engine run (real sessions, ledgers, matchers) ----
    const exitCode = await runEngine(ports, engineEntry, contractPath, paths.workspace, manifest);
    ports.log(`engine exited with code ${exitCode}`);
    await killTree(sutChild.pid ?? 0);
    const resultPath = path.join(paths.workspace, 'argus-result.json');
    if (fs.existsSync(resultPath)) {
      try {
        result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as ArgusResult;
      } catch (err) {
        result = syntheticHarnessResult(battery, `argus-result.json unreadable: ${String(err)}`);
      }
    } else {
      result = syntheticHarnessResult(battery, `engine produced no result (exit ${exitCode})`);
    }
  }

  // ---- 7. client-side validation (P0-5) ----
  const gate = gateResult(result, { cwd: paths.workspace });
  if (!gate.ok) {
    ports.log(`result validation failed: ${gate.errors.join('; ')}`);
    ports.annotate({ level: 'error', title: 'result validation', message: gate.errors.join('; ').slice(0, 300) });
    result = syntheticHarnessResult(battery, `engine result failed client-side validation: ${gate.errors[0] ?? 'unknown'}`);
  }

  // ---- 8. console registration (idempotent debit; 402 -> top-up) ----
  let runId: string | undefined;
  let runUrl: string | undefined;
  try {
    const payload: RunPayload = {
      mode: 'ci-local',
      battery,
      role: result.role ?? contract.role,
      engine_version: manifest.engine_version,
      bundle: { key_id: manifest.key_id, tree_sha256: manifest.tree_sha256 },
      rollup: result.rollup,
      verdicts: result.verdicts,
      duration_ms: result.duration_ms,
      public: inputs.publicRun,
      repo: inputs.repo,
      commit: inputs.commit,
    };
    const registration = await registerRun(
      { baseUrl: inputs.consoleUrl, apiKey: inputs.consoleApiKey },
      payload,
      idempotencyKeyFor({ ...inputs, battery }),
    );
    runId = registration.id || undefined;
    runUrl = registration.url ? `${inputs.consoleUrl.replace(/\/$/, '')}${registration.url}` : undefined;
    const replayNote = registration.replayed
      ? ' — idempotent replay, no re-debit (charge once, free retry)'
      : '';
    ports.log(
      `run registered${registration.replayed ? ' (replay)' : ''}${runUrl ? `: ${runUrl}` : ''} ` +
      `(charged ${registration.charged_credits}, balance ${registration.balance})${replayNote}`,
    );
    if (runId) ports.outputs.set('run-id', runId);
    if (runUrl) ports.outputs.set('run-url', runUrl);
  } catch (err) {
    if (err instanceof BillingError) {
      // Contract semantics (result-contract-v0): the agent was not measured, so
      // this must NOT read as a red agent failure — action_required, not failure.
      ports.log(`billing: ${String(err)}`);
      ports.annotate({ level: 'error', title: 'Argus billing', message: `${String(err)} · top-up at ${String(err.body.topup_url)}` });
      ports.summary.add(renderBillingSummary(err.body));
      await ports.summary.write();
      await ports.artifacts.upload([path.join(paths.workspace, 'argus-result.json'), ...evidenceFiles(result).map((p) => path.resolve(paths.workspace, p))], paths.workspace);
      await ports.conclusion('action_required');
      return { conclusion: 'action_required', rollup: result.rollup, engineVersion: manifest.engine_version };
    }
    ports.log(`run registration failed: ${String(err)}`);
    ports.annotate({ level: 'error', title: 'run registration', message: String(err) });
  }

  // ---- 9. render: enriched result, annotations, summary, artifacts ----
  result.run = runId && runUrl ? { id: runId, url: runUrl } : undefined;
  result.ci_local_notice = CI_LOCAL_NOTICE;
  const resultPath = path.join(paths.workspace, 'argus-result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

  // ---- 9a. P1-6: drift vs baseline fixture + flaky over verdict history ----
  let driftExtras: Annotation[] = [];
  let driftLines: string[] = [];
  try {
    const baselinePath = inputs.baselineFixture ? path.resolve(paths.repoRoot, inputs.baselineFixture) : '';
    let baselineVerdicts: Record<string, string> | null = null;
    if (baselinePath && fs.existsSync(baselinePath)) {
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      baselineVerdicts = verdictMapOf(baseline.verdicts);
    }
    const comparable = baselineVerdicts !== null;
    let drift: DriftEntry[] = [];
    if (comparable) {
      drift = deltaOf(result.verdicts, baselineVerdicts).drift;
    }
    const historyKey = `argus-verdicts-${inputs.repo}-${battery}`;
    let history: HistoryEntry[] = [];
    if (ports.history) {
      try {
        history = ((await ports.history.load(historyKey)) as HistoryEntry[] | null) ?? [];
      } catch (e) {
        ports.log(`verdict history load skipped: ${String(e)}`);
      }
    }
    const flaky = flakyIdsOf(history, result.verdicts);
    if (comparable) driftExtras = driftAnnotations(drift, flaky);
    else if (flaky.size) driftExtras = driftAnnotations([], flaky);
    driftLines = driftSummaryLines(comparable, drift, flaky, inputs.baselineFixture ?? 'baseline');
    if (ports.history && result.verdicts?.length) {
      try {
        const next: HistoryEntry[] = [...history, { commit: inputs.commit, verdicts: verdictMapOf(result.verdicts) }].slice(-HISTORY_LIMIT);
        await ports.history.save(historyKey, next);
      } catch (e) {
        ports.log(`verdict history save skipped: ${String(e)}`);
      }
    }
  } catch (e) {
    ports.log(`drift/flaky skipped: ${String(e)}`);
  }

  for (const a of [...sessionAnnotations(result.verdicts, runUrl), ...driftExtras]) ports.annotate(a);

  ports.summary.add(
    renderSummary({
      battery,
      role: result.role,
      rollup: result.rollup,
      engineVersion: manifest.engine_version,
      keyId: manifest.key_id,
      runUrl,
      sessions: result.verdicts,
      durationMs: result.duration_ms,
    }) + (driftLines.length ? `\n${driftLines.join('\n')}` : ''),
  );
  await ports.summary.write();

  try {
    await ports.artifacts.upload(
      [resultPath, ...evidenceFiles(result).map((p) => path.resolve(paths.workspace, p))],
      paths.workspace,
    );
    ports.log('evidence artifact uploaded (argus-result.json + JSONL ledgers)');
  } catch (err) {
    ports.log(`artifact upload skipped: ${String(err)}`);
  }

  // ---- 10. billboard check run (P1-2) + opt-in comment (P1-3) ----
  const conclusion: Conclusion = conclusionFor(result.rollup);
  if (ports.checks) {
    try {
      await ports.checks.create({
        name: checkRunName(battery),
        conclusion,
        title: `Argus battery ${battery} → ${result.rollup}`,
        summary: renderSummary({
          battery,
          rollup: result.rollup,
          engineVersion: manifest.engine_version,
          keyId: manifest.key_id,
          runUrl,
          sessions: result.verdicts,
        }),
        detailsUrl: runUrl,
        annotations: [...sessionAnnotations(result.verdicts, runUrl), ...driftExtras].slice(0, 50),
      });
    } catch (err) {
      ports.log(`check run skipped: ${String(err)}`);
    }
  }
  if (ports.comments) {
    try {
      await ports.comments.upsert(
        '<!-- argus-run-comment:v1 -->',
        renderComment({ battery, rollup: result.rollup, engineVersion: manifest.engine_version, keyId: manifest.key_id, runUrl, sessions: result.verdicts }),
      );
    } catch (err) {
      ports.log(`comment skipped: ${String(err)}`);
    }
  }

  ports.outputs.set('rollup', result.rollup);
  ports.outputs.set('engine-version', manifest.engine_version);
  await ports.conclusion(conclusion);
  return { conclusion, rollup: result.rollup, runId, runUrl, engineVersion: manifest.engine_version };
}

export type { SutContract };
