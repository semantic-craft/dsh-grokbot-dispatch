#!/usr/bin/env node
/**
 * DSH Stop hook script (compatible with @deepseek-ai/dsh-hooks-claude-code):
 * reads Stop payload from stdin (`{session_id, cwd, hook_event_name: "Stop"}`),
 * looks up `session_id` in `JobMapStore` (and `JobStore`), and reports the
 * completed result through the configured transport (transport.js) if not yet reported.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, JobStore } from '../core.js';
import { JobMapStore, reportJobViaYobiru } from '../job-map.js';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    process.exit(0);
  }
  const sessionId = payload.session_id || payload.sessionId;
  const stateDir = process.env.DISPATCH_STATE_DIR || DEFAULTS.stateDir || path.join(os.homedir(), '.local', 'state', 'dsh-grokbot-dispatch');
  const mapStore = new JobMapStore(stateDir);
  const entry = mapStore.resolveForSession(sessionId, [payload.prompt, payload.title, payload.last_assistant_message]);
  if (!entry || entry.reported || entry.direction === 'outbound') {
    process.exit(0);
  }
  const jobStore = new JobStore({ ...DEFAULTS, stateDir });
  const job = jobStore.get(entry.jobId);
  const resultText = payload.last_assistant_message ?? job?.result ?? 'completed';
  const state = job?.state === 'failed' ? 'failed' : 'completed';
  await reportJobViaYobiru({
    cfg: { stateDir },
    mapStore,
    entry,
    outcome: {
      state,
      sessionId,
      project: entry.project || job?.project,
      result: resultText,
      error: job?.error || null,
    },
    logger: { info() {}, warn() {} },
  });
}

main().catch(() => process.exit(0));
