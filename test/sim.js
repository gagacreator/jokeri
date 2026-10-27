'use strict';
// End-to-end simulation: starts the server, registers 4 users, the admin creates a
// table, 4 socket clients join by code and play a full 24-deal game with random legal moves.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3111;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jokeri-'));

const api = async (method, url, body, token) => {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${url}: ${j.error}`);
  return j;
};
const pick = a => a[Math.floor(Math.random() * a.length)];

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: dataDir, TRICK_DELAY: 0, DEAL_DELAY: 0, DRAW_STEP: 0, DRAW_END: 0 },
    stdio: 'inherit',
  });
  await new Promise(r => setTimeout(r, 800));
  try {
    const users = [];
    for (let i = 0; i < 4; i++) users.push(await api('POST', '/api/register', { username: 'player' + i, password: 'secret', name: 'მოთამაშე' + i }));
    if (!users[0].user.isAdmin || users[1].user.isAdmin) throw new Error('admin assignment wrong');
    await api('POST', '/api/login', { username: 'player2', password: 'secret' });
    let bad = false;
    try { await api('POST', '/api/tables', { name: 'x' }, users[1].token); } catch { bad = true; }
    if (!bad) throw new Error('non-admin created a table');

    const table = await api('POST', '/api/tables', { name: 'სატესტო' }, users[0].token);
    console.log('table code', table.code);

    let finalState = null;
    let moves = 0;
    const done = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('game timed out')), 60000);
      users.forEach((u, idx) => {
        const s = io(BASE, { auth: { token: u.token } });
        s.on('table:state', st => {
          const g = st.game;
          if (!g) return;
          if (g.phase === 'finished') { finalState = g; clearTimeout(timeout); resolve(); return; }
          if (g.turn !== st.seat) return;
          const ack = r => { if (r?.error) { clearTimeout(timeout); reject(new Error('move rejected: ' + r.error)); } };
          moves++;
          if (g.phase === 'bidding') {
            const opts = [...Array(g.cards + 1).keys()].filter(n => n !== g.forbiddenBid);
            s.emit('game:bid', pick(opts), ack);
          } else if (g.phase === 'playing') {
            const id = pick(g.legal);
            s.emit('game:play', { id, mode: pick(['high', 'low']), suit: pick(['S', 'C', 'D', 'H']) }, ack);
          }
        });
        s.on('connect', () => {
          s.emit('table:join', table.code, r => { if (r?.error) reject(new Error(r.error)); });
        });
      });
    });
    await done;

    const g = finalState;
    if (g.history.length !== 24) throw new Error('expected 24 deals, got ' + g.history.length);
    for (const h of g.history) {
      const total = h.taken.reduce((a, b) => a + b, 0);
      if (total !== h.cards) throw new Error(`deal ${h.deal}: taken ${total} != cards ${h.cards}`);
      const bidSum = h.bids.reduce((a, b) => a + b, 0);
      if (bidSum === h.cards) throw new Error(`deal ${h.deal}: bids sum equals cards`);
    }
    const sum = g.history.reduce((acc, h) => acc.map((v, i) => v + h.points[i]), [0, 0, 0, 0]);
    if (sum.join() !== g.totals.join()) throw new Error('totals mismatch');
    console.log('OK: full game, moves =', moves, 'totals =', g.totals.join(', '));
  } finally {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), e => { console.error('FAIL:', e.message); process.exit(1); });
