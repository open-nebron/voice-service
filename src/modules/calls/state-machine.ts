import { ConflictError } from '../../lib/errors.js';

export type CallState =
  | 'ringing'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'missed'
  | 'ended'
  | 'error';

export type CallEndReason =
  | 'hangup'
  | 'reject'
  | 'missed'
  | 'cancelled'
  | 'error'
  | 'livekit_closed';

const ALLOWED_TRANSITIONS: Record<CallState, readonly CallState[]> = {
  ringing: ['accepted', 'rejected', 'cancelled', 'missed'],
  accepted: ['ended', 'error'],
  rejected: [],
  cancelled: [],
  missed: [],
  ended: [],
  error: [],
};

export function isValidTransition(from: CallState, to: CallState): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

export function assertValidTransition(from: CallState, to: CallState): void {
  if (!isValidTransition(from, to)) {
    throw new ConflictError(
      'invalid_state_transition',
      `Cannot transition call state from '${from}' to '${to}'`
    );
  }
}
