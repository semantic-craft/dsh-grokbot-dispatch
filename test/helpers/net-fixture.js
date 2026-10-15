// Test-only network config: a temp config.json with RFC 2606/5737 placeholder peers/IPs,
// discovery disabled, so tests never read the real ~/.config or call tailscale.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GROK_PEER = 'grok-box.example.test/grok';
export const ZCODE_PEER = 'dsh-host.example.test/zcode';
export const BOX_IP = '192.0.2.10';
export const HOST_IP = '192.0.2.20';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dispatch-cfg-'));
export const CONFIG_PATH = path.join(dir, 'config.json');
// transport "yobiru": the v0.2 suites below pin the exact tailmsg argv (regression proof for existing Yobiru deployments).
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ transport: 'yobiru', yobiru: { python: '/usr/bin/python3' }, host: HOST_IP, grokbotPeer: GROK_PEER, zcodePeer: ZCODE_PEER, allowedIps: [BOX_IP] }));
process.env.DSH_DISPATCH_CONFIG = CONFIG_PATH;
process.env.DSH_DISPATCH_DISCOVERY = '0';
for (const k of ['DISPATCH_HOST', 'DISPATCH_PORT', 'DISPATCH_ALLOWED_IPS', 'GROKBOT_PEER', 'ZCODE_PEER', 'DISPATCH_TRANSPORT', 'TAILMSG_PYTHON', 'TAILMSG_SCRIPT', 'TAILMSG_HOME']) delete process.env[k];
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
