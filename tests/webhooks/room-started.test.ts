import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  startMockCoreServer,
  createLiveKitWebhookHeader,
  type TestKeyspaceContext,
  type MockCoreServer,
} from '../test-helper.js';

describe('LiveKit Webhook: room_started', () => {
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

  it('valid event logs and returns 200 without changing state', async () => {
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
    const call = startRes.json();

    await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    const payload = JSON.stringify({
      event: 'room_started',
      room: { name: call.roomName, numParticipants: 2 },
    });
    const authHeader = await createLiveKitWebhookHeader(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);

    const callAfter = await app.callsRepo.getById(call.id);
    expect(callAfter?.state).toBe('accepted');
  });

  it('unknown call returns 200 without error', async () => {
    const payload = JSON.stringify({
      event: 'room_started',
      room: { name: 'unknown-room', numParticipants: 0 },
    });
    const authHeader = await createLiveKitWebhookHeader(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
  });
});
