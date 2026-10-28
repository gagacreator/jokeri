'use strict';
// Sound pranks: seated players can play a whitelisted sound "to" another seat; the whole table hears it.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const PORT = 3117;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jokeri-snd-'));
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
    for (const n of ['sa', 'sb', 'sc', 'sd']) users.push(await api('POST', '/api/register', { email: n + '@test.com', password: 'secret1', name: n }));
    const t = await api('POST', '/api/tables', { name: 's' }, root.token);
    const socks = users.map(u => io(BASE, { auth: { token: u.token } }));
    await Promise.all(socks.map(s => new Promise(r => s.on('connect', r))));
    for (let i = 0; i < 4; i++) await emit(socks[i], 'table:join', t.code, 'play');
    const rs = socks[3];
    const got = [];
    rs.on('sound:play', m => got.push(m));
    assert((await emit(socks[0], 'sound:send', { seat: 2, id: 'joker' })).ok, 'send ok');
    await wait(200);
    assert(got.length === 1 && got[0].to === 2 && got[0].from === 0 && got[0].id === 'joker', 'everyone hears it');
    assert((await emit(socks[0], 'sound:send', { seat: 2, id: 'bicho' })).error, 'throttled');
    assert((await emit(socks[1], 'sound:send', { seat: 2, id: 'evil.mp3' })).error, 'unknown id refused');
    console.log('OK sound');
  } catch (e) { console.error(e.message); process.exitCode = 1; } finally { server.kill(); process.exit(); }
})();
