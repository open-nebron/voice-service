import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const StartCallBodySchema = z.object({
  calleeId: z.string().regex(UUID_REGEX, 'calleeId must be a valid UUID'),
});

const RejectCallBodySchema = z.object({
  reason: z.string().max(80).default('reject').optional(),
});

const EndCallBodySchema = z.object({
  reason: z.string().max(80).default('hangup').optional(),
});

export const callsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // 1. POST /calls (10/min)
  app.post(
    '/calls',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60000,
        },
      },
      schema: {
        description: 'Initiate a 1:1 voice call to a peer user',
        tags: ['Calls'],
        body: {
          type: 'object',
          required: ['calleeId'],
          properties: {
            calleeId: {
              type: 'string',
              format: 'uuid',
              description: 'Target peer user ID to call',
            },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              callerId: { type: 'string' },
              calleeId: { type: 'string' },
              state: { type: 'string' },
              roomName: { type: 'string' },
              createdAt: { type: 'string' },
            },
            required: ['id', 'callerId', 'calleeId', 'state', 'roomName', 'createdAt'],
          },
        },
      },
    },
    async (req, reply) => {
      const parsedBody = StartCallBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: {
            code: 'invalid_payload',
            message: parsedBody.error.issues[0]?.message || 'Invalid calleeId uuid',
          },
        });
      }

      const callerId = req.user!.userId;
      const { calleeId } = parsedBody.data;

      const call = await app.callsService.startCall(callerId, calleeId);
      return reply.status(201).send({
        id: call.id,
        callerId: call.callerId,
        calleeId: call.calleeId,
        state: call.state,
        roomName: call.roomName,
        createdAt: call.createdAt ? new Date(call.createdAt).toISOString() : new Date().toISOString(),
      });
    }
  );

  // 2. POST /calls/:id/accept (20/min)
  app.post(
    '/calls/:id/accept',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 20,
          timeWindow: 60000,
        },
      },
      schema: {
        description: 'Accept an incoming ringing call (callee only)',
        tags: ['Calls'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              call: { type: 'object', additionalProperties: true },
              callerToken: { type: 'string' },
              calleeToken: { type: 'string' },
              livekitUrl: { type: 'string' },
            },
            required: ['call', 'callerToken', 'calleeToken', 'livekitUrl'],
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.userId;

      const result = await app.callsService.acceptCall(id, userId);
      return reply.status(200).send(result);
    }
  );

  // 3. POST /calls/:id/reject (20/min)
  app.post(
    '/calls/:id/reject',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 20,
          timeWindow: 60000,
        },
      },
      schema: {
        description: 'Reject an incoming ringing call (callee only)',
        tags: ['Calls'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          additionalProperties: true,
          nullable: true,
          properties: {
            reason: { type: 'string', maxLength: 80 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.userId;
      const parsedBody = RejectCallBodySchema.safeParse(req.body || {});
      const reason = parsedBody.success ? parsedBody.data.reason || 'reject' : 'reject';

      const call = await app.callsService.rejectCall(id, userId, reason);
      return reply.status(200).send(call);
    }
  );

  // 4. POST /calls/:id/end (30/min)
  app.post(
    '/calls/:id/end',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60000,
        },
      },
      schema: {
        description: 'End an active call or cancel an outbound ringing call',
        tags: ['Calls'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          additionalProperties: true,
          nullable: true,
          properties: {
            reason: { type: 'string', maxLength: 80 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.userId;
      const parsedBody = EndCallBodySchema.safeParse(req.body || {});
      const reason = parsedBody.success ? parsedBody.data.reason || 'hangup' : 'hangup';

      const call = await app.callsService.endCall(id, userId, reason);
      return reply.status(200).send(call);
    }
  );

  // 5. GET /calls/active (120/min)
  app.get(
    '/calls/active',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 120,
          timeWindow: 60000,
        },
      },
      schema: {
        description: 'Get current active call (ringing or accepted) for the calling user',
        tags: ['Calls'],
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
          },
          204: {
            type: 'null',
            description: 'No active call currently in progress',
          },
        },
      },
    },
    async (req, reply) => {
      const userId = req.user!.userId;
      const activeCall = await app.callsService.getActiveCall(userId);
      if (!activeCall) {
        return reply.status(204).send();
      }
      return reply.status(200).send(activeCall);
    }
  );

  // 6. GET /calls/:id (120/min)
  app.get(
    '/calls/:id',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 120,
          timeWindow: 60000,
        },
      },
      schema: {
        description: 'Get call details with peer status for participant',
        tags: ['Calls'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.userId;

      const call = await app.callsService.getCall(id, userId);
      return reply.status(200).send(call);
    }
  );

  // 7. POST /calls/:id/tokens (10/min)
  app.post(
    '/calls/:id/tokens',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60000,
        },
      },
      schema: {
        description: 'Obtain fresh LiveKit access token for reconnects during an accepted call',
        tags: ['Calls'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              livekitUrl: { type: 'string' },
              roomName: { type: 'string' },
            },
            required: ['token', 'livekitUrl', 'roomName'],
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.userId;

      const result = await app.callsService.refreshToken(id, userId);
      return reply.status(200).send(result);
    }
  );

  // 8. GET /calls?limit=30&before=<ISO> (60/min)
  app.get(
    '/calls',
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60000,
        },
      },
      schema: {
        description: 'List call history for calling user (caller or callee), sorted DESC by created_at',
        tags: ['Calls'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', default: 30, minimum: 1, maximum: 100 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (req, reply) => {
      const userId = req.user!.userId;
      const { limit = 30, before } = req.query as { limit?: number; before?: string };

      const result = await app.callsService.listHistory(userId, Number(limit), before);
      return reply.status(200).send(result);
    }
  );
};
