import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type cassandra from 'cassandra-driver';
import type { Redis } from 'ioredis';
import type { JWTVerifyGetKey } from 'jose';
import type { RoomServiceClient } from 'livekit-server-sdk';

describe('Health endpoint (GET /health)', () => {
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

  let mockScylla: cassandra.Client;
  let mockRedis: Redis;
  let mockJwksKeySet: JWTVerifyGetKey;
  let mockRoomService: RoomServiceClient;

  beforeEach(() => {
    mockScylla = {
      execute: vi.fn().mockResolvedValue({ rows: [{ 'system.now()': new Date() }] }),
      shutdown: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as cassandra.Client;

    mockRedis = {
      ping: vi.fn().mockResolvedValue('PONG'),
      connect: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;

    mockJwksKeySet = vi.fn() as unknown as JWTVerifyGetKey;

    mockRoomService = {
      listRooms: vi.fn().mockResolvedValue([]),
    } as unknown as RoomServiceClient;
  });

  it('All deps mocked healthy → 200 with all "ok"', async () => {
    const app = await buildApp({
      config: testConfig,
      scyllaClient: mockScylla,
      redisClient: mockRedis,
      jwksKeySet: mockJwksKeySet,
      roomService: mockRoomService,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      status: 'ok',
      scylla: 'ok',
      redis: 'ok',
      jwks: 'ok',
      livekit: 'ok',
      version: expect.any(String),
    });

    await app.close();
  });

  it('Scylla ping rejects → 503 with scylla: "down"', async () => {
    (mockScylla.execute as any).mockImplementation((query: string) => {
      if (query.includes('system.local')) {
        return Promise.reject(new Error('Scylla timeout'));
      }
      return Promise.resolve({ rows: [] });
    });

    const app = await buildApp({
      config: testConfig,
      scyllaClient: mockScylla,
      redisClient: mockRedis,
      jwksKeySet: mockJwksKeySet,
      roomService: mockRoomService,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('down');
    expect(body.scylla).toBe('down');
    expect(body.redis).toBe('ok');

    await app.close();
  });

  it('Redis ping rejects → 503 with redis: "down"', async () => {
    (mockRedis.ping as any).mockRejectedValueOnce(new Error('Redis connection refused'));

    const app = await buildApp({
      config: testConfig,
      scyllaClient: mockScylla,
      redisClient: mockRedis,
      jwksKeySet: mockJwksKeySet,
      roomService: mockRoomService,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('down');
    expect(body.scylla).toBe('ok');
    expect(body.redis).toBe('down');

    await app.close();
  });

  it('LiveKit ping returns false → 200 with livekit: "degraded"', async () => {
    (mockRoomService.listRooms as any).mockRejectedValue(new Error('LiveKit connection refused'));

    const app = await buildApp({
      config: testConfig,
      scyllaClient: mockScylla,
      redisClient: mockRedis,
      jwksKeySet: mockJwksKeySet,
      roomService: mockRoomService,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.scylla).toBe('ok');
    expect(body.redis).toBe('ok');
    expect(body.livekit).toBe('degraded');

    await app.close();
  });

  it('JWKS fetch fails at boot → health returns jwks: "stale" (still 200 if other deps ok)', async () => {
    const app = await buildApp({
      config: {
        ...testConfig,
        AUTH_JWKS_URL: 'http://127.0.0.1:59999/.well-known/jwks.json',
      },
      scyllaClient: mockScylla,
      redisClient: mockRedis,
      roomService: mockRoomService,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.scylla).toBe('ok');
    expect(body.redis).toBe('ok');
    expect(body.jwks).toBe('stale');
    expect(body.livekit).toBe('ok');

    await app.close();
  });
});
