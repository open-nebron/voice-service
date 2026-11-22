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

describe('GET /calls/:id (getById)', () => {
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

  async function createRingingCall() {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    const calleeToken = await createTestToken(calleeId);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    expect(res.statusCode).toBe(201);
    return {
      call: res.json(),
      callerId,
      calleeId,
      callerToken,
      calleeToken,
    };
  }

  // 1. Caller sees call
  it('caller sees call', async () => {
    const { call, callerId, calleeId, callerToken } = await createRingingCall();

    const res = await app.inject({
      method: 'GET',
      url: `/calls/${call.id}`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(call.id);
    expect(body.callerId).toBe(callerId);
    expect(body.calleeId).toBe(calleeId);
    expect(body.state).toBe('ringing');
  });

  // 2. Callee sees call
  it('callee sees call', async () => {
    const { call, calleeToken } = await createRingingCall();

    const res = await app.inject({
      method: 'GET',
      url: `/calls/${call.id}`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(call.id);
  });

  // 3. Non-participant → 403
  it('non-participant → 403', async () => {
    const { call } = await createRingingCall();
    const outsiderToken = await createTestToken(crypto.randomUUID());

    const res = await app.inject({
      method: 'GET',
      url: `/calls/${call.id}`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_participant');
  });

  // 4. After end, GET returns final state
  it('after end, GET returns final state', async () => {
    const { call, callerId, callerToken, calleeToken } = await createRingingCall();

    // Accept and end
    await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/end`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/calls/${call.id}`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('ended');
    expect(body.endedBy).toBe(callerId);
    expect(body.endReason).toBe('hangup');
    expect(body.endedAt).toBeDefined();
  });
});
