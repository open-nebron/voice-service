import cassandra from 'cassandra-driver';
import type { CallState, CallEndReason } from '../../modules/calls/state-machine.js';
import { toCassandraUuid, fromCassandraUuid } from '../../lib/id.js';
import { validate as uuidValidate } from 'uuid';

export interface Call {
  id: string;
  callerId: string;
  calleeId: string;
  state: CallState;
  roomName: string;
  createdAt: Date;
  acceptedAt?: Date | null;
  endedAt?: Date | null;
  endedBy?: string | null;
  endReason?: CallEndReason | string | null;
}

export interface InsertCallParams {
  id: string;
  callerId: string;
  calleeId: string;
  roomName: string;
  createdAt: Date;
  state?: CallState;
}

export interface UpdateCallStateParams {
  state: CallState;
  acceptedAt?: Date | null;
  endedAt?: Date | null;
  endedBy?: string | null;
  endReason?: CallEndReason | string | null;
}


export class CallsRepository {
  private readonly client: cassandra.Client;

  constructor(client: cassandra.Client) {
    this.client = client;
  }

  private mapRowToCall(row: cassandra.types.Row): Call {
    return {
      id: row.id.toString(),
      callerId: fromCassandraUuid(row.caller_id),
      calleeId: fromCassandraUuid(row.callee_id),
      state: row.state as CallState,
      roomName: row.room_name,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at || null,
      endedAt: row.ended_at || null,
      endedBy: row.ended_by ? fromCassandraUuid(row.ended_by) : null,
      endReason: row.end_reason || null,
    };
  }

