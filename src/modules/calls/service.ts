import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import type { Config } from '../../config.js';
import type { CallsRepository, Call } from '../../db/repositories/calls.js';
import type { EventsPublisher } from '../events/publisher.js';
import type { LiveKitService } from '../../plugins/livekit.js';
import type { CallEndReason } from './state-machine.js';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from '../../lib/errors.js';

export class CallsService {
  private readonly callsRepo: CallsRepository;
  private readonly redis: Redis;
  private readonly eventsPublisher: EventsPublisher;
  private readonly livekit: LiveKitService;
  private readonly config: Config;

  constructor(
    callsRepo: CallsRepository,
    redis: Redis,
    eventsPublisher: EventsPublisher,
    livekit: LiveKitService,
    config: Config
  ) {
    this.callsRepo = callsRepo;
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
    const publishGrants =
      mode === 'video'
        ? ['microphone', 'camera', 'screen_share']
        : ['microphone'];

    let callerToken: string;
    let calleeToken: string;
    try {
      callerToken = await this.livekit.makeAccessToken({
        identity: call.callerId,
        room: call.roomName,
        ttl: this.config.LIVEKIT_TOKEN_TTL_SECONDS,
        grants: {
          roomJoin: true,
          canPublish: publishGrants,
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
          canPublish: publishGrants,
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

    const updatedCall: Call = {
      ...call,
      state: 'accepted',
      acceptedAt,
    };

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

    if (userId !== call.callerId && userId !== call.calleeId) {
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
      const publishGrants =
        mode === 'video'
          ? ['microphone', 'camera', 'screen_share']
          : ['microphone'];

      const token = await this.livekit.makeAccessToken({
        identity: userId,
        room: call.roomName,
        ttl: this.config.LIVEKIT_TOKEN_TTL_SECONDS,
        grants: {
          roomJoin: true,
          canPublish: publishGrants,
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
