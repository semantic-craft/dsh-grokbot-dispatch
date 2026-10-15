/**
 * Local configuration + tailnet discovery (no hostnames, IPs or user paths in code).
 *
 * Resolution order for every setting: environment variable > config file > discovery.
 *   config file: $DSH_DISPATCH_CONFIG or ~/.config/dsh-grokbot-dispatch/config.json
 *     { "host": "<bind IP>", "port": 7790, "allowedIps": ["<box IP>"],
 *       "grokbotPeer": "<box MagicDNS name>/grok", "zcodePeer": "<host>/zcode" }
 *   discovery (`tailscale status --json`, disabled with DSH_DISPATCH_DISCOVERY=0):
 *     host        -> this node's tailnet IPv4 (never 0.0.0.0)
 *     zcodePeer   -> this node's MagicDNS name + "/zcode" (ZCode runs on the same machine as DSH)
 *     allowedIps  -> tailnet IPs of the grokbotPeer node, so a box re-login that changes its IP needs no edit
 * Anything unresolved stays null/empty: the listener refuses to bind and the allowlist denies everyone.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_FILE = () => process.env.DSH_DISPATCH_CONFIG
  || path.join(os.homedir(), '.config', 'dsh-grokbot-dispatch', 'config.json');

export function readConfigFile(file = CONFIG_FILE()) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
}

const TAILSCALE_CANDIDATES = ['tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

let cachedStatus;
/** Parsed `tailscale status --json`, or null. Cached per process; override with statusProvider in tests. */
export function tailscaleStatus({ refresh = false } = {}) {
  if (process.env.DSH_DISPATCH_DISCOVERY === '0') return null;
  if (cachedStatus !== undefined && !refresh) return cachedStatus;
  cachedStatus = null;
  const bins = process.env.TAILSCALE_BIN ? [process.env.TAILSCALE_BIN] : TAILSCALE_CANDIDATES;
  for (const bin of bins) {
    try {
      const out = execFileSync(bin, ['status', '--json'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      cachedStatus = JSON.parse(out.toString('utf8')); break;
    } catch { /* try next */ }
  }
  return cachedStatus;
}

const stripDot = s => String(s || '').replace(/\.$/, '');
const ipv4 = ips => (ips || []).find(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || null;

export function selfIPv4(status) { return ipv4(status?.Self?.TailscaleIPs) || ipv4(status?.TailscaleIPs); }
export function selfDNSName(status) { return stripDot(status?.Self?.DNSName) || null; }

/** Tailnet IPv4s of the peer whose MagicDNS name (or short host name) matches `name`. */
export function peerIPs(status, name) {
  if (!status || !name) return [];
  const want = stripDot(name).toLowerCase();
  const short = want.split('.')[0];
  for (const p of Object.values(status.Peer || {})) {
    const dns = stripDot(p.DNSName).toLowerCase();
    if (dns === want || (want === short && (dns.split('.')[0] === short || String(p.HostName).toLowerCase() === short))) {
      return (p.TailscaleIPs || []).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    }
  }
  return [];
}

const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean);
const peerHost = peer => (peer ? String(peer).split('/')[0] : null);

/**
 * Resolve host/port/allowedIps/grokbotPeer/zcodePeer.
 * @param {{env?:object, file?:object, status?:() => object|null}} [src] injectable sources (tests)
 */
export function resolveNetConfig({ env = process.env, file = readConfigFile(), status = tailscaleStatus } = {}) {
  let st; const ts = () => (st === undefined ? (st = status() || null) : st);
  const grokbotPeer = env.GROKBOT_PEER || file.grokbotPeer || null;
  const host = env.DISPATCH_HOST || file.host || selfIPv4(ts()) || null;
  const port = Number(env.DISPATCH_PORT || file.port || 7790);
  let zcodePeer = env.ZCODE_PEER || file.zcodePeer || null;
  if (!zcodePeer) { const self = selfDNSName(ts()); zcodePeer = self ? `${self}/zcode` : null; }
  let allowedIps = list(env.DISPATCH_ALLOWED_IPS || file.allowedIps);
  if (!allowedIps.length) allowedIps = peerIPs(ts(), peerHost(grokbotPeer));
  return { host, port, allowedIps, grokbotPeer, zcodePeer };
}

/** Find an executable by name on PATH (or the given PATH string); absolute paths are checked directly. */
export function which(name, pathStr = process.env.PATH) {
  if (!name) return null;
  const ok = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
  if (name.includes('/')) return ok(name) ? name : null;
  for (const dir of String(pathStr || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, name);
    if (ok(f)) return f;
  }
  return null;
}

const expand = (p) => (typeof p === 'string' && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

/** Projects root: env DISPATCH_PROJECTS_ROOT > config "projectsRoot" > ~/Projects. */
export function projectsRoot(env = process.env, file = readConfigFile()) {
  return expand(env.DISPATCH_PROJECTS_ROOT || file.projectsRoot) || path.join(os.homedir(), 'Projects');
}

/** Refused project names: config "denyProjects" (regex source, case-insensitive) > /finance/i. */
export function denyProjectsRe(file = readConfigFile()) {
  return new RegExp(typeof file.denyProjects === 'string' && file.denyProjects ? file.denyProjects : 'finance', 'i');
}

/** dsh binary: env DSH_BIN > config "dshBin" > `dsh` on PATH (null if not found). */
export function dshBin(env = process.env, file = readConfigFile()) {
  return which(expand(env.DSH_BIN || file.dshBin || 'dsh'));
}
