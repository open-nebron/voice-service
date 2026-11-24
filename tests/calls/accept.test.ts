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
  verifyLiveKitToken,
  type TestKeyspaceContext,
  type MockCoreServer,
  type SignalTracker,
} from '../test-helper.js';

describe('POST /calls/:id/accept (acceptCall)', () => {
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
      LIVEKIT_API_KEY: 'test-api-key',
      LIVEKIT_API_SECRET: 'test-api-secret',
      LIVEKIT_URL: 'ws://livekit-internal:7880',
      LIVEKIT_PUBLIC_URL: 'ws://127.0.0.1:7880',
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

  async function createRingingCall() {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    const calleeToken = await createTestToken(calleeId);

    await tracker.subscribe(`ws:signal:${callerId}`);
    await tracker.subscribe(`ws:signal:${calleeId}`);

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

  // 1. Callee accepts → state='accepted', tokens returned, WS pushes to both
  it('callee accepts → state="accepted", tokens returned, WS pushes to both', async () => {
    const { call, callerId, calleeId, calleeToken } = await createRingingCall();

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    expect(acceptRes.statusCode).toBe(200);
    const body = acceptRes.json();
    expect(body.call.id).toBe(call.id);
    expect(body.call.state).toBe('accepted');
    expect(body.call.acceptedAt).toBeDefined();
    expect(body.calleeToken).toBeDefined();
    expect(body.callerToken).toBeDefined();
    expect(body.livekitUrl).toBe('ws://127.0.0.1:7880');

    // Caller gets call.accepted WS push
    const callerSignal = await tracker.waitForSignal(`ws:signal:${callerId}`, 'call.accepted');
    expect(callerSignal.type).toBe('call.accepted');
    expect(callerSignal.payload.callId).toBe(call.id);
    expect(callerSignal.payload.callerToken).toBeDefined();

    // Callee gets call.connected WS push
    const calleeSignal = await tracker.waitForSignal(`ws:signal:${calleeId}`, 'call.connected');
    expect(calleeSignal.type).toBe('call.connected');
    expect(calleeSignal.payload.callId).toBe(call.id);
    expect(calleeSignal.payload.calleeToken).toBeDefined();
  });

  // 2. Caller tries to accept own call → 403 not_callee
  it('caller tries to accept own call → 403 not_callee', async () => {
    const { call, callerToken } = await createRingingCall();

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(acceptRes.statusCode).toBe(403);
    expect(acceptRes.json().error.code).toBe('not_callee');
  });

  // 3. Accept on already-accepted call → 409 invalid_state_transition
  it('accept on already-accepted call → 409 invalid_state_transition', async () => {
    const { call, calleeToken } = await createRingingCall();

    const accept1 = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(accept1.statusCode).toBe(200);

    const accept2 = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(accept2.statusCode).toBe(409);
    expect(accept2.json().error.code).toBe('invalid_state_transition');
  });

  // 4. Accept on ended call → 409 invalid_state_transition
  it('accept on ended call → 409 invalid_state_transition', async () => {
    const { call, calleeToken } = await createRingingCall();

    // Callee rejects first
    const rejectRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/reject`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(rejectRes.statusCode).toBe(200);

    // Try accept on rejected call
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(acceptRes.statusCode).toBe(409);
    expect(acceptRes.json().error.code).toBe('invalid_state_transition');
  });

  // 5. Accept after caller blocked callee → 403 blocked
  it('accept after caller blocked callee → 403 blocked', async () => {
    const { call, callerId, calleeToken } = await createRingingCall();

    // Now caller blocks callee before accept
    mockCore.setRelationship(callerId, { blocked: true });

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(acceptRes.statusCode).toBe(403);
    expect(acceptRes.json().error.code).toBe('blocked');
  });

  // 6. Tokens decode correctly with LiveKit secret, grants include roomJoin + room
  it('tokens decode correctly with LiveKit secret, grants include roomJoin + room', async () => {
    const { call, callerId, calleeId, calleeToken } = await createRingingCall();

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(acceptRes.statusCode).toBe(200);
    const { callerToken: cToken, calleeToken: eToken } = acceptRes.json();

    const callerClaims = await verifyLiveKitToken(cToken, 'test-api-key', 'test-api-secret');
    expect(callerClaims.sub).toBe(callerId);
    expect((callerClaims.video as any).roomJoin).toBe(true);
    expect((callerClaims.video as any).room).toBe(call.roomName);

    const calleeClaims = await verifyLiveKitToken(eToken, 'test-api-key', 'test-api-secret');
    expect(calleeClaims.sub).toBe(calleeId);
    expect((calleeClaims.video as any).roomJoin).toBe(true);
    expect((calleeClaims.video as any).room).toBe(call.roomName);
  });

  // 7. Both tokens reference same roomName
  it('both tokens reference same roomName', async () => {
    const { call, calleeToken } = await createRingingCall();

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    const { callerToken: cToken, calleeToken: eToken } = acceptRes.json();

    const callerClaims = await verifyLiveKitToken(cToken, 'test-api-key', 'test-api-secret');
    const calleeClaims = await verifyLiveKitToken(eToken, 'test-api-key', 'test-api-secret');

    expect((callerClaims.video as any).room).toBe((calleeClaims.video as any).room);
    expect((callerClaims.video as any).room).toBe(call.roomName);
  });

  // 8. acceptCall returns livekitUrl === config.LIVEKIT_PUBLIC_URL and != config.LIVEKIT_URL
  it('acceptCall returns livekitUrl === config.LIVEKIT_PUBLIC_URL (and != LIVEKIT_URL when differing)', async () => {
    const { call, calleeToken } = await createRingingCall();

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    expect(acceptRes.statusCode).toBe(200);
    const body = acceptRes.json();
    expect(body.livekitUrl).toBe(app.config.LIVEKIT_PUBLIC_URL);
    expect(body.livekitUrl).not.toBe(app.config.LIVEKIT_URL);
    expect(body.livekitUrl).toBe('ws://127.0.0.1:7880');
    expect(app.config.LIVEKIT_URL).toBe('ws://livekit-internal:7880');
  });
});
