import pino, { type Logger } from 'pino';

export function createLogger(level: string = 'info', isDevelopment: boolean = false): Logger {
  return pino({
    level,
    transport:
      isDevelopment && process.stdout.isTTY
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  });
}

export const logger: Logger = createLogger(
  process.env.LOG_LEVEL || 'info',
  process.env.NODE_ENV === 'development'
);
