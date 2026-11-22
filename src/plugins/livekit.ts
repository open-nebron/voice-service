import { RoomServiceClient, AccessToken, type AccessTokenOptions } from 'livekit-server-sdk';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Config } from '../config.js';

export interface MakeAccessTokenOptions {
  identity: string;
  room?: string;
  ttl?: number | string;
  grants?: any;
}

export type MakeAccessTokenFn = {
  (options: MakeAccessTokenOptions): Promise<string>;
  (userId: string, roomName?: string, options?: Partial<AccessTokenOptions>): Promise<string>;
};

export interface LiveKitService {
  roomService: RoomServiceClient;
  makeAccessToken: MakeAccessTokenFn;
  ping: () => Promise<boolean>;
  AccessToken: typeof AccessToken;
}

export interface LiveKitPluginOptions {
  config: Config;
  roomService?: RoomServiceClient;
}

declare module 'fastify' {
  interface FastifyInstance {
    livekit: LiveKitService;
    livekitStatus: 'ok' | 'degraded';
  }
}

const plugin: FastifyPluginAsync<LiveKitPluginOptions> = async (
  fastify: FastifyInstance,
  options: LiveKitPluginOptions
) => {
  const cfg = options.config;

  const roomService =
    options.roomService ||
    new RoomServiceClient(cfg.LIVEKIT_HTTP_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET);

  let livekitStatus: 'ok' | 'degraded' = 'ok';

  // Test connectivity at boot: RoomServiceClient.listRooms() with 3s timeout
  try {
    let bootTimeoutHandle: NodeJS.Timeout;
    const bootTimeout = new Promise<never>((_, reject) => {
      bootTimeoutHandle = setTimeout(
        () => reject(new Error('LiveKit boot connection timeout')),
        3000
      );
    });
    try {
      await Promise.race([roomService.listRooms(), bootTimeout]);
      fastify.log.info('livekit: connected');
      livekitStatus = 'ok';
    } finally {
      clearTimeout(bootTimeoutHandle!);
    }
  } catch (err: any) {
    fastify.log.warn(
      { err: err.message },
      '[LiveKit] Connection attempt failed at boot. Running in degraded mode.'
    );
    livekitStatus = 'degraded';
  }

  const ping = async (): Promise<boolean> => {
    try {
      let timeoutHandle: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('LiveKit ping timeout')), 2000);
      });
      try {
        await Promise.race([roomService.listRooms(), timeoutPromise]);
        return true;
      } finally {
        clearTimeout(timeoutHandle!);
      }
    } catch {
      return false;
    }
  };

  const makeAccessToken: MakeAccessTokenFn = (async (
    optionsOrUserId: string | MakeAccessTokenOptions,
    roomName?: string,
    tokenOptions?: Partial<AccessTokenOptions>
  ): Promise<string> => {
    if (typeof optionsOrUserId === 'object') {
      const at = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, {
        identity: optionsOrUserId.identity,
        ttl: optionsOrUserId.ttl ?? cfg.LIVEKIT_TOKEN_TTL_SECONDS,
      });
      if (optionsOrUserId.grants) {
        at.addGrant(optionsOrUserId.grants);
      } else if (optionsOrUserId.room) {
        at.addGrant({ roomJoin: true, room: optionsOrUserId.room });
      }
      return await at.toJwt();
    }

    const at = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, {
      identity: optionsOrUserId,
      ttl: cfg.LIVEKIT_TOKEN_TTL_SECONDS,
      ...tokenOptions,
    });
    if (roomName) {
      at.addGrant({ roomJoin: true, room: roomName });
    }
    return await at.toJwt();
  }) as MakeAccessTokenFn;

  const livekit: LiveKitService = {
    roomService,
    makeAccessToken,
    ping,
    AccessToken,
  };

  fastify.decorate('livekit', livekit);
  fastify.decorate('livekitStatus', livekitStatus);
};

export const livekitPlugin = fp(plugin);
