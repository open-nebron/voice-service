import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  startMockCoreServer,
  type TestKeyspaceContext,
  type MockCoreServer,
} from '../test-helper.js';

describe('GET /calls/:id/debug (Internal Debug Endpoint)', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
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
      {
        INTERNAL_TOKEN: 'correct-internal-token',
        CORE_URL: mockCore.url,
      },
      { roomService: mockRoomService as any }
    );
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
    await mockCore.close();
    await context.drop();
  });

  it('rejects without X-Internal-Token header → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/calls/${crypto.randomUUID()}/debug`,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('rejects with wrong X-Internal-Token header → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/calls/${crypto.randomUUID()}/debug`,
      headers: {
        'x-internal-token': 'wrong-token',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('returns 404 for unknown call', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/calls/${crypto.randomUUID()}/debug`,
      headers: {
        'x-internal-token': 'correct-internal-token',
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('call_not_found');
  });

  it('returns call + livekit state with divergence="none" for healthy call', async () => {
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

    mockParticipants = [
      { identity: callerId, sid: 'p1' },
      { identity: calleeId, sid: 'p2' },
    ];

    const res = await app.inject({
      method: 'GET',
      url: `/calls/${call.id}/debug`,
      headers: {
        'x-internal-token': 'correct-internal-token',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.call.id).toBe(call.id);
    expect(body.call.state).toBe('accepted');
    expect(body.livekit.roomExists).toBe(true);
    expect(body.livekit.participantCount).toBe(2);
    expect(body.divergence).toBe('none');
  });

  it('detects divergence="stuck_call" when call is accepted but 0 participants in LiveKit', async () => {
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

    mockParticipants = []; // No participants in LiveKit room

    const res = await app.inject({
      method: 'GET',
      url: `/calls/${call.id}/debug`,
      headers: {
        'x-internal-token': 'correct-internal-token',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.call.state).toBe('accepted');
    expect(body.livekit.participantCount).toBe(0);
    expect(body.divergence).toBe('stuck_call');
  });
});
