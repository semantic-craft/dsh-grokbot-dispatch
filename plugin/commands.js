/**
 * Outbound DSH slash commands (/dispatch-grok, /dispatch-zcode, /dispatch-status)
 * and model tools (dispatch_grokbot, dispatch_zcode) for dispatching tasks from
 * DSH desktop sessions to Grok Bot / ZCode / any configured peer through transport.js
 * (direct HTTP by default, Yobiru opt-in), creating or
 * linking visible DSH sessions and recording sessionId <-> jobId mappings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { embedJobTag } from './job-map.js';
import { denyProjectsRe } from './config.js';
import { defaultExecRunner, knownTargets, send as transportSend, transportName } from './transport.js';

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Parse `/dispatch-grok <project> <task...>` or `/dispatch-zcode [Project: <project>] <task...>`.
 */
export function parseOutboundInput(rawInput, projectsRoot) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    throw new Error('Usage: /dispatch-<grok|zcode> <project> <task...>');
  }
  let project;
  let body;
  const tagMatch = /^\s*\[Project:\s*([^\]\n]+)\]\s*(.*)$/s.exec(trimmed);
  if (tagMatch) {
    project = tagMatch[1].trim();
    body = tagMatch[2].trim();
  } else {
    const spaceMatch = /^(\S+)\s+([\s\S]+)$/.exec(trimmed);
    if (!spaceMatch) {
      throw new Error('Usage: /dispatch-<grok|zcode> <project> <task...>');
    }
    project = spaceMatch[1].trim();
    body = spaceMatch[2].trim();
  }
  if (!PROJECT_RE.test(project)) {
    throw new Error(`Invalid project name "${project}": must be a plain folder name under ~/Projects`);
  }
  if (denyProjectsRe().test(project)) {
    throw new Error(`Project "${project}" is not allowed`);
  }
  if (!body) {
    throw new Error('Task description must not be empty');
  }
  if (projectsRoot) {
    const root = fs.realpathSync(projectsRoot);
    let cwd;
    try {
      cwd = fs.realpathSync(path.join(root, project));
    } catch {
      throw new Error(`No such project folder ~/Projects/${project}`);
    }
    if (path.dirname(cwd) !== root || !fs.statSync(cwd).isDirectory() || denyProjectsRe().test(cwd)) {
      throw new Error('Project folder must be a direct child of ~/Projects');
    }
  }
  const text = `[Project: ${project}] ${body}`;
  return { project, body, text };
}

/**
 * Dispatch an outbound task to Grok Bot or ZCode via Yobiru (`tailmsg.py request send`)
 * and record the outbound job in `mapStore` linked to the invoking DSH session.
 */
export async function dispatchOutbound({
  target,
  rawInput,
  sessionId = null,
  cfg = {},
  mapStore = null,
  services = null,
  execRunner = defaultExecRunner,
  logger = console,
}) {
  const via = transportName(cfg);
  if (!knownTargets(cfg).includes(target)) {
    throw new Error(via === 'yobiru' ? 'target must be one of grok-bot, zcode' : `target "${target}" is not a configured peer (config.json peers: ${knownTargets(cfg).join(', ') || 'none'})`);
  }
  const { project, body, text } = parseOutboundInput(rawInput, cfg.projectsRoot);
  const targetLabel = target === 'zcode' ? 'ZCode' : target === 'grok-bot' ? 'Grok Bot' : target;
  const res = await transportSend(target, {
    project, text, timeoutSeconds: String(cfg.defaultTimeoutSeconds || 1800), cfg, execRunner,
    jobId: via === 'direct' ? randomBytes(8).toString('hex') : undefined,
    selfName: cfg.selfName, callbackUrl: cfg.callbackUrl,
  });
  const peer = res.peer;
  if (res.code !== 0) {
    const errText = String(res.stderr || '').trim() || String(res.stdout || '').trim() || res.error || `exit ${res.code}`;
    throw new Error(`${via === 'yobiru' ? 'Yobiru' : 'HTTP'} dispatch to ${targetLabel} (${peer}) failed: ${errText}`);
  }
  const jobId = res.id;

  let activeSessionId = sessionId;
  // If no existing sessionId was supplied (or if createOutboundSession is requested)
  // and desktop Host services are present, create or rename a visible desktop session.
  if (!activeSessionId && services?.sessionController && services?.workspaceController && cfg.projectsRoot) {
    try {
      const cwd = path.join(cfg.projectsRoot, project);
      const { workspace } = await services.workspaceController.create({ path: cwd });
      const created = await services.sessionController.create({ workspaceId: workspace.workspaceId });
      activeSessionId = created.sessionId;
      const title = embedJobTag(`[DSH→${targetLabel}] ${body.slice(0, 50)}`, jobId);
      await services.sessionController.rename({ sessionId: activeSessionId, title }).catch(() => {});
    } catch (e) {
      logger.warn?.(`outbound visible session creation skipped: ${e.message}`);
    }
  }

  if (jobId && mapStore) {
    mapStore.bind({
      jobId,
      yobiruId: via === 'yobiru' ? jobId : null,
      // A supplied sessionId is the *originating* session (it may itself be an inbound job
      // session): never claim its bySession slot, or its own completion report is suppressed.
      sessionId: sessionId ? null : (activeSessionId || null),
      originSessionId: sessionId || null,
      project,
      source: 'dsh',
      target,
      peer,
      direction: 'outbound',
      state: 'dispatched',
      text,
    });
  }

  logger.info?.(`outbound job ${jobId ?? 'unknown'} dispatched to ${targetLabel} (${peer}) for [Project: ${project}] session=${activeSessionId ?? 'none'}`);
  return {
    ok: true,
    jobId,
    target,
    targetLabel,
    peer,
    project,
    sessionId: activeSessionId,
    text,
    rawOutput: String(res.stdout || '').trim(),
  };
}

