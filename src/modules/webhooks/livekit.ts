import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { WebhookReceiver, type WebhookEvent, type RoomServiceClient } from 'livekit-server-sdk';
import type { Config } from '../../config.js';
import type { CallsRepository } from '../../db/repositories/calls.js';
import type { EventsPublisher } from '../events/publisher.js';
import {
  handleRoomStarted,
  handleRoomFinished,
  handleParticipantJoined,
  handleParticipantLeft,
} from './handlers.js';

export class LiveKitWebhookService {
  private readonly receiver: WebhookReceiver;
  private readonly callsRepo: CallsRepository;
  private readonly redis: Redis;
  private readonly eventsPublisher: EventsPublisher;
  private readonly roomService: RoomServiceClient;
  private readonly logger: FastifyBaseLogger;

  constructor(
    config: Config,
    callsRepo: CallsRepository,
    redis: Redis,
    eventsPublisher: EventsPublisher,
    roomService: RoomServiceClient,
    logger: FastifyBaseLogger,
    receiver?: WebhookReceiver
  ) {
    this.receiver =
      receiver || new WebhookReceiver(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
    this.callsRepo = callsRepo;
    this.redis = redis;
    this.eventsPublisher = eventsPublisher;
    this.roomService = roomService;
    this.logger = logger;
  }

  async verifyAndParse(rawBody: string, authHeader?: string): Promise<WebhookEvent> {
    return await this.receiver.receive(rawBody, authHeader);
  }

  async processEvent(event: WebhookEvent): Promise<void> {
    switch (event.event) {
      case 'room_started':
        await handleRoomStarted(event, this.logger);
        break;
      case 'room_finished':
        await handleRoomFinished(
          event,
          this.callsRepo,
          this.redis,
          this.eventsPublisher,
          this.logger
        );
        break;
      case 'participant_joined':
        await handleParticipantJoined(event, this.logger);
        break;
      case 'participant_left':
        await handleParticipantLeft(
          event,
          this.callsRepo,
          this.redis,
          this.eventsPublisher,
          this.roomService,
          this.logger
        );
        break;
      default:
        this.logger.debug({ event: event.event }, 'Ignored unhandled LiveKit webhook event');
        break;
    }
  }
}
