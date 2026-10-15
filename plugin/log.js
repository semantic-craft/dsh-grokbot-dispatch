/**
 * Append-only event log with size rotation: <stateDir>/logs/dispatch.log,
 * rotated to dispatch.log.1..N when it passes maxBytes. Also forwards to the
 * DSH logger (which lands in the launchd stdout file).
 */
import fs from 'node:fs';
import path from 'node:path';

export function createEventLog(dir, { maxBytes = 2 * 1024 * 1024, keep = 5, forward = null } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'dispatch.log');
  const rotate = () => {
    try { if (fs.statSync(file).size < maxBytes) return; } catch { return; }
    for (let i = keep - 1; i >= 1; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {} }
    try { fs.renameSync(file, `${file}.1`); } catch {}
  };
  const write = (level, msg) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg instanceof Error ? (msg.stack || msg.message) : msg}\n`;
    try { rotate(); fs.appendFileSync(file, line, { mode: 0o600 }); } catch {}
    try { forward?.[level]?.(msg); } catch {}
  };
  return { file, info: (m) => write('info', m), warn: (m) => write('warn', m), error: (m) => write('error', m) };
}
