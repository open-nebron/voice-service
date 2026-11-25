import type { Redis } from 'ioredis';

export interface BanStatus {
  banned: boolean;
  reason?: string | null;
}

export async function checkUserBanned(
  redis: Redis,
  coreUrl: string | undefined,
  internalToken: string | undefined,
  userId: string
): Promise<BanStatus> {
  try {
    const cached = await redis.get(`user:banned:${userId}`);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (typeof parsed === 'object' && parsed !== null) {
          return { banned: Boolean(parsed.banned), reason: parsed.reason };
        }
      } catch {
        return { banned: cached === '1' || cached === 'true' };
      }
    }

    if (coreUrl && internalToken) {
      try {
        const url = `${coreUrl.replace(/\/$/, '')}/internal/users/${userId}/ban-status`;
        const res = await fetch(url, {
          headers: { 'x-internal-token': internalToken },
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const isBanned = Boolean(data.isBanned);
          const reason = data.bannedReason || null;
          await redis.set(
            `user:banned:${userId}`,
            JSON.stringify({ banned: isBanned, reason }),
            'EX',
            60
          );
          return { banned: isBanned, reason };
        }
      } catch {
        // Graceful fallback if core-backend is unreachable
      }
    }
  } catch {
    // Redis error, graceful fallback
  }
  return { banned: false };
}
