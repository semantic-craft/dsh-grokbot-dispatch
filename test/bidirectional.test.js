import { BOX_IP, GROK_PEER, ZCODE_PEER } from './helpers/net-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, JobStore, startJob, validateDispatch } from '../plugin/core.js';
import { JobMapStore, embedJobTag, extractJobId, formatReportPayload, reportJobViaYobiru } from '../plugin/job-map.js';
import { dispatchOutbound, parseOutboundInput, registerDispatchCommands } from '../plugin/commands.js';
import pluginDefault, { createServer, installSessionCompletionHook, name as pluginName } from '../plugin/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, '../plugin');

function makeTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gbd-bi-proj-'));
  fs.mkdirSync(path.join(root, 'sonori'));
  fs.mkdirSync(path.join(root, 'dsh-grokbot-dispatch'));
  fs.mkdirSync(path.join(root, 'Finance'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbd-bi-state-'));
  const keyFile = path.join(stateDir, 'key');
  fs.writeFileSync(keyFile, 'a'.repeat(64), { mode: 0o600 });
  return { root, stateDir, keyFile };
}

test('official DSH plugin manifest and locale files match DSH 0.2.0-rc.2 contract', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-grokbot-dispatch');
  assert.equal(pkg.dsh?.manifestVersion, 1);
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh?.harnessRange, '>=0.2.0-rc.2');
  assert.ok(pkg.exports['.']);
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');

  const en = JSON.parse(fs.readFileSync(path.join(pluginDir, 'locale/en.json'), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(path.join(pluginDir, 'locale/zh-CN.json'), 'utf8'));
  assert.ok(en.meta?.title && en.meta?.description);
  assert.ok(zh.meta?.title && zh.meta?.description);
  assert.equal(pluginDefault.name, pluginName);
  assert.equal(typeof pluginDefault.apply, 'function');
});

test('JobMapStore persists sessionId <-> jobId and resolves embedded [Job: <id>] tags', () => {
  const { stateDir } = makeTempEnv();
  const map1 = new JobMapStore(stateDir);
  const jobId = '1234567890abcdef';
  map1.bind({
    jobId,
    sessionId: 'session-abc-123',
    project: 'sonori',
    source: 'yobiru',
    yobiruId: jobId,
    direction: 'inbound',
  });

  // Re-instantiate from disk to verify persistence
  const map2 = new JobMapStore(stateDir);
  assert.equal(map2.getByJob(jobId)?.sessionId, 'session-abc-123');
  assert.equal(map2.getBySession('session-abc-123')?.jobId, jobId);

  // Resolve a session that was not yet bound by sessionId using embedded [Job: <id>] in title/prompt
  const unboundJobId = 'fedcba0987654321';
  map2.bind({ jobId: unboundJobId, project: 'sonori', source: 'grok-bot', reportViaYobiru: true });
  const titleWithTag = embedJobTag('[Grok Bot] run tests', unboundJobId);
  assert.equal(titleWithTag, `[Grok Bot] [Job: ${unboundJobId}] run tests`);
  assert.equal(extractJobId(titleWithTag), unboundJobId);

  const resolved = map2.resolveForSession('session-late-999', [titleWithTag]);
  assert.equal(resolved?.jobId, unboundJobId);
  assert.equal(map2.getBySession('session-late-999')?.jobId, unboundJobId);
});

