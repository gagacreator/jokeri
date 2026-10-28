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
    for (const n of ['pa', 'pb', 'pc', 'pd', 'watcher']) users.push(await api('POST', '/api/register', { email: n + '@test.com', password: 'secret1', name: n }));
    const t = await api('POST', '/api/tables', { name: 's' }, users[0].token);
    const socks = users.map(u => io(BASE, { auth: { token: u.token } }));
    await Promise.all(socks.map(s => new Promise(r => s.on('connect', r))));
    const w = socks[4];
    let wstate = null;
    w.on('table:state', s => { wstate = s; });

    const info = await emit(w, 'table:info', t.code);
    assert(info.canPlay && !info.seated, 'watcher may play before start');
    assert((await emit(w, 'table:join', t.code, 'watch')).ok, 'watch join');
    await wait(200);
    assert(wstate && wstate.spectator && wstate.seat === -1, 'spectator state');
    for (let i = 0; i < 4; i++) await emit(socks[i], 'table:join', t.code, 'play');
    await wait(300);
    assert(wstate.game, 'watcher sees the game start');
    assert(wstate.players.every(p => p && p.name), 'seats full, watcher took none');
    assert(wstate.watchers === 1, 'watchers count');

    // deal is made after the draw; wait for hands
    for (let i = 0; i < 120 && wstate.game.phase === 'draw'; i++) await wait(500);
    assert(wstate.game.phase !== 'draw', 'past draw');
    assert(wstate.game.hand.length === 0 && wstate.game.legal.length === 0, 'spectator has no own hand');
    assert(wstate.game.allHands.length === 4 && wstate.game.allHands.every((h, i) => h.length === wstate.game.handCounts[i]), 'spectator sees all hands');
    let ownView = null;
    socks[0].on('table:state', s => { ownView = s; });
    await emit(socks[0], 'table:join', t.code, 'play');
    await wait(200);
    assert(ownView && ownView.game.allHands === null, 'players never get other hands');

    const late = await emit(w, 'table:info', t.code);
    assert(!late.canPlay, 'cannot sit after start');
    assert((await emit(w, 'table:join', t.code, 'play')).error, 'cannot take a seat after start');

    const got = [];
    socks[0].on('chat:msg', m => got.push(m));
    assert((await emit(w, 'chat:send', 'მაყურებელი')).ok, 'spectator chat');
    await wait(300);
    assert(got.some(m => m.text === 'მაყურებელი' && m.name === 'watcher'), 'players read spectator chat');
    assert((await emit(w, 'chat:history')).messages.length === 1, 'spectator history');
    assert((await emit(w, 'voice:join')).peers, 'spectator voice join');
    assert((await emit(w, 'game:play', { id: 'x' })).error, 'spectator cannot play');
    assert((await emit(w, 'game:bid', 1)).error, 'spectator cannot bid');
    console.log('OK spectator');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    process.exit();
  }
})();
