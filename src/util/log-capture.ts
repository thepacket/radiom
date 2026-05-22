/** Captures console.log/info/warn/error/debug into an in-memory ring buffer
 *  so the in-app "Show console logs" panel can display them on devices
 *  where DevTools isn't accessible (phones, installed PWA). */

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
export interface LogEntry {
  ts: number;        // unix ms
  level: LogLevel;
  msg: string;
}

const BUFFER_LIMIT = 500;
const buffer: LogEntry[] = [];
let installed = false;

function fmtArg(a: unknown): string {
  if (a == null) return String(a);
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  const orig: Record<LogLevel, (...args: unknown[]) => void> = {
    log:   console.log.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  (['log', 'info', 'warn', 'error', 'debug'] as LogLevel[]).forEach((lvl) => {
    console[lvl] = (...args: unknown[]) => {
      const msg = args.map(fmtArg).join(' ');
      buffer.push({ ts: Date.now(), level: lvl, msg });
      if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
      orig[lvl](...args);
    };
  });
  // Also capture uncaught errors and unhandled rejections.
  window.addEventListener('error', (e) => {
    buffer.push({ ts: Date.now(), level: 'error', msg: `uncaught: ${e.message} @ ${e.filename}:${e.lineno}` });
    if (buffer.length > BUFFER_LIMIT) buffer.shift();
  });
  window.addEventListener('unhandledrejection', (e) => {
    buffer.push({ ts: Date.now(), level: 'error', msg: `unhandled rejection: ${fmtArg(e.reason)}` });
    if (buffer.length > BUFFER_LIMIT) buffer.shift();
  });
}

export function getLogs(): LogEntry[] {
  return buffer.slice();
}

export function clearLogs(): void {
  buffer.length = 0;
}