test('reportJobViaYobiru calls request respond + ack for yobiruId and is idempotent', async () => {
  const { stateDir } = makeTempEnv();
  const mapStore = new JobMapStore(stateDir);
  const jobId = 'aabbccddeeff0011';
  const entry = mapStore.bind({
    jobId,
    yobiruId: jobId,
    sessionId: 'session-yobiru-1',
    project: 'sonori',
    source: 'yobiru',
    reportViaYobiru: true,
  });

  const execCalls = [];
  const fakeExec = async (bin, args) => {
    execCalls.push([bin, ...args]);
    return { code: 0, stdout: 'ok', stderr: '' };
  };

  const r1 = await reportJobViaYobiru({
    cfg: { pythonBin: 'python3', tailmsgScript: '/mock/tailmsg.py', tailmsgHome: '/mock/.tailmsg' },
    mapStore,
    entry,
    outcome: { state: 'completed', sessionId: 'session-yobiru-1', project: 'sonori', result: 'all checks passed' },
    execRunner: fakeExec,
    logger: { info() {}, warn() {} },
  });

  assert.equal(r1.ok, true);
  assert.equal(r1.method, 'request-respond');
  assert.equal(execCalls.length, 2);
  assert.deepEqual(execCalls[0].slice(0, 6), ['python3', '/mock/tailmsg.py', '--home', '/mock/.tailmsg', 'request', 'respond']);
  assert.equal(execCalls[0][6], jobId);
  const payload = JSON.parse(execCalls[0][7]);
  assert.equal(payload.job_id, jobId);
  assert.equal(payload.state, 'completed');
  assert.equal(payload.result, 'all checks passed');
  assert.match(payload.summary, new RegExp(`\\[Job: ${jobId}\\]`));
  assert.deepEqual(execCalls[1], ['python3', '/mock/tailmsg.py', '--home', '/mock/.tailmsg', 'ack', jobId]);

  // Second call is skipped due to idempotency
  const r2 = await reportJobViaYobiru({
    cfg: {},
    mapStore,
    entry,
    outcome: { state: 'completed', result: 'duplicate' },
    execRunner: fakeExec,
    logger: { info() {}, warn() {} },
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, 'already-reported');
  assert.equal(execCalls.length, 2);
});

test('installSessionCompletionHook listens to session/event and reports via Yobiru on turn/end', async () => {
  const { stateDir } = makeTempEnv();
  const mapStore = new JobMapStore(stateDir);
  const jobId = '1122334455667788';
  mapStore.bind({
    jobId,
    callbackPeer: GROK_PEER,
    reportViaYobiru: true,
    project: 'sonori',
    source: 'grok-bot',
    direction: 'inbound',
  });

  const listeners = {};
  const fakeCtx = {
    on(event, fn) {
      listeners[event] = fn;
    },
  };
  const execCalls = [];
  const fakeExec = async (bin, args) => {
    execCalls.push([bin, ...args]);
    return { code: 0, stdout: 'sent', stderr: '' };
  };

  installSessionCompletionHook(fakeCtx, {
    cfg: {
      pythonBin: 'python3',
      tailmsgScript: '/mock/tailmsg.py',
      tailmsgHome: '/mock/.tailmsg',
      execRunner: fakeExec,
    },
    mapStore,
    getStore: () => null,
    logger: { info() {}, warn() {} },
  });

  const fakeSession = { id: 'session-hook-test', header: { id: 'session-hook-test', title: `[Grok Bot] [Job: ${jobId}] test task` } };
  listeners['session/event'](fakeSession, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: `[Job: ${jobId}] [Project: sonori] run check` }] },
  });
  listeners['session/event'](fakeSession, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'hook reported result!' }] } },
  });
  listeners['session/event'](fakeSession, {
    type: 'turn/end',
    data: { reason: { kind: 'completed' } },
  });

  // Wait briefly for async handleTurnEnd
  for (let i = 0; i < 50 && !mapStore.getByJob(jobId)?.reported; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const updated = mapStore.getByJob(jobId);
  assert.equal(updated.reported, true);
  assert.equal(updated.sessionId, 'session-hook-test');
  assert.equal(updated.reportMethod, 'send-callback');
  assert.equal(execCalls.length, 1);
  const sentPayload = JSON.parse(execCalls[0][6]);
  assert.equal(sentPayload.job_id, jobId);
  assert.equal(sentPayload.session_id, 'session-hook-test');
  assert.equal(sentPayload.result, 'hook reported result!');
});

