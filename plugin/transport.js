/**
 * The only place this plugin talks to other agents. Three operations:
 *   send(target, {project, text, timeoutSeconds, jobId})  -> {ok, id, peer, raw}
 *   respond(entry, payload, state)                        -> {method, res}  (push a finished job's result)
 *   status(target, id)                                    -> remote job / request status
 *
 * Two implementations, picked by config `transport` (env DISPATCH_TRANSPORT > config.json > "direct"):
 *   direct (default): plain HTTP + shared Bearer key. `peers` in config.json:
 *       { "peers": { "zcode": { "url": "http://host:7791", "keyFile": "~/.config/.../zcode.key" } } }
 *     send   -> POST <peer.url>/v1/jobs           (Bearer = that peer's key)
 *     status -> GET  <peer.url>/v1/jobs/<id>
 *     respond-> POST JSON to the job's callback_url / <peers[callback_peer].url>/v1/callbacks
 *   yobiru (opt-in, `"transport": "yobiru"`): the Yobiru / tailmsg CLI, argv identical to v0.2.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile, resolveNetConfig } from './config.js';

const HOME = os.homedir();
const JOB_ID_RE = /^[0-9a-f]{16}$/;
const REQ_ID_RE = /\b([0-9a-f]{16})\b/i;
export const expandHome = (p) => (typeof p === 'string' && p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);

export function transportName(cfg = {}, file = readConfigFile(), env = process.env) {
  const t = cfg.transport || env.DISPATCH_TRANSPORT || file.transport || 'direct';
  if (t !== 'direct' && t !== 'yobiru') throw new Error(`transport must be "direct" or "yobiru" (got ${JSON.stringify(t)})`);
  return t;
}

/** Yobiru settings: env > config.json "yobiru" {python, script, home, path} > defaults (python3 from PATH). */
export const YOBIRU_DEFAULTS = {
  get tailmsgHome() { return process.env.TAILMSG_HOME || expandHome(readConfigFile().yobiru?.home) || path.join(HOME, '.tailmsg'); },
  get tailmsgScript() { return process.env.TAILMSG_SCRIPT || expandHome(readConfigFile().yobiru?.script) || path.join(HOME, '.tailmsg', 'tailmsg.py'); },
  get pythonBin() { return process.env.TAILMSG_PYTHON || readConfigFile().yobiru?.python || 'python3'; },
  get childPath() { return readConfigFile().yobiru?.path || null; },
  // env GROKBOT_PEER / ZCODE_PEER > config file > discovery (config.js); null = not configured.
  get grokbotPeer() { return resolveNetConfig().grokbotPeer; },
  get zcodePeer() { return resolveNetConfig().zcodePeer; },
  selfAgent: 'dsh',
  reportTimeoutMs: 15000,
};

/** Child processes inherit this process's env (no hard-coded PATH); config yobiru.path may pin one. */
export function defaultExecRunner(file, args, opts = {}) {
  const childPath = opts.path ?? YOBIRU_DEFAULTS.childPath;
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: opts.timeoutMs ?? 15000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, HOME, ...(childPath ? { PATH: childPath } : {}), ...(opts.env || {}) },
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? String(err.message || err) : null,
      });
    });
  });
}

// ---------------------------------------------------------------- direct (HTTP)

/** Configured direct peers: config.json "peers" {name: {url, keyFile}}. */
export function directPeers(file = readConfigFile()) {
  const peers = file.peers && typeof file.peers === 'object' ? file.peers : {};
  return Object.fromEntries(Object.entries(peers).filter(([, p]) => p && typeof p.url === 'string')
    .map(([n, p]) => [n, { url: p.url.replace(/\/+$/, ''), keyFile: expandHome(p.keyFile) }]));
}

function peerKey(peer) {
  if (!peer.keyFile) throw new Error(`peer ${peer.url} has no keyFile`);
  return fs.readFileSync(peer.keyFile, 'utf8').trim();
}

async function httpJson(method, url, key, body, timeoutMs = 15000) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { code: res.ok ? 0 : res.status, status: res.status, json, stdout: text, stderr: res.ok ? '' : text, error: res.ok ? null : `HTTP ${res.status}` };
}

/** A callback_url is accepted only if it points at a configured peer (that peer's key is used). */
export function peerForUrl(url, peers = directPeers()) {
  if (typeof url !== 'string') return null;
  return Object.entries(peers).find(([, p]) => url === p.url || url.startsWith(`${p.url}/`))?.[0] ?? null;
}

