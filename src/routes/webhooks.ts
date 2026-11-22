import type { FastifyPluginAsync } from 'fastify';
import type { WebhookReceiver } from 'livekit-server-sdk';
import { LiveKitWebhookService } from '../modules/webhooks/livekit.js';

export interface WebhooksRoutesOptions {
  receiver?: WebhookReceiver;
}

export const webhooksRoutes: FastifyPluginAsync<WebhooksRoutesOptions> = async (
  fastify,
  opts
) => {
  const webhookService = new LiveKitWebhookService(
    fastify.config,
    fastify.callsRepo,
    fastify.redis,
    fastify.eventsPublisher,
    fastify.livekit.roomService,
    fastify.log,
    opts.receiver
  );

  // Scoped content type parser for raw body handling
  fastify.addContentTypeParser(
    ['application/json', 'application/webhook+json'],
    { parseAs: 'string', bodyLimit: fastify.config.WEBHOOK_BODY_LIMIT_BYTES },
    (_req, body, done) => {
      done(null, body);
    }
  );

  fastify.post(
    '/webhooks/livekit',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'LiveKit server webhook event receiver',
        description:
          'Receives and verifies WebRTC room and participant events from LiveKit server using LiveKit token signature verification.',
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader) {
        request.log.warn('LiveKit webhook missing authorization header');
        return reply.status(401).send({
          error: {
            code: 'invalid_webhook_signature',
            message: 'Missing webhook signature header',
          },
        });
      }

      const rawBody = (request.body as string) || '';

      let event: any;
      try {
        event = await webhookService.verifyAndParse(rawBody, authHeader);
      } catch (err: any) {
        request.log.warn({ err: err.message }, 'LiveKit webhook signature verification failed');
        return reply.status(401).send({
          error: {
            code: 'invalid_webhook_signature',
            message: 'Invalid webhook signature',
          },
        });
      }

      try {
        await webhookService.processEvent(event);
      } catch (err: any) {
        request.log.error({ err: err.message, event: event?.event }, 'Error processing LiveKit webhook');
      }

      // Always return 200 on valid signature so LiveKit doesn't retry indefinitely
      return reply.status(200).send({ ok: true });
    }
  );
};
