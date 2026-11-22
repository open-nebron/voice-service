import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

export const loggingPlugin: FastifyPluginAsync = fp(async (fastify) => {
  fastify.addHook('onRequest', async (req) => {
    req.log.debug({ url: req.url, method: req.method }, 'Incoming request');
  });

  fastify.addHook('onResponse', async (req, reply) => {
    req.log.debug(
      {
        url: req.url,
        method: req.method,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request completed'
    );
  });
});
