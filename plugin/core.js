/**
 * Dispatch core (no DSH imports, unit-testable with plain node):
 * request validation, key auth, job store, and the two runners:
 *  - app runner (default inside the DSH desktop Host): creates a *visible*
 *    session through the Host's own workspaceController / sessionController
 *    services, so the job shows in the desktop app's left panel under its
 *    project, titled, with live progress;
 *  - headless runner (fallback): spawns `dsh --profile headless --json`.
 * Host services are passed in as plain objects, so both runners are testable.
 */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobMapStore, embedJobTag, extractJobId, reportJobViaYobiru, wantsReport } from './job-map.js';
import { denyProjectsRe, dshBin, projectsRoot, readConfigFile, resolveNetConfig } from './config.js';
import { peerForUrl } from './transport.js';

const HOME = os.homedir();
export const DEFAULTS = {
  // host / port / allowedIps come from env > ~/.config/dsh-grokbot-dispatch/config.json > tailscale
  // discovery (see config.js); resolved lazily so importing this module never shells out.
  get host() { return resolveNetConfig().host; },            // this node's tailnet IP; never 0.0.0.0
  get port() { return resolveNetConfig().port; },
  get allowedIps() { return resolveNetConfig().allowedIps; }, // DISPATCH_ALLOWED_IPS / config allowedIps, else discovered tailnet IPs of the grokbotPeer node
  keyFile: path.join(HOME, '.config', 'dsh-grokbot-dispatch', 'key'),
  stateDir: path.join(HOME, '.local', 'state', 'dsh-grokbot-dispatch'),
  get projectsRoot() { return projectsRoot(); },   // DISPATCH_PROJECTS_ROOT / config projectsRoot / ~/Projects
  get dsh() { return dshBin(); },                   // DSH_BIN / config dshBin / `dsh` on PATH
  get selfName() { return readConfigFile().selfName || 'dsh'; },        // our name in the peers' config (direct callbacks)
  get callbackUrl() { return readConfigFile().callbackUrl || null; },  // optional: where peers POST results
  profile: 'headless',
  // 'auto': app runner when the Host services exist (desktop profile), else headless.
  // 'headless': always spawn headless (escape hatch). Env DISPATCH_RUNNER overrides.
  runner: process.env.DISPATCH_RUNNER || 'auto',
  // Standalone fallback host: when 7790 is already held (by the desktop app), wait quietly.
  standby: process.env.DISPATCH_STANDBY === '1',
  titleChars: 60,
  permissionMode: 'danger-full-access',
  maxConcurrent: 2,
  defaultTimeoutSeconds: 1800,
  maxTimeoutSeconds: 7200,
  maxTextChars: 20000,
  maxResultChars: 100000,
  watchdogSeconds: 30,         // self-check / rebind interval
  exitAfterFailedSeconds: 600,  // still unbound after this long -> exit, launchd restarts us
};

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAG_RE = /^\s*\[Project: ([^\]\n]+)\]/;
const JOB_RE = /^[0-9a-f]{16}$/;
const MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const SOURCES = { 'grok-bot': 'Grok Bot', yobiru: 'Yobiru', zcode: 'ZCode', dsh: 'DSH' };

export class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

export function loadKey(file) {
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`key file ${file} must be chmod 600`);
  const key = fs.readFileSync(file, 'utf8').trim();
  if (key.length < 32) throw new Error('key too short');
  return Buffer.from(key);
}

export function checkAuth(header, key) {
  const m = /^Bearer (\S+)$/.exec(header || '');
  if (!m) return false;
  const got = Buffer.from(m[1]);
  return got.length === key.length && timingSafeEqual(got, key);
}

export function normalizeIp(ip) { return (ip || '').replace(/^::ffff:/, ''); }

