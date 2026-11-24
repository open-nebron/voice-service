import { validate as uuidValidate } from 'uuid';
import cassandra from 'cassandra-driver';

/**
 * Validates whether a string is a valid UUID or 24-character hexadecimal ObjectId.
 */
export function isValidId(id: string): boolean {
  if (typeof id !== 'string') return false;
  return uuidValidate(id) || /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * Converts a string ID (standard UUID or 24-character hex MongoDB ObjectId)
 * to a cassandra.types.Uuid instance.
 */
export function toCassandraUuid(id: string | cassandra.types.Uuid): cassandra.types.Uuid {
  if (id instanceof cassandra.types.Uuid) return id;
  if (uuidValidate(id)) {
    return cassandra.types.Uuid.fromString(id);
  }
  if (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)) {
    const clean = id.toLowerCase();
    const formatted = `00000000-${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}-${clean.slice(12)}`;
    return cassandra.types.Uuid.fromString(formatted);
  }
  return cassandra.types.Uuid.fromString(id);
}

/**
 * Converts a cassandra.types.Uuid or UUID string back to original string representation.
 * Un-pads '00000000-' to restore 24-character MongoDB ObjectIds.
 */
export function fromCassandraUuid(val: any): string {
  if (!val) return '';
  const str = val.toString();
  if (str.startsWith('00000000-')) {
    const raw = str.replace(/-/g, '').slice(8);
    if (/^[0-9a-fA-F]{24}$/.test(raw)) {
      return raw;
    }
  }
  return str;
}
