import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { type Config, config as defaultConfig } from '../config.js';

export interface DecodedToken {
  sub: string;
  sid?: string;
  email?: string;
  aud?: string | string[];
  exp?: number;
  [key: string]: unknown;
}

export interface UserContext {
  userId: string;
  sessionId?: string;
  email?: string;
}

export interface JwtPluginOptions {
  config: Config;
  keySet?: JWTVerifyGetKey;
}

declare module 'fastify' {
  interface FastifyInstance {
    verifyJwt: (token: string) => Promise<DecodedToken>;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    jwksStatus: 'ok' | 'stale';
  }
  interface FastifyRequest {
    user?: UserContext;
  }
}

let activeKeySet: JWTVerifyGetKey | null = null;
let activeConfig: Config | null = null;

const plugin: FastifyPluginAsync<JwtPluginOptions> = async (
  fastify: FastifyInstance,
  options: JwtPluginOptions
) => {
  const cfg = options.config;
  activeConfig = cfg;

  let keySet: JWTVerifyGetKey;
  let jwksStatus: 'ok' | 'stale' = 'ok';

  if (options.keySet) {
    keySet = options.keySet;
    jwksStatus = 'ok';
  } else {
    keySet = createRemoteJWKSet(new URL(cfg.AUTH_JWKS_URL));

    // Attempt to ping / fetch JWKS on boot to verify reachable status
    try {
      const response = await fetch(cfg.AUTH_JWKS_URL);
      if (!response.ok) {
        jwksStatus = 'stale';
        fastify.log.warn(
          `[JWT] Initial JWKS fetch returned HTTP ${response.status} from ${cfg.AUTH_JWKS_URL}`
        );
      } else {
        fastify.log.info(`[JWT] Initial JWKS fetch successful from ${cfg.AUTH_JWKS_URL}`);
      }
    } catch (err: any) {
      jwksStatus = 'stale';
      fastify.log.warn(
        { err },
        `[JWT] Failed to reach JWKS endpoint at boot: ${cfg.AUTH_JWKS_URL}`
      );
    }
  }

  activeKeySet = keySet;
  fastify.decorate('jwksStatus', jwksStatus);

  const verifyJwt = async (token: string): Promise<DecodedToken> => {
    const acceptedIssuers = Array.from(
      new Set([cfg.JWT_ISSUER, 'nebron-auth'])
    );
    const { payload } = await jwtVerify(token, keySet, {
      issuer: acceptedIssuers,
      audience: cfg.JWT_AUDIENCE,
      algorithms: ['RS256'],
    });

    if (!payload.sub) {
      throw new Error('Token is missing sub claim');
    }

    return {
      sub: payload.sub,
      sid: (payload.sid as string) || (payload.sessionId as string),
      email: payload.email as string | undefined,
      aud: payload.aud,
      exp: payload.exp,
    };
  };

  fastify.decorate('verifyJwt', verifyJwt);

  const authenticate = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return reply.status(401).send({
        error: {
          code: 'invalid_token',
          message: 'Missing Authorization header',
        },
      });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
      return reply.status(401).send({
        error: {
          code: 'invalid_token',
          message: 'Malformed Authorization header. Format: Bearer <token>',
        },
      });
    }

    const token = parts[1];
    try {
      const decoded = await fastify.verifyJwt(token);
      req.user = {
        userId: decoded.sub,
        sessionId: decoded.sid,
        email: decoded.email,
      };
    } catch (err: any) {
      return reply.status(401).send({
        error: {
          code: 'invalid_token',
          message: err.message || 'Token verification failed',
        },
      });
    }
  };

  fastify.decorate('authenticate', authenticate);
};

export const jwtPlugin = fp(plugin);

/**
 * Test helper to verify an access token directly.
 */
export async function verifyAccessTokenForTest(
  token: string,
  keySetOverride?: JWTVerifyGetKey,
  configOverride?: Partial<Config>
): Promise<DecodedToken> {
  const cfg = {
    ...(activeConfig || defaultConfig),
    ...configOverride,
  };
  const keySet =
    keySetOverride ||
    activeKeySet ||
    createRemoteJWKSet(new URL(cfg.AUTH_JWKS_URL));

  const acceptedIssuers = Array.from(
    new Set([cfg.JWT_ISSUER, 'nebron-auth'])
  );
  const { payload } = await jwtVerify(token, keySet, {
    issuer: acceptedIssuers,
    audience: cfg.JWT_AUDIENCE,
    algorithms: ['RS256'],
  });

  if (!payload.sub) {
    throw new Error('Token is missing sub claim');
  }

  return {
    sub: payload.sub,
    sid: (payload.sid as string) || (payload.sessionId as string),
    email: payload.email as string | undefined,
    aud: payload.aud,
    exp: payload.exp,
  };
}
