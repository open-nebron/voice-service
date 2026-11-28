import type { Redis } from 'ioredis';

/**
 * Updates approximate live active call count in Redis ('live:active_calls').
 * Documented as approximate due to best-effort concurrency on decrement.
 */
export async function incrementLiveActiveCalls(redis: Redis): Promise<void> {
  try {
    if (typeof redis.incr === 'function') {
      await redis.incr('live:active_calls');
    }
  } catch {
    // Non-blocking live counter
  }
}

export async function decrementLiveActiveCalls(redis: Redis): Promise<void> {
  try {
    if (typeof redis.decr === 'function') {
      const next = await redis.decr('live:active_calls');
      if (next < 0 && typeof redis.set === 'function') {
        await redis.set('live:active_calls', '0');
      }
    }
  } catch {
    // Non-blocking live counter
  }
}
