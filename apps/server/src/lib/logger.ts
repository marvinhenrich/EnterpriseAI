// Schlanker, strukturierter Logger. Bewusst ohne externe Abhängigkeit gehalten,
// damit der Start-Pfad minimal bleibt; bei Bedarf später durch pino ersetzbar.

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const base = `[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (meta && Object.keys(meta).length > 0) {
    const line = `${base} ${JSON.stringify(meta)}`;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  } else {
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(base);
  }
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
