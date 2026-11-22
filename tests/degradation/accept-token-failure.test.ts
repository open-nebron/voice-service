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

describe('Graceful Degradation: acceptCall Token Generation Failure', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;
  let tracker: SignalTracker;
  let tokenGenerationShouldFail = false;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();

    const testApp = await createRealTestApp(context, {
      CORE_URL: mockCore.url,
    });
    app = testApp.app;
    redis = testApp.redis;
    tracker = await createSignalTracker();

    // Hook makeAccessToken to simulate token generation failure on demand
    const originalMakeAccessToken = app.livekit.makeAccessToken;
    app.livekit.makeAccessToken = (async (...args: any[]) => {
      if (tokenGenerationShouldFail) {
        throw new Error('LiveKit signing key corrupted or invalid grant configuration');
      }
      return (originalMakeAccessToken as any)(...args);
    }) as any;
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
    tokenGenerationShouldFail = false;
  });

  async function createRingingCall() {
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
    return { callId: call.id, callerId, calleeId, calleeToken };
  }

  it('acceptCall transitions call to "ended" with reason "error" on token failure', async () => {
    const { callId, calleeToken } = await createRingingCall();
    tokenGenerationShouldFail = true;

    const res = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    expect(res.statusCode).toBe(503);

    const call = await app.callsRepo.getById(callId);
    expect(call?.state).toBe('ended');
    expect(call?.endReason).toBe('error');
    expect(call?.endedBy).toBeNull();
    expect(call?.endedAt).toBeDefined();
  });

  it('returns 503 livekit_unavailable to the callee', async () => {
    const { callId, calleeToken } = await createRingingCall();
    tokenGenerationShouldFail = true;

    const res = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('livekit_unavailable');
  });

  it('emits ws:signal and voice.call.ended event with reason "error"', async () => {
    const { callId, callerId, calleeId, calleeToken } = await createRingingCall();

    await tracker.subscribe(`ws:signal:${callerId}`);
    await tracker.subscribe(`ws:signal:${calleeId}`);
    const callerWait = tracker.waitForSignal(`ws:signal:${callerId}`, 'call.ended');
    const calleeWait = tracker.waitForSignal(`ws:signal:${calleeId}`, 'call.ended');

    tokenGenerationShouldFail = true;

    await app.inject({
      method: 'POST',
      url: `/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    const [callerSignal, calleeSignal] = await Promise.all([callerWait, calleeWait]);
    expect(callerSignal.payload.callId).toBe(callId);
    expect(callerSignal.payload.reason).toBe('error');
    expect(calleeSignal.payload.callId).toBe(callId);
    expect(calleeSignal.payload.reason).toBe('error');

    const event = await readEventForCall(redis, callId);
    expect(event).toBeDefined();
    expect(event.event_type).toBe('voice.call.ended');
    expect(event.payload.reason).toBe('error');
    expect(event.payload.endedBy).toBeNull();
  });
});
