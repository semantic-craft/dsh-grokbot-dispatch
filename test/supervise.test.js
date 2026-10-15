import { BOX_IP, GROK_PEER, ZCODE_PEER } from './helpers/net-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { supervise, probe } from '../plugin/index.js';

const quiet = { info() {}, warn() {}, error() {} };
test('retries bind until address is free, then serves', async () => {
  const blocker = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const port = blocker.address().port;
  const server = http.createServer((q, s) => s.end('ok'));
  const sup = supervise(server, { host: '127.0.0.1', port, watchdogSeconds: 0.2, exitAfterFailedSeconds: 60 }, quiet);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sup.isListening(), false);
  await new Promise((r) => blocker.close(r));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sup.isListening(), true);
  assert.equal(await probe('127.0.0.1', port), true);
  sup.stop(); await new Promise((r) => server.close(r));
});
test('exits when unbound too long', async () => {
  let code = null;
  const sup = supervise(http.createServer(), { host: '192.0.2.1', port: 1, watchdogSeconds: 0.1, exitAfterFailedSeconds: 0.2 }, quiet, (c) => { code = c; });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(code, 1); sup.stop();
});

test('standby host waits quietly on EADDRINUSE and never exits', async () => {
  const blocker = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const port = blocker.address().port;
  let code = null;
  const server = http.createServer((q, s) => s.end('ok'));
  const sup = supervise(server, { host: '127.0.0.1', port, watchdogSeconds: 0.1, exitAfterFailedSeconds: 0.2, standby: true }, quiet, (c) => { code = c; });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(code, null); assert.equal(sup.isStandby(), true);
  await new Promise((r) => blocker.close(r));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sup.isListening(), true);
  sup.stop(); await new Promise((r) => server.close(r));
});
test('standby host yields the port back to the primary when idle', async () => {
  let primaryUp = false;
  const tmp = http.createServer().listen(0, '127.0.0.1'); await new Promise((r) => tmp.once('listening', r));
  const port = tmp.address().port; await new Promise((r) => tmp.close(r));
  const server = http.createServer((q, s) => s.end('ok'));
  const cfg = { host: '127.0.0.1', port, watchdogSeconds: 0.1, exitAfterFailedSeconds: 60, standby: true, shouldYield: () => primaryUp };
  const sup = supervise(server, cfg, quiet);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sup.isListening(), true);
  primaryUp = true;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sup.isListening(), false);
  sup.stop();
});
test('a stalled listen() (no listening/error event) is retried instead of wedging binding', async () => {
  const { EventEmitter } = await import('node:events');
  const fake = new EventEmitter(); let calls = 0;
  fake.listen = () => { calls++; }; fake.close = () => {};
  const sup = supervise(fake, { host: '127.0.0.1', port: 1, watchdogSeconds: 0.1, exitAfterFailedSeconds: 100 }, quiet, () => {});
  await new Promise((r) => setTimeout(r, 450));
  sup.stop();
  assert.ok(calls >= 3, `listen retried ${calls}x`);
});

test('no resolvable host: never binds (no 0.0.0.0 fallback), binds once resolveHost returns an IP', async () => {
  const server = http.createServer((q, s) => s.end('ok'));
  let n = 0; const warns = [];
  const cfg = { host: null, port: 0, watchdogSeconds: 0.1, exitAfterFailedSeconds: 60, resolveHost: () => (++n >= 3 ? '127.0.0.1' : null) };
  const sup = supervise(server, cfg, { info() {}, warn: (m) => warns.push(m) }, () => {});
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(server.listening, false);
  assert.ok(warns.some((m) => /no tailnet bind host/.test(m)));
  for (let i = 0; i < 30 && !server.listening; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.listening, true);
  assert.equal(server.address().address, '127.0.0.1');
  sup.stop(); server.close();
});
