import pino from "pino";
import { config } from "./config";

declare global {
  var __ca_logger: pino.Logger | undefined;
}

function make(): pino.Logger {
  const cfg = config();
  return pino({
    level: process.env.LOG_LEVEL ?? (cfg.isProd ? "info" : "debug"),
    base: { app: "commit-archaeology" },
    ...(cfg.isProd
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,app" },
          },
        }),
  });
}

export function logger(): pino.Logger {
  if (!globalThis.__ca_logger) globalThis.__ca_logger = make();
  return globalThis.__ca_logger;
}

/** Request-scoped child logger; request ids come from middleware. */
export function reqLogger(requestId: string, extra: Record<string, unknown> = {}) {
  return logger().child({ requestId, ...extra });
}
