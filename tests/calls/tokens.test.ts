import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  startMockCoreServer,
  verifyLiveKitToken,
  type TestKeyspaceContext,
  type MockCoreServer,
} from '../test-helper.js';

describe('POST /calls/:id/tokens (refresh token)', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context, {
      CORE_URL: mockCore.url,
      LIVEKIT_API_KEY: 'test-api-key',
      LIVEKIT_API_SECRET: 'test-api-secret',
    });
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
    await mockCore.close();
    await context.drop();
  });

  // 1. Refresh tokens on accepted call → fresh token
  it('refresh tokens on accepted call → fresh token', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    const calleeToken = await createTestToken(calleeId);

    // Start and accept call
    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    expect(startRes.statusCode).toBe(201);
    const callId = startRes.json().id;

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(acceptRes.statusCode).toBe(200);

    // Caller refreshes token
    const tokenRes = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/tokens`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(tokenRes.statusCode).toBe(200);
    const body = tokenRes.json();
    expect(body.token).toBeDefined();
    expect(body.livekitUrl).toBe('ws://127.0.0.1:7880');
    expect(body.roomName).toBe(callId);

    const claims = await verifyLiveKitToken(body.token, 'test-api-key', 'test-api-secret');
    expect(claims.sub).toBe(callerId);
    expect((claims.video as any).room).toBe(callId);
  });

  // 2. Refresh on ringing call → 409
  it('refresh on ringing call → 409', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);

    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    const callId = startRes.json().id;

    const tokenRes = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/tokens`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(tokenRes.statusCode).toBe(409);
    expect(tokenRes.json().error.code).toBe('invalid_state_transition');
  });

  // 3. Refresh as non-participant → 403
  it('refresh as non-participant → 403', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    const calleeToken = await createTestToken(calleeId);
    const outsiderToken = await createTestToken(crypto.randomUUID());

    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    const callId = startRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    const tokenRes = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/tokens`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });

    expect(tokenRes.statusCode).toBe(403);
    expect(tokenRes.json().error.code).toBe('not_participant');
  });
});
