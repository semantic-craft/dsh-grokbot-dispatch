import { BOX_IP } from './helpers/net-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peerIPs, readConfigFile, resolveNetConfig, selfDNSName, selfIPv4 } from '../plugin/config.js';

// Fake `tailscale status --json` built from placeholder names/IPs (RFC 2606 / 5737).
const STATUS = {
  Self: { DNSName: 'dsh-host.tailnet.example.test.', TailscaleIPs: ['192.0.2.20', 'fd7a::20'] },
  Peer: {
    a: { DNSName: 'grok-box.tailnet.example.test.', HostName: 'grok-box', TailscaleIPs: ['192.0.2.10', 'fd7a::10'] },
    b: { DNSName: 'other.tailnet.example.test.', HostName: 'other', TailscaleIPs: ['192.0.2.30'] },
  },
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cfg-test-'));

test('discovery: host = self tailnet IPv4, zcodePeer = self MagicDNS, allowedIps = grokbotPeer node IPs', () => {
  const r = resolveNetConfig({ env: {}, file: { grokbotPeer: 'grok-box.tailnet.example.test/grok' }, status: () => STATUS });
  assert.equal(r.host, '192.0.2.20');
  assert.equal(r.port, 7790);
  assert.equal(r.zcodePeer, 'dsh-host.tailnet.example.test/zcode');
  assert.deepEqual(r.allowedIps, ['192.0.2.10']);
  assert.equal(r.grokbotPeer, 'grok-box.tailnet.example.test/grok');
});

test('env beats config file beats discovery', () => {
  const file = { host: '198.51.100.1', port: 7000, grokbotPeer: 'f.example.test/grok', allowedIps: ['198.51.100.9'] };
  const fromFile = resolveNetConfig({ env: {}, file, status: () => STATUS });
  assert.deepEqual([fromFile.host, fromFile.port, fromFile.allowedIps], ['198.51.100.1', 7000, ['198.51.100.9']]);
  const env = { DISPATCH_HOST: '203.0.113.1', DISPATCH_PORT: '7999', DISPATCH_ALLOWED_IPS: '203.0.113.5, 203.0.113.6', GROKBOT_PEER: 'e.example.test/grok', ZCODE_PEER: 'z.example.test/zcode' };
  const fromEnv = resolveNetConfig({ env, file, status: () => STATUS });
  assert.deepEqual(fromEnv, { host: '203.0.113.1', port: 7999, allowedIps: ['203.0.113.5', '203.0.113.6'], grokbotPeer: 'e.example.test/grok', zcodePeer: 'z.example.test/zcode' });
});

test('nothing configured and no tailscale: host null (never 0.0.0.0), allowlist empty, grok peer unset', () => {
  const r = resolveNetConfig({ env: {}, file: {}, status: () => null });
  assert.deepEqual(r, { host: null, port: 7790, allowedIps: [], grokbotPeer: null, zcodePeer: null });
});

test('discovery is not consulted when env/config supply everything', () => {
  let calls = 0;
  resolveNetConfig({ env: { DISPATCH_HOST: '203.0.113.1', ZCODE_PEER: 'z/zcode', DISPATCH_ALLOWED_IPS: '203.0.113.5' }, file: {}, status: () => { calls++; return STATUS; } });
  assert.equal(calls, 0);
});

test('readConfigFile: missing or malformed file -> {} ; valid file parsed (temp dir)', () => {
  const d = tmp();
  try {
    assert.deepEqual(readConfigFile(path.join(d, 'nope.json')), {});
    fs.writeFileSync(path.join(d, 'bad.json'), '{not json');
    assert.deepEqual(readConfigFile(path.join(d, 'bad.json')), {});
    fs.writeFileSync(path.join(d, 'ok.json'), JSON.stringify({ allowedIps: [BOX_IP] }));
    assert.deepEqual(readConfigFile(path.join(d, 'ok.json')), { allowedIps: [BOX_IP] });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('peer lookup by MagicDNS name or short host name; helpers tolerate missing status', () => {
  assert.deepEqual(peerIPs(STATUS, 'grok-box'), ['192.0.2.10']);
  assert.deepEqual(peerIPs(STATUS, 'grok-box.tailnet.example.test.'), ['192.0.2.10']);
  assert.deepEqual(peerIPs(STATUS, 'missing'), []);
  assert.deepEqual(peerIPs(null, 'grok-box'), []);
  assert.equal(selfIPv4(STATUS), '192.0.2.20');
  assert.equal(selfDNSName(STATUS), 'dsh-host.tailnet.example.test');
  assert.equal(selfIPv4(null), null);
});

test('plugin defaults read the local config file (fixture in a temp dir)', async () => {
  const { DEFAULTS } = await import('../plugin/core.js');
  const { YOBIRU_DEFAULTS } = await import('../plugin/job-map.js');
  assert.equal(DEFAULTS.host, '192.0.2.20');
  assert.deepEqual(DEFAULTS.allowedIps, [BOX_IP]);
  assert.equal(YOBIRU_DEFAULTS.grokbotPeer, 'grok-box.example.test/grok');
});