test('outbound slash commands (/dispatch-grok, /dispatch-zcode, /dispatch-status) dispatch via Yobiru and bind job-map', async () => {
  const { root, stateDir } = makeTempEnv();
  const mapStore = new JobMapStore(stateDir);
  const registered = new Map();
  const fakeCtx = {
    commands: {
      register(def) {
        registered.set(def.name, def);
        return () => registered.delete(def.name);
      },
    },
  };

  const execCalls = [];
  const fakeExec = async (bin, args) => {
    execCalls.push([bin, ...args]);
    const isZcode = args.includes(ZCODE_PEER);
    const id = isZcode ? 'cccccccc11111111' : 'bbbbbbbb22222222';
    return { code: 0, stdout: JSON.stringify({ id, state: 'sent' }), stderr: '' };
  };

  registerDispatchCommands(fakeCtx, {
    cfg: {
      projectsRoot: root,
      pythonBin: 'python3',
      tailmsgScript: '/mock/tailmsg.py',
      tailmsgHome: '/mock/.tailmsg',
    },
    mapStore,
    getServices: () => undefined,
    getStore: () => ({ running: new Map(), get: () => null }),
    execRunner: fakeExec,
    logger: { info() {}, warn() {} },
  });

  assert.ok(registered.has('dispatch-grok'));
  assert.ok(registered.has('dispatch-zcode'));
  assert.ok(registered.has('dispatch-status'));

  // Test /dispatch-grok
  const grokRes = await registered.get('dispatch-grok').handler({
    rawInput: 'sonori verify audio pipeline',
    agent: { session: { header: { id: 'session-desktop-ui-1' } } },
  });
  assert.equal(grokRes.kind, 'success');
  assert.match(grokRes.text, /\[Job: bbbbbbbb22222222\]/);
  assert.equal(mapStore.getByJob('bbbbbbbb22222222')?.target, 'grok-bot');
  assert.equal(mapStore.getByJob('bbbbbbbb22222222')?.originSessionId, 'session-desktop-ui-1');

  // Test /dispatch-zcode
  const zcodeRes = await registered.get('dispatch-zcode').handler({
    rawInput: '[Project: dsh-grokbot-dispatch] run unit tests',
    agent: { session: { header: { id: 'session-desktop-ui-2' } } },
  });
  assert.equal(zcodeRes.kind, 'success');
  assert.match(zcodeRes.text, /\[Job: cccccccc11111111\]/);
  assert.equal(mapStore.getByJob('cccccccc11111111')?.target, 'zcode');

  // Refuses Finance project
  const finRes = await registered.get('dispatch-grok').handler({
    rawInput: 'Finance secret audit',
  });
  assert.equal(finRes.kind, 'error');
  assert.match(finRes.text, /not allowed/i);

  // Test /dispatch-status
  const statusRes = await registered.get('dispatch-status').handler({ rawInput: 'bbbbbbbb22222222' });
  assert.equal(statusRes.kind, 'success');
  assert.match(statusRes.text, /session-desktop-ui-1/);
});

test('Stop hook script (hooks/stop-report.mjs) resolves session_id from JobMapStore and invokes Yobiru', async () => {
  const { stateDir } = makeTempEnv();
  const mapStore = new JobMapStore(stateDir);
  const jobId = '445566778899aabb';
  mapStore.bind({
    jobId,
    sessionId: 'session-stop-cli-1',
    project: 'sonori',
    source: 'grok-bot',
    callbackPeer: GROK_PEER,
    reportViaYobiru: true,
    direction: 'inbound',
  });

  const fakeTailmsg = path.join(stateDir, 'fake-tailmsg.py');
  const outLog = path.join(stateDir, 'tailmsg-invocations.json');
  fs.writeFileSync(
    fakeTailmsg,
    `import json, sys\nopen(${JSON.stringify(outLog)}, "w").write(json.dumps(sys.argv[1:]))\n`,
    { mode: 0o700 },
  );

  const hookScript = path.join(pluginDir, 'hooks/stop-report.mjs');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], {
      env: {
        ...process.env,
        DISPATCH_STATE_DIR: stateDir,
        TAILMSG_SCRIPT: fakeTailmsg,
        TAILMSG_HOME: stateDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(
      JSON.stringify({
        session_id: 'session-stop-cli-1',
        hook_event_name: 'Stop',
        last_assistant_message: 'Stop hook CLI verified!',
      }),
    );
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });

  const args = JSON.parse(fs.readFileSync(outLog, 'utf8'));
  assert.equal(args[2], 'send');
  assert.equal(args[3], GROK_PEER);
  const payload = JSON.parse(args[4]);
  assert.equal(payload.job_id, jobId);
  assert.equal(payload.session_id, 'session-stop-cli-1');
  assert.equal(payload.result, 'Stop hook CLI verified!');
  assert.equal(mapStore.getByJob(jobId)?.reported, true);
});

