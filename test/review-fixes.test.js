import { BOX_IP, GROK_PEER, ZCODE_PEER } from './helpers/net-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobMapStore, reportJobViaYobiru } from '../plugin/job-map.js';
import { dispatchOutbound } from '../plugin/commands.js';

test('concurrent completion paths report a job only once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgd-'));
  const store = new JobMapStore(dir);
  store.bind({ jobId: 'aaaaaaaaaaaaaaaa', callbackPeer: 'peer/x', direction: 'inbound' });
  let calls = 0;
  const execRunner = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { code: 0, stdout: '', stderr: '' }; };
  const args = { mapStore: store, entry: store.getByJob('aaaaaaaaaaaaaaaa'), outcome: { state: 'completed', result: 'ok' }, execRunner, logger: {} };
  await Promise.all([reportJobViaYobiru(args), reportJobViaYobiru(args)]);
  assert.equal(calls, 1);
  assert.equal(store.getByJob('aaaaaaaaaaaaaaaa').reported, true);
});

test('outbound dispatch from an inbound job session keeps the inbound session mapping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgd-'));
  const store = new JobMapStore(dir);
  store.bind({ jobId: 'bbbbbbbbbbbbbbbb', sessionId: 'S1', direction: 'inbound' });
  const execRunner = async () => ({ code: 0, stdout: JSON.stringify({ id: 'cccccccccccccccc' }), stderr: '' });
  const out = await dispatchOutbound({ target: 'grok-bot', rawInput: 'proj do it', sessionId: 'S1', cfg: {}, mapStore: store, execRunner, logger: {} });
  assert.equal(out.jobId, 'cccccccccccccccc');
  assert.equal(store.getBySession('S1').jobId, 'bbbbbbbbbbbbbbbb');
  assert.equal(store.getByJob('cccccccccccccccc').originSessionId, 'S1');
});

test('registerDispatchCommands never touches ctx.commands/ctx.get directly when ctx.inject exists (Cordis)', async () => {
  const { registerDispatchCommands } = await import('../plugin/commands.js');
  const registered = new Map();
  const ctx = {
    get() { throw new Error('cannot get property "commands" without inject'); },
    get commands() { throw new Error('cannot get property "commands" without inject'); },
    inject(deps, cb) { assert.deepEqual(deps, ['commands']); cb({ commands: { register: (d) => { registered.set(d.name, d); return () => {}; } } }); },
  };
  assert.doesNotThrow(() => registerDispatchCommands(ctx, { cfg: {}, mapStore: null, logger: {} }));
  assert.ok(registered.has('dispatch-grok') && registered.has('dispatch-zcode') && registered.has('dispatch-status'));
});

