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

describe('POST /calls/:id/reject (rejectCall)', () => {
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

  // 1. Callee rejects → state='rejected', WS push to caller
  it('callee rejects → state="rejected", WS push to caller', async () => {
    const { call, callerId, calleeId, calleeToken } = await createRingingCall();

    const rejectRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/reject`,
      headers: { authorization: `Bearer ${calleeToken}` },
      payload: {},
    });

    expect(rejectRes.statusCode).toBe(200);
    const body = rejectRes.json();
    expect(body.state).toBe('rejected');
    expect(body.endedBy).toBe(calleeId);
    expect(body.endReason).toBe('reject');

    // Caller gets call.rejected signal
    const signal = await tracker.waitForSignal(`ws:signal:${callerId}`, 'call.rejected');
    expect(signal.type).toBe('call.rejected');
    expect(signal.payload.callId).toBe(call.id);
    expect(signal.payload.reason).toBe('reject');
  });

  // 2. Caller rejects own call → 403 not_callee
  it('caller rejects own call → 403 not_callee', async () => {
    const { call, callerToken } = await createRingingCall();

    const rejectRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/reject`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(rejectRes.statusCode).toBe(403);
    expect(rejectRes.json().error.code).toBe('not_callee');
  });

  // 3. Reject on ended → 409 invalid_state_transition
  it('reject on ended → 409 invalid_state_transition', async () => {
    const { call, calleeToken } = await createRingingCall();

    const reject1 = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/reject`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(reject1.statusCode).toBe(200);

    const reject2 = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/reject`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });
    expect(reject2.statusCode).toBe(409);
    expect(reject2.json().error.code).toBe('invalid_state_transition');
  });

  // 4. Reject includes custom reason
  it('reject includes custom reason', async () => {
    const { call, callerId, calleeToken } = await createRingingCall();

    const rejectRes = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/reject`,
      headers: { authorization: `Bearer ${calleeToken}` },
      payload: { reason: 'busy' },
    });

    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().endReason).toBe('busy');

    const signal = await tracker.waitForSignal(`ws:signal:${callerId}`, 'call.rejected');
    expect(signal.payload.reason).toBe('busy');
  });

  // 5. Event voice.call.rejected published to nebron.events
  it('event voice.call.rejected published to nebron.events', async () => {
    const { call, calleeToken } = await createRingingCall();

    await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/reject`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    const event = await readEventForCall(redis, call.id, 'nebron.events');
    expect(event).toBeDefined();
    expect(event.event_type).toBe('voice.call.rejected');
    expect(event.payload.callId).toBe(call.id);
  });
});
