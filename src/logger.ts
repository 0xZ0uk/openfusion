export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: number = LOG_LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  currentLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
}

export function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= currentLevel;
}

export function log(
  level: LogLevel,
  module: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${module}]`;
  const line = data
    ? `${prefix} ${message} ${JSON.stringify(data)}`
    : `${prefix} ${message}`;

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export function createModuleLogger(moduleName: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) =>
      log("debug", moduleName, msg, data),
    info: (msg: string, data?: Record<string, unknown>) =>
      log("info", moduleName, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) =>
      log("warn", moduleName, msg, data),
    error: (msg: string, data?: Record<string, unknown>) =>
      log("error", moduleName, msg, data),
  };
}
