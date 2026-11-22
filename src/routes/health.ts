import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get(
    '/health',
    {
      schema: {
        description: 'Health check endpoint reporting ScyllaDB, Redis, JWKS, and LiveKit status',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded'] },
              scylla: { type: 'string', enum: ['ok', 'down'] },
              redis: { type: 'string', enum: ['ok', 'down'] },
              jwks: { type: 'string', enum: ['ok', 'stale'] },
              livekit: { type: 'string', enum: ['ok', 'degraded'] },
              version: { type: 'string' },
            },
            required: ['status', 'scylla', 'redis', 'jwks', 'livekit'],
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded', 'down'] },
              scylla: { type: 'string', enum: ['ok', 'down'] },
              redis: { type: 'string', enum: ['ok', 'down'] },
              jwks: { type: 'string', enum: ['ok', 'stale'] },
              livekit: { type: 'string', enum: ['ok', 'degraded'] },
              version: { type: 'string' },
            },
            required: ['status', 'scylla', 'redis', 'jwks', 'livekit'],
          },
        },
      },
    },
    async (request, reply) => {
      let scyllaStatus: 'ok' | 'down' = 'ok';
      let redisStatus: 'ok' | 'down' = 'ok';
      let livekitStatus: 'ok' | 'degraded' = 'ok';

      // 1. Ping Scylla with SELECT now() FROM system.local (2s timeout)
      try {
        if (!app.scylla) {
          scyllaStatus = 'down';
        } else {
          let timeoutHandle: NodeJS.Timeout;
          const timeout = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error('ScyllaDB query timeout')),
              2000
            );
          });
          try {
            await Promise.race([
              app.scylla.execute('SELECT now() FROM system.local'),
              timeout,
            ]);
          } finally {
            clearTimeout(timeoutHandle!);
          }
        }
      } catch (err: any) {
        request.log.warn({ err: err.message }, 'Health check: ScyllaDB ping failed');
        scyllaStatus = 'down';
      }

      // 2. Ping Redis with PING
      try {
        if (!app.redis) {
          redisStatus = 'down';
        } else {
          const pong = await app.redis.ping();
          if (pong !== 'PONG') {
            redisStatus = 'down';
          }
        }
      } catch (err: any) {
        request.log.warn({ err: err.message }, 'Health check: Redis ping failed');
        redisStatus = 'down';
      }

      // 3. Ping LiveKit with fastify.livekit.ping()
      try {
        if (!app.livekit || typeof app.livekit.ping !== 'function') {
          livekitStatus = 'degraded';
        } else {
          const livekitOk = await app.livekit.ping();
          livekitStatus = livekitOk ? 'ok' : 'degraded';
        }
      } catch (err: any) {
        request.log.warn({ err: err.message }, 'Health check: LiveKit ping failed');
        livekitStatus = 'degraded';
      }

      const jwksStatus: 'ok' | 'stale' = app.jwksStatus || 'ok';

      // Return 200 if scylla+redis+jwks ok (livekit degraded does NOT fail health)
      // Return 503 if scylla or redis down
      const isCriticalHealthy = scyllaStatus === 'ok' && redisStatus === 'ok';
      const statusCode = isCriticalHealthy ? 200 : 503;
      const status: 'ok' | 'down' = isCriticalHealthy ? 'ok' : 'down';

      return reply.status(statusCode).send({
        status,
        scylla: scyllaStatus,
        redis: redisStatus,
        jwks: jwksStatus,
        livekit: livekitStatus,
        version: process.env.npm_package_version || '1.0.0',
      });
    }
  );
};
