import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  startMockCoreServer,
  type TestKeyspaceContext,
  type MockCoreServer,
} from './test-helper.js';

describe('Voice Rate Limiting', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;

  const rateLimitUser = crypto.randomUUID();
  let token: string;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(
      context,
      { CORE_URL: mockCore.url },
      { disableRateLimit: false }
    );
    app = testApp.app;
    token = await createTestToken(rateLimitUser);
  });

  afterAll(async () => {
    await app.close();
    await mockCore.close();
    await context.drop();
  });

  it('11th POST /calls within a minute → 429 rate_limit_exceeded', async () => {
    // POST /calls limit is 10/min
    for (let i = 1; i <= 10; i++) {
      const callee = crypto.randomUUID();
      const res = await app.inject({
        method: 'POST',
        url: '/calls',
        headers: { authorization: `Bearer ${token}` },
        payload: { calleeId: callee },
      });
      // The first call succeeds (201). Subsequent calls might be 409 already_in_call,
      // but they still count towards the rate limit and are not 429 yet!
      expect([201, 409]).toContain(res.statusCode);
    }

    // 11th request should be rate limited
    const res11 = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${token}` },
      payload: { calleeId: crypto.randomUUID() },
    });

    expect(res11.statusCode).toBe(429);
    expect(res11.json().error.code).toBe('rate_limit_exceeded');
  });
});
