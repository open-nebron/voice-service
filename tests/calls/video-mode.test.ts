import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  startMockCoreServer,
  verifyLiveKitToken,
  type TestKeyspaceContext,
  type MockCoreServer,
} from '../test-helper.js';

describe('Video Calls and LiveKit Grants (mode: audio | video)', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context, {
      CORE_URL: mockCore.url,
      LIVEKIT_API_KEY: 'test-api-key',
      LIVEKIT_API_SECRET: 'test-api-secret',
      LIVEKIT_URL: 'ws://livekit-internal:7880',
      LIVEKIT_PUBLIC_URL: 'ws://127.0.0.1:7880',
    });
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
    await mockCore.close();
    await context.drop();
  });

  beforeEach(() => {
    mockCore.reset();
  });

  async function initiateAndAcceptCall(mode?: 'audio' | 'video') {
    const callerId = crypto.randomUUID();
    const calleeId = crypto.randomUUID();
    const callerJwt = await createTestToken(callerId);
    const calleeJwt = await createTestToken(calleeId);

    const startPayload: Record<string, unknown> = { calleeId };
    if (mode) {
      startPayload.mode = mode;
    }

    const startRes = await app.inject({
      method: 'POST',
      url: '/calls',
      headers: { authorization: `Bearer ${callerJwt}` },
      payload: startPayload,
    });
    expect(startRes.statusCode).toBe(201);
    const callData = startRes.json();
    expect(callData.mode).toBe(mode || 'audio');

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/calls/${callData.id}/accept`,
      headers: { authorization: `Bearer ${calleeJwt}` },
    });
    expect(acceptRes.statusCode).toBe(200);
    const acceptData = acceptRes.json();

    return {
      callId: callData.id,
      callerId,
      calleeId,
      callerJwt,
      calleeJwt,
      callerToken: acceptData.callerToken,
      calleeToken: acceptData.calleeToken,
    };
  }

  // 1. Audio call → token grants only microphone
  it('Audio call → token grants only microphone', async () => {
    const { callerToken, calleeToken } = await initiateAndAcceptCall('audio');

    const callerClaims = await verifyLiveKitToken(callerToken);
    const calleeClaims = await verifyLiveKitToken(calleeToken);

    expect(callerClaims.video?.canPublish).toEqual(['microphone']);
    expect(callerClaims.video?.canSubscribe).toBe(true);
    expect(callerClaims.video?.roomJoin).toBe(true);

    expect(calleeClaims.video?.canPublish).toEqual(['microphone']);
    expect(calleeClaims.video?.canSubscribe).toBe(true);
    expect(calleeClaims.video?.roomJoin).toBe(true);
  });

  // 2. Video call → token grants microphone, camera, screen_share
  it('Video call → token grants microphone, camera, screen_share', async () => {
    const { callerToken, calleeToken } = await initiateAndAcceptCall('video');

    const callerClaims = await verifyLiveKitToken(callerToken);
    const calleeClaims = await verifyLiveKitToken(calleeToken);

    expect(callerClaims.video?.canPublish).toEqual(['microphone', 'camera', 'screen_share']);
    expect(callerClaims.video?.canSubscribe).toBe(true);
    expect(callerClaims.video?.roomJoin).toBe(true);

    expect(calleeClaims.video?.canPublish).toEqual(['microphone', 'camera', 'screen_share']);
    expect(calleeClaims.video?.canSubscribe).toBe(true);
    expect(calleeClaims.video?.roomJoin).toBe(true);
  });

  // 3. Token refresh preserves mode
  it('Token refresh preserves mode', async () => {
    // 3a. Audio call refresh
    const audioCall = await initiateAndAcceptCall('audio');
    const audioRefreshRes = await app.inject({
      method: 'POST',
      url: `/calls/${audioCall.callId}/tokens`,
      headers: { authorization: `Bearer ${audioCall.callerJwt}` },
    });
    expect(audioRefreshRes.statusCode).toBe(200);
    const audioRefreshData = audioRefreshRes.json();
    const audioRefreshClaims = await verifyLiveKitToken(audioRefreshData.token);
    expect(audioRefreshClaims.video?.canPublish).toEqual(['microphone']);

    // 3b. Video call refresh
    const videoCall = await initiateAndAcceptCall('video');
    const videoRefreshRes = await app.inject({
      method: 'POST',
      url: `/calls/${videoCall.callId}/tokens`,
      headers: { authorization: `Bearer ${videoCall.calleeJwt}` },
    });
    expect(videoRefreshRes.statusCode).toBe(200);
    const videoRefreshData = videoRefreshRes.json();
    const videoRefreshClaims = await verifyLiveKitToken(videoRefreshData.token);
    expect(videoRefreshClaims.video?.canPublish).toEqual(['microphone', 'camera', 'screen_share']);
  });

  // 4. Screen share works mid-video-call (via grants, verified by token decode)
  it('Screen share works mid-video-call (via grants, verified by token decode)', async () => {
    const videoCall = await initiateAndAcceptCall('video');

    // Verify both participants have screen_share permission in their live tokens
    const callerClaims = await verifyLiveKitToken(videoCall.callerToken);
    const calleeClaims = await verifyLiveKitToken(videoCall.calleeToken);

    const callerPublishList = (callerClaims.video?.canPublish as string[]) || [];
    const calleePublishList = (calleeClaims.video?.canPublish as string[]) || [];

    expect(callerPublishList).toContain('screen_share');
    expect(callerPublishList).toContain('camera');
    expect(callerPublishList).toContain('microphone');

    expect(calleePublishList).toContain('screen_share');
    expect(calleePublishList).toContain('camera');
    expect(calleePublishList).toContain('microphone');
  });
});
