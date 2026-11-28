import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { RoomServiceClient, WebhookEvent } from 'livekit-server-sdk';
import type { CallsRepository } from '../../db/repositories/calls.js';
import type { EventsPublisher } from '../events/publisher.js';
import { decrementLiveActiveCalls } from '../../lib/live-call-stats.js';

export async function handleRoomStarted(
  event: WebhookEvent,
  logger: FastifyBaseLogger
): Promise<void> {
  const callId = event.room?.name;
  logger.info(
    { callId, participantCount: event.room?.numParticipants },
    'livekit room started'
  );
}

export async function handleRoomFinished(
  event: WebhookEvent,
  callsRepo: CallsRepository,
  redis: Redis,
  eventsPublisher: EventsPublisher,
  logger: FastifyBaseLogger
): Promise<void> {
  const callId = event.room?.name;
  if (!callId) {
    logger.warn('LiveKit room_finished event missing room name');
    return;
  }

  const call = await callsRepo.getById(callId);
  if (!call) {
    logger.warn({ callId }, 'LiveKit room_finished for unknown call');
    return;
  }

  if (call.state === 'ringing' || call.state === 'accepted') {
    if (call.state === 'ringing') {
      logger.warn({ callId }, 'LiveKit room_finished for ringing call anomaly');
    }

    const endedAt = new Date();
    await callsRepo.updateState(callId, {
      state: 'ended',
      endedAt,
      endedBy: null,
      endReason: 'livekit_closed',
    });
    if (call.state === 'accepted') {
      await decrementLiveActiveCalls(redis);
    }

    await redis.publish(
      `ws:signal:${call.callerId}`,
      JSON.stringify({
        type: 'call.ended',
        payload: { callId, reason: 'livekit_closed' },
      })
    );

    await redis.publish(
      `ws:signal:${call.calleeId}`,
      JSON.stringify({
        type: 'call.ended',
        payload: { callId, reason: 'livekit_closed' },
      })
    );

    await eventsPublisher.publish({
      type: 'voice.call.ended',
      payload: {
        callId,
        callerId: call.callerId,
        calleeId: call.calleeId,
        endedBy: null,
        reason: 'livekit_closed',
        at: endedAt.toISOString(),
      },
    });

    logger.info({ callId }, 'livekit room_finished auto-ended call');
  }
}

export async function handleParticipantJoined(
  event: WebhookEvent,
  logger: FastifyBaseLogger
): Promise<void> {
  const callId = event.room?.name;
  const identity = event.participant?.identity;
  logger.info({ callId, identity }, 'livekit participant joined');
}

export async function handleParticipantLeft(
  event: WebhookEvent,
  callsRepo: CallsRepository,
  redis: Redis,
  eventsPublisher: EventsPublisher,
  roomService: RoomServiceClient,
  logger: FastifyBaseLogger
): Promise<void> {
  const callId = event.room?.name;
  if (!callId) {
    logger.warn('LiveKit participant_left event missing room name');
    return;
  }

  const call = await callsRepo.getById(callId);
  if (!call) {
    logger.warn({ callId }, 'LiveKit participant_left for unknown call');
    return;
  }

  if (call.state !== 'accepted') {
    return;
  }

  let participants: any[] = [];
  try {
    participants = await roomService.listParticipants(call.roomName);
  } catch (err: any) {
    // Room might already be closed or not found -> count is 0
    participants = [];
  }

  const count = participants ? participants.length : 0;

  if (count === 0) {
    const endedAt = new Date();
    await callsRepo.updateState(callId, {
      state: 'ended',
      endedAt,
      endedBy: null,
      endReason: 'livekit_closed',
    });
    await decrementLiveActiveCalls(redis);
    if (call.state === 'accepted') {
      await decrementLiveActiveCalls(redis);
    }

    await redis.publish(
      `ws:signal:${call.callerId}`,
      JSON.stringify({
        type: 'call.ended',
        payload: { callId, reason: 'livekit_closed' },
      })
    );

    await redis.publish(
      `ws:signal:${call.calleeId}`,
      JSON.stringify({
        type: 'call.ended',
        payload: { callId, reason: 'livekit_closed' },
      })
    );

    await eventsPublisher.publish({
      type: 'voice.call.ended',
      payload: {
        callId,
        callerId: call.callerId,
        calleeId: call.calleeId,
        endedBy: null,
        reason: 'livekit_closed',
        at: endedAt.toISOString(),
      },
    });

    logger.info({ callId }, 'livekit participant_left: 0 participants remaining, ended call');
  } else if (count === 1) {
    const leftUserId = event.participant?.identity;
    const remainingUserId = leftUserId === call.callerId ? call.calleeId : call.callerId;

    await redis.publish(
      `ws:signal:${remainingUserId}`,
      JSON.stringify({
        type: 'call.peer_disconnected',
        payload: { callId, userId: leftUserId },
      })
    );

    logger.info(
      { callId, leftUserId, remainingUserId },
      'livekit participant_left: peer_disconnected signaled'
    );
  }
}
