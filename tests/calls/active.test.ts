import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

describe('GET /calls/active (findActiveByUser)', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context, {
      CORE_URL: mockCore.url,
    });
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
    await mockCore.close();
    await context.drop();
  });

  beforeEach(() => {
    mockCore.reset();
  });

  // 1. No active call → 204
  it('no active call → 204', async () => {
    const inactiveToken = await createTestToken(crypto.randomUUID());
    const res = await app.inject({
      method: 'GET',
      url: '/calls/active',
      headers: { authorization: `Bearer ${inactiveToken}` },
    });

    expect(res.statusCode).toBe(204);
  });

  // 2. Ringing call → 200 with call
  it('ringing call → 200 with call', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    const calleeToken = await createTestToken(calleeId);

    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    expect(startRes.statusCode).toBe(201);
    const callId = startRes.json().id;

    // Caller checks active
    const resCaller = await app.inject({
      method: 'GET',
      url: '/calls/active',
      headers: { authorization: `Bearer ${callerToken}` },
    });
    expect(resCaller.statusCode).toBe(200);
    expect(resCaller.json().id).toBe(callId);

    // Callee checks active
    const resCallee = await app.inject({
      method: 'GET',
      url: '/calls/active',
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(resCallee.statusCode).toBe(200);
    expect(resCallee.json().id).toBe(callId);
  });

  // 3. After accept then hangup → 204
  it('after accept then hangup → 204', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    const calleeToken = await createTestToken(calleeId);

    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    expect(startRes.statusCode).toBe(201);
    const callId = startRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    await app.inject({
      method: 'POST',
      url: `/calls/${callId}/end`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/calls/active',
      headers: { authorization: `Bearer ${callerToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
