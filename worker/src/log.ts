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

/**
 * An error as log fields, with its stack kept.
 *
 * `errorMessage` alone throws the stack away, which is the difference between
 * a log line that tells you where something broke and one that only tells you
 * that it did. Capped so a stray multi-kilobyte driver error cannot flood the
 * log, and spread into the caller's fields rather than nested so the shape
 * stays flat and greppable.
 */
export function describeError(error: unknown): { error: string; type?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      error: error.message.slice(0, 500),
      type: error.name,
      ...(error.stack ? { stack: error.stack.slice(0, 2000) } : {}),
    };
  }
  // Baileys rejects with Boom objects, which are not instanceof Error here.
  const shaped = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
  if (shaped && typeof shaped === 'object' && typeof shaped.message === 'string') {
    return {
      error: shaped.message.slice(0, 500),
      ...(typeof shaped.name === 'string' ? { type: shaped.name } : {}),
      ...(typeof shaped.stack === 'string' ? { stack: shaped.stack.slice(0, 2000) } : {}),
    };
  }
  return { error: String(error).slice(0, 500) };
}

/**
 * A saved name in a log line, as a shape rather than the name.
 *
 * Names come from strangers and end up in somebody's address book. The log
 * needs enough to debug "why was this saved as one character" without becoming
 * the contact list that masking phone numbers already avoids.
 */
export const maskName = (name: string | null | undefined): string => {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  return trimmed.length <= 2 ? `${[...trimmed][0] ?? '?'}…` : `${[...trimmed][0]}…${trimmed.length}`;
};

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
