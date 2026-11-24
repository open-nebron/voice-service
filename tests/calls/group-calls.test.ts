import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  startMockCoreServer,
  startMockChatServer,
  createSignalTracker,
  readEventForCall,
  type TestKeyspaceContext,
  type MockCoreServer,
  type MockChatServer,
  type SignalTracker,
} from '../test-helper.js';

describe('Group calls (voice-service)', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let mockChat: MockChatServer;
  let app: FastifyInstance;
  let redis: Redis;
  let tracker: SignalTracker;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    mockChat = await startMockChatServer();
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(
      context,
      {
        CORE_URL: mockCore.url,
        CHAT_URL: mockChat.url,
        MAX_GROUP_CALL_PARTICIPANTS: 3,
      },
      {
        disableRateLimit: true,
      }
    );
    app = testApp.app;
    redis = testApp.redis;
    tracker = await createSignalTracker();
  });

  afterAll(async () => {
    await tracker.close();
    await app.close();
    await mockCore.close();
    await mockChat.close();
    await context.drop();
  });

  beforeEach(() => {
    mockCore.reset();
    mockChat.reset();
    tracker.clear();
  });

  it('starts group call successfully with host token and LiveKit room', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);

    mockChat.setMember(convId, hostId, true, 'group', 'owner');

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { mode: 'video' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.call.id).toBeDefined();
    expect(body.call.conversationId).toBe(convId);
    expect(body.call.hostId).toBe(hostId);
    expect(body.call.state).toBe('accepted');
    expect(body.call.mode).toBe('video');
    expect(body.token).toBeDefined();
    expect(body.roomName).toBe(body.call.id);
  });

  it('rings first invitee when starting group call', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const inviteeId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);

    mockChat.setMember(convId, hostId, true, 'group', 'owner');
    mockChat.setMember(convId, inviteeId, true, 'group', 'member');

    await tracker.subscribe(`ws:signal:${inviteeId}`);

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { firstInviteeId: inviteeId, mode: 'audio' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.call.state).toBe('ringing');

    const signal = await tracker.waitForSignal(
      `ws:signal:${inviteeId}`,
      'call.ringing'
    );
    expect(signal.payload.callerId).toBe(hostId);
    expect(signal.payload.conversationId).toBe(convId);
    expect(signal.payload.isGroup).toBe(true);

    const event = await readEventForCall(redis, body.call.id);
    expect(event).toBeDefined();
    expect(event.event_type).toBe('voice.call.group_started');
    expect(event.payload.hostId).toBe(hostId);
    expect(event.payload.conversationId).toBe(convId);
  });

  it('rejects start group call if host is not a member', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);

    mockChat.setMember(convId, hostId, false, 'group');

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_member');
  });

  it('rejects start group call if conversation is direct rather than group', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);

    mockChat.setMember(convId, hostId, true, 'direct');

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_conversation_type');
  });

  it('rejects start group call if first invitee is not a member', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const inviteeId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);

    mockChat.setMember(convId, hostId, true, 'group');
    mockChat.setMember(convId, inviteeId, false, 'group');

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { firstInviteeId: inviteeId },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invitee_not_member');
  });

  it('rejects start group call if active call already in progress', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);

    mockChat.setMember(convId, hostId, true, 'group');

    const first = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {},
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('call_already_active');
  });

  it('member can join group call, transitions ringing to accepted, publishes event and ws broadcast', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);
    const memberToken = await createTestToken(memberId);

    mockChat.setMember(convId, hostId, true, 'group');
    mockChat.setMember(convId, memberId, true, 'group');

    // Start with ringing first invitee
    const startRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { firstInviteeId: memberId },
    });
    expect(startRes.statusCode).toBe(201);
    const callId = startRes.json().call.id;

    await tracker.subscribe(`ws:conv:${convId}`);

    const joinRes = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/join`,
      headers: { authorization: `Bearer ${memberToken}` },
    });

    expect(joinRes.statusCode).toBe(200);
    expect(joinRes.json().token).toBeDefined();

    const wsMsg = await tracker.waitForSignal(
      `ws:conv:${convId}`,
      'call.participant_joined'
    );
    expect(wsMsg.payload.callId).toBe(callId);
    expect(wsMsg.payload.participantCount).toBe(2);

    const joinedEvent = await readEventForCall(redis, callId);
    expect(joinedEvent).toBeDefined();
    expect(joinedEvent.event_type).toBe('voice.call.participant_joined');
    expect(joinedEvent.payload.userId).toBe(memberId);
  });

  it('rejects join group call if user is not a conversation member', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const nonMemberId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);
    const nonMemberToken = await createTestToken(nonMemberId);

    mockChat.setMember(convId, hostId, true, 'group');
    mockChat.setMember(convId, nonMemberId, false, 'group');

    const startRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {},
    });
    const callId = startRes.json().call.id;

    const joinRes = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/join`,
      headers: { authorization: `Bearer ${nonMemberToken}` },
    });

    expect(joinRes.statusCode).toBe(403);
    expect(joinRes.json().error.code).toBe('not_member');
  });

  it('enforces max participants limit (429 call_full)', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const u3 = crypto.randomUUID();

    const hostToken = await createTestToken(hostId);
    const t1 = await createTestToken(u1);
    const t2 = await createTestToken(u2);
    const t3 = await createTestToken(u3);

    mockChat.setMember(convId, hostId, true, 'group');
    mockChat.setMember(convId, u1, true, 'group');
    mockChat.setMember(convId, u2, true, 'group');
    mockChat.setMember(convId, u3, true, 'group');

    // Host joins (count = 1)
    const startRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {},
    });
    const callId = startRes.json().call.id;

    // u1 joins (count = 2)
    const j1 = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/join`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(j1.statusCode).toBe(200);

    // u2 joins (count = 3, MAX is 3)
    const j2 = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/join`,
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(j2.statusCode).toBe(200);

    // u3 tries to join (count 3 >= MAX 3 -> 429 call_full)
    const j3 = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/join`,
      headers: { authorization: `Bearer ${t3}` },
    });
    expect(j3.statusCode).toBe(429);
    expect(j3.json().error.code).toBe('call_full');
  });

  it('participant can leave call, and auto-ends when last participant leaves', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);
    const memberToken = await createTestToken(memberId);

    mockChat.setMember(convId, hostId, true, 'group');
    mockChat.setMember(convId, memberId, true, 'group');

    const startRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {},
    });
    const callId = startRes.json().call.id;

    await app.inject({
      method: 'POST',
      url: `/calls/${callId}/join`,
      headers: { authorization: `Bearer ${memberToken}` },
    });

    await tracker.subscribe(`ws:conv:${convId}`);

    // member leaves
    const leaveRes1 = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/leave`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(leaveRes1.statusCode).toBe(200);
    expect(leaveRes1.json().remainingCount).toBe(1);

    const leaveWs = await tracker.waitForSignal(
      `ws:conv:${convId}`,
      'call.participant_left'
    );
    expect(leaveWs.payload.participantCount).toBe(1);

    // host leaves (last participant)
    const leaveRes2 = await app.inject({
      method: 'POST',
      url: `/calls/${callId}/leave`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(leaveRes2.statusCode).toBe(200);
    expect(leaveRes2.json().remainingCount).toBe(0);

    const endedWs = await tracker.waitForSignal(
      `ws:conv:${convId}`,
      'call.ended'
    );
    expect(endedWs).toBeDefined();

    const endedEvent = await readEventForCall(redis, callId);
    expect(endedEvent).toBeDefined();
    expect(endedEvent.event_type).toBe('voice.call.ended');
    expect(endedEvent.payload.reason).toBe('all_left');
  });

  it('host can force-end group call (DELETE /calls/:id), non-host rejected', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);
    const memberToken = await createTestToken(memberId);

    mockChat.setMember(convId, hostId, true, 'group');
    mockChat.setMember(convId, memberId, true, 'group');

    const startRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {},
    });
    const callId = startRes.json().call.id;

    await app.inject({
      method: 'POST',
      url: `/calls/${callId}/join`,
      headers: { authorization: `Bearer ${memberToken}` },
    });

    // Member tries to delete -> 403
    const forbiddenEnd = await app.inject({
      method: 'DELETE',
      url: `/calls/${callId}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(forbiddenEnd.statusCode).toBe(403);
    expect(forbiddenEnd.json().error.code).toBe('not_host');

    await tracker.subscribe(`ws:signal:${memberId}`);
    await tracker.subscribe(`ws:conv:${convId}`);

    // Host force-ends
    const hostEnd = await app.inject({
      method: 'DELETE',
      url: `/calls/${callId}`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(hostEnd.statusCode).toBe(200);
    expect(hostEnd.json().state).toBe('ended');
    expect(hostEnd.json().endReason).toBe('host_ended');

    const kickSignal = await tracker.waitForSignal(
      `ws:signal:${memberId}`,
      'call.ended'
    );
    expect(kickSignal).toBeDefined();

    const convEnd = await tracker.waitForSignal(
      `ws:conv:${convId}`,
      'call.ended'
    );
    expect(convEnd).toBeDefined();

    const endedEvent = await readEventForCall(redis, callId);
    expect(endedEvent).toBeDefined();
    expect(endedEvent.event_type).toBe('voice.call.ended');
    expect(endedEvent.payload.reason).toBe('host_ended');
  });

  it('GET /calls?conversationId=...&state=active returns active group call or 204', async () => {
    const convId = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const hostToken = await createTestToken(hostId);

    mockChat.setMember(convId, hostId, true, 'group');

    // 1. Before starting call -> 204
    const beforeRes = await app.inject({
      method: 'GET',
      url: `/calls?conversationId=${convId}&state=active`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(beforeRes.statusCode).toBe(204);

    // 2. Start call
    const startRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/calls`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {},
    });
    const callId = startRes.json().call.id;

    // 3. Query active -> 200 with call
    const activeRes = await app.inject({
      method: 'GET',
      url: `/calls?conversationId=${convId}&state=active`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(activeRes.statusCode).toBe(200);
    expect(activeRes.json().id).toBe(callId);
  });
});
