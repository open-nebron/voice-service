import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  startMockCoreServer,
  type TestKeyspaceContext,
  type MockCoreServer,
} from '../test-helper.js';

describe('Graceful Degradation: startCall LiveKit Down', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();

    // Mock LiveKit roomService whose listRooms() throws or times out
    const failingRoomService = {
      listRooms: async () => {
        throw new Error('Connection refused to LiveKit server');
      },
      listParticipants: async () => [],
      deleteRoom: async () => undefined,
    };

    const testApp = await createRealTestApp(
      context,
      { CORE_URL: mockCore.url },
      { roomService: failingRoomService as any }
    );
    app = testApp.app;
    redis = testApp.redis;
  });

  afterAll(async () => {
    await app.close();
    await mockCore.close();
    await context.drop();
  });

  it('startCall returns 503 livekit_unavailable when LiveKit ping fails', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('livekit_unavailable');
  });

  it('no call record is inserted into ScyllaDB on LiveKit failure', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);

    await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });

    const active = await app.callsRepo.findActiveByUser(callerId);
    expect(active).toBeNull();
  });

  it('no ringing event is published to Redis Stream', async () => {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerToken = await createTestToken(callerId);

    const res = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: { calleeId },
    });
    expect(res.statusCode).toBe(503);

    const events = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 30);
    const hasEventForCall = (events || []).some(([_, fields]) => {
      const idx = fields.indexOf('payload');
      if (idx !== -1) {
        try {
          const parsed = JSON.parse(fields[idx + 1]);
          return parsed.callerId === callerId || parsed.calleeId === calleeId;
        } catch {
          return false;
        }
      }
      return false;
    });
    expect(hasEventForCall).toBe(false);
  });
});
