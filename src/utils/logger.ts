import { redact } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export type LogSink = (line: string) => void;

/**
 * Structured JSON-lines logger.
 *
 * - Always writes to stderr by default. stdout is reserved for the MCP stdio protocol.
 * - Every record is deep-redacted (sensitive keys and secret-looking values are masked).
 */
export class JsonLogger implements Logger {
  readonly #level: LogLevel;
  readonly #sink: LogSink;
  readonly #bindings: LogFields;
  readonly #clock: () => Date;

  constructor(options: { level?: LogLevel; sink?: LogSink; bindings?: LogFields; clock?: () => Date } = {}) {
    this.#level = options.level ?? 'info';
    this.#sink = options.sink ?? ((line) => process.stderr.write(line + '\n'));
    this.#bindings = options.bindings ?? {};
    this.#clock = options.clock ?? (() => new Date());
  }

  debug(event: string, fields?: LogFields): void {
    this.#write('debug', event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.#write('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.#write('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.#write('error', event, fields);
  }

  child(bindings: LogFields): Logger {
    return new JsonLogger({
      level: this.#level,
      sink: this.#sink,
      bindings: { ...this.#bindings, ...bindings },
      clock: this.#clock,
    });
  }

  #write(level: Exclude<LogLevel, 'silent'>, event: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.#level]) return;
    const record = redact({
      time: this.#clock().toISOString(),
      level,
      event,
      ...this.#bindings,
      ...fields,
    });
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ level, event, note: 'unserializable log fields' });
    }
    this.#sink(line);
  }
}

/** Logger that drops everything; handy for tests and library use. */
export const silentLogger: Logger = new JsonLogger({ level: 'silent', sink: () => undefined });
