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

describe('Relationship Checks (block & mute)', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context, {
      CORE_URL: mockCore.url,
      INTERNAL_TOKEN: 'expected-internal-token',
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

  // 1. startCall calls core-backend /relationships/check with X-Internal-Token
  it('startCall calls core-backend /relationships/check with X-Internal-Token', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCore.getLastAuthHeader()).toBe('expected-internal-token');
  });

  // 2. If CORE_URL returns 503 → startCall returns 503 service_unavailable
  it('if CORE_URL returns 503 → startCall returns 503 service_unavailable', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    mockCore.setStatusCode(503);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('service_unavailable');
  });

  // 3. Relationship status refreshed on each call
  it('relationship status is refreshed on each call', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);

    // First call: allowed
    mockCore.setRelationship(calleeId, { blocked: false });
    const res1 = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    expect(res1.statusCode).toBe(201);

    // End call
    await app.inject({
      method: 'POST',
      url: `/calls/${res1.json().id}/end`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    // Callee now blocks caller
    mockCore.setRelationship(calleeId, { blocked: true });

    // Second call: blocked
    const res2 = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    expect(res2.statusCode).toBe(403);
    expect(res2.json().error.code).toBe('blocked');
  });
});