test('E2E closed loop: dispatch -> visible desktop session -> completion -> automatic Yobiru report with matching jobId', async () => {
  const { root, stateDir } = makeTempEnv();
  const yobiruReports = [];
  const fakeExec = async (bin, args) => {
    yobiruReports.push([bin, ...args]);
    return { code: 0, stdout: 'ok', stderr: '' };
  };
  const cfg = {
    ...DEFAULTS,
    projectsRoot: root,
    stateDir,
    pythonBin: 'python3',
    tailmsgScript: '/mock/tailmsg.py',
    tailmsgHome: '/mock/.tailmsg',
    execRunner: fakeExec,
  };
  const store = new JobStore(cfg);

  let pushEvent;
  const eventQueue = [];
  const fakeServices = {
    workspaceController: {
      async create(r) {
        return { workspace: { workspaceId: 'ws-e2e', path: r.path }, created: true };
      },
    },
    sessionController: {
      async create() {
        return { sessionId: 'session-e2e-visible' };
      },
      async rename(r) {
        return { title: r.title, seq: 1 };
      },
      async prompt() {
        for (const ev of [
          { seq: 2, type: 'turn/start', data: {} },
          { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'E2E task finished cleanly' }] } } },
          { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ]) {
          eventQueue.push(ev);
          pushEvent?.();
        }
        return { accepted: true };
      },
      async cancel() {
        return { accepted: true };
      },
      follow(_r, signal) {
        return (async function* () {
          yield { type: 'snapshot', records: [] };
          while (!signal.aborted) {
            if (!eventQueue.length) {
              await new Promise((res) => {
                pushEvent = res;
                signal.addEventListener('abort', res, { once: true });
              });
              continue;
            }
            yield { type: 'event', event: eventQueue.shift() };
          }
        })();
      },
    },
    permissionPresets: { set() {} },
    agents: { get: () => ({ session: {} }) },
  };

  const incomingJobId = '9988776655443322';
  const spec = validateDispatch(cfg, {
    project: 'sonori',
    text: '[Project: sonori] run E2E closed-loop verification',
    source: 'yobiru',
    job_id: incomingJobId,
    yobiru_id: incomingJobId,
  });

  const job = startJob(store, spec, { info() {}, warn() {} }, fakeServices);
  assert.equal(job.id, incomingJobId);

  for (let i = 0; i < 100 && store.get(job.id)?.state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const finishedJob = store.get(incomingJobId);
  assert.equal(finishedJob.state, 'completed');
  assert.equal(finishedJob.session_id, 'session-e2e-visible');
  assert.equal(finishedJob.title, `[Yobiru] [Job: ${incomingJobId}] run E2E closed-loop verification`);

  const mapped = store.mapStore.getByJob(incomingJobId);
  assert.equal(mapped.reported, true);
  assert.equal(mapped.reportMethod, 'request-respond');
  assert.equal(yobiruReports.length, 2); // request respond + ack
  const reportedPayload = JSON.parse(yobiruReports[0][7]);
  assert.equal(reportedPayload.job_id, incomingJobId);
  assert.equal(reportedPayload.yobiru_id, incomingJobId);
  assert.equal(reportedPayload.session_id, 'session-e2e-visible');
  assert.equal(reportedPayload.state, 'completed');
  assert.equal(reportedPayload.result, 'E2E task finished cleanly');
});
