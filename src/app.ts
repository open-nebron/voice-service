import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { type Config, loadConfig } from './config.js';
import { scyllaPlugin, type ScyllaPluginOptions } from './plugins/scylla.js';
import { redisPlugin, type RedisPluginOptions } from './plugins/redis.js';
import { jwtPlugin, type JwtPluginOptions } from './plugins/jwt.js';
import { livekitPlugin, type LiveKitPluginOptions } from './plugins/livekit.js';
import { loggingPlugin } from './plugins/logging.js';
import { docsPlugin } from './plugins/docs.js';
import { runMigrations } from './db/migrate.js';
import { CallsRepository } from './db/repositories/calls.js';
import { EventsPublisher } from './modules/events/publisher.js';
import { CallsService } from './modules/calls/service.js';
import { CallTimeoutJob } from './jobs/call-timeout.js';
import { CallReconcileJob } from './jobs/call-reconcile.js';
import { healthRoutes } from './routes/health.js';
import { callsRoutes } from './routes/calls.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { debugRoutes } from './routes/debug.js';
import { AppError } from './lib/errors.js';
import type { WebhookReceiver } from 'livekit-server-sdk';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    callsRepo: CallsRepository;
    eventsPublisher: EventsPublisher;
    callsService: CallsService;
    callTimeoutJob: CallTimeoutJob;
    callReconcileJob: CallReconcileJob;
  }
}

export interface BuildAppOptions {
  config?: Config;
  scyllaClient?: ScyllaPluginOptions['client'];
  redisClient?: RedisPluginOptions['client'];
  jwksKeySet?: JwtPluginOptions['keySet'];
  roomService?: LiveKitPluginOptions['roomService'];
  callsService?: CallsService;
  webhookReceiver?: WebhookReceiver;
  startTimeoutJob?: boolean;
  startReconcileJob?: boolean;
  disableRateLimit?: boolean;
}

export async function buildApp(
  configOrOptions?: Config | BuildAppOptions
): Promise<FastifyInstance> {
  let options: BuildAppOptions = {};

  if (configOrOptions) {
    if ('PORT' in configOrOptions && 'REDIS_URL' in configOrOptions) {
      options = { config: configOrOptions as Config };
    } else {
      options = configOrOptions as BuildAppOptions;
    }
  }

  const cfg = options.config || loadConfig();

  const isDev = cfg.NODE_ENV === 'development';
  const app = Fastify({
    logger:
      cfg.NODE_ENV === 'test'
        ? false
        : {
            level: cfg.LOG_LEVEL,
            transport:
              isDev && process.stdout.isTTY
                ? {
                    target: 'pino-pretty',
                    options: {
                      colorize: true,
                      translateTime: 'SYS:standard',
                      ignore: 'pid,hostname',
                    },
                  }
                : undefined,
          },
  });

  app.decorate('config', cfg);

  // Register OpenAPI docs
  await app.register(docsPlugin);

  // Register request/response logging
  await app.register(loggingPlugin);

  // Register core infra plugins
  await app.register(scyllaPlugin, { config: cfg, client: options.scyllaClient });
  await app.register(redisPlugin, { config: cfg, client: options.redisClient });
  await app.register(jwtPlugin, { config: cfg, keySet: options.jwksKeySet });
  await app.register(livekitPlugin, { config: cfg, roomService: options.roomService });

  // Run Scylla migrations (if scylla connected)
  if (app.scylla && typeof app.scylla.execute === 'function') {
    try {
      await runMigrations(app.scylla, cfg.SCYLLA_KEYSPACE, app.log);
    } catch (err: any) {
      if (cfg.NODE_ENV !== 'test') {
        throw err;
      }
    }
  }

  // Register repositories & services
  const callsRepo = new CallsRepository(app.scylla);
  const eventsPublisher = new EventsPublisher(app.redis, cfg.EVENTS_STREAM);
  const callsService =
    options.callsService ||
    new CallsService(callsRepo, app.redis, eventsPublisher, app.livekit, cfg);

  app.decorate('callsRepo', callsRepo);
  app.decorate('eventsPublisher', eventsPublisher);
  app.decorate('callsService', callsService);

  // Background missed calls timeout job
  const callTimeoutJob = new CallTimeoutJob(
    callsRepo,
    app.redis,
    eventsPublisher,
    cfg,
    app.log
  );
  app.decorate('callTimeoutJob', callTimeoutJob);

  const shouldStartTimeout = options.startTimeoutJob ?? (cfg.NODE_ENV !== 'test');
  if (shouldStartTimeout) {
    callTimeoutJob.start();
  }

  // Background call reconciliation job
  const callReconcileJob = new CallReconcileJob(
    callsRepo,
    app.livekit.roomService,
    app.redis,
    eventsPublisher,
    cfg,
    app.log
  );
  app.decorate('callReconcileJob', callReconcileJob);

  const shouldStartReconcile = options.startReconcileJob ?? (cfg.NODE_ENV !== 'test');
  if (shouldStartReconcile) {
    callReconcileJob.start();
  }

  app.addHook('onClose', async () => {
    callTimeoutJob.stop();
    callReconcileJob.stop();
  });

  // Register rate limiting
  if (!options.disableRateLimit) {
    const isRealRedis = typeof (app.redis as any)?.defineCommand === 'function';
    await app.register(rateLimit, {
      global: false,
      hook: 'preHandler',
      redis: isRealRedis ? app.redis : undefined,
      keyGenerator: (req) => req.user?.userId || req.ip,
    });
  }

  // Standardized error envelopes
  app.setErrorHandler((error: any, _request, reply) => {
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'rate_limit_exceeded',
          message: error.message || 'Rate limit exceeded, retry later',
        },
      });
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'invalid_payload',
          message: error.message,
        },
      });
    }

    const statusCode = error.statusCode || 500;
    return reply.status(statusCode).send({
      error: {
        code: error.code || 'internal_error',
        message: error.message || 'Internal server error',
      },
    });
  });

  // Register routes
  await app.register(healthRoutes);
  await app.register(webhooksRoutes, { receiver: options.webhookReceiver });
  await app.register(debugRoutes);
  await app.register(callsRoutes);

  return app;
}
