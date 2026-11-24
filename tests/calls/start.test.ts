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
  readEventForCall,
  type TestKeyspaceContext,
  type MockCoreServer,
  type SignalTracker,
} from '../test-helper.js';

describe('POST /calls (startCall)', () => {
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
      CALL_RING_TIMEOUT_SECONDS: 45,
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

  // 1. Caller initiates → row created with state='ringing', WS push sent to callee
  it('caller initiates → row created with state="ringing", WS push sent to callee', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    await tracker.subscribe(`ws:signal:${calleeId}`);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.callerId).toBe(callerId);
    expect(body.calleeId).toBe(calleeId);
    expect(body.state).toBe('ringing');
    expect(body.roomName).toBe(body.id);

    // Verify WS signal pushed to callee
    const signal = await tracker.waitForSignal(`ws:signal:${calleeId}`, 'call.ringing');
    expect(signal.type).toBe('call.ringing');
    expect(signal.payload.callId).toBe(body.id);
    expect(signal.payload.callerId).toBe(callerId);
    expect(signal.payload.roomName).toBe(body.roomName);
  });

  // 2. Caller initiates → caller receives call.dialing WS push
  it('caller initiates → caller receives call.dialing WS push', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    await tracker.subscribe(`ws:signal:${callerId}`);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });

    expect(res.statusCode).toBe(201);
    const dialingSignal = await tracker.waitForSignal(`ws:signal:${callerId}`, 'call.dialing');
    expect(dialingSignal.type).toBe('call.dialing');
    expect(dialingSignal.payload.calleeId).toBe(calleeId);
    expect(dialingSignal.payload.callId).toBe(res.json().id);
  });

  // 3. Call self → 400 cannot_call_self
  it('call self → 400 cannot_call_self', async () => {
    const callerId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId: callerId },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cannot_call_self');
  });

  // 4. Caller is blocked by callee → 403 blocked
  it('caller is blocked by callee → 403 blocked', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    mockCore.setRelationship(calleeId, { blocked: true });

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('blocked');
  });

  // 5. Callee has muted caller → 403 muted
  it('callee has muted caller → 403 muted', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);
    mockCore.setRelationship(calleeId, { blocked: false, muted: { calls: true } });

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('muted');
  });

  // 6. Caller already in active call → 409 already_in_call
  it('caller already in active call → 409 already_in_call', async () => {
    const userX = crypto.randomUUID();
    const userY = crypto.randomUUID();
    const userZ = crypto.randomUUID();
    const tokenX = await createTestToken(userX);

    // X calls Y (active ringing)
    const call1 = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${tokenX}` },
      payload: { calleeId: userY },
    });
    expect(call1.statusCode).toBe(201);

    // X calls Z while still ringing with Y
    const call2 = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${tokenX}` },
      payload: { calleeId: userZ },
    });
    expect(call2.statusCode).toBe(409);
    expect(call2.json().error.code).toBe('already_in_call');
  });

  // 7. Invalid calleeId uuid → 400
  it('invalid calleeId uuid → 400', async () => {
    const callerId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId: 'not-a-valid-uuid' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeDefined();
  });

  // 8. Event voice.call.ringing published to nebron.events
  it('event voice.call.ringing published to nebron.events', async () => {
    const userE1 = crypto.randomUUID();
    const userE2 = crypto.randomUUID();
    const tokenE1 = await createTestToken(userE1);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${tokenE1}` },
      payload: { calleeId: userE2 },
    });
    expect(res.statusCode).toBe(201);
    const callId = res.json().id;

    // Check Redis stream event
    const event = await readEventForCall(redis, callId, 'nebron.events');
    expect(event).toBeDefined();
    expect(event.event_type).toBe('voice.call.ringing');
    expect(event.payload.callId).toBe(callId);
    expect(event.payload.callerId).toBe(userE1);
    expect(event.payload.calleeId).toBe(userE2);
  });

  // 9. MongoDB ObjectId (24-hex chars) caller and callee
  it('supports 24-hex MongoDB ObjectId user IDs', async () => {
    const callerId = '6b05523f0e785a20e6ca6522';
    const calleeId = '6b05523f0e785a20e6ca6523';
    const callerToken = await createTestToken(callerId);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.callerId).toBe(callerId);
    expect(body.calleeId).toBe(calleeId);
    expect(body.state).toBe('ringing');

    // Verify GET /calls/active works with ObjectId
    const activeRes = await app.inject({
      method: 'GET',
      url: '/calls/active',
      headers: { authorization: `Bearer ${callerToken}` },
    });
    expect(activeRes.statusCode).toBe(200);
    expect(activeRes.json().id).toBe(body.id);
    expect(activeRes.json().callerId).toBe(callerId);
    expect(activeRes.json().calleeId).toBe(calleeId);
  });
});
