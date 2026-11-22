import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { RoomServiceClient } from 'livekit-server-sdk';
import type { CallsRepository } from '../db/repositories/calls.js';
import type { EventsPublisher } from '../modules/events/publisher.js';
import type { Config } from '../config.js';

export class CallReconcileJob {
  private readonly callsRepo: CallsRepository;
  private readonly roomService: RoomServiceClient;
  private readonly redis: Redis;
  private readonly eventsPublisher: EventsPublisher;
  private readonly config: Config;
  private readonly log: FastifyBaseLogger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    callsRepo: CallsRepository,
    roomService: RoomServiceClient,
    redis: Redis,
    eventsPublisher: EventsPublisher,
    config: Config,
    log: FastifyBaseLogger
  ) {
    this.callsRepo = callsRepo;
    this.roomService = roomService;
    this.redis = redis;
    this.eventsPublisher = eventsPublisher;
    this.config = config;
    this.log = log;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.poll().catch((err) => this.log.error({ err }, 'Call reconcile poll error')),
      this.config.RECONCILE_POLL_INTERVAL_MS
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let reconciledCount = 0;

    try {
      const stuckCalls = await this.callsRepo.findAcceptedOlderThan(
        this.config.RECONCILE_MIN_CALL_AGE_SECONDS,
        this.config.RECONCILE_BATCH_SIZE
      );

      for (const call of stuckCalls) {
        try {
          let participantCount = 0;
          let roomExists = true;

          try {
            const participants = await this.roomService.listParticipants(call.roomName);
            participantCount = participants ? participants.length : 0;
          } catch (err: any) {
            const errMsg = String(err?.message || '').toLowerCase();
            if (
              errMsg.includes('could not find room') ||
              errMsg.includes('not found') ||
              err?.status === 404
            ) {
              roomExists = false;
              participantCount = 0;
            } else {
              this.log.warn(
                { callId: call.id, err: err?.message },
                'Failed to query LiveKit participants for call reconciliation'
              );
              continue;
            }
          }

          if (!roomExists || participantCount === 0) {
            const endedAt = new Date();
            const applied = await this.callsRepo.updateToEndedAtomic(
              call.id,
              endedAt,
              'livekit_closed'
            );

            if (applied) {
              reconciledCount++;
              const ageSeconds = Math.round(
                (endedAt.getTime() - new Date(call.createdAt).getTime()) / 1000
              );
              this.log.info(
                { callId: call.id, ageSeconds },
                'reconciliation: auto-ended stuck call'
              );

              await this.redis.publish(
                `ws:signal:${call.callerId}`,
                JSON.stringify({
                  type: 'call.ended',
                  payload: { callId: call.id, reason: 'livekit_closed' },
                })
              );

              await this.redis.publish(
                `ws:signal:${call.calleeId}`,
                JSON.stringify({
                  type: 'call.ended',
                  payload: { callId: call.id, reason: 'livekit_closed' },
                })
              );

              await this.eventsPublisher.publish({
                type: 'voice.call.ended',
                payload: {
                  callId: call.id,
                  callerId: call.callerId,
                  calleeId: call.calleeId,
                  endedBy: null,
                  reason: 'livekit_closed',
                  at: endedAt.toISOString(),
                },
              });
            }
          }
        } catch (err: any) {
          this.log.error({ callId: call.id, err: err?.message }, 'Error reconciling call');
        }

        // Pause 100ms between calls to avoid hammering LiveKit
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      this.running = false;
    }

    return reconciledCount;
  }
}
