import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

export const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4004),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  SCYLLA_HOSTS: z.string().default('scylla:9042'),
  SCYLLA_KEYSPACE: z.string().default('nebron'),
  SCYLLA_DATACENTER: z.string().default('datacenter1'),
  REDIS_URL: z
    .string({
      required_error: 'REDIS_URL is required',
      invalid_type_error: 'REDIS_URL must be a string',
    })
    .min(1, 'REDIS_URL is required'),
  AUTH_JWKS_URL: z
    .string({
      required_error: 'AUTH_JWKS_URL is required',
      invalid_type_error: 'AUTH_JWKS_URL must be a string',
    })
    .url('AUTH_JWKS_URL must be a valid URL'),
  JWT_ISSUER: z.string().default('nebron-auth'),
  JWT_AUDIENCE: z.string().default('voice'),
  LIVEKIT_URL: z
    .string({
      required_error: 'LIVEKIT_URL is required',
      invalid_type_error: 'LIVEKIT_URL must be a string',
    })
    .min(1, 'LIVEKIT_URL is required'),
  LIVEKIT_PUBLIC_URL: z
    .string({
      required_error: 'LIVEKIT_PUBLIC_URL is required',
      invalid_type_error: 'LIVEKIT_PUBLIC_URL must be a string',
    })
    .min(1, 'LIVEKIT_PUBLIC_URL is required')
    .default('ws://localhost:7880'),
  LIVEKIT_HTTP_URL: z
    .string({
      required_error: 'LIVEKIT_HTTP_URL is required',
      invalid_type_error: 'LIVEKIT_HTTP_URL must be a string',
    })
    .url('LIVEKIT_HTTP_URL must be a valid URL'),
  LIVEKIT_API_KEY: z
    .string({
      required_error: 'LIVEKIT_API_KEY is required',
      invalid_type_error: 'LIVEKIT_API_KEY must be a string',
    })
    .min(1, 'LIVEKIT_API_KEY is required'),
  LIVEKIT_API_SECRET: z
    .string({
      required_error: 'LIVEKIT_API_SECRET is required',
      invalid_type_error: 'LIVEKIT_API_SECRET must be a string',
    })
    .min(1, 'LIVEKIT_API_SECRET is required'),
  CORE_URL: z.string().default('http://core:4002'),
  CHAT_URL: z.string().default('http://chat:4003'),
  SPACES_URL: z.string().default('http://spaces:4005'),
  MAX_GROUP_CALL_PARTICIPANTS: z.coerce.number().int().positive().default(10),
  INTERNAL_TOKEN: z
    .string({
      required_error: 'INTERNAL_TOKEN is required',
      invalid_type_error: 'INTERNAL_TOKEN must be a string',
    })
    .min(1, 'INTERNAL_TOKEN is required'),
  EVENTS_STREAM: z.string().default('nebron.events'),
  CALL_RING_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(45),
  CALL_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(7200),
  LIVEKIT_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  CALL_TIMEOUT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RECONCILE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  RECONCILE_MIN_CALL_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  RECONCILE_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  WEBHOOK_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1048576),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(envOverrides?: Record<string, unknown>): Config {
  const source = {
    ...process.env,
    ...envOverrides,
  };

  const result = configSchema.safeParse(source);
  if (!result.success) {
    const errorMessages = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration. Missing or invalid environment variables:\n${errorMessages}`
    );
  }

  return result.data;
}

let _configInstance: Config | null = null;

export const config: Config = new Proxy({} as Config, {
  get: (_target, prop: string | symbol) => {
    if (!_configInstance) {
      _configInstance = loadConfig();
    }
    return Reflect.get(_configInstance, prop);
  },
});
