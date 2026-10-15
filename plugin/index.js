/**
 * dsh-grokbot-dispatch: DSH (DeepSeek Harness) official Cordis plugin.
 * Primary mount: the DSH desktop app's own Host (profile "desktop"), where
 * each [Project: name] task becomes a visible app session (left panel, under
 * its project), outbound slash commands (/dispatch-grok, /dispatch-zcode,
 * /dispatch-status)  dispatch tasks to configured peers via transport.js (direct HTTP by default, Yobiru opt-in), and
 * session completion hooks (session/event turn/end + agent/turn-stopping)
 * automatically report results the same way using persistent sessionId<->jobId
 * mapping.
 * Fallback mount (optional): a standalone host (profile "grokbot-dispatch",
 * DISPATCH_STANDBY=1) which runs tasks headless and only takes over 7790 when
 * the desktop app is closed.
 */
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createEventLog } from './log.js';
import { resolveNetConfig, tailscaleStatus, which } from './config.js';
import { checkTransport, knownTargets } from './transport.js';
import { DEFAULTS, HttpError, JobStore, checkAuth, checkCompat, loadKey, normalizeIp, pickRunner, publicJob, startJob, validateDispatch } from './core.js';
import { JobMapStore, reportJobViaYobiru, wantsReport } from './job-map.js';
import { dispatchOutbound, registerDispatchCommands } from './commands.js';

export const name = 'grokbot-dispatch';

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(new HttpError(400, 'invalid JSON')); } });
    req.on('error', reject);
  });
}

function extractBlocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

/**
 * Install DSH session completion hooks (`session/event` and `agent/turn-stopping`)
 * so any session mapped to a `jobId` (either explicitly at creation or via `[Job: <id>]`
 * in its prompt/title) automatically reports its final result (transport.js) when its turn ends.
 */
export function installSessionCompletionHook(ctx, { cfg, mapStore, getStore, logger = console }) {
  const liveSession = new Map();
  const handleTurnEnd = async (sessionId, reasonKind = 'completed', fallbackTexts = []) => {
    if (!sessionId) return;
    const tracked = liveSession.get(sessionId) || {};
    const entry = mapStore.resolveForSession(sessionId, [
      ...fallbackTexts,
      tracked.title,
      tracked.prompt,
      tracked.lastAssistant,
    ]);
    if (!entry || entry.direction === 'outbound') return;
    const store = getStore?.();
    const job = store?.get(entry.jobId);
    const state = reasonKind === 'completed' ? 'completed' : (job?.state === 'completed' ? 'completed' : 'failed');
    const result = tracked.lastAssistant ?? job?.result ?? null;
    const error = state === 'completed' ? null : (job?.error ?? `turn ended: ${reasonKind}`);
    mapStore.bind({
      ...entry,
      sessionId,
      state,
    });
    if (wantsReport(entry) || cfg.autoReportYobiru) {
      await reportJobViaYobiru({
        cfg,
        mapStore,
        entry: mapStore.getByJob(entry.jobId) || entry,
        outcome: {
          state,
          sessionId,
          project: entry.project || job?.project || null,
          result,
          error,
        },
        execRunner: cfg.execRunner,
        logger,
      }).catch((e) => logger.warn?.(`session hook report error: ${e.message}`));
    }
  };

  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      const sessionId = session?.id ?? session?.header?.id;
      if (!sessionId || !event || typeof event !== 'object') return;
      const st = liveSession.get(sessionId) || {
        title: session?.header?.title || null,
        prompt: null,
        lastAssistant: null,
      };
      if (session?.header?.title) st.title = session.header.title;
      if (event.type === 'user/message') {
        const text = extractBlocksText(event.data?.content);
        if (text) {
          st.prompt = text;
          mapStore.resolveForSession(sessionId, [text, st.title]);
        }
      } else if (event.type === 'assistant/message') {
        const text = extractBlocksText(event.data?.message?.content);
        if (text) st.lastAssistant = text;
      } else if (event.type === 'turn/end') {
        const kind = event.data?.reason?.kind ?? 'completed';
        liveSession.set(sessionId, st);
        void handleTurnEnd(sessionId, kind, [st.title, st.prompt]);
        return;
      }
      liveSession.set(sessionId, st);
    });

    ctx.on('agent/turn-stopping', ({ agent }) => {
      const sessionId = agent?.session?.header?.id ?? agent?.id;
      if (!sessionId) return;
      const title = agent?.session?.header?.title;
      void handleTurnEnd(sessionId, 'completed', [title]);
    });
  }

  return { handleTurnEnd, liveSession };
}

