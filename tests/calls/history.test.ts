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
} from '../test-helper.js';

describe('GET /calls (call history)', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();
  const newUser = crypto.randomUUID();

  let tokenA: string;
  let tokenB: string;
  let tokenNew: string;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context, {
      CORE_URL: mockCore.url,
    });
    app = testApp.app;

    tokenA = await createTestToken(userA);
    tokenB = await createTestToken(userB);
    tokenNew = await createTestToken(newUser);

    // Call 1: A calls B, rejected
    const c1 = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { calleeId: userB },
    });
    await app.inject({
      method: 'POST',
      url: `/calls/${c1.json().id}/reject`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    await new Promise((r) => setTimeout(r, 20));

    // Call 2: B calls A, accepted and ended
    const c2 = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { calleeId: userA },
    });
    await app.inject({
      method: 'POST',
      url: `/calls/${c2.json().id}/accept`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    await app.inject({
      method: 'POST',
      url: `/calls/${c2.json().id}/end`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    await new Promise((r) => setTimeout(r, 20));

    // Call 3: A calls C, cancelled
    const c3 = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { calleeId: userC },
    });
    await app.inject({
      method: 'POST',
      url: `/calls/${c3.json().id}/end`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
  });

  afterAll(async () => {
    await app.close();
    await mockCore.close();
    await context.drop();
  });

  // 1. History includes calls where user is caller or callee
  it('history includes calls where user is caller or callee', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/calls',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const calls = res.json().calls;
    expect(calls.length).toBe(3);
    const participants = calls.map((c: any) => [c.callerId, c.calleeId]);
    participants.forEach(([c, e]: [string, string]) => {
      expect(c === userA || e === userA).toBe(true);
    });
  });

  // 2. Sorted DESC by created_at
  it('sorted DESC by created_at', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/calls',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const calls = res.json().calls;
    for (let i = 0; i < calls.length - 1; i++) {
      const current = new Date(calls[i].createdAt).getTime();
      const next = new Date(calls[i + 1].createdAt).getTime();
      expect(current).toBeGreaterThanOrEqual(next);
    }
  });

  // 3. Paginated with before
  it('paginated with before', async () => {
    const resAll = await app.inject({
      method: 'GET',
      url: '/calls',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const allCalls = resAll.json().calls;
    expect(allCalls.length).toBeGreaterThan(1);

    const secondCallTime = allCalls[1].createdAt;
    const resBefore = await app.inject({
      method: 'GET',
      url: `/calls?before=${encodeURIComponent(secondCallTime)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(resBefore.statusCode).toBe(200);
    const pagedCalls = resBefore.json().calls;
    pagedCalls.forEach((c: any) => {
      expect(new Date(c.createdAt).getTime()).toBeLessThan(
        new Date(secondCallTime).getTime()
      );
    });
  });

  // 4. Empty for new user
  it('empty for new user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/calls',
      headers: { authorization: `Bearer ${tokenNew}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().calls).toEqual([]);
  });
});