/** Validate a dispatch body; returns {project, cwd, text, timeoutSeconds, mode, source, jobId, yobiruId, callbackPeer, reportViaYobiru}. */
export function validateDispatch(cfg, body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON object body required');
  const { project, text } = body;
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) throw new HttpError(400, 'project must be a plain folder name under ~/Projects');
  if (denyProjectsRe().test(project)) throw new HttpError(403, 'project not allowed');
  if (typeof text !== 'string' || !text.trim() || text.length > cfg.maxTextChars) throw new HttpError(400, `text required (max ${cfg.maxTextChars} chars)`);
  const strippedForTag = text.replace(/^\s*\[(?:Job|Yobiru-ID):\s*[0-9a-f]{16}\]\s*/i, '');
  const tag = TAG_RE.exec(strippedForTag);
  if (!tag || tag[1] !== project) throw new HttpError(400, `text must start with "[Project: ${project}]"`);
  const root = fs.realpathSync(cfg.projectsRoot);
  let cwd;
  try { cwd = fs.realpathSync(path.join(root, project)); } catch { throw new HttpError(404, `no such project folder ~/Projects/${project}`); }
  if (path.dirname(cwd) !== root || !fs.statSync(cwd).isDirectory() || denyProjectsRe().test(cwd)) throw new HttpError(403, 'project folder must be a direct child of ~/Projects');
  let timeoutSeconds = body.timeout_seconds ?? cfg.defaultTimeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > cfg.maxTimeoutSeconds) throw new HttpError(400, `timeout_seconds must be 10..${cfg.maxTimeoutSeconds}`);
  const mode = body.permission_mode ?? cfg.permissionMode;
  if (!MODES.includes(mode)) throw new HttpError(400, `permission_mode must be one of ${MODES.join(', ')}`);
  const source = body.source ?? 'grok-bot';
  if (!Object.hasOwn(SOURCES, source)) throw new HttpError(400, `source must be one of ${Object.keys(SOURCES).join(', ')}`);
  const rawJobId = body.job_id ?? body.yobiru_id ?? extractJobId(text);
  if (rawJobId !== undefined && rawJobId !== null && !JOB_RE.test(String(rawJobId))) {
    throw new HttpError(400, 'job_id / yobiru_id must be 16 lowercase hex chars');
  }
  const jobId = rawJobId ? String(rawJobId) : undefined;
  const yobiruId = body.yobiru_id ? String(body.yobiru_id) : (source === 'yobiru' && jobId ? jobId : undefined);
  const callbackPeer = typeof body.callback_peer === 'string' && body.callback_peer.trim() ? body.callback_peer.trim() : undefined;
  const callbackUrl = typeof body.callback_url === 'string' && body.callback_url.trim() ? body.callback_url.trim() : undefined;
  // Never POST results to arbitrary URLs: callback_url must point at a configured peer (its key is used).
  if (callbackUrl && !peerForUrl(callbackUrl)) throw new HttpError(400, 'callback_url must start with a configured peer url (config.json peers)');
  const reportViaYobiru = Boolean(body.report_via_yobiru || yobiruId || callbackPeer || source === 'yobiru');
  return { project, cwd, text, timeoutSeconds, mode, source, jobId, yobiruId, callbackPeer, callbackUrl, reportViaYobiru };
}

/** Left-panel title: "[Grok Bot] <first N chars of the task, tag stripped>" (with optional [Job: id] embedded). */
export function sessionTitle(spec, n = DEFAULTS.titleChars, jobId = undefined) {
  const body = spec.text
    .replace(/^\s*\[(?:Job|Yobiru-ID):\s*[0-9a-f]{16}\]\s*/i, '')
    .replace(TAG_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = [...body].slice(0, n).join('');
  const base = `[${SOURCES[spec.source] ?? SOURCES['grok-bot']}] ${cut}${[...body].length > n ? '…' : ''}`.trim();
  return jobId ? embedJobTag(base, jobId) : base;
}

/** Fold Host session events (turn/start, assistant/message, tool/call, turn/end) into job progress. */
export function foldSessionEvent(acc, ev) {
  if (!ev || typeof ev !== 'object') return acc;
  const data = ev.data ?? {};
  if (ev.type === 'turn/start') acc.started = true;
  else if (ev.type === 'tool/call' && acc.started) acc.tools.push(data.name);
  else if (ev.type === 'assistant/message' && acc.started) {
    const t = (data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (t) acc.final = t;
  } else if (ev.type === 'turn/end' && acc.started) acc.turnEnd = data.reason?.kind ?? 'unknown';
  return acc;
}

/** Which runner to use for this job: 'app' needs the Host services. */
export function pickRunner(cfg, services) {
  if (cfg.runner === 'headless') return 'headless';
  const ok = services && services.sessionController && services.workspaceController;
  if (cfg.runner === 'app' && !ok) throw new HttpError(503, 'desktop app session services unavailable');
  return ok ? 'app' : 'headless';
}

export class JobStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = path.join(cfg.stateDir, 'jobs');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.running = new Map();
    this.mapStore = new JobMapStore(cfg.stateDir);
  }
  file(id) { return path.join(this.dir, `${id}.json`); }
  save(job) {
    const tmp = this.file(job.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file(job.id));
  }
  get(id) {
    if (!JOB_RE.test(id || '')) return null;
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }
  /** Jobs left 'running' by a previous host process can never finish; mark them. */
  reconcile() {
    for (const n of fs.readdirSync(this.dir)) {
      if (!n.endsWith('.json')) continue;
      const job = this.get(n.slice(0, -5));
      if (job && (job.state === 'running' || job.state === 'queued')) {
        Object.assign(job, { state: 'failed', error: 'dispatch service restarted while job was running', finished_at: new Date().toISOString() });
        this.save(job);
      }
    }
  }
}