export function createServer(cfg, logger = console, getServices = () => undefined) {
  const key = loadKey(cfg.keyFile);
  const store = new JobStore(cfg);
  store.reconcile();
  const health = () => { let runner; try { runner = pickRunner(cfg, getServices()); } catch { runner = 'unavailable'; }
    const checks = checkCompat(cfg, { which, checkTransport });
    return { ok: checks.ok, running: store.running.size, runner, transport: checks.transport, checks: { errors: checks.errors, warnings: checks.warnings }, uptime_s: Math.round(process.uptime()) }; };
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      const src = normalizeIp(req.socket.remoteAddress);
      // This host itself (its own bind IP) may read /health only, for the self-check script.
      if (src === cfg.host && req.method === 'GET' && req.url === '/health') return send(200, health());
      if (!cfg.allowedIps.includes(src)) { logger.warn?.(`forbidden source ${normalizeIp(req.socket.remoteAddress)} ${req.method} ${req.url}`); throw new HttpError(403, 'forbidden'); }
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, health());
      if (!checkAuth(req.headers.authorization, key)) { logger.warn?.(`auth failed from ${normalizeIp(req.socket.remoteAddress)} ${req.method} ${url.pathname}`); throw new HttpError(401, 'unauthorized'); }
      if (req.method === 'POST' && url.pathname === '/v1/jobs') {
        logger.info?.(`job request received from ${normalizeIp(req.socket.remoteAddress)}`);
        const spec = validateDispatch(cfg, await readBody(req, cfg.maxTextChars * 4 + 4096));
        const job = startJob(store, spec, logger, getServices());
        logger.info?.(`job ${job.id} started for [Project: ${spec.project}] mode=${spec.mode} runner=${job.runner} source=${job.source}`);
        return send(202, publicJob(job));
      }
      if (req.method === 'POST' && url.pathname === '/v1/outbound') {
        const body = await readBody(req, cfg.maxTextChars * 4 + 4096);
        const targets = knownTargets(cfg);
        if (!targets.includes(body?.target)) throw new HttpError(400, `target must be one of ${targets.join(', ') || '(no peers configured)'}`);
        const target = body.target;
        const out = await dispatchOutbound({
          target,
          rawInput: body?.text || `${body?.project || ''} ${body?.task || ''}`,
          sessionId: body?.session_id || null,
          cfg,
          mapStore: store.mapStore,
          services: getServices(),
          execRunner: cfg.execRunner,
          logger,
        });
        return send(202, out);
      }
      // Direct-transport push: a peer reports the result of a job we dispatched to it.
      if (req.method === 'POST' && url.pathname === '/v1/callbacks') {
        const r = await readBody(req, cfg.maxResultChars * 2 + 8192);
        const id = r?.job_id;
        if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, 'job_id (16 hex) required');
        const prev = store.mapStore.getByJob(id) || { jobId: id, direction: 'outbound' };
        store.mapStore.bind({ ...prev, state: r.state === 'completed' ? 'completed' : 'failed', result: r.result ?? null, error: r.error ?? null,
          resultSessionId: r.session_id ?? null, callbackReceivedAt: new Date().toISOString() });
        logger.info?.(`callback received for job ${id} state=${r.state} from ${normalizeIp(req.socket.remoteAddress)}`);
        return send(200, { ok: true, job_id: id });
      }
      const m = /^\/v1\/jobs\/([0-9a-f]{16})$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const job = store.get(m[1]);
        if (!job) throw new HttpError(404, 'no such job');
        const mapEntry = store.mapStore.getByJob(m[1]);
        return send(200, { ...publicJob(job), ...(mapEntry?.reported ? { reported: true, report_method: mapEntry.reportMethod, yobiru_reported: true, yobiru_report_method: mapEntry.reportMethod } : {}) });
      }
      if (req.method === 'GET' && url.pathname === '/v1/job-map') {
        return send(200, { entries: store.mapStore.list() });
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError && e.code !== 401 && e.code !== 403 && e.code !== 404 && req.method === 'POST') logger.warn?.(`job request rejected ${e.code}: ${e.message}`);
      send(e instanceof HttpError ? e.code : 500, { error: e instanceof HttpError ? e.message : 'internal error' });
      if (!(e instanceof HttpError)) logger.error?.(e);
    }
  });
  return { server, store };
}

