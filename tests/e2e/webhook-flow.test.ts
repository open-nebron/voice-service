import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('End-to-End Webhook Lifecycle Flow', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;
  let tracker: SignalTracker;
  let mockParticipants: any[] = [];

  const mockRoomService = {
    listRooms: async () => [],
    listParticipants: async () => mockParticipants,
    deleteRoom: async () => undefined,
  };

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();

    const testApp = await createRealTestApp(
      context,
      { CORE_URL: mockCore.url },
      { roomService: mockRoomService as any }
    );
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

  it('full lifecycle: start → accept → room_finished webhook → call ended in Scylla, WS emitted, Redis event published', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    const calleeToken = await createTestToken(calleeId);

    await tracker.subscribe(`ws:signal:${callerId}`);
    await tracker.subscribe(`ws:signal:${calleeId}`);

    // 1. Caller starts call
    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    expect(startRes.statusCode).toBe(201);
    const call = startRes.json();
    expect(call.state).toBe('ringing');

    // 2. Callee accepts call
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(acceptRes.statusCode).toBe(200);

    const callAfterAccept = await app.callsRepo.getById(call.id);
    expect(callAfterAccept?.state).toBe('accepted');

    // 3. LiveKit room finishes (e.g. timeout or both disconnected ungracefully)
    const endWaitCaller = tracker.waitForSignal(`ws:signal:${callerId}`, 'call.ended');
    const endWaitCallee = tracker.waitForSignal(`ws:signal:${calleeId}`, 'call.ended');

    const webhookPayload = JSON.stringify({
      event: 'room_finished',
      room: { name: call.roomName },
    });
    const authHeader = await createLiveKitWebhookHeader(webhookPayload);

    const webhookRes = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: {
        authorization: authHeader,
        'content-type': 'application/json',
      },
      payload: webhookPayload,
    });
    expect(webhookRes.statusCode).toBe(200);

    // 4. Verify terminal state in ScyllaDB
    const callFinal = await app.callsRepo.getById(call.id);
    expect(callFinal?.state).toBe('ended');
    expect(callFinal?.endReason).toBe('livekit_closed');
    expect(callFinal?.endedBy).toBeNull();
    expect(callFinal?.endedAt).toBeDefined();

    // 5. Verify signals received
    const [callerEndedSignal, calleeEndedSignal] = await Promise.all([
      endWaitCaller,
      endWaitCallee,
    ]);
    expect(callerEndedSignal.payload.reason).toBe('livekit_closed');
    expect(calleeEndedSignal.payload.reason).toBe('livekit_closed');

    // 6. Verify event stream
    const event = await readEventForCall(redis, call.id);
    expect(event).toBeDefined();
    expect(event.event_type).toBe('voice.call.ended');
    expect(event.payload.reason).toBe('livekit_closed');
  });

  it('full lifecycle: start → accept → participant_left (count=0) → call ended immediately', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    const calleeToken = await createTestToken(calleeId);

    // 1. Start call
    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    const call = startRes.json();

    // 2. Accept call
    await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    // 3. Last participant leaves (mock 0 participants remaining)
    mockParticipants = [];
    const webhookPayload = JSON.stringify({
      event: 'participant_left',
      room: { name: call.roomName },
      participant: { identity: callerId },
    });
    const authHeader = await createLiveKitWebhookHeader(webhookPayload);

    const webhookRes = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: {
        authorization: authHeader,
        'content-type': 'application/json',
      },
      payload: webhookPayload,
    });
    expect(webhookRes.statusCode).toBe(200);

    // 4. Verify final state
    const callFinal = await app.callsRepo.getById(call.id);
    expect(callFinal?.state).toBe('ended');
    expect(callFinal?.endReason).toBe('livekit_closed');
  });
});
