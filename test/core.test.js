import { BOX_IP, GROK_PEER, ZCODE_PEER } from './helpers/net-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, JobStore, checkAuth, foldSessionEvent, parseEvents, pickRunner, sessionTitle, startJob, validateDispatch } from '../plugin/core.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gbd-'));
fs.mkdirSync(path.join(root, 'sonori'));
fs.mkdirSync(path.join(root, 'Finance'));
const cfg = { ...DEFAULTS, projectsRoot: root };

test('requires matching [Project: name] tag', () => {
  assert.throws(() => validateDispatch(cfg, { project: 'sonori', text: 'hi' }), /must start with/);
  assert.throws(() => validateDispatch(cfg, { project: 'sonori', text: '[Project: other] hi' }), /must start with/);
  const ok = validateDispatch(cfg, { project: 'sonori', text: '[Project: sonori] hi' });
  assert.equal(ok.mode, 'danger-full-access');
});
test('rejects traversal, missing and Finance projects', () => {
  assert.throws(() => validateDispatch(cfg, { project: '../x', text: '[Project: ../x] hi' }), /plain folder/);
  assert.throws(() => validateDispatch(cfg, { project: 'nope', text: '[Project: nope] hi' }), /no such project/);
  assert.throws(() => validateDispatch(cfg, { project: 'Finance', text: '[Project: Finance] hi' }), /not allowed/);
});
test('bearer auth is exact', () => {
  const key = Buffer.from('a'.repeat(64));
  assert.equal(checkAuth('Bearer ' + 'a'.repeat(64), key), true);
  assert.equal(checkAuth('Bearer ' + 'a'.repeat(63), key), false);
  assert.equal(checkAuth(undefined, key), false);
});
test('parses dsh --json events', () => {
  const ev = parseEvents('{"type":"session","sessionId":"s1"}\n{"type":"tool_call","tool":"read"}\n{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n{"type":"final","text":"done"}');
  assert.deepEqual(ev, { sessionId: 's1', final: 'done', turnEnd: 'completed', tools: ['read'] });
});

test('allowlist default comes from local config (only the box IP)', () => {
  assert.deepEqual(DEFAULTS.allowedIps, [BOX_IP]);
});
test('source + title', () => {
  const spec = validateDispatch(cfg, { project: 'sonori', text: '[Project: sonori]  fix   the build please' });
  assert.equal(spec.source, 'grok-bot');
  assert.equal(sessionTitle(spec), '[Grok Bot] fix the build please');
  assert.equal(sessionTitle({ ...spec, source: 'yobiru', text: '[Project: sonori] ' + 'x'.repeat(80) }), '[Yobiru] ' + 'x'.repeat(60) + '…');
  assert.throws(() => validateDispatch(cfg, { project: 'sonori', text: '[Project: sonori] hi', source: 'evil' }), /source must be/);
});
test('runner selection keeps headless fallback', () => {
  const svc = { sessionController: {}, workspaceController: {} };
  assert.equal(pickRunner({ runner: 'auto' }, svc), 'app');
  assert.equal(pickRunner({ runner: 'auto' }, undefined), 'headless');
  assert.equal(pickRunner({ runner: 'headless' }, svc), 'headless');
  assert.throws(() => pickRunner({ runner: 'app' }, undefined), /unavailable/);
});
test('folds host session events', () => {
  const acc = { started: false, tools: [], final: null, turnEnd: null };
  for (const e of [
    { type: 'turn/start', data: {} }, { type: 'tool/call', data: { name: 'bash' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 'done' }] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } }]) foldSessionEvent(acc, e);
  assert.deepEqual(acc, { started: true, tools: ['bash'], final: 'done', turnEnd: 'completed' });
});

function fakeHost({ hang = false } = {}) {
  const calls = [];
  let push; const queue = [];
  const sessionController = {
    async create(r) { calls.push(['session.create', r]); return { sessionId: 'session-1' }; },
    async rename(r) { calls.push(['rename', r]); return { title: r.title, seq: 1 }; },
    async prompt(r, signal) {
      calls.push(['prompt', r]);
      if (!hang) for (const e of [{ seq: 2, type: 'turn/start', data: {} }, { seq: 3, type: 'tool/call', data: { name: 'read' } },
        { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'all good' }] } } },
        { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } }]) { queue.push(e); push?.(); }
      return { accepted: true };
    },
    async cancel(r) { calls.push(['cancel', r]); queue.push({ seq: 9, type: 'turn/end', data: { reason: { kind: 'cancelled' } } }); queue.unshift({ seq: 8, type: 'turn/start', data: {} }); push?.(); return { accepted: true }; },
    follow(r, signal) {
      calls.push(['follow', r]);
      return (async function* () {
        yield { type: 'snapshot', records: [] };
        while (!signal.aborted) {
          if (!queue.length) { await new Promise((res) => { push = res; signal.addEventListener('abort', res, { once: true }); }); continue; }
          yield { type: 'event', event: queue.shift() };
        }
      })();
    },
  };
  const workspaceController = { async create(r) { calls.push(['workspace.create', r]); return { workspace: { workspaceId: 'ws-1', path: r.path }, created: true }; } };
  const session = {};
  const permissionPresets = { set(s, name) { calls.push(['permission', s === session, name]); } };
  const agents = { get: (id) => (id === 'session-1' ? { session } : undefined) };
  return { calls, svc: { sessionController, workspaceController, permissionPresets, agents } };
}
const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

test('app runner creates a visible, titled, full-access session and records the result', async () => {
  const store = new JobStore({ ...cfg, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gbd-st-')) });
  const { calls, svc } = fakeHost();
  const spec = validateDispatch(cfg, { project: 'sonori', text: '[Project: sonori] check the build' });
  const job = startJob(store, spec, { info() {}, warn() {} }, svc);
  assert.equal(job.runner, 'app');
  await until(() => store.get(job.id)?.state === 'completed');
  const done = store.get(job.id);
  assert.equal(done.state, 'completed'); assert.equal(done.result, 'all good'); assert.deepEqual(done.tools, ['read']);
  assert.equal(done.session_id, 'session-1'); assert.equal(done.title, `[Grok Bot] [Job: ${done.id}] check the build`);
  assert.equal(store.mapStore.getBySession('session-1')?.jobId, done.id);
  assert.deepEqual(calls.map((c) => c[0]), ['workspace.create', 'session.create', 'permission', 'rename', 'follow', 'prompt']);
  assert.deepEqual(calls[1][1], { workspaceId: 'ws-1' });
  assert.deepEqual(calls[2], ['permission', true, 'danger-full-access']);
  assert.deepEqual(calls[5][1], { requestId: job.id, sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: spec.text }] });
  assert.equal(store.running.size, 0);
});
test('app runner cancels the session on timeout', async () => {
  const store = new JobStore({ ...cfg, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gbd-st-')) });
  const { calls, svc } = fakeHost({ hang: true });
  const spec = { ...validateDispatch(cfg, { project: 'sonori', text: '[Project: sonori] slow' }), timeoutSeconds: 0.05 };
  const job = startJob(store, spec, { info() {}, warn() {} }, svc);
  await until(() => store.get(job.id)?.state === 'failed');
  assert.equal(store.get(job.id).error, 'timeout');
  assert.ok(calls.some((c) => c[0] === 'cancel'));
});
