import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { canConnectVoice, canSpeak, canView, parsePermissions } from '@nebron/permissions';
import { AppError, ForbiddenError } from '../lib/errors.js';

const joinSpaceVoiceBodySchema = z.object({
  userId: z.string().min(1),
});

export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    const token =
      (request.headers['x-internal-token'] as string) ||
      (request.headers.authorization?.replace(/^Bearer\s+/i, '') as string);

    if (!token || token !== fastify.config.INTERNAL_TOKEN) {
      return reply.status(403).send({ error: { code: 'forbidden', message: 'Forbidden' } });
    }
  });

  fastify.get('/internal/stats', async (_request, reply) => {
    const today = new Date().toISOString().slice(0, 10);
    const key = `stats:calls:${today}`;
    const countStr = await fastify.redis.get(key);
    const todayCount = countStr ? parseInt(countStr, 10) : 0;

    return reply.status(200).send({
      calls: {
        today: todayCount,
      },
      today: todayCount,
    });
  });

  fastify.get('/internal/analytics/calls', async (request, reply) => {
    const query = (request.query as { since?: string; until?: string }) || {};
    const now = new Date();
    const parseBoundary = (raw: string | undefined, fallback: Date, endOfDay: boolean): Date => {
      if (!raw) return fallback;
      const trimmed = raw.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const d = new Date(`${trimmed}T00:00:00.000Z`);
        return endOfDay ? new Date(d.getTime() + 86_400_000) : d;
      }
      const parsed = new Date(trimmed);
      return Number.isNaN(parsed.getTime()) ? fallback : parsed;
    };

    const since = parseBoundary(query.since, new Date(now.getTime() - 30 * 86_400_000), false);
    const until = parseBoundary(query.until, new Date(now.getTime() + 1000), true);

    const res = await fastify.scylla.execute(
      'SELECT id, caller_id, callee_id, state, mode, created_at, accepted_at, ended_at FROM calls'
    );

    let totalCalls = 0;
    let completedCalls = 0;
    let totalDurationSeconds = 0;
    let durationCount = 0;
    let audio = 0;
    let video = 0;
    const uniqueUsers = new Set<string>();
    const dailyMap = new Map<string, { callsMade: number; seconds: number }>();
    const histCounts = {
      '<1m': 0,
      '1-5m': 0,
      '5-15m': 0,
      '15-30m': 0,
      '30m+': 0,
    };

    for (const row of res.rows) {
      const createdAt =
        row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
      if (Number.isNaN(createdAt.getTime())) continue;
      if (createdAt < since || createdAt >= until) continue;

      totalCalls++;
      if (row.mode === 'video') video++;
      else audio++;

      if (row.caller_id) uniqueUsers.add(row.caller_id.toString());
      if (row.callee_id) uniqueUsers.add(row.callee_id.toString());

      let callSec = 0;
      if (row.accepted_at && row.ended_at) {
        const acc = row.accepted_at instanceof Date ? row.accepted_at : new Date(row.accepted_at);
        const end = row.ended_at instanceof Date ? row.ended_at : new Date(row.ended_at);
        if (!Number.isNaN(acc.getTime()) && !Number.isNaN(end.getTime())) {
          callSec = Math.max(0, (end.getTime() - acc.getTime()) / 1000);
          totalDurationSeconds += callSec;
          durationCount++;
          completedCalls++;
          if (callSec < 60) histCounts['<1m']++;
          else if (callSec < 300) histCounts['1-5m']++;
          else if (callSec < 900) histCounts['5-15m']++;
          else if (callSec < 1800) histCounts['15-30m']++;
          else histCounts['30m+']++;
        }
      }

      const dk = createdAt.toISOString().slice(0, 10);
      const dayEntry = dailyMap.get(dk) ?? { callsMade: 0, seconds: 0 };
      dayEntry.callsMade++;
      dayEntry.seconds += callSec;
      dailyMap.set(dk, dayEntry);
    }

    const avgDurationSeconds =
      durationCount > 0 ? Number((totalDurationSeconds / durationCount).toFixed(2)) : 0;
    const totalMinutes = Number((totalDurationSeconds / 60).toFixed(2));
    const daily = Array.from(dailyMap.entries())
      .map(([date, d]) => ({
        date,
        callsMade: d.callsMade,
        callMinutes: Number((d.seconds / 60).toFixed(2)),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const durationHistogram = Object.entries(histCounts).map(([bucket, count]) => ({ bucket, count }));

    return reply.status(200).send({
      since: since.toISOString(),
      until: until.toISOString(),
      totalCalls,
      completedCalls,
      avgDurationSeconds,
      totalMinutes,
      byType: { audio, video },
      uniqueUsersCount: uniqueUsers.size,
      daily,
      durationHistogram,
    });
  });

  fastify.post<{ Params: { spaceId: string; chId: string }; Body: { userId: string } }>(
    '/internal/spaces/:spaceId/channels/:chId/join',
    async (request, reply) => {
      const { spaceId, chId } = request.params;
      if (!spaceId || !chId) {
        throw new AppError(400, 'invalid_payload', 'spaceId and chId are required');
      }

      const parsed = joinSpaceVoiceBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(400, 'invalid_payload', 'Valid userId is required');
      }
      const { userId } = parsed.data;

      // Check channel voice permissions via Redis cache / spaces-service
      const cacheKey = `space:perm:${spaceId}:${chId}:${userId}`;
      let isMember = false;
      let perms = 0n;
      let resolvedFromCache = false;

      try {
        const cached = await fastify.redis.get(cacheKey);
        if (cached) {
          const parsedCache = JSON.parse(cached) as { isMember?: boolean; permissions?: string };
          isMember = Boolean(parsedCache.isMember);
          perms = parsePermissions(parsedCache.permissions ?? '0');
          resolvedFromCache = true;
        }
      } catch {
        // Fallback to HTTP check
      }

      if (!resolvedFromCache) {
        const base = fastify.config.SPACES_URL.replace(/\/$/, '');
        const permUrl = `${base}/spaces/${encodeURIComponent(spaceId)}/channels/${encodeURIComponent(
          chId
        )}/permissions/${encodeURIComponent(userId)}`;

        let res: Response;
        try {
          res = await fetch(permUrl, {
            method: 'GET',
            headers: {
              'x-internal-token': fastify.config.INTERNAL_TOKEN,
              'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(3000),
          });
        } catch {
          throw new AppError(503, 'service_unavailable', 'Spaces service unavailable');
        }

        if (res.status === 403 || res.status === 404) {
          throw new ForbiddenError('missing_permission', 'User does not have access to this voice channel');
        }
        if (!res.ok) {
          throw new AppError(503, 'service_unavailable', 'Spaces service unavailable');
        }

        const body = (await res.json()) as { isMember?: boolean; permissions?: string };
        isMember = Boolean(body.isMember);
        perms = isMember ? parsePermissions(body.permissions ?? '0') : 0n;

        try {
          await fastify.redis.set(
            cacheKey,
            JSON.stringify({ isMember, permissions: perms.toString() }),
            'EX',
            60
          );
        } catch {
          // Ignore cache write error
        }
      }

      if (!isMember || !canView(perms) || !canConnectVoice(perms)) {
        throw new ForbiddenError('missing_permission', 'User lacks CONNECT permission for this voice channel');
      }

      const roomName = `space_${spaceId}_channel_${chId}`;

      try {
        await fastify.livekit.roomService.createRoom({ name: roomName });
      } catch {
        // Non-blocking in degraded/test environments; room auto-creates on LiveKit join
      }

      const token = await fastify.livekit.makeAccessToken({
        identity: userId,
        room: roomName,
        grants: {
          roomJoin: true,
          room: roomName,
          canPublish: canSpeak(perms),
          canSubscribe: true,
        },
      });

      return reply.status(200).send({
        token,
        roomName,
        room_name: roomName,
        livekitUrl: fastify.config.LIVEKIT_PUBLIC_URL,
      });
    }
  );
};
