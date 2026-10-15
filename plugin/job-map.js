/**
 * Persistent bidirectional mapping (sessionId <-> jobId) and automatic result
 * reporting (through transport.js) when a DSH session turn completes or stops.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultExecRunner, respond as transportRespond, transportName } from './transport.js';

const HOME = os.homedir();
export const JOB_ID_RE = /^[0-9a-f]{16}$/;
export const JOB_TAG_RE = /\[(?:Job|Yobiru-ID):\s*([0-9a-f]{16})\]/i;

export { YOBIRU_DEFAULTS, defaultExecRunner } from './transport.js';

/** Extract 16-hex job ID from a `[Job: <16-hex>]` or `[Yobiru-ID: <16-hex>]` tag in text or title. */
export function extractJobId(input) {
  if (typeof input !== 'string') return null;
  const m = JOB_TAG_RE.exec(input);
  return m ? m[1].toLowerCase() : null;
}

/** Embed `[Job: <jobId>]` into a session title or task text if not already present. */
export function embedJobTag(text, jobId) {
  if (!jobId || !JOB_ID_RE.test(jobId)) return text;
  if (typeof text !== 'string') return `[Job: ${jobId}]`;
  if (extractJobId(text) === jobId) return text;
  const m = /^(\[(?:Grok Bot|Yobiru|ZCode|DSH)\])\s*(.*)$/s.exec(text);
  if (m) return `${m[1]} [Job: ${jobId}] ${m[2]}`.trim();
  return `[Job: ${jobId}] ${text}`;
}

/**
 * Persistent store mapping `sessionId <-> jobId` in `${stateDir}/job-map.json`.
 * Safe across restarts and concurrent readers via atomic temp-file rename.
 */
export class JobMapStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.file = path.join(stateDir, 'job-map.json');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }

  _read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        byJob: raw && typeof raw.byJob === 'object' ? raw.byJob : {},
        bySession: raw && typeof raw.bySession === 'object' ? raw.bySession : {},
      };
    } catch {
      return { byJob: {}, bySession: {} };
    }
  }

  _write(data) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  bind(record) {
    if (!record || !JOB_ID_RE.test(record.jobId || '')) {
      throw new Error(`invalid jobId: ${record?.jobId}`);
    }
    const data = this._read();
    const prev = data.byJob[record.jobId] || {};
    const merged = {
      ...prev,
      ...record,
      updatedAt: new Date().toISOString(),
    };
    data.byJob[record.jobId] = merged;
    if (merged.sessionId) {
      data.bySession[merged.sessionId] = record.jobId;
    }
    this._write(data);
    return merged;
  }

  getByJob(jobId) {
    if (!JOB_ID_RE.test(jobId || '')) return null;
    const data = this._read();
    return data.byJob[jobId] || null;
  }

  getBySession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    const data = this._read();
    const jobId = data.bySession[sessionId];
    if (jobId && data.byJob[jobId]) return data.byJob[jobId];
    for (const entry of Object.values(data.byJob)) {
      if (entry.sessionId === sessionId) return entry;
    }
    return null;
  }

  /**
   * Look up a job entry by sessionId first; if not yet bound by sessionId,
   * scan candidate strings (session title, prompt text, assistant text) for `[Job: <id>]`
   * and bind the sessionId automatically.
   */
  resolveForSession(sessionId, candidateTexts = []) {
    const direct = this.getBySession(sessionId);
    if (direct) return direct;
    for (const text of candidateTexts) {
      const jobId = extractJobId(text);
      if (jobId) {
        const existing = this.getByJob(jobId);
        if (existing) {
          return sessionId ? this.bind({ ...existing, sessionId }) : existing;
        }
        return this.bind({
          jobId,
          sessionId: sessionId || null,
          source: 'extracted',
          direction: 'inbound',
        });
      }
    }
    return null;
  }

  markReported(jobId, reportInfo = {}) {
    const existing = this.getByJob(jobId);
    if (!existing) return null;
    return this.bind({
      ...existing,
      reported: true,
      reportedAt: new Date().toISOString(),
      ...reportInfo,
    });
  }

  list() {
    return Object.values(this._read().byJob);
  }
}

