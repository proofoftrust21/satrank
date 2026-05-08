// SatRank V3 — minimal structured logger.
//
// JSON lines on stdout. No pino, no winston. Six lines.

const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof levels;

const min: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

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
