'use strict';
// Dev helper: seats N random-playing bots so you can join the remaining seat(s) from a real browser.
// Usage: node test/bots.js [bots=3] [base=http://localhost:3000] [tableCode]
// Without a tableCode it registers admin@test.com (becomes admin on a fresh server) and creates a table.

const { io } = require('socket.io-client');

const BOTS = Number(process.argv[2] || 3);
const BASE = process.argv[3] || 'http://localhost:3000';
const CODE = process.argv[4];
const pick = a => a[Math.floor(Math.random() * a.length)];

async function api(method, url, body, token) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}

async function account(email, name) {
  try { return await api('POST', '/api/register', { email, password: 'secret1', name }); }
  catch { return await api('POST', '/api/login', { email, password: 'secret1' }); }
}

(async () => {
  let table = { code: CODE };
  if (!CODE) {
    const admin = await account('admin@test.com', 'ადმინი');
    table = await api('POST', '/api/tables', { name: 'სატესტო მაგიდა' }, admin.token);
  }
  console.log(`${BASE}/t/${table.code}`);
  for (let i = 1; i <= BOTS; i++) {
    const u = await account(`bot${i}@test.com`, 'ბოტი' + i);
    const s = io(BASE, { auth: { token: u.token } });
    s.on('connect', () => s.emit('table:join', table.code, () => {}));
    s.on('table:state', st => {
      const g = st.game;
      if (!g || g.turn !== st.seat) return;
      setTimeout(() => {
        if (g.phase === 'bidding') s.emit('game:bid', pick([...Array(g.cards + 1).keys()].filter(n => n !== g.forbiddenBid)));
        else if (g.phase === 'playing') s.emit('game:play', { id: pick(g.legal), mode: pick(['high', 'low']), suit: pick(['S', 'C', 'D', 'H']) });
      }, 700);
    });
  }
})();
