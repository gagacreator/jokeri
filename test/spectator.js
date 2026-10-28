'use strict';
// Spectators: watch without a seat, see every hand (players don't), can chat and join voice signaling.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3114;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jokeri-spec-'));
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
    const root = await api('POST', '/api/register', { email: 'root@test.com', password: 'secret1', name: 'root' }); // first account = admin
    for (const n of ['pa', 'pb', 'pc', 'pd', 'late']) users.push(await api('POST', '/api/register', { email: n + '@test.com', password: 'secret1', name: n }));
    const t = await api('POST', '/api/tables', { name: 's' }, root.token);
    const socks = users.map(u => io(BASE, { auth: { token: u.token } }));
    await Promise.all(socks.map(s => new Promise(r => s.on('connect', r))));
    const rs = io(BASE, { auth: { token: root.token } });
    await new Promise(r => rs.on('connect', r));
    assert(!(await emit(rs, 'table:info', t.code)).canPlay, 'admin cannot play');
    assert((await emit(rs, 'table:join', t.code, 'play')).error, 'admin cannot enter (play)');
    assert((await emit(rs, 'table:join', t.code, 'watch')).error, 'admin cannot enter (watch)');
    for (let i = 0; i < 4; i++) await emit(socks[i], 'table:join', t.code, 'play');
    await wait(300);
    // nobody else may watch: asking to watch a started table is refused
    assert((await emit(socks[4], 'table:join', t.code, 'watch')).error, 'late guest cannot watch');
    assert((await emit(rs, 'table:join', t.code, 'watch')).error, 'admin still refused after start');
    console.log('OK spectator');
  } catch (e) { console.error(e.message); process.exitCode = 1; } finally { server.kill(); process.exit(); }
})();