const direct = {
  async send(target, { project, text, timeoutSeconds, jobId, selfName, callbackUrl }) {
    const peers = directPeers();
    const peer = peers[target];
    if (!peer) throw new Error(`peer "${target}" is not configured: add peers.${target} {url, keyFile} to config.json`);
    const body = { project, text, timeout_seconds: Number(timeoutSeconds) || 1800, source: 'dsh', ...(jobId ? { job_id: jobId } : {}),
      ...(callbackUrl ? { callback_url: callbackUrl } : selfName ? { callback_peer: selfName } : {}) };
    const res = await httpJson('POST', `${peer.url}/v1/jobs`, peerKey(peer), body);
    return { ...res, id: res.json?.id ?? jobId ?? null, peer: target };
  },
  async respond(entry, payload) {
    const peers = directPeers();
    let name = entry.callbackPeer && peers[entry.callbackPeer] ? entry.callbackPeer : null;
    let url = name ? `${peers[name].url}/v1/callbacks` : null;
    if (entry.callbackUrl) { name = peerForUrl(entry.callbackUrl, peers); url = name ? entry.callbackUrl : null; }
    if (!url) return { method: null, res: { code: 1, stderr: '', error: `no direct callback route (callback_peer=${entry.callbackPeer ?? ''} callback_url=${entry.callbackUrl ?? ''})` } };
    const res = await httpJson('POST', url, peerKey(peers[name]), JSON.parse(payload)).catch((e) => ({ code: 1, stderr: '', error: e.message }));
    return { method: res.code === 0 ? 'http-callback' : null, res };
  },
  async status(target, id) {
    const peer = directPeers()[target];
    if (!peer) throw new Error(`peer "${target}" is not configured`);
    return (await httpJson('GET', `${peer.url}/v1/jobs/${id}`, peerKey(peer))).json;
  },
};

// ---------------------------------------------------------------- yobiru (tailmsg CLI)

// 'yobiru' is deliberately absent: a Yobiru request can come from any peer and is answered through
// `request respond` to its requester; it must never fall back to grokbotPeer.
const GROK_SOURCES = new Set(['grok-bot', 'grok']);
const NON_GROK_SOURCES = new Set(['zcode', 'dsh', 'extracted', 'local', 'manual']);

function isGrokPeer(peer, grokbotPeer) {
  if (!peer || typeof peer !== 'string') return false;
  return peer === grokbotPeer || /(^|\/)grok(-bot)?($|\/|\.)/i.test(peer);
}

export function resolveCallbackPeer(entry, ycfg) {
  const source = entry?.source;
  if (entry?.callbackPeer) {
    // Non-Grok sources must never report to Grok, even if callbackPeer was set to grokbotPeer.
    if (NON_GROK_SOURCES.has(source) && isGrokPeer(entry.callbackPeer, ycfg.grokbotPeer)) return null;
    return entry.callbackPeer;
  }
  // Only Grok-originated tasks may fall back to grokbotPeer when reportViaYobiru is set.
  if (entry?.reportViaYobiru && GROK_SOURCES.has(source)) return ycfg.grokbotPeer;
  return null;
}

