'use strict';
// A player who does not move within TURN_LIMIT gets nagged: the table receives table:nag for that seat.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3115;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jokeri-nag-'));
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
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dataDir, TURN_LIMIT: '700' }, stdio: 'ignore' });
  await wait(800);
  try {
    const users = [];
    for (const n of ['na', 'nb', 'nc', 'nd']) users.push(await api('POST', '/api/register', { email: n + '@test.com', password: 'secret1', name: n }));
    const t = await api('POST', '/api/tables', { name: 'n' }, users[0].token);
    const socks = users.map(u => io(BASE, { auth: { token: u.token } }));
    await Promise.all(socks.map(s => new Promise(r => s.on('connect', r))));
    let state = null;
    const nags = [];
    socks[0].on('table:state', s => { state = s; });
    socks[0].on('table:nag', n => nags.push(n));
    for (const s of socks) await emit(s, 'table:join', t.code, 'play');
    for (let i = 0; i < 120 && !(state?.game && state.game.phase === 'bidding'); i++) await wait(500);
    assert(state.game.phase === 'bidding', 'reached bidding');
    assert(typeof state.turnLeft === 'number' && state.turnLeft <= 700, 'turnLeft is reported');
    await wait(1000);
    assert(nags.length >= 1 && nags[0].seat === state.game.turn, 'nag for the player on turn');
    console.log('OK nag', nags.length);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    process.exit();
  }
})();
