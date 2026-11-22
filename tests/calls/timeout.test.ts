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

describe('CallTimeoutJob', () => {
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
      CALL_RING_TIMEOUT_SECONDS: 1, // 1 second timeout for test speed
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

  // 1. Ringing call older than timeout → transitions to 'missed'
  it('ringing call older than timeout → transitions to "missed"', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);

    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    expect(startRes.statusCode).toBe(201);
    const callId = startRes.json().id;

    // Wait 1.1s for call to exceed 1s timeout
    await new Promise((r) => setTimeout(r, 1100));

    // Run poll
    await app.callTimeoutJob.poll();

    // Verify call state is now 'missed'
    const getRes = await app.inject({
      method: 'GET',
      url: `/calls/${callId}`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(getRes.statusCode).toBe(200);
    const call = getRes.json();
    expect(call.state).toBe('missed');
    expect(call.endReason).toBe('missed');
    expect(call.endedAt).toBeDefined();
  });

  // 2. Missed call pushes call.missed to both parties
  it('missed call pushes call.missed to both parties', async () => {
    const caller2 = crypto.randomUUID();
    const callee2 = crypto.randomUUID();
    await tracker.subscribe(`ws:signal:${caller2}`);
    await tracker.subscribe(`ws:signal:${callee2}`);

    const token2 = await createTestToken(caller2);
    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${token2}` },
      payload: { calleeId: callee2 },
    });
    const callId = startRes.json().id;

    await new Promise((r) => setTimeout(r, 1100));
    await app.callTimeoutJob.poll();

    const callerSignal = await tracker.waitForSignal(`ws:signal:${caller2}`, 'call.missed');
    expect(callerSignal.type).toBe('call.missed');
    expect(callerSignal.payload.callId).toBe(callId);

    const calleeSignal = await tracker.waitForSignal(`ws:signal:${callee2}`, 'call.missed');
    expect(calleeSignal.type).toBe('call.missed');
    expect(calleeSignal.payload.callId).toBe(callId);
  });

  // 3. Job does not touch already-accepted calls / LWT idempotency
  it('job does not touch already-accepted calls / LWT idempotency', async () => {
    const caller3 = crypto.randomUUID();
    const callee3 = crypto.randomUUID();
    const token3Caller = await createTestToken(caller3);
    const token3Callee = await createTestToken(callee3);

    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${token3Caller}` },
      payload: { calleeId: callee3 },
    });
    const callId = startRes.json().id;

    // Callee accepts immediately
    await app.inject({
      method: 'POST',
      url: `/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${token3Callee}` },
    });

    // Wait past timeout threshold
    await new Promise((r) => setTimeout(r, 1100));

    // Poll should not modify accepted call
    await app.callTimeoutJob.poll();

    const getRes = await app.inject({
      method: 'GET',
      url: `/calls/${callId}`,
      headers: { authorization: `Bearer ${token3Caller}` },
    });

    expect(getRes.json().state).toBe('accepted');
  });
});