/** TCP-connect to host:port; resolves true if something accepts. */
export function probe(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Keeps the server bound to the tailnet IP across sleep/wake and tailnet
 * reconnects: listen errors (EADDRNOTAVAIL while tailscale is down) are
 * retried, and a watchdog probes our own socket every watchdogSeconds and
 * rebinds if it stops accepting. If we stay unbound past
 * exitAfterFailedSeconds the process exits so launchd KeepAlive restarts it.
 */
export function supervise(server, cfg, logger, exit = (c) => process.exit(c)) {
  let listening = false; let binding = false; let downSince = null; let stopped = false; let standby = false;
  server.on('listening', () => { listening = true; downSince = null; standby = false; logger.info?.(`listening on ${cfg.host}:${cfg.port}`); });
  server.on('close', () => { listening = false; });
  server.on('error', (e) => {
    listening = false; binding = false;
    // Standby (fallback host): the port is held by the primary (desktop app) host; wait quietly, never exit.
    if (cfg.standby && e.code === 'EADDRINUSE') { if (!standby) logger.info?.(`standby: ${cfg.host}:${cfg.port} held by the primary host; will take over when it is free`); standby = true; downSince = null; return; }
    downSince ??= Date.now();
    logger.warn?.(`listen ${cfg.host}:${cfg.port} failed: ${e.code || e.message}; retrying in ${cfg.watchdogSeconds}s`);
  });
  let bindStartedAt = 0;
  const bind = () => {
    if (stopped) return;
    // A listen() that never emits 'listening' or 'error' (seen after a long tailnet outage) would
    // leave `binding` stuck forever; treat it as stale after one watchdog period and retry.
    if (binding && Date.now() - bindStartedAt < cfg.watchdogSeconds * 1000) return;
    if (binding) { logger.warn?.(`listen ${cfg.host}:${cfg.port} attempt stalled; retrying`); try { server.close(); } catch {} }
    // No configured/discovered tailnet IP (tailscale down at startup): never fall back to 0.0.0.0.
    // Re-resolve each attempt so the listener comes up once tailscale reports an IP.
    if (!cfg.host && typeof cfg.resolveHost === 'function') cfg.host = cfg.resolveHost();
    if (!cfg.host) { downSince ??= Date.now(); logger.warn?.('no tailnet bind host (set DISPATCH_HOST or "host" in config.json, or bring tailscale up); not listening'); return; }
    binding = true; bindStartedAt = Date.now();
    try { server.listen(cfg.port, cfg.host, () => { binding = false; }); }
    catch (e) { binding = false; logger.warn?.(`listen ${cfg.host}:${cfg.port} threw: ${e.code || e.message}`); }
  };
  const tick = async () => {
    if (stopped) return;
    if (listening && !(await probe(cfg.host, cfg.port))) {
      logger.warn?.('self-probe failed (sleep/network change?); rebinding');
      downSince ??= Date.now();
      await new Promise((r) => server.close(() => r()));
      listening = false; binding = false;
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }
    // Fallback host serving while the primary (desktop app) is back: hand the port over once idle.
    if (listening && cfg.standby && cfg.shouldYield?.()) {
      logger.info?.('primary host is up and we are idle; yielding the port');
      await new Promise((r) => server.close(() => r()));
      listening = false; binding = false; standby = true;
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return;
    }
    if (!listening) {
      if (standby) { if (!cfg.shouldYield?.()) bind(); return; }
      downSince ??= Date.now();
      if ((Date.now() - downSince) / 1000 > cfg.exitAfterFailedSeconds) {
        logger.error?.(`unbound for >${cfg.exitAfterFailedSeconds}s; exiting so launchd restarts the service`);
        exit(1);
        downSince = Date.now();
      }
      bind();
    }
  };
  if (cfg.standby && cfg.shouldYield?.()) { standby = true; logger.info?.('standby: primary host is up; not binding'); } else bind();
  const timer = setInterval(() => { tick().catch((e) => logger.error?.(e)); }, cfg.watchdogSeconds * 1000);
  // A standby host with its port yielded has no other handle; keep it alive instead of exiting into a launchd restart loop.
  if (!cfg.standby) timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); }, isListening: () => listening, isStandby: () => standby };
}