test('startJob is idempotent for duplicate job_id while running and after completion', async () => {
  const { DEFAULTS, JobStore, startJob, validateDispatch } = await import('../plugin/core.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dgd-proj-'));
  fs.mkdirSync(path.join(root, 'sonori'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgd-state-'));
  const cfg = { ...DEFAULTS, projectsRoot: root, stateDir, maxConcurrent: 1, execRunner: async () => ({ code: 0, stdout: 'ok', stderr: '' }) };
  const store = new JobStore(cfg);

  let sessionCreations = 0;
  let releaseTurn;
  const turnGate = new Promise((res) => { releaseTurn = res; });
  const svc = {
    workspaceController: {
      async create(r) { return { workspace: { workspaceId: 'ws-dup', path: r.path }, created: true }; },
    },
    sessionController: {
      async create() { sessionCreations++; return { sessionId: `session-${sessionCreations}` }; },
      async rename(r) { return { title: r.title, seq: 1 }; },
      async prompt() { return { accepted: true }; },
      async cancel() { return { accepted: true }; },
      follow(_r, signal) {
        return (async function* () {
          yield { type: 'snapshot', records: [] };
          await Promise.race([turnGate, new Promise((res) => signal.addEventListener('abort', res, { once: true }))]);
          yield { type: 'event', event: { seq: 1, type: 'turn/start', data: {} } };
          yield { type: 'event', event: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first run' }] } } } };
          yield { type: 'event', event: { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } } };
        })();
      },
    },
    permissionPresets: { set() {} },
    agents: { get: () => ({ session: {} }) },
  };

  const jobId = '1111222233334444';
  const spec = validateDispatch(cfg, {
    project: 'sonori',
    text: '[Project: sonori] test idempotent retry',
    source: 'yobiru',
    job_id: jobId,
  });

  const job1 = startJob(store, spec, {}, svc);
  assert.equal(job1.id, jobId);
  assert.equal(store.running.size, 1);

  // Retry with the same job_id while job1 is still running (even with maxConcurrent: 1)
  const job2 = startJob(store, spec, {}, svc);
  assert.equal(job2.id, jobId);
  assert.equal(store.running.size, 1);
  assert.equal(sessionCreations, 0); // async sessionController.create hasn't resolved yet, and job2 didn't start a second runner

  releaseTurn();
  for (let i = 0; i < 100 && store.get(jobId)?.state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(store.get(jobId)?.state, 'completed');

  // Retry again after completion: returns persisted completed job without starting a new session
  const job3 = startJob(store, spec, {}, svc);
  assert.equal(job3.id, jobId);
  assert.equal(job3.state, 'completed');
  assert.equal(job3.result, 'first run');
  assert.equal(sessionCreations, 1);
});

test('cross-process report.lock prevents concurrent duplicate reports and releases lock on failure for retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgd-lock-'));
  const store = new JobMapStore(dir);
  const jobId = '2222333344445555';
  const entry = store.bind({
    jobId,
    yobiruId: jobId,
    callbackPeer: GROK_PEER,
    reportViaYobiru: true,
    source: 'yobiru',
    direction: 'inbound',
  });
  const lockFile = path.join(dir, `${jobId}.report.lock`);

  // Simulate another process (e.g., Stop hook) holding <job>.report.lock while reported is still false
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999 }), { flag: 'wx', mode: 0o600 });
  let callsWhileLocked = 0;
  const blockedRes = await reportJobViaYobiru({
    mapStore: store,
    entry,
    outcome: { state: 'completed', result: 'should not send' },
    execRunner: async () => { callsWhileLocked++; return { code: 0, stdout: '', stderr: '' }; },
    logger: {},
  });
  assert.equal(blockedRes.ok, true);
  assert.equal(blockedRes.skipped, 'already-reported');
  assert.equal(callsWhileLocked, 0);

  // Remove external lock and verify a failed send releases the lock so a subsequent retry succeeds
  fs.unlinkSync(lockFile);
  let attempts = 0;
  const failRes = await reportJobViaYobiru({
    mapStore: store,
    entry,
    outcome: { state: 'completed', result: 'retry me' },
    execRunner: async () => { attempts++; return { code: 1, stdout: '', stderr: 'transient error' }; },
    logger: {},
  });
  assert.equal(failRes.ok, false);
  assert.equal(attempts, 2); // request respond failed + send callback failed
  assert.equal(fs.existsSync(lockFile), false); // lock released on failure

  let retryCalls = 0;
  const okRes = await reportJobViaYobiru({
    mapStore: store,
    entry,
    outcome: { state: 'completed', result: 'retry succeeded' },
    execRunner: async () => { retryCalls++; return { code: 0, stdout: 'ok', stderr: '' }; },
    logger: {},
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.method, 'request-respond');
  assert.equal(retryCalls, 2); // request respond + ack
  assert.equal(fs.existsSync(lockFile), true);
  assert.equal(store.getByJob(jobId).reported, true);
});

test('only Grok sources report/fallback to grokbotPeer; zcode/dsh/local tasks never report to Grok', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgd-src-'));
  const store = new JobMapStore(dir);
  const calls = [];
  const execRunner = async (bin, args) => {
    calls.push([bin, ...args]);
    return { code: 0, stdout: 'ok', stderr: '' };
  };

  // 1. zcode source with reportViaYobiru:true but no callbackPeer/yobiruId -> must NOT fallback to grokbotPeer
  const zcodeNoPeer = store.bind({
    jobId: '3333444455556666',
    source: 'zcode',
    reportViaYobiru: true,
    direction: 'inbound',
  });
  const rZcodeNoPeer = await reportJobViaYobiru({
    mapStore: store,
    entry: zcodeNoPeer,
    outcome: { state: 'completed', result: 'local only' },
    execRunner,
    logger: {},
  });
  assert.equal(rZcodeNoPeer.ok, false);
  assert.equal(calls.length, 0);
  assert.equal(Boolean(store.getByJob('3333444455556666').reported), false);

  // 2. dsh / local (extracted) source -> must NOT report to grokbotPeer even if reportViaYobiru or grok callbackPeer is set
  for (const [id, src, peer] of [
    ['4444555566667777', 'dsh', GROK_PEER],
    ['5555666677778888', 'extracted', undefined],
    ['6666777788889999', 'local', GROK_PEER],
  ]) {
    const entry = store.bind({
      jobId: id,
      source: src,
      callbackPeer: peer,
      reportViaYobiru: true,
      direction: 'inbound',
    });
    const r = await reportJobViaYobiru({
      mapStore: store,
      entry,
      outcome: { state: 'completed', result: 'do not send to grok' },
      execRunner,
      logger: {},
    });
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  }

  // 3. zcode source with explicit callbackPeer pointing to zcode -> reports to zcodePeer
  const zcodeWithPeer = store.bind({
    jobId: '777788889999aaaa',
    source: 'zcode',
    callbackPeer: ZCODE_PEER,
    reportViaYobiru: true,
    direction: 'inbound',
  });
  const rZcodePeer = await reportJobViaYobiru({
    mapStore: store,
    entry: zcodeWithPeer,
    outcome: { state: 'completed', result: 'for zcode' },
    execRunner,
    logger: {},
  });
  assert.equal(rZcodePeer.ok, true);
  assert.equal(rZcodePeer.method, 'send-callback');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(ZCODE_PEER));

  // 4. grok-bot source with reportViaYobiru:true and no callbackPeer -> falls back to grokbotPeer
  const grokEntry = store.bind({
    jobId: '88889999aaaabbbb',
    source: 'grok-bot',
    reportViaYobiru: true,
    direction: 'inbound',
  });
  const rGrok = await reportJobViaYobiru({
    mapStore: store,
    entry: grokEntry,
    outcome: { state: 'completed', result: 'for grok' },
    execRunner,
    logger: {},
  });
  assert.equal(rGrok.ok, true);
  assert.equal(rGrok.method, 'send-callback');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes(GROK_PEER));
});

