import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  startMockCoreServer,
  createSignalTracker,
  createLiveKitWebhookHeader,
  readEventForCall,
  type TestKeyspaceContext,
  type MockCoreServer,
  type SignalTracker,
} from '../test-helper.js';

describe('LiveKit Webhook: room_finished', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;
  let tracker: SignalTracker;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context, {
      CORE_URL: mockCore.url,
    });
    app = testApp.app;
    redis = testApp.redis;
    tracker = await createSignalTracker();
  });

  afterAll(async () => {
    await tracker.close();
    await app.close();
    await mockCore.close();
    await context.drop();
  });

  beforeEach(() => {
    mockCore.reset();
    tracker.clear();
  });

  async function createAcceptedCall() {
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

    return { callId: call.id, callerId, calleeId, roomName: call.roomName };
  }

  it('force-ends accepted call when room_finished arrives', async () => {
    const { callId, roomName } = await createAcceptedCall();

    const payload = JSON.stringify({
      event: 'room_finished',
      room: { name: roomName },
    });
    const authHeader = await createLiveKitWebhookHeader(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);

    const call = await app.callsRepo.getById(callId);
    expect(call?.state).toBe('ended');
    expect(call?.endReason).toBe('livekit_closed');
    expect(call?.endedAt).toBeDefined();
    expect(call?.endedBy).toBeNull();
  });

  it('emits ws:signal to both parties with reason "livekit_closed"', async () => {
    const { callId, callerId, calleeId, roomName } = await createAcceptedCall();

    await tracker.subscribe(`ws:signal:${callerId}`);
    await tracker.subscribe(`ws:signal:${calleeId}`);

    const payload = JSON.stringify({
      event: 'room_finished',
      room: { name: roomName },
    });
    const authHeader = await createLiveKitWebhookHeader(payload);

    const callerWait = tracker.waitForSignal(`ws:signal:${callerId}`, 'call.ended');
    const calleeWait = tracker.waitForSignal(`ws:signal:${calleeId}`, 'call.ended');

    await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload,
    });

    const [callerSignal, calleeSignal] = await Promise.all([callerWait, calleeWait]);
    expect(callerSignal.payload.callId).toBe(callId);
    expect(callerSignal.payload.reason).toBe('livekit_closed');
    expect(calleeSignal.payload.callId).toBe(callId);
    expect(calleeSignal.payload.reason).toBe('livekit_closed');
  });

  it('publishes voice.call.ended to nebron.events with reason "livekit_closed" and endedBy null', async () => {
    const { callId, roomName } = await createAcceptedCall();

    const payload = JSON.stringify({
      event: 'room_finished',
      room: { name: roomName },
    });
    const authHeader = await createLiveKitWebhookHeader(payload);

    await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload,
    });

    const event = await readEventForCall(redis, callId);
    expect(event).toBeDefined();
    expect(event.event_type).toBe('voice.call.ended');
    expect(event.payload.reason).toBe('livekit_closed');
    expect(event.payload.endedBy).toBeNull();
  });

  it('idempotent on already ended call', async () => {
    const { callId, callerId, roomName } = await createAcceptedCall();
    const callerToken = await createTestToken(callerId);

    // End call manually first
    await app.inject({
      method: 'POST',
      url: `/calls/${callId}/end`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    const beforeCall = await app.callsRepo.getById(callId);
    expect(beforeCall?.state).toBe('ended');
    expect(beforeCall?.endReason).toBe('hangup');

    // Deliver room_finished webhook
    const payload = JSON.stringify({
      event: 'room_finished',
      room: { name: roomName },
    });
    const authHeader = await createLiveKitWebhookHeader(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(200);

    // Reason should remain 'hangup' and not be overwritten
    const afterCall = await app.callsRepo.getById(callId);
    expect(afterCall?.state).toBe('ended');
    expect(afterCall?.endReason).toBe('hangup');
  });

  it('handles call in "ringing" state (anomaly force-end)', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);

    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    const call = startRes.json();
    expect(call.state).toBe('ringing');

    const payload = JSON.stringify({
      event: 'room_finished',
      room: { name: call.roomName },
    });
    const authHeader = await createLiveKitWebhookHeader(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(200);

    const updated = await app.callsRepo.getById(call.id);
    expect(updated?.state).toBe('ended');
    expect(updated?.endReason).toBe('livekit_closed');
  });
});
