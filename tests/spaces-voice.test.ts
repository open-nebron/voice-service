import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { TokenVerifier } from 'livekit-server-sdk';
import { DEFAULT_EVERYONE_PERMISSIONS, PermissionBits } from '@nebron/permissions';
import {
  setupTestKeyspace,
  createRealTestApp,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Voice Service Space Voice Channel Join', () => {
  let keyspaceContext: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;
  let mockSpacesServer: http.Server;

  const userSpeaker = crypto.randomUUID();
  const userListener = crypto.randomUUID();
  const userNoConnect = crypto.randomUUID();
  const spaceId = 'space_v1';
  const channelId = 'vc_1';

  const permsMap = new Map<string, { isMember: boolean; permissions: bigint }>([
    [userSpeaker, { isMember: true, permissions: DEFAULT_EVERYONE_PERMISSIONS }],
    [
      userListener,
      {
        isMember: true,
        permissions: PermissionBits.VIEW_CHANNEL | PermissionBits.CONNECT, // no SPEAK
      },
    ],
    [userNoConnect, { isMember: true, permissions: PermissionBits.VIEW_CHANNEL }],
  ]);

  beforeAll(async () => {
    mockSpacesServer = http.createServer((req, res) => {
      if (req.headers['x-internal-token'] !== 'test-internal-token') {
        res.writeHead(403).end();
        return;
      }
      const match = (req.url || '').match(/\/permissions\/([^/?]+)/);
      if (match) {
        const uid = decodeURIComponent(match[1]);
        const entry = permsMap.get(uid) || { isMember: false, permissions: 0n };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            userId: uid,
            isMember: entry.isMember,
            permissions: entry.permissions.toString(),
          })
        );
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => mockSpacesServer.listen(0, '127.0.0.1', resolve));
    const port = (mockSpacesServer.address() as AddressInfo).port;

    keyspaceContext = await setupTestKeyspace();
    const res = await createRealTestApp(keyspaceContext, {
      SPACES_URL: `http://127.0.0.1:${port}`,
    });
    app = res.app;
    redis = res.redis;
  });

  beforeEach(async () => {
    for (const uid of [userSpeaker, userListener, userNoConnect]) {
      await redis.del(`space:perm:${spaceId}:${channelId}:${uid}`);
    }
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => mockSpacesServer.close(() => resolve()));
    await keyspaceContext.drop();
  });

  it('Requires INTERNAL_TOKEN and enforces CONNECT permission on voice channel join', async () => {
    const noTok = await app.inject({
      method: 'POST',
      url: `/internal/spaces/${spaceId}/channels/${channelId}/join`,
      payload: { userId: userSpeaker },
    });
    expect(noTok.statusCode).toBe(403);

    const denied = await app.inject({
      method: 'POST',
      url: `/internal/spaces/${spaceId}/channels/${channelId}/join`,
      headers: { 'x-internal-token': 'test-internal-token' },
      payload: { userId: userNoConnect },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('missing_permission');
  });

  it('Returns valid LiveKit token with room space_{spaceId}_channel_{chId} and respects SPEAK grant', async () => {
    const verifier = new TokenVerifier('test-api-key', 'test-api-secret');

    const resSpeaker = await app.inject({
      method: 'POST',
      url: `/internal/spaces/${spaceId}/channels/${channelId}/join`,
      headers: { 'x-internal-token': 'test-internal-token' },
      payload: { userId: userSpeaker },
    });
    expect(resSpeaker.statusCode).toBe(200);
    const bodySpeaker = resSpeaker.json();
    expect(bodySpeaker.roomName).toBe(`space_${spaceId}_channel_${channelId}`);
    expect(bodySpeaker.room_name).toBe(`space_${spaceId}_channel_${channelId}`);

    const decodedSpeaker = await verifier.verify(bodySpeaker.token);
    expect(decodedSpeaker.sub).toBe(userSpeaker);
    expect(decodedSpeaker.video?.room).toBe(`space_${spaceId}_channel_${channelId}`);
    expect(decodedSpeaker.video?.canPublish).toBe(true);

    const resListener = await app.inject({
      method: 'POST',
      url: `/internal/spaces/${spaceId}/channels/${channelId}/join`,
      headers: { 'x-internal-token': 'test-internal-token' },
      payload: { userId: userListener },
    });
    expect(resListener.statusCode).toBe(200);
    const decodedListener = await verifier.verify(resListener.json().token);
    expect(decodedListener.video?.canPublish).toBe(false);
    expect(decodedListener.video?.canSubscribe).toBe(true);
  });
});
