import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { TrackSource } from 'livekit-server-sdk';
import type { Config } from '../../config.js';
import type { CallsRepository, Call } from '../../db/repositories/calls.js';
import type { CallParticipantsRepository } from '../../db/repositories/call-participants.js';
import type { EventsPublisher } from '../events/publisher.js';
import type { LiveKitService } from '../../plugins/livekit.js';
import type { CallEndReason, CallState } from './state-machine.js';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from '../../lib/errors.js';
import { capture } from '../../lib/analytics.js';

export class CallsService {
  private readonly callsRepo: CallsRepository;
  private readonly callParticipantsRepo: CallParticipantsRepository;
  private readonly redis: Redis;
  private readonly eventsPublisher: EventsPublisher;
  private readonly livekit: LiveKitService;
  private readonly config: Config;

  constructor(
    callsRepo: CallsRepository,
    callParticipantsRepo: CallParticipantsRepository,
    redis: Redis,
    eventsPublisher: EventsPublisher,
    livekit: LiveKitService,
    config: Config
  ) {
    this.callsRepo = callsRepo;
    this.callParticipantsRepo = callParticipantsRepo;
    this.redis = redis;
    this.eventsPublisher = eventsPublisher;
    this.livekit = livekit;
    this.config = config;
  }

  private async checkRelationships(
    callerId: string,
    calleeId: string
  ): Promise<void> {
    const url = new URL('/relationships/check', this.config.CORE_URL);
    url.searchParams.set('userIds', calleeId);
    url.searchParams.set('fromUserId', callerId);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'x-internal-token': this.config.INTERNAL_TOKEN,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new AppError(503, 'service_unavailable', 'Relationship service unavailable');
    }

    if (!response.ok) {
      throw new AppError(503, 'service_unavailable', 'Relationship service unavailable');
    }

    const json = (await response.json()) as {
      data?: Record<string, { blocked?: boolean; muted?: { calls?: boolean } }>;
    };

