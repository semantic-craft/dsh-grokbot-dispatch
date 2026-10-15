// transport.js: direct HTTP (default) send / respond / status, and the startup compat check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-transport-'));
const CONFIG = path.join(dir, 'config.json');
const KEY = path.join(dir, 'peer.key');
fs.writeFileSync(KEY, 'k'.repeat(64), { mode: 0o600 });
process.env.DSH_DISPATCH_CONFIG = CONFIG;
process.env.DSH_DISPATCH_DISCOVERY = '0';
for (const k of ['DISPATCH_TRANSPORT', 'DISPATCH_HOST', 'DISPATCH_ALLOWED_IPS']) delete process.env[k];
const writeCfg = (c) => fs.writeFileSync(CONFIG, JSON.stringify(c));

const T = await import('../plugin/transport.js');
const { checkCompat, validateDispatch, HttpError } = await import('../plugin/core.js');

function peerServer() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      res.writeHead(req.method === 'POST' && req.url === '/v1/jobs' ? 202 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url.startsWith('/v1/jobs/') ? { id: req.url.slice(9), state: 'completed', result: 'done' } : { id: seen.at(-1).body?.job_id ?? 'x', ok: true }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('transport defaults to direct; "yobiru" is opt-in; anything else is rejected', () => {
  writeCfg({});
  assert.equal(T.transportName(), 'direct');
  writeCfg({ transport: 'yobiru' });
  assert.equal(T.transportName(), 'yobiru');
  writeCfg({ transport: 'carrier-pigeon' });
  assert.throws(() => T.transportName(), /direct" or "yobiru/);
});

test('direct send/status/respond use peers {url,keyFile} with Bearer auth', async () => {
  const p = await peerServer();
  writeCfg({ peers: { zcode: { url: `${p.url}/`, keyFile: KEY } } });
  assert.deepEqual(T.knownTargets(), ['zcode']);
  const s = await T.send('zcode', { project: 'demo', text: '[Project: demo] hi', timeoutSeconds: '60', jobId: 'aaaaaaaaaaaaaaaa', selfName: 'dsh' });
  assert.equal(s.code, 0); assert.equal(s.id, 'aaaaaaaaaaaaaaaa');
  assert.deepEqual(p.seen[0], { method: 'POST', url: '/v1/jobs', auth: `Bearer ${'k'.repeat(64)}`,
    body: { project: 'demo', text: '[Project: demo] hi', timeout_seconds: 60, source: 'dsh', job_id: 'aaaaaaaaaaaaaaaa', callback_peer: 'dsh' } });
  assert.equal((await T.status('zcode', 'aaaaaaaaaaaaaaaa')).result, 'done');
  const payload = JSON.stringify({ job_id: 'bbbbbbbbbbbbbbbb', state: 'completed', result: 'r' });
  const viaPeer = await T.respond({ jobId: 'bbbbbbbbbbbbbbbb', callbackPeer: 'zcode' }, payload, 'completed');
  assert.equal(viaPeer.method, 'http-callback');
  assert.equal(p.seen.at(-1).url, '/v1/callbacks');
  const viaUrl = await T.respond({ jobId: 'bbbbbbbbbbbbbbbb', callbackUrl: `${p.url}/hook/x` }, payload, 'completed');
  assert.equal(viaUrl.method, 'http-callback');
  assert.equal(p.seen.at(-1).url, '/hook/x');
  // callback_url outside configured peers is never contacted
  const n = p.seen.length;
  const evil = await T.respond({ jobId: 'bbbbbbbbbbbbbbbb', callbackUrl: 'http://192.0.2.99/steal' }, payload, 'completed');
  assert.equal(evil.method, null); assert.equal(p.seen.length, n);
  await assert.rejects(T.send('grok-bot', { project: 'demo', text: 'x' }), /not configured/);
  p.srv.close();
});

test('validateDispatch refuses a callback_url that is not a configured peer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-')); fs.mkdirSync(path.join(root, 'demo'));
  writeCfg({ peers: { zcode: { url: 'http://192.0.2.7:7791', keyFile: KEY } } });
  const cfg = { projectsRoot: root, maxTextChars: 1000, defaultTimeoutSeconds: 60, maxTimeoutSeconds: 100, permissionMode: 'read-only' };
  const body = { project: 'demo', text: '[Project: demo] x' };
  assert.equal(validateDispatch(cfg, { ...body, callback_url: 'http://192.0.2.7:7791/v1/callbacks' }).callbackUrl, 'http://192.0.2.7:7791/v1/callbacks');
  assert.throws(() => validateDispatch(cfg, { ...body, callback_url: 'http://evil.example/x' }), HttpError);
});

test('denyProjects / projectsRoot are configurable, defaults unchanged', async () => {
  const C = await import('../plugin/config.js');
  writeCfg({});
  assert.ok(C.denyProjectsRe().test('Finance')); assert.equal(C.projectsRoot({}), path.join(os.homedir(), 'Projects'));
  writeCfg({ denyProjects: '^secret', projectsRoot: '~/work' });
  assert.ok(!C.denyProjectsRe().test('Finance')); assert.ok(C.denyProjectsRe().test('Secret-x'));
  assert.equal(C.projectsRoot({}), path.join(os.homedir(), 'work'));
});

test('checkCompat names every missing prerequisite instead of failing silently', () => {
  writeCfg({ transport: 'yobiru', yobiru: { script: '/nonexistent/tailmsg.py', python: '/nonexistent/python3' } });
  const bad = checkCompat({ keyFile: path.join(dir, 'nokey'), host: null, allowedIps: [], dsh: null, runner: 'headless', projectsRoot: '/nonexistent' },
    { which: () => null, checkTransport: T.checkTransport });
  assert.equal(bad.ok, false); assert.equal(bad.transport, 'yobiru');
  for (const re of [/^key: missing/, /^host:/, /^allowedIps:/, /^dsh:/, /^projectsRoot:/, /tailmsg script not found/, /python/]) assert.ok(bad.errors.some((e) => re.test(e)), String(re));
  const loose = path.join(dir, 'loose.key'); fs.writeFileSync(loose, 'x'.repeat(64), { mode: 0o644 }); fs.chmodSync(loose, 0o644);
  writeCfg({ peers: { zcode: { url: 'http://192.0.2.7:7791', keyFile: KEY } } });
  const r = checkCompat({ keyFile: loose, host: '127.0.0.1', allowedIps: ['127.0.0.1'], dsh: '/bin/true', projectsRoot: dir }, { checkTransport: T.checkTransport });
  assert.deepEqual(r.errors, [`key: key file ${loose} must be chmod 600`]);
  const good = checkCompat({ keyFile: KEY, host: '127.0.0.1', allowedIps: ['127.0.0.1'], dsh: '/bin/true', projectsRoot: dir }, { checkTransport: T.checkTransport });
  assert.equal(good.ok, true, JSON.stringify(good)); assert.equal(good.transport, 'direct');
});

test('child processes inherit PATH (no hard-coded PATH) unless yobiru.path pins one', async () => {
  writeCfg({});
  const r = await T.defaultExecRunner('/bin/sh', ['-c', 'printf %s "$PATH"']);
  assert.equal(r.stdout, process.env.PATH);
  writeCfg({ yobiru: { path: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' } });
  assert.equal((await T.defaultExecRunner('/bin/sh', ['-c', 'printf %s "$PATH"'])).stdout, '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
});
