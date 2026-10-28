'use strict';
// Checks that voice signaling is relayed only between seated players who joined voice.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3112;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jokeri-voice-'));
const api = async (method, url, body, token) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
};
const emit = (s, ev, ...args) => new Promise(res => s.emit(ev, ...args, res));
const wait = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };

(async () => {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dataDir }, stdio: 'ignore' });
  await wait(800);
  try {
    const users = [];
    const root = await api('POST', '/api/register', { email: 'root@test.com', password: 'secret1', name: 'root' }); // first account = admin, never seated
    for (const n of ['voiceaa', 'voicebb', 'voicecc']) users.push(await api('POST', '/api/register', { email: n + '@test.com', password: 'secret1' }));
    const ice = await api('GET', '/api/ice', null, users[0].token);
    assert(ice.iceServers.length >= 1, 'ice servers');
    const t = await api('POST', '/api/tables', { name: 'v' }, root.token);
    const socks = users.map(u => io(BASE, { auth: { token: u.token } }));
    await Promise.all(socks.map(s => new Promise(r => s.on('connect', r))));
    // A and B sit at the table, C does not
    await emit(socks[0], 'table:join', t.code);
    await emit(socks[1], 'table:join', t.code);
    const got = { a: [], b: [], c: [] };
    socks[0].on('voice:signal', m => got.a.push(m));
    socks[1].on('voice:signal', m => got.b.push(m));
    socks[2].on('voice:signal', m => got.c.push(m));

    const r0 = await emit(socks[0], 'voice:join');
    assert(r0.peers.length === 0, 'first joiner sees no peers');
    const r1 = await emit(socks[1], 'voice:join');
    assert(r1.peers.length === 1 && r1.peers[0] === users[0].user.id, 'second joiner sees first');
    const rc = await emit(socks[2], 'voice:join');
    assert(rc.error, 'non-seated user cannot join voice');

    socks[1].emit('voice:signal', { to: users[0].user.id, data: { sdp: { type: 'offer', sdp: 'x' } } });
    socks[2].emit('voice:signal', { to: users[0].user.id, data: { candidate: 'spoof' } });
    await wait(300);
    assert(got.a.length === 1 && got.a[0].from === users[1].user.id, 'A received B signal');
    assert(got.c.length === 0 && got.b.length === 0, 'no leaks');

    const left = new Promise(r => socks[0].once('voice:left', r));
    socks[1].disconnect();
    const l = await left;
    assert(l.uid === users[1].user.id, 'left event on disconnect');
    console.log('OK: voice signaling');
  } finally {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().then(() => process.exit(0), e => { console.error('FAIL:', e.message); process.exit(1); });