test('POST /v1/outbound rejects missing or invalid target with HTTP 400 without dispatching', async () => {
  const { DEFAULTS } = await import('../plugin/core.js');
  const { createServer } = await import('../plugin/index.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dgd-out-proj-'));
  fs.mkdirSync(path.join(root, 'sonori'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgd-out-state-'));
  const keyFile = path.join(stateDir, 'key');
  const key = 'k'.repeat(64);
  fs.writeFileSync(keyFile, key, { mode: 0o600 });

  let dispatched = 0;
  const cfg = {
    ...DEFAULTS,
    host: '127.0.0.1',
    allowedIps: ['127.0.0.1'],
    projectsRoot: root,
    stateDir,
    keyFile,
    execRunner: async () => {
      dispatched++;
      return { code: 0, stdout: JSON.stringify({ id: '9999000011112222' }), stderr: '' };
    },
  };

  const { server } = createServer(cfg, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    for (const badBody of [
      { project: 'sonori', task: 'missing target' },
      { target: 'z-code', project: 'sonori', task: 'misspelled target' },
      { target: '', project: 'sonori', task: 'empty target' },
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/outbound`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(badBody),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /target must be one of grok-bot, zcode/);
    }
    assert.equal(dispatched, 0);

    const okRes = await fetch(`http://127.0.0.1:${port}/v1/outbound`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ target: 'zcode', project: 'sonori', task: 'valid target' }),
    });
    assert.equal(okRes.status, 202);
    assert.equal(dispatched, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});





test('yobiru-sourced job whose request respond fails never falls back to grokbotPeer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgd-yob-'));
  const store = new JobMapStore(dir);
  const calls = [];
  const execRunner = async (bin, args) => { calls.push(args); return { code: 1, stdout: '', stderr: 'respond failed' }; };
  const entry = store.bind({ jobId: '7777888899990000', source: 'yobiru', reportViaYobiru: true, direction: 'inbound' });
  const r = await reportJobViaYobiru({ mapStore: store, entry, outcome: { state: 'completed', result: 'x' }, execRunner, logger: {} });
  assert.equal(r.ok, false);
  assert.ok(calls.every((a) => !a.includes('send')), 'no callback send to Grok');
  assert.ok(calls.some((a) => a.includes('respond')));
});

test('an abandoned report.lock older than the stale window is taken over and the job reports once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgd-stale-'));
  const store = new JobMapStore(dir);
  const entry = store.bind({ jobId: '8888999900001111', source: 'grok-bot', reportViaYobiru: true, direction: 'inbound' });
  const lock = path.join(dir, '8888999900001111.report.lock');
  fs.writeFileSync(lock, '{}');
  const calls = [];
  const execRunner = async (bin, args) => { calls.push(args); return { code: 0, stdout: 'ok', stderr: '' }; };
  const fresh = await reportJobViaYobiru({ mapStore: store, entry, outcome: { state: 'completed' }, execRunner, logger: {} });
  assert.equal(fresh.skipped, 'already-reported');
  assert.equal(calls.length, 0);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  const r = await reportJobViaYobiru({ mapStore: store, entry, outcome: { state: 'completed' }, execRunner, logger: {} });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'send-callback');
  assert.equal(calls.filter((a) => a.includes('send')).length, 1);
});