    const status = json.data?.[calleeId];
    if (status) {
      if (status.blocked) {
        throw new ForbiddenError('blocked', 'User is blocked');
      }
      if (status.muted?.calls) {
        throw new ForbiddenError('muted', 'User has muted calls');
      }
    }
  }

  private async checkBlockOnly(targetUserId: string): Promise<void> {
    const url = new URL('/relationships/check', this.config.CORE_URL);
    url.searchParams.set('userIds', targetUserId);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'x-internal-token': this.config.INTERNAL_TOKEN,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new AppError(503, 'service_unavailable', 'Relationship service unavailable');
    }

    if (!response.ok) {
      throw new AppError(503, 'service_unavailable', 'Relationship service unavailable');
    }

    const json = (await response.json()) as {
      data?: Record<string, { blocked?: boolean }>;
    };

    if (json.data?.[targetUserId]?.blocked) {
      throw new ForbiddenError('blocked', 'User is blocked');
    }
  }

  async checkConversationMembership(
    conversationId: string,
    userId: string
  ): Promise<{ isMember: boolean; kind: string; role?: string }> {
    const url = new URL(`/internal/conversations/${conversationId}/members/${userId}`, this.config.CHAT_URL);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'x-internal-token': this.config.INTERNAL_TOKEN,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new AppError(503, 'service_unavailable', 'Chat service unavailable');
    }

    if (response.status === 404) {
      throw new NotFoundError('conversation_not_found', 'Conversation not found');
    }

    if (!response.ok) {
      throw new AppError(503, 'service_unavailable', 'Chat service unavailable');
    }

    const data = (await response.json()) as { isMember: boolean; kind?: string; role?: string };
    return {
      isMember: Boolean(data.isMember),
      kind: data.kind || 'group',
      role: data.role,
    };
  }

  async startCall(callerId: string, calleeId: string, mode: 'audio' | 'video' = 'audio'): Promise<Call> {
    if (callerId === calleeId) {
      throw new BadRequestError('cannot_call_self', 'Cannot call yourself');
    }

    // Ping LiveKit before creating call
    const livekitUp = await this.livekit.ping();
    if (!livekitUp) {
      throw new AppError(
        503,
        'livekit_unavailable',
        'Voice service temporarily unavailable, please try again'
      );
    }

    // 1. Check block / mute via core-backend
    await this.checkRelationships(callerId, calleeId);

    // 2. Check neither party is currently in an active call
    const [callerActive, calleeActive] = await Promise.all([
      this.callsRepo.findActiveByUser(callerId),
      this.callsRepo.findActiveByUser(calleeId),
    ]);

    if (callerActive || calleeActive) {
      throw new ConflictError('already_in_call', 'User is already in an active call');
    }

    // 3. Create call record with state='ringing'
    const id = crypto.randomUUID();
    const roomName = id;
    const createdAt = new Date();

    const call = await this.callsRepo.insert({
      id,
      callerId,
      calleeId,
      roomName,
      createdAt,
      state: 'ringing',
      mode,
    });

    try {
      const today = new Date().toISOString().slice(0, 10);
      const key = `stats:calls:${today}`;
      await this.redis.incr(key);
      await this.redis.expire(key, 86400 * 7);
    } catch {
      // Ignore
    }

    // 4. Publish voice.call.ringing to Redis Stream nebron.events
    await this.eventsPublisher.publish({
      type: 'voice.call.ringing',
      payload: {
        callId: id,
        callerId,
        calleeId,
        roomName,
        startedAt: createdAt.toISOString(),
      },
    });

    // 5. Publish to Redis ws:signal channels
    await this.redis.publish(
      `ws:signal:${calleeId}`,
      JSON.stringify({
        type: 'call.ringing',
        payload: {
          callId: id,
          callerId,
          roomName,
          startedAt: createdAt.toISOString(),
          mode,
        },
      })
    );

    await this.redis.publish(
      `ws:signal:${callerId}`,
      JSON.stringify({
        type: 'call.dialing',
        payload: {
          callId: id,
          calleeId,
          mode,
        },
      })
    );

    capture(callerId, 'call_started', { callId: id, callType: mode });

    return call;
  }

  async acceptCall(
    callId: string,
    userId: string
  ): Promise<{
    call: Call;
    callerToken: string;
    calleeToken: string;
    livekitUrl: string;
  }> {
    const call = await this.callsRepo.getById(callId);
    if (!call) {
      throw new NotFoundError('call_not_found', 'Call not found');
    }

    if (call.state !== 'ringing') {
      throw new ConflictError(
        'invalid_state_transition',
        `Cannot accept call in state '${call.state}'`
      );
    }

    if (userId !== call.calleeId) {
      throw new ForbiddenError('not_callee', 'Only the callee can accept this call');
    }

    // Re-check block in case callee blocked caller between ringing and accept
    await this.checkBlockOnly(call.callerId);

    const acceptedAt = new Date();
    await this.callsRepo.updateState(callId, {
      state: 'accepted',
      acceptedAt,
    });

    // Generate LiveKit tokens for BOTH caller and callee
    const mode = call.mode || 'audio';
    const publishSources =
      mode === 'video'
        ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE]
        : [TrackSource.MICROPHONE];

    let callerToken: string;
    let calleeToken: string;
    try {
      callerToken = await this.livekit.makeAccessToken({
        identity: call.callerId,
        room: call.roomName,
        ttl: this.config.LIVEKIT_TOKEN_TTL_SECONDS,
        grants: {
          roomJoin: true,
          canPublish: true,
          canPublishSources: publishSources,
          canSubscribe: true,
          room: call.roomName,
        },
      });

      calleeToken = await this.livekit.makeAccessToken({
        identity: call.calleeId,
        room: call.roomName,
        ttl: this.config.LIVEKIT_TOKEN_TTL_SECONDS,
        grants: {
          roomJoin: true,
          canPublish: true,
          canPublishSources: publishSources,
          canSubscribe: true,
          room: call.roomName,
        },
      });
    } catch (err: any) {
      const endedAt = new Date();
      await this.callsRepo.updateState(callId, {
        state: 'ended',
        endedAt,
        endedBy: null,
        endReason: 'error',
      });

      await this.redis.publish(
        `ws:signal:${call.callerId}`,
        JSON.stringify({
          type: 'call.ended',
          payload: { callId, reason: 'error' },
        })
      );
      await this.redis.publish(
        `ws:signal:${call.calleeId}`,
        JSON.stringify({
          type: 'call.ended',
          payload: { callId, reason: 'error' },
        })
      );

      await this.eventsPublisher.publish({
        type: 'voice.call.ended',
        payload: {
          callId,
          callerId: call.callerId,
          calleeId: call.calleeId,
          endedBy: null,
          reason: 'error',
          at: endedAt.toISOString(),
        },
      });

      throw new AppError(
        503,
        'livekit_unavailable',
        'Voice service temporarily unavailable, please try again'
      );
    }

    // Publish event voice.call.accepted to nebron.events
    await this.eventsPublisher.publish({
      type: 'voice.call.accepted',
      payload: {
        callId,
        callerId: call.callerId,
        calleeId: call.calleeId,
        acceptedAt: acceptedAt.toISOString(),
      },
    });

    // Publish to ws:signal channels
    await this.redis.publish(
      `ws:signal:${call.callerId}`,
      JSON.stringify({
        type: 'call.accepted',
        payload: {
          callId,
          callerToken,
          livekitUrl: this.config.LIVEKIT_PUBLIC_URL,
          roomName: call.roomName,
          mode,
        },
      })
    );

    await this.redis.publish(
      `ws:signal:${call.calleeId}`,
      JSON.stringify({
        type: 'call.connected',
        payload: {
          callId,
          calleeToken,
          livekitUrl: this.config.LIVEKIT_PUBLIC_URL,
          roomName: call.roomName,
          mode,
        },
      })
    );

    if (call.conversationId) {
      await this.callParticipantsRepo.add(callId, call.calleeId);
      const atIso = acceptedAt.toISOString();
      await this.eventsPublisher.publish({
        type: 'voice.call.participant_joined',
        payload: {
          callId,
          conversationId: call.conversationId,
          userId: call.calleeId,
          at: atIso,
        },
      });
      await this.redis.publish(
        `ws:conv:${call.conversationId}`,
        JSON.stringify({
          type: 'call.participant_joined',
          payload: {
            callId,
            conversationId: call.conversationId,
            userId: call.calleeId,
            at: atIso,
          },
        })
      );
    }

    const updatedCall: Call = {
      ...call,
      state: 'accepted',
      acceptedAt,
    };

    capture(userId, 'call_accepted', { callId });

    return {
      call: updatedCall,
      callerToken,
      calleeToken,
      livekitUrl: this.config.LIVEKIT_PUBLIC_URL,
    };
  }

  async rejectCall(
    callId: string,
    userId: string,
    reason = 'reject'
  ): Promise<Call> {
    const call = await this.callsRepo.getById(callId);
    if (!call) {
      throw new NotFoundError('call_not_found', 'Call not found');
    }

    if (call.state !== 'ringing') {
      throw new ConflictError(
        'invalid_state_transition',
        `Cannot reject call in state '${call.state}'`
      );
    }

    if (userId !== call.calleeId) {
      throw new ForbiddenError('not_callee', 'Only the callee can reject this call');
    }

    const endedAt = new Date();
    await this.callsRepo.updateState(callId, {
      state: 'rejected',
      endedAt,
      endedBy: userId,
      endReason: reason,
    });

    // Publish voice.call.rejected event
    await this.eventsPublisher.publish({
      type: 'voice.call.rejected',
      payload: {
        callId,
        callerId: call.callerId,
        calleeId: call.calleeId,
        rejectedBy: userId,
        reason,
        at: endedAt.toISOString(),
      },
    });

    // Publish to ws:signal:{callerId}
    await this.redis.publish(
      `ws:signal:${call.callerId}`,
      JSON.stringify({
        type: 'call.rejected',
        payload: {
          callId,
          calleeId: call.calleeId,
          reason,
        },
      })
    );

    capture(userId, 'call_rejected', { callId, reason });

    return {
      ...call,
      state: 'rejected',
      endedAt,
      endedBy: userId,
      endReason: reason,
    };
  }

  async endCall(
    callId: string,
    userId: string,
    reason: CallEndReason | string = 'hangup'
  ): Promise<Call> {
    const call = await this.callsRepo.getById(callId);
    if (!call) {
      throw new NotFoundError('call_not_found', 'Call not found');
    }

    if (call.state !== 'ringing' && call.state !== 'accepted') {
      throw new ConflictError(
        'invalid_state_transition',
        `Cannot end call in state '${call.state}'`
      );
    }

    if (userId !== call.callerId && userId !== call.calleeId) {
      throw new ForbiddenError('not_participant', 'User is not a participant in this call');
    }

    const endedAt = new Date();

    if (call.state === 'ringing') {
      if (userId === call.callerId) {
        // Caller hung up before accept -> cancelled
        await this.callsRepo.updateState(callId, {
          state: 'cancelled',
          endedAt,
          endedBy: userId,
          endReason: 'cancelled',
        });

        await this.redis.publish(
          `ws:signal:${call.calleeId}`,
          JSON.stringify({
            type: 'call.cancelled',
            payload: { callId },
          })
        );

        await this.eventsPublisher.publish({
          type: 'voice.call.cancelled',
          payload: {
            callId,
            callerId: call.callerId,
            calleeId: call.calleeId,
            cancelledBy: userId,
            at: endedAt.toISOString(),
          },
        });

        return {
          ...call,
          state: 'cancelled',
          endedAt,
          endedBy: userId,
          endReason: 'cancelled',
        };
      } else {
        // Callee hung up while ringing -> treated as reject with reason='hangup'
        await this.callsRepo.updateState(callId, {
          state: 'rejected',
          endedAt,
          endedBy: userId,
          endReason: 'hangup',
        });

        await this.redis.publish(
          `ws:signal:${call.callerId}`,
          JSON.stringify({
            type: 'call.rejected',
            payload: {
              callId,
              calleeId: call.calleeId,
              reason: 'hangup',
            },
          })
        );

        await this.eventsPublisher.publish({
          type: 'voice.call.rejected',
          payload: {
            callId,
            callerId: call.callerId,
            calleeId: call.calleeId,
            rejectedBy: userId,
            reason: 'hangup',
            at: endedAt.toISOString(),
          },
        });

        return {
          ...call,
          state: 'rejected',
          endedAt,
          endedBy: userId,
          endReason: 'hangup',
        };
      }
    }

    // Call was 'accepted' -> ended
    await this.callsRepo.updateState(callId, {
      state: 'ended',
      endedAt,
      endedBy: userId,
      endReason: reason,
    });

    const otherParty = userId === call.callerId ? call.calleeId : call.callerId;
    await this.redis.publish(
      `ws:signal:${otherParty}`,
      JSON.stringify({
        type: 'call.ended',
        payload: {
          callId,
          endedBy: userId,
          reason,
        },
      })
    );

    const eventReason = (
      ['hangup', 'reject', 'missed', 'cancelled', 'error', 'livekit_closed'].includes(reason)
        ? reason
        : 'hangup'
    ) as CallEndReason;

    await this.eventsPublisher.publish({
      type: 'voice.call.ended',
      payload: {
        callId,
        callerId: call.callerId,
        calleeId: call.calleeId,
        endedBy: userId,
        reason: eventReason,
        at: endedAt.toISOString(),
      },
    });

    const startMs = (call.acceptedAt || call.createdAt).getTime();
    const duration = Math.max(0, Math.round((endedAt.getTime() - startMs) / 1000));
    capture(userId, 'call_ended', { callId, duration, reason });

    return {
      ...call,
      state: 'ended',
      endedAt,
      endedBy: userId,
      endReason: reason,
    };
  }

  async getCall(
    callId: string,
    userId: string
  ): Promise<Call & { peer: { userId: string; role: 'caller' | 'callee'; state: string } }> {
    const call = await this.callsRepo.getById(callId);
    if (!call) {
      throw new NotFoundError('call_not_found', 'Call not found');
    }

    if (call.conversationId) {
      const isPart = await this.callParticipantsRepo.isParticipant(callId, userId);
      const membership = await this.checkConversationMembership(call.conversationId, userId);
      if (!isPart && !membership.isMember) {
        throw new ForbiddenError('not_participant', 'User is not a participant in this call');
      }
      const participants = await this.callParticipantsRepo.listActive(callId);
      return {
        ...call,
        participants,
        peer: {
          userId: call.hostId || call.callerId,
          role: 'caller',
          state: call.state,
        },
      };
    }

    if (userId !== call.callerId && userId !== call.calleeId) {
      throw new ForbiddenError('not_participant', 'User is not a participant in this call');
    }

    const peerId = userId === call.callerId ? call.calleeId : call.callerId;
    const peerRole: 'caller' | 'callee' = userId === call.callerId ? 'callee' : 'caller';

    return {
      ...call,
      peer: {
        userId: peerId,
        role: peerRole,
        state: call.state,
      },
    };
  }

  async refreshToken(
    callId: string,
    userId: string
  ): Promise<{ token: string; livekitUrl: string; roomName: string }> {
    const call = await this.callsRepo.getById(callId);
    if (!call) {
      throw new NotFoundError('call_not_found', 'Call not found');
    }

    if (call.conversationId) {
      const isPart = await this.callParticipantsRepo.isParticipant(callId, userId);
      if (!isPart) {
        throw new ForbiddenError('not_participant', 'User is not a participant in this call');
      }
    } else if (userId !== call.callerId && userId !== call.calleeId) {
      throw new ForbiddenError('not_participant', 'User is not a participant in this call');
    }

    if (call.state !== 'accepted') {
      throw new ConflictError(
        'invalid_state_transition',
        `Cannot generate token for call in state '${call.state}'`
      );
    }

    try {
      const mode = call.mode || 'audio';
      const publishSources =
        mode === 'video'
          ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE]
          : [TrackSource.MICROPHONE];

      const token = await this.livekit.makeAccessToken({
        identity: userId,
        room: call.roomName,
        ttl: this.config.LIVEKIT_TOKEN_TTL_SECONDS,
        grants: {
          roomJoin: true,
          canPublish: true,
          canPublishSources: publishSources,
          canSubscribe: true,
          room: call.roomName,
        },
      });

      return {
        token,
        livekitUrl: this.config.LIVEKIT_PUBLIC_URL,
        roomName: call.roomName,
      };
    } catch {
      throw new AppError(
        503,
        'livekit_unavailable',
        'Voice service temporarily unavailable, please try again'
      );
    }
  }

  async startGroupCall(
    hostId: string,
    conversationId: string,
    firstInviteeId?: string,
    mode: 'audio' | 'video' = 'audio'
  ): Promise<{
    call: Call;
    token: string;
    hostToken: string;
    livekitUrl: string;
    roomName: string;
  }> {
    const livekitUp = await this.livekit.ping();
    if (!livekitUp) {
      throw new AppError(
        503,
        'livekit_unavailable',
        'Voice service temporarily unavailable, please try again'
      );
    }

    const hostMembership = await this.checkConversationMembership(conversationId, hostId);
    if (!hostMembership.isMember) {
      throw new ForbiddenError('not_member', 'User is not a member of this conversation');
    }
    if (hostMembership.kind !== 'group') {
      throw new BadRequestError('invalid_conversation_type', 'Group calls can only be started in group conversations');
    }

    if (firstInviteeId) {
      if (firstInviteeId === hostId) {
        throw new BadRequestError('cannot_call_self', 'Cannot call yourself');
      }
      const inviteeMembership = await this.checkConversationMembership(conversationId, firstInviteeId);
      if (!inviteeMembership.isMember) {
        throw new BadRequestError('invitee_not_member', 'First invitee is not a member of this conversation');
      }
      await this.checkRelationships(hostId, firstInviteeId);
    }

    const existingActive = await this.callsRepo.findByConversation(conversationId, 'active');
    if (existingActive) {
      throw new ConflictError('call_already_active', 'An active call already exists in this conversation');
    }

    const hostActive = await this.callsRepo.findActiveByUser(hostId);
    if (hostActive) {
      throw new ConflictError('already_in_call', 'User is already in an active call');
    }

    const id = crypto.randomUUID();
    const roomName = id;
    const createdAt = new Date();
    const state: CallState = firstInviteeId ? 'ringing' : 'accepted';

    const call = await this.callsRepo.insert({
      id,
      callerId: hostId,
      calleeId: firstInviteeId || hostId,
      roomName,
      createdAt,
      state,
      mode,
      conversationId,
      hostId,
    });

    try {
      const today = new Date().toISOString().slice(0, 10);
      const key = `stats:calls:${today}`;
      await this.redis.incr(key);
      await this.redis.expire(key, 86400 * 7);
    } catch {
      // Ignore
    }

    if (state === 'accepted') {
      await this.callsRepo.updateState(id, {
        state: 'accepted',
        acceptedAt: createdAt,
      });
      call.state = 'accepted';
      call.acceptedAt = createdAt;
    }

    await this.callParticipantsRepo.add(id, hostId, createdAt);

    const publishSources =
      mode === 'video'
        ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE]
        : [TrackSource.MICROPHONE];

    const hostToken = await this.livekit.makeAccessToken({
      identity: hostId,
      room: roomName,
      ttl: this.config.LIVEKIT_TOKEN_TTL_SECONDS,
      grants: {
        roomJoin: true,
        canPublish: true,
        canPublishSources: publishSources,
        canSubscribe: true,
        room: roomName,
      },
    });

    await this.eventsPublisher.publish({
      type: 'voice.call.group_started',
      payload: {
        callId: id,
        conversationId,
        hostId,
        roomName,
        mode,
        startedAt: createdAt.toISOString(),
      },
    });

    if (firstInviteeId) {
      await this.redis.publish(
        `ws:signal:${firstInviteeId}`,
        JSON.stringify({
          type: 'call.ringing',
          payload: {
            callId: id,
            callerId: hostId,
            conversationId,
            roomName,
            startedAt: createdAt.toISOString(),
            mode,
            isGroup: true,
          },
        })
      );

      await this.redis.publish(
        `ws:signal:${hostId}`,
        JSON.stringify({
          type: 'call.dialing',
          payload: {
            callId: id,
            conversationId,
            calleeId: firstInviteeId,
            mode,
            isGroup: true,
          },
        })
      );
    }

    capture(hostId, 'group_call_started', { callId: id, roomName });

    return {
      call,
      token: hostToken,
      hostToken,
      livekitUrl: this.config.LIVEKIT_PUBLIC_URL,
      roomName,
    };
  }

  async joinCall(
    callId: string,
    userId: string
  ): Promise<{
    token: string;
    livekitUrl: string;
    roomName: string;
    call: Call;
  }> {
    const call = await this.callsRepo.getById(callId);
    if (!call) {
      throw new NotFoundError('call_not_found', 'Call not found');
    }
    if (!call.conversationId) {
      throw new BadRequestError('not_group_call', 'Call is not a group call');
    }

    if (call.state !== 'ringing' && call.state !== 'accepted') {
      throw new ConflictError(
        'invalid_state_transition',
        `Cannot join call in state '${call.state}'`
      );
    }

    const membership = await this.checkConversationMembership(call.conversationId, userId);
    if (!membership.isMember) {
      throw new ForbiddenError('not_member', 'User is not a member of this conversation');
    }

    const isAlreadyParticipant = await this.callParticipantsRepo.isParticipant(callId, userId);

    if (!isAlreadyParticipant) {
      const activeCount = await this.callParticipantsRepo.countActive(callId);
      if (activeCount >= this.config.MAX_GROUP_CALL_PARTICIPANTS) {
        throw new AppError(429, 'call_full', 'Call is full');
      }

      const joinedAt = new Date();
      await this.callParticipantsRepo.add(callId, userId, joinedAt);

      if (call.state === 'ringing') {
        await this.callsRepo.updateState(callId, {
          state: 'accepted',
          acceptedAt: joinedAt,
        });
        call.state = 'accepted';
        call.acceptedAt = joinedAt;
      }

      await this.eventsPublisher.publish({
        type: 'voice.call.participant_joined',
        payload: {
          callId,
          conversationId: call.conversationId,
          userId,
          at: joinedAt.toISOString(),
        },
      });

      const activeParticipants = await this.callParticipantsRepo.listActive(callId);
      await this.redis.publish(
        `ws:conv:${call.conversationId}`,
        JSON.stringify({
          type: 'call.participant_joined',
          payload: {
            callId,
            conversationId: call.conversationId,
            userId,
            joinedAt: joinedAt.toISOString(),
            participantCount: activeParticipants.length,
            participants: activeParticipants,
          },
        })
      );
    }

    const mode = call.mode || 'audio';
    const publishSources =
      mode === 'video'
        ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE]
        : [TrackSource.MICROPHONE];

    const token = await this.livekit.makeAccessToken({
      identity: userId,
      room: call.roomName,
      ttl: this.config.LIVEKIT_TOKEN_TTL_SECONDS,
      grants: {
        roomJoin: true,
        canPublish: true,
        canPublishSources: publishSources,
        canSubscribe: true,
        room: call.roomName,
      },
    });

    return {
      token,
      livekitUrl: this.config.LIVEKIT_PUBLIC_URL,
      roomName: call.roomName,
      call,
    };
  }

  async leaveCall(
    callId: string,
    userId: string
  ): Promise<{ ok: boolean; remainingCount: number }> {
    const call = await this.callsRepo.getById(callId);
    if (!call) {
      throw new NotFoundError('call_not_found', 'Call not found');
    }
    if (!call.conversationId) {
      throw new BadRequestError('not_group_call', 'Call is not a group call');
    }

    const isParticipant = await this.callParticipantsRepo.isParticipant(callId, userId);
    if (!isParticipant) {
      throw new ForbiddenError('not_participant', 'User is not a participant in this call');
    }

    const leftAt = new Date();
    await this.callParticipantsRepo.remove(callId, userId, leftAt);

    await this.eventsPublisher.publish({
      type: 'voice.call.participant_left',
      payload: {
        callId,
        conversationId: call.conversationId,
        userId,
        at: leftAt.toISOString(),
      },
    });

    const remaining = await this.callParticipantsRepo.listActive(callId);

    if (remaining.length === 0) {
      await this.callsRepo.updateState(callId, {
        state: 'ended',
        endedAt: leftAt,
        endedBy: userId,
        endReason: 'all_left',
      });

      try {
        await this.livekit.roomService?.deleteRoom(call.roomName);
      } catch {
        // ignore
      }

      await this.eventsPublisher.publish({
        type: 'voice.call.ended',
        payload: {
          callId,
          conversationId: call.conversationId,
          callerId: call.callerId,
          calleeId: call.calleeId,
          endedBy: userId,
          reason: 'all_left',
          at: leftAt.toISOString(),
        },
      });

      await this.redis.publish(
        `ws:conv:${call.conversationId}`,
        JSON.stringify({
          type: 'call.ended',
          payload: {
            callId,
            conversationId: call.conversationId,
            endedBy: userId,
            reason: 'all_left',
          },
        })
      );
    } else {
      await this.redis.publish(
        `ws:conv:${call.conversationId}`,
        JSON.stringify({
          type: 'call.participant_left',
          payload: {
            callId,
            conversationId: call.conversationId,
            userId,
            leftAt: leftAt.toISOString(),
            participantCount: remaining.length,
            participants: remaining,
          },
        })
      );
    }

    return { ok: true, remainingCount: remaining.length };
  }

  async endGroupCall(
    callId: string,
    hostId: string
  ): Promise<Call> {
    const call = await this.callsRepo.getById(callId);
    if (!call) {
      throw new NotFoundError('call_not_found', 'Call not found');
    }
    if (!call.conversationId) {
      throw new BadRequestError('not_group_call', 'Call is not a group call');
    }

    if (call.hostId !== hostId && call.callerId !== hostId) {
      throw new ForbiddenError('not_host', 'Only the call host can end the call');
    }

    if (call.state !== 'ringing' && call.state !== 'accepted') {
      throw new ConflictError(
        'invalid_state_transition',
        `Cannot end call in state '${call.state}'`
      );
    }

    const endedAt = new Date();
    await this.callsRepo.updateState(callId, {
      state: 'ended',
      endedAt,
      endedBy: hostId,
      endReason: 'host_ended',
    });

    const remaining = await this.callParticipantsRepo.listActive(callId);
    for (const pId of remaining) {
      await this.callParticipantsRepo.remove(callId, pId, endedAt);
      await this.redis.publish(
        `ws:signal:${pId}`,
        JSON.stringify({
          type: 'call.ended',
          payload: {
            callId,
            conversationId: call.conversationId,
            endedBy: hostId,
            reason: 'host_ended',
          },
        })
      );
    }

    try {
      await this.livekit.roomService?.deleteRoom(call.roomName);
    } catch {
      // ignore
    }

    await this.eventsPublisher.publish({
      type: 'voice.call.ended',
      payload: {
        callId,
        conversationId: call.conversationId,
        callerId: call.callerId,
        calleeId: call.calleeId,
        endedBy: hostId,
        reason: 'host_ended',
        at: endedAt.toISOString(),
      },
    });

    await this.redis.publish(
      `ws:conv:${call.conversationId}`,
      JSON.stringify({
        type: 'call.ended',
        payload: {
          callId,
          conversationId: call.conversationId,
          endedBy: hostId,
          reason: 'host_ended',
        },
      })
    );

    return {
      ...call,
      state: 'ended',
      endedAt,
      endedBy: hostId,
      endReason: 'host_ended',
    };
  }

  async getConversationCall(
    conversationId: string,
    state?: string,
    userId?: string
  ): Promise<Call | null> {
    if (userId) {
      const membership = await this.checkConversationMembership(conversationId, userId);
      if (!membership.isMember) {
        throw new ForbiddenError('not_member', 'User is not a member of this conversation');
      }
    }
    return this.callsRepo.findByConversation(conversationId, state);
  }

  async getActiveCall(userId: string): Promise<Call | null> {
    return this.callsRepo.findActiveByUser(userId);
  }

  async listHistory(
    userId: string,
    limit = 30,
    before?: Date | string
  ): Promise<{ calls: Call[]; nextCursor?: string }> {
    const calls = await this.callsRepo.listForUser(userId, limit, before);
    const lastCall = calls[calls.length - 1];
    const nextCursor =
      calls.length === limit && lastCall && lastCall.createdAt
        ? new Date(lastCall.createdAt).toISOString()
        : undefined;
    return {
      calls,
      nextCursor,
    };
  }
}
