import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  createSignalTracker,
  readEventForCall,
  type TestKeyspaceContext,
  type SignalTracker,
} from '../test-helper.js';
import { CallReconcileJob } from '../../src/jobs/call-reconcile.js';

describe('Call Reconciliation Job', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;
  let tracker: SignalTracker;
  let mockParticipants: any[] = [];
  let listParticipantsShouldFail = false;

  const mockRoomService = {
    listRooms: async () => [],
    listParticipants: async () => {
      if (listParticipantsShouldFail) {
        throw new Error('LiveKit connection timeout or network glitch');
      }
      return mockParticipants;
    },
    deleteRoom: async () => undefined,
  };

  beforeAll(async () => {
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(
      context,
      {
        RECONCILE_MIN_CALL_AGE_SECONDS: 10,
        RECONCILE_BATCH_SIZE: 100,
      },
      { roomService: mockRoomService as any }
    );
    app = testApp.app;
    redis = testApp.redis;
    tracker = await createSignalTracker();
  });

  afterAll(async () => {
    await tracker.close();
    await app.close();
    await context.drop();
  });

  beforeEach(() => {
    tracker.clear();
    mockParticipants = [];
    listParticipantsShouldFail = false;
  });

  async function createOldAcceptedCall(ageSeconds: number) {
    const id = crypto.randomUUID();
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const createdAt = new Date(Date.now() - ageSeconds * 1000);
    const acceptedAt = new Date(Date.now() - ageSeconds * 1000);

    const call = await app.callsRepo.insert({
      id,
      callerId,
      calleeId,
      roomName: id,
      createdAt,
      state: 'ringing',
    });

    await app.callsRepo.updateState(id, {
      state: 'accepted',
      acceptedAt,
    });

    return { id, callerId, calleeId, roomName: id };
  }

  it('auto-ends accepted call older than threshold with 0 participants', async () => {
    const { id, callerId, calleeId } = await createOldAcceptedCall(30); // 30s > 10s
    mockParticipants = []; // 0 participants

    await tracker.subscribe(`ws:signal:${callerId}`);
    await tracker.subscribe(`ws:signal:${calleeId}`);
    const callerWait = tracker.waitForSignal(`ws:signal:${callerId}`, 'call.ended');
    const calleeWait = tracker.waitForSignal(`ws:signal:${calleeId}`, 'call.ended');

    const job = new CallReconcileJob(
      app.callsRepo,
      mockRoomService as any,
      redis,
      app.eventsPublisher,
      app.config,
      app.log
    );

    const reconciled = await job.poll();
    expect(reconciled).toBe(1);

    const call = await app.callsRepo.getById(id);
    expect(call?.state).toBe('ended');
    expect(call?.endReason).toBe('livekit_closed');
    expect(call?.endedAt).toBeDefined();

    // Check WS signals
    const [callerSignal, calleeSignal] = await Promise.all([callerWait, calleeWait]);
    expect(callerSignal.payload.callId).toBe(id);
    expect(callerSignal.payload.reason).toBe('livekit_closed');
    expect(calleeSignal.payload.callId).toBe(id);
    expect(calleeSignal.payload.reason).toBe('livekit_closed');

    // Check Redis event
    const event = await readEventForCall(redis, id);
    expect(event).toBeDefined();
    expect(event.payload.reason).toBe('livekit_closed');
    expect(event.payload.endedBy).toBeNull();
  });

  it('skips accepted call with active participants (> 0)', async () => {
    const { id, callerId } = await createOldAcceptedCall(30);
    mockParticipants = [{ identity: callerId }]; // Active participant

    const job = new CallReconcileJob(
      app.callsRepo,
      mockRoomService as any,
      redis,
      app.eventsPublisher,
      app.config,
      app.log
    );

    const reconciled = await job.poll();
    expect(reconciled).toBe(0);

    const call = await app.callsRepo.getById(id);
    expect(call?.state).toBe('accepted');

    // Clean up so it does not leak into next test
    await app.callsRepo.updateState(id, { state: 'ended', endedAt: new Date() });
  });

  it('skips accepted call newer than threshold', async () => {
    const { id } = await createOldAcceptedCall(2); // 2s < 10s threshold
    mockParticipants = [];

    const job = new CallReconcileJob(
      app.callsRepo,
      mockRoomService as any,
      redis,
      app.eventsPublisher,
      app.config,
      app.log
    );

    const reconciled = await job.poll();
    expect(reconciled).toBe(0);

    const call = await app.callsRepo.getById(id);
    expect(call?.state).toBe('accepted');
  });

  it('skips non-accepted calls', async () => {
    const id = crypto.randomUUID();
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const createdAt = new Date(Date.now() - 30 * 1000);

    // Call in ringing state
    await app.callsRepo.insert({
      id,
      callerId,
      calleeId,
      roomName: id,
      createdAt,
      state: 'ringing',
    });

    mockParticipants = [];

    const job = new CallReconcileJob(
      app.callsRepo,
      mockRoomService as any,
      redis,
      app.eventsPublisher,
      app.config,
      app.log
    );

    const reconciled = await job.poll();
    expect(reconciled).toBe(0);

    const call = await app.callsRepo.getById(id);
    expect(call?.state).toBe('ringing'); // Reconcile job only touches 'accepted'
  });

  it('LWT conflict handled gracefully if call already ended', async () => {
    const { id } = await createOldAcceptedCall(30);
    mockParticipants = [];

    // Simulate concurrent hangup before LWT executes
    await app.callsRepo.updateState(id, {
      state: 'ended',
      endedAt: new Date(),
      endedBy: crypto.randomUUID(),
      endReason: 'hangup',
    });

    const job = new CallReconcileJob(
      app.callsRepo,
      mockRoomService as any,
      redis,
      app.eventsPublisher,
      app.config,
      app.log
    );

    const reconciled = await job.poll();
    expect(reconciled).toBe(0); // LWT was not applied since state was no longer 'accepted'

    const call = await app.callsRepo.getById(id);
    expect(call?.state).toBe('ended');
    expect(call?.endReason).toBe('hangup');
  });

  it('LiveKit API error skips call and retries next cycle without auto-ending', async () => {
    const { id } = await createOldAcceptedCall(30);
    listParticipantsShouldFail = true;

    const job = new CallReconcileJob(
      app.callsRepo,
      mockRoomService as any,
      redis,
      app.eventsPublisher,
      app.config,
      app.log
    );

    const reconciled = await job.poll();
    expect(reconciled).toBe(0);

    // Call should still be accepted (not ended on transient error)
    const call = await app.callsRepo.getById(id);
    expect(call?.state).toBe('accepted');
  });
});
