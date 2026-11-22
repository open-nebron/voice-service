import { describe, it, expect, vi } from 'vitest';
import { jwtVerify } from 'jose';
import { AccessToken } from 'livekit-server-sdk';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type cassandra from 'cassandra-driver';
import type { Redis } from 'ioredis';
import type { JWTVerifyGetKey } from 'jose';
import type { RoomServiceClient } from 'livekit-server-sdk';

describe('LiveKit Integration and Token Generation', () => {
  const testConfig: Config = {
    PORT: 4004,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SCYLLA_HOSTS: 'localhost:9042',
    SCYLLA_KEYSPACE: 'nebron',
    SCYLLA_DATACENTER: 'datacenter1',
    REDIS_URL: 'redis://localhost:6379',
    AUTH_JWKS_URL: 'http://localhost:4001/.well-known/jwks.json',
    JWT_ISSUER: 'nebron-auth',
    JWT_AUDIENCE: 'voice',
    LIVEKIT_URL: 'ws://localhost:7880',
    LIVEKIT_HTTP_URL: 'http://localhost:7880',
    LIVEKIT_API_KEY: 'test-api-key',
    LIVEKIT_API_SECRET: 'test-api-secret',
    CORE_URL: 'http://core:4002',
    INTERNAL_TOKEN: 'test-internal-token',
    EVENTS_STREAM: 'nebron.events',
  };

  const mockScylla = {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
  } as unknown as cassandra.Client;

  const mockRedis = {
    ping: vi.fn().mockResolvedValue('PONG'),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue('OK'),
  } as unknown as Redis;

  const mockJwksKeySet = vi.fn() as unknown as JWTVerifyGetKey;

  const mockRoomService = {
    listRooms: vi.fn().mockResolvedValue([]),
  } as unknown as RoomServiceClient;

  async function createTestApp() {
    return await buildApp({
      config: testConfig,
      scyllaClient: mockScylla,
      redisClient: mockRedis,
      jwksKeySet: mockJwksKeySet,
      roomService: mockRoomService,
    });
  }

  it("fastify.livekit.makeAccessToken('user-id', 'room-name') returns non-empty string", async () => {
    const app = await createTestApp();

    const token = await app.livekit.makeAccessToken('user-id', 'room-name');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    // Direct AccessToken verification check
    const directAt = new AccessToken(testConfig.LIVEKIT_API_KEY, testConfig.LIVEKIT_API_SECRET, {
      identity: 'user-id',
    });
    directAt.addGrant({ roomJoin: true, room: 'room-name' });
    const directToken = await directAt.toJwt();
    expect(typeof directToken).toBe('string');
    expect(directToken.length).toBeGreaterThan(0);

    await app.close();
  });

  it('Token decodes with jose.jwtVerify using LIVEKIT_API_SECRET → grants include roomJoin:true, room: "room-name"', async () => {
    const app = await createTestApp();

    const token = await app.livekit.makeAccessToken('user-id', 'room-name');
    const secret = new TextEncoder().encode(testConfig.LIVEKIT_API_SECRET);
    const { payload } = await jwtVerify(token, secret);

    expect(payload.video).toBeDefined();
    expect(payload.video).toMatchObject({
      roomJoin: true,
      room: 'room-name',
    });

    await app.close();
  });

  it("Token has sub === 'user-id' and iss === LIVEKIT_API_KEY", async () => {
    const app = await createTestApp();

    const token = await app.livekit.makeAccessToken('user-id', 'room-name');
    const secret = new TextEncoder().encode(testConfig.LIVEKIT_API_SECRET);
    const { payload } = await jwtVerify(token, secret);

    expect(payload.sub).toBe('user-id');
    expect(payload.iss).toBe(testConfig.LIVEKIT_API_KEY);

    await app.close();
  });
});
