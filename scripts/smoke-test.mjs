import crypto from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';

const CHAT_WS_URL = 'ws://localhost:4003/ws';
const VOICE_URL = 'http://localhost:4004';

const privateKeyPem = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDQcPy2exh85wVG
rUZBl8/d2JOKjVXDFDFc3XxZz2ahQ8CRg63CM2hoSpqyUnNJYPQ7O9kCUP1GZfTF
GhI9dd29bURIsYbKe4+vk0efsdnR2BCppxm43OIZZq7hpBEkYIvi8GNiEgbWz4Ms
GGyXvGK7p+eM/MgDzISfUahUcuX8qvLM4a8o3jwf44iPUJpuqerXbhUZx2rJmzX7
NHw4mzY1qrZ4wt4H95jfuqT8bWmPzF0VkRB1iofr+v/WTN9WT76PBsuuI5/PpjGb
e3AiAtmJlJQfJXHoW0RXp3bn/wNnzhEKTeqMcezoWpjXEsZ410CSRPNiiwPXasRw
3+/46c9VAgMBAAECggEAKyuzk4HUNQ5N//DkU7KDGWIBUNlr8U7t2FuBJUK48V6M
dDbvFoE6Nxt4hcVg3kpH2zrOe9XVVy7HrsjzDSqrxc9rLJkkHyzPOiCJXZBi2jzj
Wpfi0nBhHbywLMijykJ6xoJeOxIbu4LYGppmZ1jbpB0m7oLuVCcYMr0hXXg8nQNV
MAs5eZDaR5S5q4+a3sXVs9frW7WU6btdnVNwAc5swieCDkqnt6qfKAqT3MkBPdge
/hBrwrDWyzX+ZT3Y/hp/R9G2jJhbjc6X8L4jQVuH+iYwtp+PSCFkNr4ISPCBzTEA
fQQi8tlR0LgBeseVc6k6CZfeiQOEqbmeagbyEKOA8wKBgQDuv6Fkc7fozfv26sxi
qkg4ElyhTnZs0gpE97m1oUS92mEi7HH4TlxTr4O9/dGGUZ9eOTaMt1FtTsb1iQuy
yvcl6dm7LRFp8XtuYNCHj1diO0EjItdtIWIXDwuCS1VWv09PD7U2G36FJIsGtvor
Vu3DWJ1SB45gk/AXzm0psGWj3wKBgQDfgLv6KMkLoh4DiNMLsWUX+H9zeweALCmI
j877CXjXfus7uDWWZu0Uf1kIJONsmIAPLksvPMrigPk0HrjA0LlLjECWW/SzYUCs
cIpf4hXEBElpB7DzuVWHeJD1nxvvVb/XVns+6eWPDNTuzKXKJ+zVRx9wE2H/vYmg
v/U4TS7TSwKBgB7StLZwTiULOuVk6OAwFcTPchANPjLMZzECPoKZgHN2VyYYGpqx
GzBer4Z+12cc8JNMlaNTI3sWOY+HkvARThkh+M82gVIJMCNO8n0d3206My2jGObo
8W4CrjyzFyBs8INHhuCmag4sapqCUwf3YBjhPuZRPWtwjgW0y9kfAfBHAoGAdViY
2XIahHIcwgxPil8cTeaZvB8HRCNrtxiSOrmxaatohFVmRU5LAa0PKLh9c6Hp8o6C
yQ1pFF1U+il7JTkxYFoF+yvSoW/ZTfBUpp0EgoMhq/Ru0rgnENabfWqJdzKVY9Ez
KkgRz/aTwcFO9oHZ1ezes7BpjqWMIgtHC8VyZVsCgYATQ19M9v9sC9pduh+7ALiA
ZOD8rGbOwNYhKNT5g+bs4/MuQFoIux/SSovElLGqnhG8f3hfCw0DxMU7G8vzE0rU
Dd99QFWXTQltrY+v0VM3k1c8eOq8DT/Lf/hOIsNZXX9BpC31MWCl3pFdBNH3nh+M
1nAm58mJfkA+KuLiOtGLug==
-----END PRIVATE KEY-----`;

async function createDevToken(userId) {
  const privateKey = await importPKCS8(privateKeyPem, 'RS256');
  return new SignJWT({
    sub: userId,
    sessionId: crypto.randomUUID(),
    sid: crypto.randomUUID(),
    email: `${userId}@nebron.com`,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
    .setIssuer('nebron-auth')
    .setAudience(['voice', 'chat', 'core'])
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function run() {
  console.log('--- Starting Voice 1:1 Live Stack Smoke Test ---');

  // 1. Generate User A (Caller) & User B (Callee) UUIDs and signed tokens
  console.log('1. Generating User A & User B with RS256 JWT tokens...');
  const userA = {
    userId: crypto.randomUUID(),
  };
  const userB = {
    userId: crypto.randomUUID(),
  };
  userA.token = await createDevToken(userA.userId);
  userB.token = await createDevToken(userB.userId);

  console.log(`   User A (Caller): ${userA.userId}`);
  console.log(`   User B (Callee): ${userB.userId}`);

  // 2. Connect Callee B to chat-service WebSocket
  console.log('2. Connecting Callee B to chat-service WebSocket gateway...');
  const wsB = new WebSocket(`${CHAT_WS_URL}?token=${userB.token}`);

  const wsBMessages = [];
  wsB.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data.toString());
      wsBMessages.push(msg);
      console.log(`   [WS B Received]: ${msg.type}`);
    } catch {}
  };

  await new Promise((resolve, reject) => {
    wsB.onopen = () => resolve();
    wsB.onerror = (err) => reject(err);
  });
  console.log('   Callee B WebSocket connected successfully.');

  // Small delay to ensure subscription registration
  await new Promise((r) => setTimeout(r, 600));

  // 3. User A initiates call to User B
  console.log('3. User A initiating call to User B (POST /calls)...');
  const callRes = await fetch(`${VOICE_URL}/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userA.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ calleeId: userB.userId }),
  });

  if (!callRes.ok) {
    throw new Error(`POST /calls failed: ${callRes.status} ${await callRes.text()}`);
  }

  const call = await callRes.json();
  console.log(`   Call initiated: ID=${call.id}, State=${call.state}`);
  if (call.state !== 'ringing') throw new Error(`Expected state 'ringing', got ${call.state}`);

  // 4. Verify Callee B receives call.ringing via WebSocket
  console.log('4. Verifying Callee B received "call.ringing" via WS...');
  let ringingMsg = null;
  for (let i = 0; i < 20; i++) {
    ringingMsg = wsBMessages.find((m) => m.type === 'call.ringing');
    if (ringingMsg) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ringingMsg) throw new Error('Callee B never received call.ringing frame on WS!');
  console.log('   ✓ call.ringing received with roomName:', ringingMsg.payload.roomName);

  // 5. User B accepts the call
  console.log('5. User B accepting call (POST /calls/:id/accept)...');
  const acceptRes = await fetch(`${VOICE_URL}/calls/${call.id}/accept`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userB.token}`,
    },
  });

  if (!acceptRes.ok) {
    throw new Error(`POST /calls/:id/accept failed: ${acceptRes.status} ${await acceptRes.text()}`);
  }

  const acceptData = await acceptRes.json();
  console.log(`   Call accepted: State=${acceptData.call.state}`);
  console.log(`   LiveKit URL: ${acceptData.livekitUrl}`);
  console.log(`   Caller token present: ${!!acceptData.callerToken}`);
  console.log(`   Callee token present: ${!!acceptData.calleeToken}`);

  // 6. Verify Callee B received call.connected via WS
  console.log('6. Verifying Callee B received "call.connected" via WS...');
  let connectedMsg = null;
  for (let i = 0; i < 20; i++) {
    connectedMsg = wsBMessages.find((m) => m.type === 'call.connected');
    if (connectedMsg) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!connectedMsg) throw new Error('Callee B never received call.connected frame on WS!');
  console.log('   ✓ call.connected received with token:', connectedMsg.payload.calleeToken.substring(0, 20) + '...');

  // 7. User A hangs up
  console.log('7. User A ending call (POST /calls/:id/end)...');
  const endRes = await fetch(`${VOICE_URL}/calls/${call.id}/end`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userA.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason: 'hangup' }),
  });

  if (!endRes.ok) {
    throw new Error(`POST /calls/:id/end failed: ${endRes.status} ${await endRes.text()}`);
  }

  const endData = await endRes.json();
  console.log(`   Call ended: State=${endData.state}, Reason=${endData.endReason}`);

  // 8. Verify Callee B received call.ended via WS
  console.log('8. Verifying Callee B received "call.ended" via WS...');
  let endedMsg = null;
  for (let i = 0; i < 20; i++) {
    endedMsg = wsBMessages.find((m) => m.type === 'call.ended');
    if (endedMsg) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!endedMsg) throw new Error('Callee B never received call.ended frame on WS!');
  console.log('   ✓ call.ended received via WS');

  // 9. Verify GET /calls/:id
  console.log('9. Checking GET /calls/:id for final state...');
  const getRes = await fetch(`${VOICE_URL}/calls/${call.id}`, {
    headers: { Authorization: `Bearer ${userA.token}` },
  });
  const getCall = await getRes.json();
  console.log(`   GET /calls/:id state: ${getCall.state}, endedBy: ${getCall.endedBy}`);
  if (getCall.state !== 'ended') throw new Error(`Expected state 'ended', got ${getCall.state}`);

  wsB.close();
  console.log('\n=========================================');
  console.log('   SMOKE TEST RESULT: ALL CHECKS PASSED');
  console.log('=========================================');
}

run().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