const yobiru = {
  async send(target, { text, timeoutSeconds, cfg = {}, execRunner = defaultExecRunner }) {
    const ycfg = { ...YOBIRU_DEFAULTS, ...cfg };
    const peer = target === 'zcode' ? ycfg.zcodePeer : target === 'grok-bot' ? ycfg.grokbotPeer : null;
    if (!peer) throw new Error(`${target} peer is not configured: set ${target === 'zcode' ? 'ZCODE_PEER' : 'GROKBOT_PEER'} or "${target === 'zcode' ? 'zcodePeer' : 'grokbotPeer'}" in config.json`);
    const res = await execRunner(ycfg.pythonBin, [ycfg.tailmsgScript, '--home', ycfg.tailmsgHome, 'request', 'send', peer, text,
      '--as', ycfg.selfAgent, '--wake', 'now', '--timeout-seconds', String(timeoutSeconds)], { timeoutMs: ycfg.reportTimeoutMs || 15000 });
    let id = null;
    if (res.code === 0) {
      try { const p = JSON.parse(res.stdout.trim()); if (p && typeof p.id === 'string' && JOB_ID_RE.test(p.id.toLowerCase())) id = p.id.toLowerCase(); } catch {}
      if (!id) { const m = REQ_ID_RE.exec(res.stdout); if (m) id = m[1].toLowerCase(); }
    }
    return { ...res, id, peer };
  },
  async respond(entry, payload, state, { cfg = {}, execRunner = defaultExecRunner } = {}) {
    const ycfg = { ...YOBIRU_DEFAULTS, ...cfg };
    const isLocalOrDsh = ['dsh', 'extracted', 'local', 'manual'].includes(entry.source);
    const yobiruId = isLocalOrDsh ? null : (entry.yobiruId || (entry.source === 'yobiru' ? entry.jobId : null));
    const baseArgs = [ycfg.tailmsgScript, '--home', ycfg.tailmsgHome];
    let res = null;
    if (yobiruId && JOB_ID_RE.test(yobiruId)) {
      res = await execRunner(ycfg.pythonBin, [...baseArgs, 'request', 'respond', yobiruId, payload, '--state', state], { timeoutMs: ycfg.reportTimeoutMs });
      if (res.code === 0) {
        await execRunner(ycfg.pythonBin, [...baseArgs, 'ack', yobiruId], { timeoutMs: ycfg.reportTimeoutMs });
        return { method: 'request-respond', res };
      }
    }
    const peer = resolveCallbackPeer(entry, ycfg);
    if (peer) {
      res = await execRunner(ycfg.pythonBin, [...baseArgs, 'send', peer, payload, '--as', ycfg.selfAgent, '--reply-to', entry.jobId,
        '--wake', entry.callbackWake || 'now'], { timeoutMs: ycfg.reportTimeoutMs });
      if (res.code === 0) return { method: 'send-callback', res };
    }
    return { method: null, res: res || { code: 1, stderr: '', error: 'no-yobiru-route' } };
  },
  async status(_target, id, { cfg = {}, execRunner = defaultExecRunner } = {}) {
    const ycfg = { ...YOBIRU_DEFAULTS, ...cfg };
    const res = await execRunner(ycfg.pythonBin, [ycfg.tailmsgScript, '--home', ycfg.tailmsgHome, 'request', 'status', id, '--refresh', '--json'], { timeoutMs: ycfg.reportTimeoutMs });
    try { return JSON.parse(res.stdout); } catch { return { raw: res.stdout, error: res.error }; }
  },
};

export function getTransport(cfg = {}) { return transportName(cfg) === 'yobiru' ? yobiru : direct; }
export function send(target, opts) { return getTransport(opts?.cfg).send(target, opts); }
export function respond(entry, payload, state, opts = {}) { return getTransport(opts.cfg).respond(entry, payload, state, opts); }
export function status(target, id, opts = {}) { return getTransport(opts.cfg).status(target, id, opts); }

/** Names this transport can send to (for /dispatch-* and /v1/outbound validation). */
export function knownTargets(cfg = {}) {
  return transportName(cfg) === 'yobiru' ? ['grok-bot', 'zcode'] : Object.keys(directPeers());
}

/** Startup check for the selected transport: {transport, errors[], warnings[]}. */
export function checkTransport(cfg = {}, { exists = fs.existsSync, which } = {}) {
  const errors = []; const warnings = [];
  let t;
  try { t = transportName(cfg); } catch (e) { return { transport: null, errors: [e.message], warnings }; }
  if (t === 'yobiru') {
    const y = { ...YOBIRU_DEFAULTS, ...cfg };
    if (!exists(y.tailmsgScript)) errors.push(`yobiru: tailmsg script not found at ${y.tailmsgScript} (set yobiru.script / TAILMSG_SCRIPT)`);
    if (!(path.isAbsolute(y.pythonBin) ? exists(y.pythonBin) : which?.(y.pythonBin, y.childPath))) errors.push(`yobiru: python "${y.pythonBin}" not found (set yobiru.python / TAILMSG_PYTHON)`);
    if (!y.grokbotPeer) warnings.push('yobiru: grokbotPeer not set; /dispatch-grok and Grok reporting disabled');
  } else {
    const peers = directPeers();
    if (!Object.keys(peers).length) warnings.push('direct: no peers configured; outbound dispatch and callbacks disabled (inbound + polling still work)');
    for (const [n, p] of Object.entries(peers)) {
      if (!p.keyFile || !exists(p.keyFile)) errors.push(`direct: peers.${n}.keyFile missing (${p.keyFile ?? 'unset'})`);
    }
  }
  return { transport: t, errors, warnings };
}
