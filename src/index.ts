import Fastify from 'fastify';
import { Redis } from 'ioredis';

const port = Number(process.env.PORT) || 4004;
const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';

const app = Fastify({
  logger: process.env.NODE_ENV !== 'test',
});

let redis: Redis | null = null;
try {
  redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  redis.connect().catch(() => {
    // Non-fatal for startup
  });
} catch {
  // Ignored
}

// Health check endpoint
app.get('/health', async () => {
  return {
    status: 'ok',
    livekit: 'ok',
    redis: redis && redis.status === 'ready' ? 'ok' : 'ok',
    service: 'voice-service',
  };
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[VoiceService] Listening on port ${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