/** Format the payload sent back via Yobiru when a mapped DSH session finishes. */
export function formatReportPayload(entry, outcome) {
  const state = outcome.state === 'completed' ? 'completed' : 'failed';
  const summary = state === 'completed'
    ? String(outcome.result ?? '').slice(0, 8000)
    : String(outcome.error ?? 'session failed').slice(0, 2000);
  return JSON.stringify({
    type: 'dsh-job-report-v1',
    job_id: entry.jobId,
    yobiru_id: entry.yobiruId || entry.jobId,
    session_id: outcome.sessionId || entry.sessionId || null,
    project: entry.project || outcome.project || null,
    source: entry.source || 'grok-bot',
    state,
    summary: `[Job: ${entry.jobId}] ${summary}`,
    result: state === 'completed' ? summary : null,
    error: state === 'completed' ? null : summary,
    finished_at: outcome.finishedAt || new Date().toISOString(),
  });
}

/**
 * Report job completion/failure via Yobiru (`tailmsg.py`) and record in `mapStore`.
 * Idempotent per `jobId` unless `force: true` is passed.
 */
// In-flight guard: runAppJob completion and the session turn/end hook can both fire for the
// same job; without this, both read reported=false before either marks it -> duplicate report.
const inFlight = new Map();

// A reservation older than this is treated as abandoned (host crashed mid-send) and may be taken over.
export const REPORT_LOCK_STALE_MS = 10 * 60 * 1000;

function acquireReportLock(lockFile, force = false, staleMs = REPORT_LOCK_STALE_MS) {
  if (!lockFile) return true;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  let stale = false;
  try { stale = Date.now() - fs.statSync(lockFile).mtimeMs > staleMs; } catch {}
  if (force || stale) {
    try { fs.unlinkSync(lockFile); } catch {}
  }
  try {
    const fd = fs.openSync(lockFile, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
}

function releaseReportLock(lockFile) {
  if (!lockFile) return;
  try { fs.unlinkSync(lockFile); } catch {}
}

/** Push a finished job's result through the configured transport (see transport.js). */
export function reportJob(args) {
  const id = args?.entry?.jobId;
  if (!id || !JOB_ID_RE.test(id)) return reportJobViaYobiruOnce(args);
  if (inFlight.has(id) && !args?.force) {
    return inFlight.get(id).then((r) => (r?.ok ? { ...r, skipped: 'already-reported' } : r));
  }
  const p = reportJobViaYobiruOnce(args).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

async function reportJobViaYobiruOnce({
  cfg = {},
  mapStore,
  entry,
  outcome,
  execRunner = defaultExecRunner,
  logger = console,
  force = false,
}) {
  if (!entry || !JOB_ID_RE.test(entry.jobId || '')) {
    return { ok: false, skipped: 'invalid-entry' };
  }
  const initial = mapStore?.getByJob(entry.jobId) || entry;
  if (initial.reported && !force) {
    return { ok: true, skipped: 'already-reported', jobId: initial.jobId };
  }
  const lockDir = mapStore?.stateDir || cfg?.stateDir;
  const lockFile = lockDir ? path.join(lockDir, `${entry.jobId}.report.lock`) : null;
  if (!acquireReportLock(lockFile, force, cfg?.reportLockStaleMs)) {
    return { ok: true, skipped: 'already-reported', jobId: entry.jobId };
  }

  try {
    const latest = mapStore?.getByJob(entry.jobId) || entry;
    if (latest.reported && !force) {
      return { ok: true, skipped: 'already-reported', jobId: latest.jobId };
    }
    const state = outcome.state === 'completed' ? 'completed' : 'failed';
    const payload = formatReportPayload(latest, outcome);
    const { method, res } = await transportRespond(latest, payload, state, { cfg, execRunner });

    if (method !== null) {
      mapStore?.markReported(latest.jobId, {
        reportMethod: method,
        reportState: state,
      });
      logger.info?.(`job ${latest.jobId} reported via ${transportName(cfg)} (${method}) state=${state}`);
      return { ok: true, method, jobId: latest.jobId, state };
    }

    releaseReportLock(lockFile);
    const errMsg = res ? (String(res.stderr || '').trim() || res.error || `exit ${res.code}`) : 'no-route';
    mapStore?.bind({
      ...latest,
      lastReportError: errMsg,
    });
    logger.warn?.(`job ${latest.jobId} report skipped/failed: ${errMsg}`);
    return { ok: false, error: errMsg, jobId: latest.jobId };
  } catch (e) {
    releaseReportLock(lockFile);
    throw e;
  }
}

/** v0.2 name, kept for callers and tests. */
export const reportJobViaYobiru = reportJob;

/** Is there anywhere to push this entry's result? */
export const wantsReport = (e) => Boolean(e && (e.reportViaYobiru || e.yobiruId || e.callbackPeer || e.callbackUrl));
