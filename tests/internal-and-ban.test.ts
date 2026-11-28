import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Voice Service Internal Stats & Ban Enforcement', () => {
  let keyspaceContext: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  const bannedUser = crypto.randomUUID();

  beforeAll(async () => {
    keyspaceContext = await setupTestKeyspace();
    const testApp = await createRealTestApp(keyspaceContext);
    app = testApp.app;
    redis = testApp.redis;
  });

  afterAll(async () => {
    await redis.del(`user:banned:${bannedUser}`);
    await app.close();
    await keyspaceContext.drop();
  });

  it('GET /internal/stats requires valid internal token', async () => {
    // 1. Without token → 403
    const resNoToken = await app.inject({
      method: 'GET',
      url: '/internal/stats',
    });
    expect(resNoToken.statusCode).toBe(403);

    // 2. With wrong token → 403
    const resWrong = await app.inject({
      method: 'GET',
      url: '/internal/stats',
      headers: { 'x-internal-token': 'wrong-token' },
    });
    expect(resWrong.statusCode).toBe(403);

    // Increment today's call counter in Redis
    const today = new Date().toISOString().slice(0, 10);
    await redis.incr(`stats:calls:${today}`);

    // 3. With valid token → 200
    const resOk = await app.inject({
      method: 'GET',
      url: '/internal/stats',
      headers: { 'x-internal-token': 'test-internal-token' },
    });
    expect(resOk.statusCode).toBe(200);
    const body = JSON.parse(resOk.body);
    expect(body.calls.today).toBeGreaterThanOrEqual(1);
  });

  it('Banned user gets 403 account_banned on authenticated requests', async () => {
    // Mark user as banned in Redis
    await redis.set(
      `user:banned:${bannedUser}`,
      JSON.stringify({ banned: true, reason: 'Abusive language' }),
      'EX',
      3600
    );

    const token = await createTestToken(bannedUser);
    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        calleeId: crypto.randomUUID(),
        mode: 'audio',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('account_banned');
    expect(body.error.reason).toBe('Abusive language');
  });

  it('GET /internal/analytics/calls aggregates call counts, duration, and mode without PII', async () => {
    const c1 = crypto.randomUUID();
    const c2 = crypto.randomUUID();
    const now = new Date();
    const acceptedAt = new Date(now.getTime() - 120_000);
    const endedAt = new Date(now.getTime());

    await app.callsRepo.insert({
      id: c1,
      callerId: crypto.randomUUID(),
      calleeId: crypto.randomUUID(),
      roomName: c1,
      createdAt: acceptedAt,
      state: 'accepted',
      mode: 'video',
    });
    await app.callsRepo.updateState(c1, { state: 'ended', acceptedAt, endedAt, endReason: 'hangup' });

    await app.callsRepo.insert({
      id: c2,
      callerId: crypto.randomUUID(),
      calleeId: crypto.randomUUID(),
      roomName: c2,
      createdAt: now,
      state: 'ringing',
      mode: 'audio',
    });

    const forbidden = await app.inject({
      method: 'GET',
      url: '/internal/analytics/calls',
    });
    expect(forbidden.statusCode).toBe(403);

    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/internal/analytics/calls?since=${encodeURIComponent(since)}`,
      headers: { 'x-internal-token': 'test-internal-token' },
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json();
    expect(stats.totalCalls).toBeGreaterThanOrEqual(2);
    expect(stats.byType.video).toBeGreaterThanOrEqual(1);
    expect(stats.byType.audio).toBeGreaterThanOrEqual(1);
    expect(stats.avgDurationSeconds).toBeGreaterThan(0);
    expect(stats.totalMinutes).toBeGreaterThan(0);
    expect(Array.isArray(stats.durationHistogram)).toBe(true);
    expect(stats.durationHistogram.some((b: any) => b.bucket === '1-5m' && b.count >= 1)).toBe(true);
  });
});