/** pid file the primary (desktop) host holds while mounted; the standby host yields to it. */
export function primaryAlive(file) {
  try { const pid = Number(fs.readFileSync(file, 'utf8').trim()); if (!pid || pid === process.pid) return false; process.kill(pid, 0); return true; } catch { return false; }
}

export function apply(ctx, config = {}) {
  const cfg = { resolveHost: () => resolveNetConfig({ status: () => tailscaleStatus({ refresh: true }) }).host, ...DEFAULTS, ...(config || {}) };
  const logger = createEventLog(path.join(cfg.stateDir, 'logs'), { forward: ctx.logger ? ctx.logger('grokbot-dispatch') : console });
  const marker = path.join(cfg.stateDir, 'primary.pid');
  const mapStore = new JobMapStore(cfg.stateDir);
  let store;
  const getServices = () => {
    const sessionController = ctx.get?.('sessionController');
    if (!sessionController) return undefined;
    return { sessionController, workspaceController: ctx.get('workspaceController'), permissionPresets: ctx.get('permissionPresets'), agents: ctx.get('agents') };
  };

  registerDispatchCommands(ctx, {
    cfg,
    mapStore,
    getServices,
    getStore: () => store,
    execRunner: cfg.execRunner,
    logger,
  });

  installSessionCompletionHook(ctx, {
    cfg,
    mapStore,
    getStore: () => store,
    logger,
  });

  ctx.effect(() => {
    logger.info?.(`service starting pid=${process.pid} role=${cfg.standby ? 'standby(headless fallback)' : 'primary'}`);
    if (cfg.standby) cfg.shouldYield = () => primaryAlive(marker) && (store?.running.size ?? 0) === 0;
    else { fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(marker, String(process.pid), { mode: 0o600 }); }
    const checks = checkCompat(cfg, { which, checkTransport });
    for (const e of checks.errors) logger.error?.(`compat check FAILED: ${e}`);
    for (const w of checks.warnings) logger.warn?.(`compat check: ${w}`);
    logger.info?.(`compat check ${checks.ok ? 'ok' : 'FAILED'} transport=${checks.transport} dsh=${cfg.dsh ?? 'not found'}`);
    const created = createServer(cfg, logger, getServices); const { server } = created; store = created.store;
    // The primary lives inside the desktop app: never process.exit() it; just keep retrying the bind.
    const sup = supervise(server, cfg, logger, cfg.standby ? undefined : () => logger.error?.('still unbound; staying up (primary host is never exited)'));
    return () => { sup.stop(); logger.info?.('service stopping');
      if (!cfg.standby) { try { if (fs.readFileSync(marker, 'utf8').trim() === String(process.pid)) fs.unlinkSync(marker); } catch {} } return new Promise((r) => server.close(() => r())); };
  });
}

const plugin = { name, apply };
export default plugin;
