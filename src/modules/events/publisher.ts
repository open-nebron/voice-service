import type { Redis } from 'ioredis';
import type { NebronEvent } from '@nebron/contracts';

export class EventsPublisher {
  private readonly redis: Redis;
  private readonly streamName: string;

  constructor(redis: Redis, streamName = 'nebron.events') {
    this.redis = redis;
    this.streamName = streamName;
  }

  async publish(event: NebronEvent): Promise<string> {
    const id = await this.redis.xadd(
      this.streamName,
      '*',
      'type',
      event.type,
      'payload',
      JSON.stringify(event.payload)
    );
    return id || '';
  }
}