/** Parse dsh --json event lines into {sessionId, final, turnEnd, tools}. */
export function parseEvents(raw) {
  const out = { sessionId: null, final: null, turnEnd: null, tools: [] };
  for (const line of raw.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session') out.sessionId = e.sessionId ?? e.session?.sessionId ?? out.sessionId;
    else if (e.type === 'final') out.final = e.text ?? out.final;
    else if (e.type === 'tool_call') out.tools.push(e.tool);
    else if (e.type === 'status' && e.phase === 'turn_end') out.turnEnd = e.reason?.kind ?? null;
  }
  return out;
}

/**
 * Start one job. `services` (optional) are the desktop Host services
 * {sessionController, workspaceController, permissionPresets, agents}; with
 * them the job becomes a visible app session, without them it runs headless.
 */
export function startJob(store, spec, logger = console, services = undefined) {
  const cfg = store.cfg;
  if (spec.jobId) {
    const existing = store.get(spec.jobId);
    if (existing) return existing;
  }
  if (store.running.size >= cfg.maxConcurrent) throw new HttpError(429, `busy: ${store.running.size} jobs running`);
  const runner = pickRunner(cfg, services);
  if (runner === 'headless' && !cfg.dsh) throw new HttpError(503, 'dsh binary not found: put dsh on PATH or set dshBin / DSH_BIN');
  const id = spec.jobId || randomBytes(8).toString('hex');
  const job = {
    id, project: spec.project, cwd: spec.cwd, permission_mode: spec.mode, timeout_seconds: spec.timeoutSeconds,
    source: spec.source ?? 'grok-bot', runner, state: 'running', created_at: new Date().toISOString(), text: spec.text,
    ...(spec.yobiruId ? { yobiru_id: spec.yobiruId } : {}),
    ...(spec.callbackPeer ? { callback_peer: spec.callbackPeer } : {}),
    ...(spec.callbackUrl ? { callback_url: spec.callbackUrl } : {}),
  };
  store.save(job);
  const mapEntry = store.mapStore.bind({
    jobId: id,
    yobiruId: spec.yobiruId || null,
    callbackPeer: spec.callbackPeer || null,
    callbackUrl: spec.callbackUrl || null,
    reportViaYobiru: Boolean(spec.reportViaYobiru),
    project: spec.project,
    source: job.source,
    direction: 'inbound',
    state: 'running',
  });
  if (runner === 'app') { runAppJob(store, job, spec, services, logger); return job; }
  const env = { ...process.env, DSH_PERMISSION_MODE: spec.mode };
  delete env.DEEPSEEK_BASE_URL; // dsh only accepts it from the launching env; never leak the dispatcher's
  const promptText = embedJobTag(spec.text, id);
  const child = spawn(cfg.dsh, ['--profile', cfg.profile, '--json', promptText], { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  store.running.set(id, child);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { if (stdout.length < 4e6) stdout += d; });
  child.stderr.on('data', (d) => { if (stderr.length < 2e5) stderr += d; });
  const timer = setTimeout(() => { job.timed_out = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, spec.timeoutSeconds * 1000);
  const finish = (code, signal, err) => {
    clearTimeout(timer);
    store.running.delete(id);
    const ev = parseEvents(stdout);
    fs.writeFileSync(path.join(store.dir, `${id}.events.jsonl`), stdout, { mode: 0o600 });
    const ok = !err && code === 0 && !job.timed_out && (ev.turnEnd === null || ev.turnEnd === 'completed');
    Object.assign(job, {
      state: ok ? 'completed' : 'failed', exit_code: code, signal: signal ?? null, session_id: ev.sessionId,
      turn_end: ev.turnEnd, tools: ev.tools, finished_at: new Date().toISOString(),
      result: ev.final == null ? null : String(ev.final).slice(0, cfg.maxResultChars),
      error: ok ? null : (err ? String(err.message) : job.timed_out ? 'timeout' : stderr.trim().split('\n').slice(-5).join('\n').slice(0, 2000) || `exit ${code}`),
    });
    store.save(job);
    const updatedMap = store.mapStore.bind({
      ...mapEntry,
      sessionId: ev.sessionId || null,
      state: job.state,
    });
    if (wantsReport(updatedMap)) {
      reportJobViaYobiru({
        cfg,
        mapStore: store.mapStore,
        entry: updatedMap,
        outcome: { state: job.state, sessionId: ev.sessionId, project: job.project, result: job.result, error: job.error, finishedAt: job.finished_at },
        execRunner: cfg.execRunner,
        logger,
      }).catch(() => {});
    }
    logger.info?.(`job ${id} ${job.state} exit=${code} signal=${signal ?? ''} turn_end=${ev.turnEnd ?? ''}${job.state === 'failed' ? ` error=${JSON.stringify(String(job.error).slice(0, 300))}` : ''}`);
  };
  child.on('error', (e) => finish(null, null, e));
  child.on('close', (code, signal) => finish(code, signal));
  return job;
}

/**
 * App runner. Real Host signatures (DSH 0.2.0-rc.2, dsh-api-*-controller lib/index.js):
 *   workspaceController.create({path}) -> {workspace:{workspaceId,...}, created}   (idempotent per dir)
 *   sessionController.create({workspaceId} | {cwd}, never both) -> {sessionId, agentPreset?}
 *   permissionPresets.set(agents.get(sessionId).session, 'danger-full-access')    (sandbox+approval:never)
 *   sessionController.rename({sessionId, title}) -> {title, seq}
 *   sessionController.prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text}]}, signal) -> {accepted}
 *   sessionController.follow({address:{kind:'session',sessionId}}, signal) -> async iterator of
 *     {type:'snapshot',...} then {type:'event', event:{seq,type,data}}
 *   sessionController.cancel({sessionId}) -> {accepted}
 */
export async function runAppJob(store, job, spec, svc, logger = console) {
  const cfg = store.cfg;
  const ac = new AbortController();
  let sessionId = null; let timer;
  store.running.set(job.id, { cancel: () => ac.abort() });
  const acc = { started: false, tools: [], final: null, turnEnd: null };
  let error = null;
  try {
    const { workspace } = await svc.workspaceController.create({ path: spec.cwd });
    ({ sessionId } = await svc.sessionController.create({ workspaceId: workspace.workspaceId }));
    Object.assign(job, { session_id: sessionId, workspace_id: workspace.workspaceId });
    const agent = svc.agents?.get?.(sessionId);
    if (svc.permissionPresets && agent?.session) svc.permissionPresets.set(agent.session, spec.mode);
    else logger.warn?.(`job ${job.id}: could not pin permission preset ${spec.mode}; session uses the app default`);
    const title = sessionTitle(spec, cfg.titleChars, job.id);
    try { await svc.sessionController.rename({ sessionId, title }); job.title = title; } catch (e) { logger.warn?.(`job ${job.id}: rename failed: ${e.message}`); }
    store.save(job);
    store.mapStore.bind({
      jobId: job.id,
      sessionId,
      workspaceId: workspace.workspaceId,
      title,
      project: spec.project,
      source: job.source,
      direction: 'inbound',
      state: 'running',
    });
    timer = setTimeout(() => {
      job.timed_out = true;
      Promise.resolve().then(() => svc.sessionController.cancel({ sessionId })).catch(() => {}).finally(() => setTimeout(() => ac.abort(), 5000).unref?.());
    }, spec.timeoutSeconds * 1000);
    // Subscribe before prompting so no event is missed (first next() attaches listeners and yields the snapshot).
    const it = svc.sessionController.follow({ address: { kind: 'session', sessionId } }, ac.signal)[Symbol.asyncIterator]();
    const first = await it.next();
    for (const r of first.value?.records ?? []) if (r.type === 'event') foldSessionEvent(acc, r.event);
    await svc.sessionController.prompt({ requestId: job.id, sessionId, mode: 'queue', content: [{ type: 'text', text: spec.text }] }, ac.signal);
    let lastSave = 0;
    while (acc.turnEnd === null && !ac.signal.aborted) {
      const { value, done } = await it.next();
      if (done) break;
      if (value?.type !== 'event') continue;
      const n = acc.tools.length; foldSessionEvent(acc, value.event);
      if (acc.tools.length !== n && Date.now() - lastSave > 2000) { job.tools = [...acc.tools]; store.save(job); lastSave = Date.now(); }
    }
    ac.abort(); await it.return?.().catch?.(() => {});
  } catch (e) {
    if (!ac.signal.aborted) error = e;
  } finally {
    clearTimeout(timer); ac.abort();
    store.running.delete(job.id);
  }
  const ok = !error && !job.timed_out && acc.turnEnd === 'completed';
  Object.assign(job, {
    state: ok ? 'completed' : 'failed', session_id: sessionId, turn_end: acc.turnEnd, tools: acc.tools,
    finished_at: new Date().toISOString(),
    result: acc.final == null ? null : String(acc.final).slice(0, cfg.maxResultChars),
    error: ok ? null : error ? String(error.message ?? error).slice(0, 2000) : job.timed_out ? 'timeout' : `turn ended: ${acc.turnEnd ?? 'no turn/end'}`,
  });
  store.save(job);
  const updatedMap = store.mapStore.bind({
    jobId: job.id,
    sessionId,
    state: job.state,
  });
  if (wantsReport(updatedMap)) {
    await reportJobViaYobiru({
      cfg,
      mapStore: store.mapStore,
      entry: updatedMap,
      outcome: { state: job.state, sessionId, project: job.project, result: job.result, error: job.error, finishedAt: job.finished_at },
      execRunner: cfg.execRunner,
      logger,
    }).catch(() => {});
  }
  logger.info?.(`job ${job.id} ${job.state} runner=app session=${sessionId ?? ''} turn_end=${acc.turnEnd ?? ''}${job.state === 'failed' ? ` error=${JSON.stringify(String(job.error).slice(0, 300))}` : ''}`);
  return job;
}

export function publicJob(job) {
  const { text, cwd, ...rest } = job;
  return { ...rest, text_preview: text.slice(0, 200) };
}

/**
 * Startup compatibility check. Never throws: returns {ok, transport, errors[], warnings[]} for the
 * startup log and /health, so a misconfigured install says why instead of silently doing nothing.
 */
export function checkCompat(cfg, { which: whichFn, checkTransport } = {}) {
  const errors = []; const warnings = [];
  try { loadKey(cfg.keyFile); } catch (e) { errors.push(`key: ${e.code === 'ENOENT' ? `missing ${cfg.keyFile} (openssl rand -hex 32 > it; chmod 600)` : e.message}`); }
  if (!cfg.host) errors.push('host: no bind host (set "host" in config.json or DISPATCH_HOST; tailscale discovery found none)');
  if (!cfg.allowedIps?.length) errors.push('allowedIps: empty, every caller is refused (set "allowedIps" in config.json or DISPATCH_ALLOWED_IPS)');
  if (!cfg.dsh) (cfg.runner === 'headless' ? errors : warnings).push('dsh: binary not found on PATH (set "dshBin" or DSH_BIN); headless runner unavailable');
  try { fs.accessSync(cfg.projectsRoot); } catch { errors.push(`projectsRoot: ${cfg.projectsRoot} does not exist`); }
  const t = checkTransport ? checkTransport(cfg, { which: whichFn }) : { transport: null, errors: [], warnings: [] };
  errors.push(...t.errors); warnings.push(...t.warnings);
  return { ok: errors.length === 0, transport: t.transport, errors, warnings };
}
