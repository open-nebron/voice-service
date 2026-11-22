import type { Redis } from 'ioredis';
import type { Config } from '../config.js';
import type { CallsRepository } from '../db/repositories/calls.js';
import type { EventsPublisher } from '../modules/events/publisher.js';

export interface CallTimeoutJobLogger {
  info: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export class CallTimeoutJob {
  private readonly callsRepo: CallsRepository;
  private readonly redis: Redis;
  private readonly eventsPublisher: EventsPublisher;
  private readonly config: Config;
  private readonly logger: CallTimeoutJobLogger;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    callsRepo: CallsRepository,
    redis: Redis,
    eventsPublisher: EventsPublisher,
    config: Config,
    logger?: CallTimeoutJobLogger
  ) {
    this.callsRepo = callsRepo;
    this.redis = redis;
    this.eventsPublisher = eventsPublisher;
    this.config = config;
    this.logger = logger || console;
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.config.CALL_TIMEOUT_POLL_INTERVAL_MS || 5000;
    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        this.logger.error({ err }, '[CallTimeoutJob] Error in poll interval');
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Scans for calls in state='ringing' older than CALL_RING_TIMEOUT_SECONDS (45s).
   * Note for multi-instance deployments:
   * To prevent duplicate processing across pods, multi-instance needs a Redis lock or
   * the Scylla atomic conditional update (LWT) below:
   * UPDATE calls SET state='missed', ended_at=?, end_reason='missed' WHERE id = ? IF state = 'ringing'
   */
  async poll(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const timeoutSec = this.config.CALL_RING_TIMEOUT_SECONDS || 45;
      const expiredCalls = await this.callsRepo.findExpiredRinging(timeoutSec);

      for (const call of expiredCalls) {
        const endedAt = new Date();
        const applied = await this.callsRepo.updateToMissedAtomic(call.id, endedAt);

        // If the LWT condition was not applied (call already accepted/rejected/cancelled), skip silently
        if (!applied) {
          continue;
        }

        // 1. Publish ws:signal to caller
        await this.redis.publish(
          `ws:signal:${call.callerId}`,
          JSON.stringify({
            type: 'call.missed',
            payload: { callId: call.id },
          })
        );

        // 2. Publish ws:signal to callee
        await this.redis.publish(
          `ws:signal:${call.calleeId}`,
          JSON.stringify({
            type: 'call.missed',
            payload: { callId: call.id },
          })
        );

        // 3. Publish voice.call.missed to nebron.events
        await this.eventsPublisher.publish({
          type: 'voice.call.missed',
          payload: {
            callId: call.id,
            callerId: call.callerId,
            calleeId: call.calleeId,
            at: endedAt.toISOString(),
          },
        });
      }
    } finally {
      this.isRunning = false;
    }
  }
}
