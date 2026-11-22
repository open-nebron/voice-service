import { Redis } from 'ioredis';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Config } from '../config.js';

export interface RedisPluginOptions {
  config: Config;
  client?: Redis;
}

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

const plugin: FastifyPluginAsync<RedisPluginOptions> = async (
  fastify: FastifyInstance,
  options: RedisPluginOptions
) => {
  if (options.client) {
    fastify.decorate('redis', options.client);
    fastify.addHook('onClose', async () => {
      await options.client!.quit();
    });
    return;
  }

  const redis = new Redis(options.config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  await redis.connect();
  await redis.ping();
  fastify.log.info('redis: connected');

  fastify.decorate('redis', redis);

  fastify.addHook('onClose', async () => {
    try {
      await redis.quit();
      fastify.log.info('[Redis] Client connection closed cleanly');
    } catch (err: any) {
      fastify.log.error({ err }, '[Redis] Error while disconnecting');
    }
  });
};

export const redisPlugin = fp(plugin);
