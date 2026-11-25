import type { FastifyPluginAsync } from 'fastify';

export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    const token =
      (request.headers['x-internal-token'] as string) ||
      (request.headers.authorization?.replace(/^Bearer\s+/i, '') as string);

    if (!token || token !== fastify.config.INTERNAL_TOKEN) {
      return reply.status(403).send({ error: { code: 'forbidden', message: 'Forbidden' } });
    }
  });

  fastify.get('/internal/stats', async (_request, reply) => {
    const today = new Date().toISOString().slice(0, 10);
    const key = `stats:calls:${today}`;
    const countStr = await fastify.redis.get(key);
    const todayCount = countStr ? parseInt(countStr, 10) : 0;

    return reply.status(200).send({
      calls: {
        today: todayCount,
      },
      today: todayCount,
    });
  });
};