  async insert(params: InsertCallParams): Promise<Call> {
    const state = params.state || 'ringing';
    const query = `
      INSERT INTO calls (id, caller_id, callee_id, state, room_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    await this.client.execute(
      query,
      [
        toCassandraUuid(params.id),
        toCassandraUuid(params.callerId),
        toCassandraUuid(params.calleeId),
        state,
        params.roomName,
        params.createdAt,
      ],
      { prepare: true }
    );

    return {
      id: params.id,
      callerId: params.callerId,
      calleeId: params.calleeId,
      state,
      roomName: params.roomName,
      createdAt: params.createdAt,
      acceptedAt: null,
      endedAt: null,
      endedBy: null,
      endReason: null,
    };
  }

  async getById(id: string): Promise<Call | null> {
    if (!uuidValidate(id)) {
      return null;
    }
    const query = `SELECT * FROM calls WHERE id = ?`;
    const result = await this.client.execute(
      query,
      [toCassandraUuid(id)],
      { prepare: true }
    );
    if (!result.rows || result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return this.mapRowToCall(row);
  }

  async updateState(id: string, patch: UpdateCallStateParams): Promise<void> {
    const fields: string[] = ['state = ?'];
    const params: any[] = [patch.state];

    if (patch.acceptedAt !== undefined) {
      fields.push('accepted_at = ?');
      params.push(patch.acceptedAt);
    }
    if (patch.endedAt !== undefined) {
      fields.push('ended_at = ?');
      params.push(patch.endedAt);
    }
    if (patch.endedBy !== undefined) {
      fields.push('ended_by = ?');
      params.push(patch.endedBy ? toCassandraUuid(patch.endedBy) : null);
    }
    if (patch.endReason !== undefined) {
      fields.push('end_reason = ?');
      params.push(patch.endReason);
    }

    params.push(toCassandraUuid(id));
    const query = `UPDATE calls SET ${fields.join(', ')} WHERE id = ?`;
    await this.client.execute(query, params, { prepare: true });
  }

  async findRingingByCallee(calleeId: string): Promise<Call[]> {
    const calleeUuid = toCassandraUuid(calleeId);
    const query = `SELECT * FROM calls WHERE callee_id = ? AND state = 'ringing' ALLOW FILTERING`;
    const result = await this.client.execute(query, [calleeUuid], { prepare: true });
    if (!result.rows) return [];
    return result.rows.map((r) => this.mapRowToCall(r));
  }

  async findActiveByUser(userId: string): Promise<Call | null> {
    const userUuid = toCassandraUuid(userId);
    // Check if user is caller or callee in active states (ringing or accepted)
    const [callerRes, calleeRes] = await Promise.all([
      this.client.execute(`SELECT * FROM calls WHERE caller_id = ? ALLOW FILTERING`, [userUuid], {
        prepare: true,
      }),
      this.client.execute(`SELECT * FROM calls WHERE callee_id = ? ALLOW FILTERING`, [userUuid], {
        prepare: true,
      }),
    ]);

    const allRows = [...(callerRes.rows || []), ...(calleeRes.rows || [])];
    for (const row of allRows) {
      if (row.state === 'ringing' || row.state === 'accepted') {
        return this.mapRowToCall(row);
      }
    }
    return null;
  }

  async listForUser(userId: string, limit = 30, before?: Date | string): Promise<Call[]> {
    const userUuid = toCassandraUuid(userId);
    const [callerRes, calleeRes] = await Promise.all([
      this.client.execute(`SELECT * FROM calls WHERE caller_id = ?`, [userUuid], { prepare: true }),
      this.client.execute(`SELECT * FROM calls WHERE callee_id = ?`, [userUuid], { prepare: true }),
    ]);

    const seenIds = new Set<string>();
    const calls: Call[] = [];

    const beforeTime = before ? new Date(before).getTime() : Infinity;

    for (const row of [...(callerRes.rows || []), ...(calleeRes.rows || [])]) {
      const call = this.mapRowToCall(row);
      if (!seenIds.has(call.id)) {
        seenIds.add(call.id);
        const callTime = call.createdAt ? new Date(call.createdAt).getTime() : 0;
        if (callTime < beforeTime) {
          calls.push(call);
        }
      }
    }

    // Sort DESC by created_at
    calls.sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return timeB - timeA;
    });

    return calls.slice(0, limit);
  }

  async findExpiredRinging(olderThanSeconds: number): Promise<Call[]> {
    const query = `SELECT * FROM calls WHERE state = 'ringing' ALLOW FILTERING`;
    const result = await this.client.execute(query, [], { prepare: true });
    if (!result.rows) return [];

    const threshold = Date.now() - olderThanSeconds * 1000;
    return result.rows
      .map((r) => this.mapRowToCall(r))
      .filter((c) => c.createdAt && new Date(c.createdAt).getTime() < threshold);
  }

  async updateToMissedAtomic(id: string, endedAt: Date): Promise<boolean> {
    const query = `
      UPDATE calls SET state = 'missed', ended_at = ?, end_reason = 'missed'
      WHERE id = ? IF state = 'ringing'
    `;
    const result = await this.client.execute(
      query,
      [endedAt, toCassandraUuid(id)],
      { prepare: true }
    );
    return result.wasApplied ? result.wasApplied() : true;
  }

  async findAcceptedOlderThan(olderThanSeconds: number, limit = 100): Promise<Call[]> {
    const query = `SELECT * FROM calls WHERE state = 'accepted' ALLOW FILTERING`;
    const result = await this.client.execute(query, [], { prepare: true });
    if (!result.rows) return [];

    const threshold = Date.now() - olderThanSeconds * 1000;
    return result.rows
      .map((r) => this.mapRowToCall(r))
      .filter((c) => {
        const ts = c.acceptedAt
          ? new Date(c.acceptedAt).getTime()
          : c.createdAt
            ? new Date(c.createdAt).getTime()
            : 0;
        return ts < threshold;
      })
      .slice(0, limit);
  }

  async updateToEndedAtomic(
    id: string,
    endedAt: Date,
    reason: string = 'livekit_closed'
  ): Promise<boolean> {
    const query = `
      UPDATE calls SET state = 'ended', ended_at = ?, ended_by = null, end_reason = ?
      WHERE id = ? IF state = 'accepted'
    `;
    const result = await this.client.execute(
      query,
      [endedAt, reason, toCassandraUuid(id)],
      { prepare: true }
    );
    return result.wasApplied ? result.wasApplied() : true;
  }
}
