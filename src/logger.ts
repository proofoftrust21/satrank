// SatRank V3 — minimal structured logger.
//
// JSON lines on stdout. No pino, no winston. Six lines.

const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof levels;

// LOG_LEVEL is also validated by config.ts (zod), but logger.ts is imported
// before config.ts on the cold path, so we re-validate here defensively. An
// invalid env value previously silently fell back to undefined → suppressed
// all logging.
const RAW = process.env.LOG_LEVEL;
const min: Level = RAW === 'debug' || RAW === 'info' || RAW === 'warn' || RAW === 'error' ? RAW : 'info';

function emit(level: Level, msg: string, ctx: object = {}) {
  if (levels[level] < levels[min]) return;
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx }) + '\n');
}

export const logger = {
  debug: (ctx: object | string, msg?: string) => typeof ctx === 'string' ? emit('debug', ctx) : emit('debug', msg ?? '', ctx),
  info:  (ctx: object | string, msg?: string) => typeof ctx === 'string' ? emit('info',  ctx) : emit('info',  msg ?? '', ctx),
  warn:  (ctx: object | string, msg?: string) => typeof ctx === 'string' ? emit('warn',  ctx) : emit('warn',  msg ?? '', ctx),
  error: (ctx: object | string, msg?: string) => typeof ctx === 'string' ? emit('error', ctx) : emit('error', msg ?? '', ctx),
};
