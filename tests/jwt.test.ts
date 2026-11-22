import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose';
import { buildApp } from '../src/app.js';
import { verifyAccessTokenForTest } from '../src/plugins/jwt.js';
import type { Config } from '../src/config.js';
import type cassandra from 'cassandra-driver';
import type { Redis } from 'ioredis';
import type { RoomServiceClient } from 'livekit-server-sdk';

describe('JWT Verification and authenticate preHandler', () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let jwksServer: http.Server;
  let jwksUrl: string;

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

  const mockRoomService = {
    listRooms: vi.fn().mockResolvedValue([]),
  } as unknown as RoomServiceClient;

  beforeAll(async () => {
    // Generate RSA key pair for testing
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;

    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-voice-key-id';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    // Serve JWKS via local HTTP server
    jwksServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });

    await new Promise<void>((resolve) => {
      jwksServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = jwksServer.address() as AddressInfo;
    jwksUrl = `http://127.0.0.1:${addr.port}/.well-known/jwks.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      jwksServer.close(() => resolve());
    });
  });

  function getTestConfig(): Config {
    return {
      PORT: 4004,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SCYLLA_HOSTS: 'localhost:9042',
      SCYLLA_KEYSPACE: 'nebron',
      SCYLLA_DATACENTER: 'datacenter1',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_JWKS_URL: jwksUrl,
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
  }

  async function createTestApp() {
    const app = await buildApp({
      config: getTestConfig(),
      scyllaClient: mockScylla,
      redisClient: mockRedis,
      roomService: mockRoomService,
    });

    app.get('/test/protected', { preHandler: app.authenticate }, async (req) => {
      return { user: req.user };
    });

    return app;
  }

  it('Valid token signed with test RSA key, aud includes "voice" → authenticate passes', async () => {
    const app = await createTestApp();

    const token = await new SignJWT({
      sid: 'session-voice-123',
      email: 'user@nebron.com',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-voice-key-id' })
      .setIssuer('nebron-auth')
      .setAudience(['voice', 'web'])
      .setSubject('user-voice-456')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user).toEqual({
      userId: 'user-voice-456',
      sessionId: 'session-voice-123',
      email: 'user@nebron.com',
    });

    // Also verify verifyAccessTokenForTest helper
    const decoded = await verifyAccessTokenForTest(token, undefined, getTestConfig());
    expect(decoded.sub).toBe('user-voice-456');
    expect(decoded.sid).toBe('session-voice-123');
    expect(decoded.email).toBe('user@nebron.com');

    await app.close();
  });

  it('Wrong audience (aud: ["core"] only) → 401', async () => {
    const app = await createTestApp();

    const token = await new SignJWT({
      sid: 'session-voice-123',
      email: 'user@nebron.com',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-voice-key-id' })
      .setIssuer('nebron-auth')
      .setAudience(['core']) // Wrong audience! Missing 'voice'
      .setSubject('user-voice-456')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('invalid_token');

    await app.close();
  });

  it('Expired token → 401', async () => {
    const app = await createTestApp();

    const token = await new SignJWT({
      sid: 'session-voice-123',
      email: 'user@nebron.com',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-voice-key-id' })
      .setIssuer('nebron-auth')
      .setAudience(['voice'])
      .setSubject('user-voice-456')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10) // Expired
      .sign(privateKey);

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('invalid_token');

    await app.close();
  });

  it('Malformed Authorization header → 401', async () => {
    const app = await createTestApp();

    // Not Bearer format
    const res1 = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res1.statusCode).toBe(401);
    expect(res1.json().error.code).toBe('invalid_token');

    // Missing token part
    const res2 = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: 'Bearer' },
    });
    expect(res2.statusCode).toBe(401);
    expect(res2.json().error.code).toBe('invalid_token');

    await app.close();
  });

  it('Missing Authorization header → 401', async () => {
    const app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('invalid_token');
    expect(body.error.message).toContain('Missing Authorization header');

    await app.close();
  });
});
