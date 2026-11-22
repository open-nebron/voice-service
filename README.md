# Nebron Voice Service (`voice-service`)

Voice room management, WebRTC audio calling control plane, and LiveKit integration for Nebron.

---

## 1. What voice-service is

`voice-service` serves as the WebRTC call control plane and LiveKit integration service for Nebron.
- **Call Control Plane**: Manages 1-on-1 audio calling sessions, state transitions, and real-time signaling.
- **LiveKit Server Integration**: Connects to LiveKit server via `livekit-server-sdk` for room lifecycle orchestration, participant tracking, and room token minting.
- **Token Verification**: Verifies RS256 JWT access tokens issued by `auth-service` via JWKS public keys. This service strictly verifies tokens and never issues identity tokens.
- **Infra Integration**: Uses ScyllaDB for high-throughput call history persistence and Redis for pub/sub signaling coordination and rate limiting.

> Note: Group calls (v2), call recording, and transcription are deferred to future milestones.

---

## 2. Prerequisites

- **Node.js**: `20.x` LTS or later
- **npm**: `10.x` or later
- **Docker & Docker Compose**: For local infrastructure dependencies (ScyllaDB, Redis, LiveKit, Auth JWKS)

---

## 3. How to Run Standalone

The service depends on ScyllaDB, Redis, Auth service (for JWKS), and LiveKit. You can run all required infrastructure and `voice-service` via the `infra` repo:

```bash
# From polyrepo root:
cd infra
make up-voice
```

To tail the logs:
```bash
make logs-voice
```

To run with hot reloading (mounts local `src/` directory):
```bash
make dev-voice
```

To stop the service:
```bash
make down-voice
```

To verify health:
```bash
curl http://localhost:4004/health | jq
```

---

## 4. How to Run Tests

Ensure local dependencies are installed:
```bash
cd voice-service
npm install
```

Run test suite via Vitest (all network calls and external databases are mocked):
```bash
npm test
```

Run linter:
```bash
npm run lint
```

Build production bundle:
```bash
npm run build
```

---

## 5. Endpoint Table

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/calls` | Bearer JWT | 10/min | Initiate a 1:1 voice call to a peer user |
| `POST` | `/calls/:id/accept` | Bearer JWT | 20/min | Accept an incoming ringing call (callee only) |
| `POST` | `/calls/:id/reject` | Bearer JWT | 20/min | Reject an incoming ringing call (callee only) |
| `POST` | `/calls/:id/end` | Bearer JWT | 30/min | End active call or cancel outbound ringing call |
| `GET` | `/calls/active` | Bearer JWT | 120/min | Get currently active call (ringing or accepted) or 204 |
| `GET` | `/calls/:id` | Bearer JWT | 120/min | Get call details and peer status (participant only) |
| `POST` | `/calls/:id/tokens` | Bearer JWT | 10/min | Obtain fresh LiveKit access token for reconnects |
| `GET` | `/calls` | Bearer JWT | 60/min | List paginated call history for user (caller or callee) |
| `POST` | `/webhooks/livekit` | LiveKit JWT | None | LiveKit server webhook event receiver (raw body signature verification) |
| `GET` | `/calls/:id/debug` | X-Internal-Token | None | Internal diagnostic endpoint inspecting Scylla call state and LiveKit room |
| `GET` | `/health` | Public | None | System health check (Scylla, Redis, JWKS, LiveKit) |
| `GET` | `/docs` | Public | None | OpenAPI 3.1 Swagger UI documentation |

---

## 6. Calls (1:1 Call Control Plane)

### 6.1 State Machine & Allowed Transitions

```
               ┌───────────────────────┐
               │        ringing        │
               └──┬───┬─────────┬────┬─┘
                  │   │         │    │
       accepted   │   │ reject  │    │ caller cancels
       (callee)   │   │(callee) │    │
                  ▼   ▼         ▼    ▼
          ┌────────┐ ┌────────┐ ┌─────────┐ ┌─────────┐
          │accepted│ │rejected│ │  missed │ │cancelled│
          └───┬────┘ └────────┘ └─────────┘ └─────────┘
              │           ▲          ▲           ▲
              │           │          │           │
              │         (final)    (final)     (final)
              ▼
          ┌────────┐
          │  ended │
          └────────┘
              ▲
              │ (final)
```

| Current State | Target State | Trigger / Endpoint | Actor |
|---|---|---|---|
| `ringing` | `accepted` | `POST /calls/:id/accept` | Callee |
| `ringing` | `rejected` | `POST /calls/:id/reject` or `POST /calls/:id/end` | Callee |
| `ringing` | `cancelled` | `POST /calls/:id/end` | Caller |
| `ringing` | `missed` | `CallTimeoutJob` (>45s ringing) | System background job (Scylla LWT) |
| `accepted` | `ended` | `POST /calls/:id/end` | Either caller or callee |
| `accepted` | `error` | LiveKit room failure | Webhook (Prompt 4c) |

Any invalid transition returns `409 Conflict` (`invalid_state_transition`).

### 6.2 Real-Time WebSocket Signaling (`ws:signal:{userId}`)

Voice signaling messages are published to Redis channel `ws:signal:{userId}`. `chat-service` subscribes to these channels and forwards incoming frames verbatim to the user's active WebSocket connection.

| Event Type | Target User | Trigger | Payload |
|---|---|---|---|
| `call.ringing` | Callee | Caller initiates call | `{ callId, callerId, roomName, startedAt }` |
| `call.dialing` | Caller | Caller initiates call | `{ callId, calleeId }` |
| `call.accepted` | Caller | Callee accepts call | `{ callId, callerToken, livekitUrl, roomName }` |
| `call.connected` | Callee | Callee accepts call | `{ callId, calleeToken, livekitUrl, roomName }` |
| `call.rejected` | Caller | Callee rejects call | `{ callId, calleeId, reason }` |
| `call.cancelled` | Callee | Caller cancels ringing call | `{ callId, callerId, reason }` |
| `call.ended` | Peer | Participant hangs up | `{ callId, endedBy, reason }` |
| `call.missed` | Both parties | Timeout job sweeps call >45s | `{ callId }` |
| `call.peer_disconnected` | Remaining participant | Peer disconnected from LiveKit | `{ callId, userId }` |

### 6.3 Curl Examples

#### 1. Initiate Call (`POST /calls`)
```bash
curl -X POST http://localhost:4004/calls \
  -H "Authorization: Bearer $CALLER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"calleeId": "22222222-2222-4222-8222-222222222222"}'
