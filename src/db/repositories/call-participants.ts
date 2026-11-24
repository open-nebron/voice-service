import cassandra from 'cassandra-driver';
import { toCassandraUuid, fromCassandraUuid } from '../../lib/id.js';

export interface CallParticipant {
  callId: string;
  userId: string;
  joinedAt: Date;
  leftAt?: Date | null;
}

export class CallParticipantsRepository {
  private readonly client: cassandra.Client;

  constructor(client: cassandra.Client) {
    this.client = client;
  }

  async add(callId: string, userId: string, joinedAt = new Date()): Promise<void> {
    const query = `
      INSERT INTO call_participants (call_id, user_id, joined_at, left_at)
      VALUES (?, ?, ?, null)
    `;
    await this.client.execute(
      query,
      [toCassandraUuid(callId), toCassandraUuid(userId), joinedAt],
      { prepare: true }
    );
  }

  async remove(callId: string, userId: string, leftAt = new Date()): Promise<void> {
    const query = `
      UPDATE call_participants SET left_at = ?
      WHERE call_id = ? AND user_id = ?
    `;
    await this.client.execute(
      query,
      [leftAt, toCassandraUuid(callId), toCassandraUuid(userId)],
      { prepare: true }
    );
  }

  async listActive(callId: string): Promise<string[]> {
    const query = `SELECT user_id, left_at FROM call_participants WHERE call_id = ?`;
    const result = await this.client.execute(query, [toCassandraUuid(callId)], { prepare: true });
    if (!result.rows) return [];
    return result.rows
      .filter((row) => row.left_at === null || row.left_at === undefined)
      .map((row) => fromCassandraUuid(row.user_id));
  }

  async countActive(callId: string): Promise<number> {
    const active = await this.listActive(callId);
    return active.length;
  }

  async isParticipant(callId: string, userId: string): Promise<boolean> {
    const query = `SELECT user_id, left_at FROM call_participants WHERE call_id = ? AND user_id = ?`;
    const result = await this.client.execute(
      query,
      [toCassandraUuid(callId), toCassandraUuid(userId)],
      { prepare: true }
    );
    if (!result.rows || result.rows.length === 0) return false;
    const row = result.rows[0];
    if (!row) return false;
    return row.left_at === null || row.left_at === undefined;
  }
}
