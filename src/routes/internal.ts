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
