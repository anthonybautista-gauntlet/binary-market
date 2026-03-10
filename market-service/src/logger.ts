import pino from "pino";

const isDev = process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: "market-service" },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  isDev
    ? pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname,service",
        },
      })
    : undefined
);

export function jobLogger(jobName: string) {
  return logger.child({ job: jobName });
}