```

#### 2. Accept Call (`POST /calls/:id/accept`)
```bash
curl -X POST http://localhost:4004/calls/$CALL_ID/accept \
  -H "Authorization: Bearer $CALLEE_TOKEN"
```

#### 3. Reject Call (`POST /calls/:id/reject`)
```bash
curl -X POST http://localhost:4004/calls/$CALL_ID/reject \
  -H "Authorization: Bearer $CALLEE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "busy"}'
```

#### 4. End or Cancel Call (`POST /calls/:id/end`)
```bash
curl -X POST http://localhost:4004/calls/$CALL_ID/end \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "hangup"}'
```

#### 5. Get Active Call (`GET /calls/active`)
```bash
curl http://localhost:4004/calls/active \
  -H "Authorization: Bearer $USER_TOKEN"
```

#### 6. Get Call Details (`GET /calls/:id`)
```bash
curl http://localhost:4004/calls/$CALL_ID \
  -H "Authorization: Bearer $USER_TOKEN"
```

#### 7. Refresh LiveKit Token (`POST /calls/:id/tokens`)
```bash
curl -X POST http://localhost:4004/calls/$CALL_ID/tokens \
  -H "Authorization: Bearer $USER_TOKEN"
```

#### 8. Call History (`GET /calls`)
```bash
curl "http://localhost:4004/calls?limit=30" \
  -H "Authorization: Bearer $USER_TOKEN"
```

---

## 7. Webhooks & Reconciliation

### 7.1 LiveKit Webhook Integration (`POST /webhooks/livekit`)
To prevent calls from remaining stuck in `state='accepted'` when clients drop ungracefully (e.g. mobile app killed, network drop), LiveKit delivers server-side webhook events:
- **Signature Verification**: Validates the incoming JWT signature in `Authorization` against SHA256 checksum of the raw request payload using `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.
- **`room_finished`**: Backstop event when a room is destroyed. Force-ends calls in `ringing` or `accepted` with `endReason: 'livekit_closed'`, emits `ws:signal` to both parties, and publishes `voice.call.ended` to `nebron.events`.
- **`participant_left`**: Fast path when both participants drop (`count === 0`). Immediately force-ends the call. If 1 participant remains (`count === 1`), notifies them via `call.peer_disconnected` signaling.
- **Idempotency**: Webhook handling is strictly idempotent and safe against races with manual client hangup.

### 7.2 Call Reconciliation Background Job (`CallReconcileJob`)
- Runs every 60 seconds (`RECONCILE_POLL_INTERVAL_MS`).
- Queries ScyllaDB for calls in `state='accepted'` older than 5 minutes (`RECONCILE_MIN_CALL_AGE_SECONDS`).
- Verifies room participant count with LiveKit `listParticipants`.
- If 0 participants remain or the room does not exist, executes an atomic Lightweight Transaction (LWT):
  ```cql
  UPDATE calls SET state = 'ended', ended_at = ?, ended_by = null, end_reason = 'livekit_closed'
  WHERE id = ? IF state = 'accepted';
  ```
- Emits real-time signals and stream events to guarantee user call concurrency state is never permanently stuck.

### 7.3 Internal Diagnostic Inspection (`GET /calls/:id/debug`)
Protected by `X-Internal-Token`, this endpoint compares persisted ScyllaDB state against live WebRTC room state in LiveKit and computes state divergence (`none`, `stuck_call`, `orphan_room`).

---

## 8. Vendored Contracts Note

Similar to `core-backend` and `chat-service`, `voice-service` depends on `@nebron/contracts` via a vendored tarball located at `vendor/nebron-contracts-<version>.tgz`.
When updating shared schemas or event contracts in `../shared-contracts`:
1. Build and pack the contracts in `../shared-contracts`:
   ```bash
   cd ../shared-contracts
   npm run build
   npm pack
   ```
2. Copy the resulting tarball into `vendor/`:
   ```bash
   cp ../shared-contracts/nebron-contracts-*.tgz vendor/
   ```
3. Update `package.json` dependency reference if version changed, then run `npm install`.

---

## 9. Future Milestones (Voice v2)

- Group audio calls and multi-party room management
- Call recording, media egress, and MinIO/S3 archival
- Real-time speech-to-text transcription and transcript indexing
- Screen sharing and peer-to-peer data channels
