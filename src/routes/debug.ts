import type { FastifyPluginAsync } from 'fastify';

export const debugRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/calls/:id/debug',
    {
      schema: {
        tags: ['Calls'],
        summary: 'Internal call state and LiveKit diagnostic inspection',
        description:
          'Inspects call record state from ScyllaDB and compares against live WebRTC room state in LiveKit to detect state divergence (e.g. stuck calls or orphan rooms). Protected by X-Internal-Token header.',
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
            additionalProperties: true,
            required: ['call', 'livekit', 'divergence'],
            properties: {
              call: {
                type: 'object',
                additionalProperties: true,
              },
              livekit: {
                type: 'object',
                additionalProperties: true,
                required: ['roomExists', 'participantCount', 'participants'],
                properties: {
                  roomExists: { type: 'boolean' },
                  participantCount: { type: 'number' },
                  participants: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                    },
                  },
                  error: { type: 'string' },
                },
              },
              divergence: {
                type: 'string',
                enum: ['none', 'stuck_call', 'orphan_room'],
              },
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
          404: {
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
          503: {
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
      const internalTokenHeader = request.headers['x-internal-token'];
      const configuredToken = fastify.config.INTERNAL_TOKEN;

      if (!configuredToken) {
        return reply.status(503).send({
          error: {
            code: 'service_unavailable',
            message: 'Internal authentication is not configured',
          },
        });
      }

      if (!internalTokenHeader || internalTokenHeader !== configuredToken) {
        return reply.status(401).send({
          error: {
            code: 'unauthorized',
            message: 'Unauthorized internal access',
          },
        });
      }

      const { id } = request.params as { id: string };
      const call = await fastify.callsRepo.getById(id);

      if (!call) {
        return reply.status(404).send({
          error: {
            code: 'call_not_found',
            message: 'Call not found',
          },
        });
      }

      // Best-effort 2s timeout query against LiveKit
      let livekitState: {
        roomExists: boolean;
        participantCount: number;
        participants: Array<{ identity: string; sid: string; joinedAt?: number }>;
        error?: string;
      };

      try {
        let timeoutHandle: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('LiveKit participant query timeout')),
            2000
          );
        });

        try {
          const participants = await Promise.race([
            fastify.livekit.roomService.listParticipants(call.roomName),
            timeoutPromise,
          ]);

          livekitState = {
            roomExists: true,
            participantCount: participants ? participants.length : 0,
            participants: (participants || []).map((p) => ({
              identity: p.identity,
              sid: p.sid,
              joinedAt: p.joinedAt ? Number(p.joinedAt) : undefined,
            })),
          };
        } finally {
          clearTimeout(timeoutHandle!);
        }
      } catch (err: any) {
        livekitState = {
          roomExists: false,
          participantCount: 0,
          participants: [],
          error: err?.message || 'Failed to query LiveKit',
        };
      }

      let divergence: 'none' | 'stuck_call' | 'orphan_room' = 'none';
      if (call.state === 'accepted' && livekitState.participantCount === 0) {
        divergence = 'stuck_call';
      } else if (call.state === 'ended' && livekitState.participantCount > 0) {
        divergence = 'orphan_room';
      }

      return reply.send({
        call,
        livekit: livekitState,
        divergence,
      });
    }
  );
};
