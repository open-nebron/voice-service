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
  type TestKeyspaceContext,
  type MockCoreServer,
  type SignalTracker,
} from '../test-helper.js';

describe('POST /calls/:id/end (endCall)', () => {
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

  async function createAcceptedCall() {
    const data = await createRingingCall();
    const res = await app.inject({
      method: 'POST',
      url: `/calls/${data.call.id}/accept`,
      headers: { authorization: `Bearer ${data.calleeToken}` },
    });
    expect(res.statusCode).toBe(200);
    return data;
  }

  // 1. Caller hangs up while ringing → state='cancelled', callee gets call.cancelled WS push
  it('caller hangs up while ringing → state="cancelled", callee gets call.cancelled WS push', async () => {
    const { call, callerId, calleeId, callerToken } = await createRingingCall();

    const res = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/end`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('cancelled');
    expect(body.endedBy).toBe(callerId);
    expect(body.endReason).toBe('cancelled');

    const signal = await tracker.waitForSignal(`ws:signal:${calleeId}`, 'call.cancelled');
    expect(signal.type).toBe('call.cancelled');
    expect(signal.payload.callId).toBe(call.id);
  });

  // 2. Callee hangs up while ringing → state='rejected' with reason='hangup'
  it('callee hangs up while ringing → state="rejected" with reason="hangup"', async () => {
    const { call, callerId, calleeId, calleeToken } = await createRingingCall();

    const res = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/end`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('rejected');
    expect(body.endedBy).toBe(calleeId);
    expect(body.endReason).toBe('hangup');

    const signal = await tracker.waitForSignal(`ws:signal:${callerId}`, 'call.rejected');
    expect(signal.type).toBe('call.rejected');
    expect(signal.payload.callId).toBe(call.id);
  });

  // 3. Accepted call: caller hangs up → 'ended', callee gets call.ended
  it('accepted call: caller hangs up → "ended", callee gets call.ended', async () => {
    const { call, callerId, calleeId, callerToken } = await createAcceptedCall();

    const res = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/end`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('ended');
    expect(body.endedBy).toBe(callerId);
    expect(body.endReason).toBe('hangup');

    const signal = await tracker.waitForSignal(`ws:signal:${calleeId}`, 'call.ended');
    expect(signal.type).toBe('call.ended');
    expect(signal.payload.callId).toBe(call.id);
  });

  // 4. Accepted call: callee hangs up → 'ended', caller gets call.ended
  it('accepted call: callee hangs up → "ended", caller gets call.ended', async () => {
    const { call, callerId, calleeId, calleeToken } = await createAcceptedCall();

    const res = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/end`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('ended');
    expect(body.endedBy).toBe(calleeId);

    const signal = await tracker.waitForSignal(`ws:signal:${callerId}`, 'call.ended');
    expect(signal.type).toBe('call.ended');
    expect(signal.payload.callId).toBe(call.id);
  });

  // 5. Non-participant tries to end → 403
  it('non-participant tries to end → 403', async () => {
    const { call } = await createRingingCall();
    const outsiderToken = await createTestToken(crypto.randomUUID());

    const res = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/end`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_participant');
  });

  // 6. End on already-ended → 409
  it('end on already-ended → 409', async () => {
    const { call, callerToken } = await createAcceptedCall();

    const end1 = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/end`,
      headers: { authorization: `Bearer ${callerToken}` },
    });
    expect(end1.statusCode).toBe(200);

    const end2 = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/end`,
      headers: { authorization: `Bearer ${callerToken}` },
    });
    expect(end2.statusCode).toBe(409);
    expect(end2.json().error.code).toBe('invalid_state_transition');
  });

  // 7. Idempotency: double-end with small delay → one succeeds, one 409
  it('idempotency: double-end with small delay → one succeeds, one 409', async () => {
    const { call, callerToken, calleeToken } = await createAcceptedCall();

    const [res1, res2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/calls/${call.id}/end`,
        headers: { authorization: `Bearer ${callerToken}` },
      }),
      new Promise<any>((resolve) =>
        setTimeout(async () => {
          const res = await app.inject({
            method: 'POST',
            url: `/calls/${call.id}/end`,
            headers: { authorization: `Bearer ${calleeToken}` },
          });
          resolve(res);
        }, 50)
      ),
    ]);

    const statuses = [res1.statusCode, res2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
  });

  // 8. Custom end reason recorded
  it('custom end reason recorded', async () => {
    const { call, callerToken } = await createAcceptedCall();

    const res = await app.inject({
      method: 'POST',
      url: `/calls/${call.id}/end`,
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { reason: 'custom_hangup' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().endReason).toBe('custom_hangup');
  });
});
