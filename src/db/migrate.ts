import type cassandra from 'cassandra-driver';

export interface MigrationLogger {
  info: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

/**
 * Runs idempotent database migrations for Nebron voice-service.
 * Creates keyspace if not exists and the calls table with indexes.
 */
export async function runMigrations(
  client: cassandra.Client,
  keyspace: string = 'nebron',
  logger?: MigrationLogger
): Promise<void> {
  const log: MigrationLogger = logger || console;

  try {
    // 1. Ensure Keyspace exists
    await client.execute(`
      CREATE KEYSPACE IF NOT EXISTS "${keyspace}"
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
    `);

    // 2. calls table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "${keyspace}".calls (
        id              uuid,
        caller_id       uuid,
        callee_id       uuid,
        state           text,
        room_name       text,
        created_at      timestamp,
        accepted_at     timestamp,
        ended_at        timestamp,
        ended_by        uuid,
        end_reason      text,
        mode            text,
        PRIMARY KEY (id)
      )
    `);

    // Add mode column if upgrading existing table
    try {
      await client.execute(`ALTER TABLE "${keyspace}".calls ADD mode text`);
    } catch {
      // Column may already exist
    }

    // 3. Indexes
    await client.execute(`
      CREATE INDEX IF NOT EXISTS calls_by_caller ON "${keyspace}".calls (caller_id)
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS calls_by_callee ON "${keyspace}".calls (callee_id)
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS calls_by_state ON "${keyspace}".calls (state)
    `);

    log.info('schema migrated');
  } catch (err: any) {
    if (process.env.NODE_ENV === 'test') {
      if ('warn' in log && typeof log.warn === 'function') {
        log.warn(`[ScyllaDB] Migration skipped/mocked in test: ${err.message}`);
      }
      return;
    }

    if ('error' in log && typeof log.error === 'function') {
      log.error({ err }, `[ScyllaDB] Migration failed: ${err.message}`);
    } else {
      console.error(`[ScyllaDB] Migration failed: ${err.message}`);
    }
    process.exit(1);
  }
}
