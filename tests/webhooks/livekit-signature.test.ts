import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestKeyspace,
  createRealTestApp,
  createLiveKitWebhookHeader,
  type TestKeyspaceContext,
} from '../test-helper.js';

describe('LiveKit Webhook Signature Verification', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;

  beforeAll(async () => {
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  it('valid signature → 200', async () => {
    const payload = JSON.stringify({
      event: 'room_started',
      room: { name: 'test-room-1', numParticipants: 0 },
    });
    const authHeader = await createLiveKitWebhookHeader(
      payload,
      'test-api-key',
      'test-api-secret'
    );

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: {
        authorization: authHeader,
        'content-type': 'application/json',
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('invalid signature → 401 invalid_webhook_signature', async () => {
    const payload = JSON.stringify({
      event: 'room_started',
      room: { name: 'test-room-2' },
    });
    // Signed with wrong secret
    const badHeader = await createLiveKitWebhookHeader(
      payload,
      'test-api-key',
      'wrong-secret'
    );

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: {
        authorization: badHeader,
        'content-type': 'application/json',
      },
      payload,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_webhook_signature');
  });

  it('missing signature header → 401 invalid_webhook_signature', async () => {
    const payload = JSON.stringify({
      event: 'room_started',
      room: { name: 'test-room-3' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: {
        'content-type': 'application/json',
      },
      payload,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_webhook_signature');
  });

  it('accepts Content-Type application/webhook+json', async () => {
    const payload = JSON.stringify({
      event: 'room_started',
      room: { name: 'test-room-4', numParticipants: 0 },
    });
    const authHeader = await createLiveKitWebhookHeader(
      payload,
      'test-api-key',
      'test-api-secret'
    );

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: {
        authorization: authHeader,
        'content-type': 'application/webhook+json',
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
