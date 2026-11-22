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
  type TestKeyspaceContext,
  type MockCoreServer,
  type SignalTracker,
} from './test-helper.js';

describe('Voice Multi-Instance Coordination', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app1: FastifyInstance;
  let app2: FastifyInstance;
  let redis1: Redis;
  let redis2: Redis;
  let tracker: SignalTracker;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();

    // App instance 1
    const testApp1 = await createRealTestApp(context, {
      CORE_URL: mockCore.url,
      PORT: 4004,
    });
    app1 = testApp1.app;
    redis1 = testApp1.redis;

    // App instance 2 (sharing Scylla keyspace and Redis)
    const testApp2 = await createRealTestApp(context, {
      CORE_URL: mockCore.url,
      PORT: 4005,
    });
    app2 = testApp2.app;
    redis2 = testApp2.redis;

    tracker = await createSignalTracker();
  });

  afterAll(async () => {
    await tracker.close();
    await app1.close();
    await app2.close();
    await mockCore.close();
    await context.drop();
  });

  it('caller on instance 1 initiates → callee receives call.ringing via Redis pub/sub and instance 2 sees state', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    await tracker.subscribe(`ws:signal:${calleeId}`);

    const callerToken = await createTestToken(callerId);
    const calleeToken = await createTestToken(calleeId);

    // 1. Caller on app1 initiates call
    const res1 = await app1.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });

    expect(res1.statusCode).toBe(201);
    const callId = res1.json().id;

    // 2. Callee receives WS signal published via Redis
    const signal = await tracker.waitForSignal(`ws:signal:${calleeId}`, 'call.ringing');
    expect(signal.type).toBe('call.ringing');
    expect(signal.payload.callId).toBe(callId);
    expect(signal.payload.callerId).toBe(callerId);

    // 3. Callee on app2 can get the call from shared Scylla database
    const res2 = await app2.inject({
      method: 'GET',
      url: `/calls/${callId}`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    expect(res2.statusCode).toBe(200);
    expect(res2.json().id).toBe(callId);
    expect(res2.json().state).toBe('ringing');

    // 4. Callee on app2 accepts the call
    const acceptRes = await app2.inject({
      method: 'POST',
      url: `/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${calleeToken}` },
    });

    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json().call.state).toBe('accepted');

    // 5. Caller on app1 sees updated accepted state
    const getAccepted = await app1.inject({
      method: 'GET',
      url: `/calls/${callId}`,
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(getAccepted.statusCode).toBe(200);
    expect(getAccepted.json().state).toBe('accepted');
  });
});
