'use strict';
// Table text chat: only seated players can read/write, messages are broadcast and kept as history.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3113;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jokeri-chat-'));
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
    for (const n of ['chata', 'chatb', 'chatc']) users.push(await api('POST', '/api/register', { email: n + '@test.com', password: 'secret1', name: n }));
    const t = await api('POST', '/api/tables', { name: 'c' }, root.token);
    const socks = users.map(u => io(BASE, { auth: { token: u.token } }));
    await Promise.all(socks.map(s => new Promise(r => s.on('connect', r))));
    await emit(socks[0], 'table:join', t.code);
    await emit(socks[1], 'table:join', t.code);
    const got = { a: [], b: [], c: [] };
    socks[0].on('chat:msg', m => got.a.push(m));
    socks[1].on('chat:msg', m => got.b.push(m));
    socks[2].on('chat:msg', m => got.c.push(m));

    const r1 = await emit(socks[0], 'chat:send', '  გამარჯობა <b>x</b>  ');
    assert(r1.ok, 'send ok');
    await wait(500);
    const r2 = await emit(socks[1], 'chat:send', 'მისალმება');
    assert(r2.ok, 'second send ok');
    const rc = await emit(socks[2], 'chat:send', 'intruder');
    assert(rc.error, 'non-seated user cannot chat');
    const rs = await emit(socks[0], 'chat:send', 'a');
    const rs2 = await emit(socks[0], 'chat:send', 'b');
    assert(rs.ok || rs.error, 'rate-limit reply');
    assert(rs2.error, 'rapid second message rejected');
    assert((await emit(socks[0], 'chat:send', '   ')).error, 'empty rejected');
    await wait(300);
    assert(got.a.length >= 2 && got.b.length >= 2, 'both players received');
    assert(got.a[0].text === 'გამარჯობა <b>x</b>' && got.a[0].name === 'chata', 'trimmed text and sender name');
    assert(got.c.length === 0, 'outsider received nothing');
    const h = await emit(socks[1], 'chat:history');
    assert(h.messages.length >= 2 && h.messages[0].text.startsWith('გამარჯობა'), 'history kept');
    assert((await emit(socks[2], 'chat:history')).messages.length === 0, 'outsider has no history');
    console.log('OK: chat');
  } finally {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().then(() => process.exit(0), e => { console.error('FAIL:', e.message); process.exit(1); });
