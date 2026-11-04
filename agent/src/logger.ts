export type LogFields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Error text only; never serializes the error object, which could carry request details. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One JSON object per line. Callers must not put secrets in `fields`. */
export function createJsonLogger(write: (line: string) => void = (l) => console.log(l)): Logger {
  const emit = (level: string, msg: string, fields?: LogFields) =>
    write(
      JSON.stringify(
        { ts: new Date().toISOString(), level, msg, ...fields },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
