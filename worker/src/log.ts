/** One-line JSON logs. Phone numbers are masked: logs outlive the need to know them. */

type Fields = Record<string, unknown>;

function write(level: string, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};

export const maskPhone = (phone: string | null | undefined): string =>
  phone ? `…${phone.slice(-4)}` : '';

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Baileys wants a pino-like logger; a silent one keeps message traffic out of the logs. */
export const silentLogger = {
  level: 'silent',
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};
