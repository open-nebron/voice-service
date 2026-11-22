import cassandra from 'cassandra-driver';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Config } from '../config.js';

export interface ScyllaPluginOptions {
  config: Config;
  client?: cassandra.Client;
}

declare module 'fastify' {
  interface FastifyInstance {
    scylla: cassandra.Client;
  }
}

const plugin: FastifyPluginAsync<ScyllaPluginOptions> = async (
  fastify: FastifyInstance,
  options: ScyllaPluginOptions
) => {
  if (options.client) {
    fastify.decorate('scylla', options.client);
    fastify.addHook('onClose', async () => {
      await options.client!.shutdown();
    });
    return;
  }

  const { SCYLLA_HOSTS, SCYLLA_DATACENTER, SCYLLA_KEYSPACE } = options.config;
  const contactPoints = SCYLLA_HOSTS.split(',').map((h: string) => h.trim());

  const client = new cassandra.Client({
    contactPoints,
    localDataCenter: SCYLLA_DATACENTER,
    keyspace: SCYLLA_KEYSPACE,
  });

  const maxRetries = 10;
  const retryDelayMs = 3000;
  let connected = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fastify.log.info(
        `[ScyllaDB] Connecting to ScyllaDB at ${contactPoints.join(', ')} (attempt ${attempt}/${maxRetries})...`
      );
      const bootstrapClient = new cassandra.Client({
        contactPoints,
        localDataCenter: SCYLLA_DATACENTER,
      });
      await bootstrapClient.connect();
      await bootstrapClient.execute(
        `CREATE KEYSPACE IF NOT EXISTS "${SCYLLA_KEYSPACE}" WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`
      );
      await bootstrapClient.shutdown();

      await client.connect();
      fastify.log.info('[ScyllaDB] Successfully connected to ScyllaDB');
      connected = true;
      break;
    } catch (err: any) {
      fastify.log.warn(
        `[ScyllaDB] Connection attempt ${attempt}/${maxRetries} failed: ${err.message}`
      );
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  if (!connected) {
    fastify.log.error(
      '[ScyllaDB] All 10 connection attempts to ScyllaDB failed. Exiting process.'
    );
    process.exit(1);
  }

  fastify.decorate('scylla', client);

  fastify.addHook('onClose', async () => {
    try {
      await client.shutdown();
      fastify.log.info('[ScyllaDB] Client connection shut down cleanly');
    } catch (err: any) {
      fastify.log.error({ err }, '[ScyllaDB] Error while shutting down client');
    }
  });
};

export const scyllaPlugin = fp(plugin);