/**
 * Register official DSH slash commands (`/dispatch-grok`, `/dispatch-zcode`, `/dispatch-status`)
 * onto `ctx.commands` (via `ctx.inject(['commands'], ...)` or direct `ctx.get('commands')`).
 */
export function registerDispatchCommands(ctx, { cfg, mapStore, getServices, getStore, execRunner, logger }) {
  const mountCommands = (commandsSvc) => {
    if (!commandsSvc || typeof commandsSvc.register !== 'function') return [];
    const disposers = [];

    const makeHandler = (target) => async (invocation) => {
      try {
        const sessionId = invocation?.agent?.session?.header?.id ?? invocation?.agent?.id ?? null;
        const out = await dispatchOutbound({
          target,
          rawInput: invocation?.rawInput || '',
          sessionId,
          cfg,
          mapStore,
          services: getServices?.(),
          execRunner,
          logger,
        });
        return {
          kind: 'success',
          text: `Dispatched to ${out.targetLabel} [Job: ${out.jobId ?? 'pending'}] for [Project: ${out.project}] via ${out.peer}`,
        };
      } catch (e) {
        return {
          kind: 'error',
          text: e instanceof Error ? e.message : String(e),
        };
      }
    };

    disposers.push(
      commandsSvc.register({
        definitionId: 'dsh-grokbot-dispatch/dispatch-grok',
        name: 'dispatch-grok',
        description: 'Dispatch a [Project: <name>] task to Grok Bot (configured peer)',
        input: { hint: '<project> <task...>' },
        handler: makeHandler('grok-bot'),
      }),
    );

    disposers.push(
      commandsSvc.register({
        definitionId: 'dsh-grokbot-dispatch/dispatch-zcode',
        name: 'dispatch-zcode',
        description: 'Dispatch a [Project: <name>] task to ZCode (configured peer)',
        input: { hint: '<project> <task...>' },
        handler: makeHandler('zcode'),
      }),
    );

    disposers.push(
      commandsSvc.register({
        definitionId: 'dsh-grokbot-dispatch/dispatch-status',
        name: 'dispatch-status',
        description: 'Show dsh-grokbot-dispatch status and recent sessionId <-> jobId mappings',
        input: { hint: '[job-id]' },
        handler: async (invocation) => {
          const arg = String(invocation?.rawInput || '').trim();
          const store = getStore?.();
          if (arg) {
            const mapped = mapStore?.getByJob(arg) || mapStore?.getBySession(arg);
            const job = store?.get(arg);
            if (!mapped && !job) {
              return { kind: 'error', text: `No job or session mapping found for "${arg}"` };
            }
            return {
              kind: 'success',
              text: JSON.stringify({ job: job || null, mapping: mapped || null }, null, 2),
            };
          }
          const recent = (mapStore?.list() || []).slice(-5);
          return {
            kind: 'success',
            text: `running=${store?.running?.size ?? 0} mapped_jobs=${recent.length}\n` +
              recent.map((m) => `- [Job: ${m.jobId}] session=${m.sessionId ?? 'none'} dir=${m.direction ?? 'inbound'} project=${m.project ?? '?'} reported=${Boolean(m.reported)}`).join('\n'),
          };
        },
      }),
    );

    return disposers;
  };

  // Real Cordis: `commands` is not a declared dependency of this plugin, so ctx.get('commands') /
  // ctx.commands throw "cannot get property without inject" and abort apply() (plugin never
  // activates, port 7790 never binds). Always go through ctx.inject; plain objects (tests) fall back.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['commands'], (cmdCtx) => {
        try { mountCommands(cmdCtx.commands); } catch (e) { logger?.warn?.(`slash commands not registered: ${e.message}`); }
      });
    } catch (e) { logger?.warn?.(`slash commands not registered: ${e.message}`); }
    return [];
  }
  try { return mountCommands(ctx.commands); } catch (e) { logger?.warn?.(`slash commands not registered: ${e.message}`); }
  return [];
}
