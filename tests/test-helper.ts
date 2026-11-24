import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type KeyLike } from 'jose';
import cassandra from 'cassandra-driver';
import { Redis } from 'ioredis';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { TokenVerifier, AccessToken } from 'livekit-server-sdk';
import { buildApp, type BuildAppOptions } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import type { Config } from '../src/config.js';

let testPrivateKey: KeyLike | null = null;
let testPublicKey: KeyLike | null = null;
let testJwks: ReturnType<typeof createLocalJWKSet> | null = null;

export async function initTestAuth() {
  if (testPrivateKey && testJwks) {
    return { privateKey: testPrivateKey, jwks: testJwks };
  }

  const pair = await generateKeyPair('RS256', { extractable: true });
  testPrivateKey = pair.privateKey;
  testPublicKey = pair.publicKey;

  const jwk = await exportJWK(testPublicKey);
  jwk.kid = 'test-voice-key-id';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  testJwks = createLocalJWKSet({ keys: [jwk] });
  return { privateKey: testPrivateKey, jwks: testJwks };
}

export async function createTestToken(
  userId: string,
  options?: {
    email?: string;
    sessionId?: string;
    sid?: string;
    issuer?: string;
    audience?: string | string[];
    expiresIn?: string;
  }
): Promise<string> {
  const { privateKey } = await initTestAuth();
  const sessionVal = options?.sessionId || options?.sid || 'test-session';

  return new SignJWT({
    sub: userId,
    sessionId: sessionVal,
    sid: sessionVal,
    email: options?.email || `${userId}@nebron.com`,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-voice-key-id' })
    .setIssuer(options?.issuer || 'nebron-auth')
    .setAudience(options?.audience || ['voice'])
    .setIssuedAt()
    .setExpirationTime(options?.expiresIn || '1h')
    .sign(privateKey);
}

export interface TestKeyspaceContext {
  keyspace: string;
  client: cassandra.Client;
  drop: () => Promise<void>;
}

export async function setupTestKeyspace(
  scyllaHost = '127.0.0.1:9042',
  datacenter = 'datacenter1'
): Promise<TestKeyspaceContext> {
  const keyspace = `test_${crypto.randomUUID().replace(/-/g, '_')}`;

  const bootstrapClient = new cassandra.Client({
    contactPoints: [scyllaHost],
    localDataCenter: datacenter,
  });
  await bootstrapClient.connect();

  await bootstrapClient.execute(
    `CREATE KEYSPACE "${keyspace}" WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`
  );

  const client = new cassandra.Client({
    contactPoints: [scyllaHost],
    localDataCenter: datacenter,
    keyspace,
  });
  await client.connect();

  await runMigrations(client, keyspace);

  return {
    keyspace,
    client,
    drop: async () => {
      await client.shutdown();
      await bootstrapClient.execute(`DROP KEYSPACE IF EXISTS "${keyspace}"`);
      await bootstrapClient.shutdown();
    },
  };
}

export interface MockCoreServer {
  url: string;
  setRelationship(
    targetUserId: string,
    state: { blocked?: boolean; muted?: { calls?: boolean } }
  ): void;
  setStatusCode(code: number | null): void;
  getLastAuthHeader(): string | null;
  reset(): void;
  close(): Promise<void>;
}

export function startMockCoreServer(port = 0): Promise<MockCoreServer> {
  const relationships = new Map<
    string,
    { blocked?: boolean; muted?: { calls?: boolean } }
  >();
  let overrideStatusCode: number | null = null;
  let lastAuthHeader: string | null = null;

  const server = http.createServer((req, res) => {
    lastAuthHeader = req.headers['x-internal-token'] as string || null;

    if (overrideStatusCode !== null) {
      res.writeHead(overrideStatusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'error', message: 'Simulated core error' } }));
      return;
    }

    const parsedUrl = new URL(req.url || '', 'http://127.0.0.1');
    if (parsedUrl.pathname === '/relationships/check') {
      const userIds = (parsedUrl.searchParams.get('userIds') || '').split(',').filter(Boolean);
      const data: Record<string, any> = {};
      for (const id of userIds) {
        data[id] = relationships.get(id) || {
          blocked: false,
          muted: { calls: false },
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        setRelationship(targetUserId, state) {
          relationships.set(targetUserId, state);
        },
        setStatusCode(code) {
          overrideStatusCode = code;
        },
        getLastAuthHeader() {
          return lastAuthHeader;
        },
        reset() {
          relationships.clear();
          overrideStatusCode = null;
          lastAuthHeader = null;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export class SignalTracker {
  private sub: Redis;
  private messages: Array<{ channel: string; data: any }> = [];
  private waiters: Array<{
    predicate: (channel: string, msg: any) => boolean;
    resolve: (msg: any) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(sub: Redis) {
    this.sub = sub;
    this.sub.on('message', (channel, message) => {
      try {
        const parsed = JSON.parse(message);
        const idx = this.waiters.findIndex((w) => w.predicate(channel, parsed));
        if (idx !== -1) {
          const waiter = this.waiters.splice(idx, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        } else {
          this.messages.push({ channel, data: parsed });
        }
      } catch {
        // ignore
      }
    });
  }

  async subscribe(channel: string): Promise<void> {
    await this.sub.subscribe(channel);
  }

  async waitForSignal(
    channel: string,
    type?: string,
    timeoutMs = 4000
  ): Promise<any> {
    const pred = (ch: string, data: any) =>
      ch === channel && (!type || data.type === type);
    const existingIdx = this.messages.findIndex((m) => pred(m.channel, m.data));
    if (existingIdx !== -1) {
      return this.messages.splice(existingIdx, 1)[0].data;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for signal on ${channel} (type: ${type})`));
      }, timeoutMs);
      this.waiters.push({ predicate: pred, resolve, timer });
    });
  }

  clear(): void {
    this.messages = [];
    this.waiters.forEach((w) => clearTimeout(w.timer));
    this.waiters = [];
  }

  async close(): Promise<void> {
    await this.sub.quit();
  }
}

export async function createSignalTracker(
  redisUrl = 'redis://127.0.0.1:6379'
): Promise<SignalTracker> {
  const sub = new Redis(redisUrl, { lazyConnect: true });
  await sub.connect();
  return new SignalTracker(sub);
}

export async function readEventForCall(
  redis: Redis,
  callId: string,
  stream = 'nebron.events'
): Promise<any> {
  const res = await redis.xrevrange(stream, '+', '-', 'COUNT', 50);
  if (!res || res.length === 0) return null;
  for (const [id, fields] of res) {
    const obj: Record<string, any> = { id };
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    if (obj.type && !obj.event_type) {
      obj.event_type = obj.type;
    }
    if (obj.payload) {
      try {
        obj.payload = JSON.parse(obj.payload);
      } catch {
        // ignore
      }
    }
    if (obj.payload?.callId === callId) {
      return obj;
    }
  }
  return null;
}

export async function readLatestEvent(
  redis: Redis,
  stream = 'nebron.events'
): Promise<any> {
  const res = await redis.xrevrange(stream, '+', '-', 'COUNT', 1);
  if (!res || res.length === 0) return null;
  const [id, fields] = res[0];
  const obj: Record<string, any> = { id };
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  if (obj.type && !obj.event_type) {
    obj.event_type = obj.type;
  }
  if (obj.payload) {
    try {
      obj.payload = JSON.parse(obj.payload);
    } catch {
      // ignore
    }
  }
  return obj;
}

export async function verifyLiveKitToken(
  token: string,
  apiKey = 'test-api-key',
  apiSecret = 'test-api-secret'
) {
  const verifier = new TokenVerifier(apiKey, apiSecret);
  return verifier.verify(token);
}

export async function createLiveKitWebhookHeader(
  body: string,
  apiKey = 'test-api-key',
  apiSecret = 'test-api-secret'
): Promise<string> {
  const hash = crypto.createHash('sha256').update(body).digest('base64');
  const token = new AccessToken(apiKey, apiSecret, { identity: 'webhook' });
  (token as any).sha256 = hash;
  return await token.toJwt();
}

export async function createRealTestApp(
  keyspaceContext: TestKeyspaceContext,
  configOverrides?: Partial<Config>,
  optionsOverrides?: Partial<BuildAppOptions>
) {
  const { jwks } = await initTestAuth();

  const redis = new Redis('redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  await redis.connect();

  const testConfig: Config = {
    PORT: 4004,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SCYLLA_HOSTS: '127.0.0.1:9042',
    SCYLLA_KEYSPACE: keyspaceContext.keyspace,
    SCYLLA_DATACENTER: 'datacenter1',
    REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
    JWT_ISSUER: 'nebron-auth',
    JWT_AUDIENCE: 'voice',
    LIVEKIT_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_PUBLIC_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_HTTP_URL: 'http://127.0.0.1:7880',
    LIVEKIT_API_KEY: 'test-api-key',
    LIVEKIT_API_SECRET: 'test-api-secret',
    CORE_URL: 'http://127.0.0.1:4002',
    INTERNAL_TOKEN: 'test-internal-token',
    EVENTS_STREAM: 'nebron.events',
    CALL_RING_TIMEOUT_SECONDS: 45,
    CALL_MAX_DURATION_SECONDS: 14400,
    LIVEKIT_TOKEN_TTL_SECONDS: 3600,
    CALL_TIMEOUT_POLL_INTERVAL_MS: 5000,
    ...configOverrides,
  };

  const defaultRoomService = {
    listRooms: async () => [],
    listParticipants: async () => [],
    deleteRoom: async () => undefined,
  } as unknown as any;

  const app = await buildApp({
    config: testConfig,
    scyllaClient: keyspaceContext.client,
    redisClient: redis,
    jwksKeySet: jwks,
    roomService: optionsOverrides?.roomService || defaultRoomService,
    startTimeoutJob: false,
    startReconcileJob: false,
    disableRateLimit: true,
    ...optionsOverrides,
  });

  return { app, redis };
}
