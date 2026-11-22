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
  type TestKeyspaceContext,
  type MockCoreServer,
  type SignalTracker,
} from '../test-helper.js';

describe('LiveKit Webhook: participant_left', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;
  let tracker: SignalTracker;
  let mockParticipants: any[] = [];

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();

    const mockRoomService = {
      listRooms: async () => [],
      listParticipants: async () => mockParticipants,
      deleteRoom: async () => undefined,
    };

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

  beforeEach(() => {
    mockCore.reset();
    tracker.clear();
    mockParticipants = [];
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

  it('both leave (count === 0) → ends call immediately', async () => {
    const { callId, roomName } = await createAcceptedCall();
    mockParticipants = []; // 0 remaining

    const payload = JSON.stringify({
      event: 'participant_left',
      room: { name: roomName },
      participant: { identity: 'user-1' },
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
  });

  it('one leaves (count === 1) → sends call.peer_disconnected to remaining user', async () => {
    const { callId, callerId, calleeId, roomName } = await createAcceptedCall();
    mockParticipants = [{ identity: calleeId }]; // 1 remaining (callee)

    await tracker.subscribe(`ws:signal:${calleeId}`);
    const peerWait = tracker.waitForSignal(`ws:signal:${calleeId}`, 'call.peer_disconnected');

    const payload = JSON.stringify({
      event: 'participant_left',
      room: { name: roomName },
      participant: { identity: callerId }, // caller left
    });
    const authHeader = await createLiveKitWebhookHeader(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);

    const signal = await peerWait;
    expect(signal.payload.callId).toBe(callId);
    expect(signal.payload.userId).toBe(callerId);

    // Call state remains 'accepted'
    const call = await app.callsRepo.getById(callId);
    expect(call?.state).toBe('accepted');
  });

  it('ignored if call is not in "accepted" state', async () => {
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

    mockParticipants = [];

    const payload = JSON.stringify({
      event: 'participant_left',
      room: { name: call.roomName },
      participant: { identity: callerId },
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
    expect(updated?.state).toBe('ringing'); // Unchanged
  });

  it('unknown call → returns 200 without error', async () => {
    const payload = JSON.stringify({
      event: 'participant_left',
      room: { name: 'non-existent-call-id' },
      participant: { identity: 'some-user' },
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
