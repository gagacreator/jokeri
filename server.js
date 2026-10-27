'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const G = require('./game');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRICK_DELAY = Number(process.env.TRICK_DELAY ?? 1800);
const DEAL_DELAY = Number(process.env.DEAL_DELAY ?? 5000);
const DRAW_STEP = Number(process.env.DRAW_STEP ?? 1000); // ms per card in the ace draw
const DRAW_END = Number(process.env.DRAW_END ?? 4500);
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').toLowerCase();

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TABLES_FILE = path.join(DATA_DIR, 'tables.json');

function load(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function save(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

const db = load(DB_FILE, { users: {}, sessions: {} });
const tables = new Map(Object.entries(load(TABLES_FILE, {})));
const timers = new Map();
const conns = new Map(); // userId -> Set<socket>

const saveDb = () => save(DB_FILE, db);
let saveTimer = null;
function saveTables() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(TABLES_FILE, Object.fromEntries(tables)), 300);
}

// ---------- auth ----------
function hashPw(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}
function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, isAdmin: !!u.isAdmin };
}
function userFromToken(token) {
  const s = token && db.sessions[token];
  return s ? db.users[s.uid] : null;
}
function newSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { uid: user.id, created: Date.now() };
  saveDb();
  return token;
}

const app = express();
app.use(express.json({ limit: '10kb' }));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!user) return res.status(401).json({ error: 'გაიარე ავტორიზაცია' });
  req.user = user;
  next();
}
function adminOnly(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'მხოლოდ ადმინისტრატორისთვის' });
  next();
}

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 20) || username;
  if (!/^[^\s]{3,24}$/.test(username)) return res.status(400).json({ error: 'მომხმარებლის სახელი: 3-24 სიმბოლო, ცარიელი ადგილის გარეშე' });
  if (password.length < 4) return res.status(400).json({ error: 'პაროლი მინიმუმ 4 სიმბოლო უნდა იყოს' });
  if (Object.values(db.users).some(u => u.username === username)) return res.status(409).json({ error: 'ეს სახელი დაკავებულია' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    username, name, salt,
    hash: hashPw(password, salt),
    // the very first account (or ADMIN_USERNAME) becomes the admin
    isAdmin: Object.keys(db.users).length === 0 || username === ADMIN_USERNAME,
  };
  db.users[user.id] = user;
  const token = newSession(user);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = Object.values(db.users).find(u => u.username === username);
  const ok = user && crypto.timingSafeEqual(Buffer.from(hashPw(password, user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
  if (!ok) return res.status(401).json({ error: 'არასწორი სახელი ან პაროლი' });
  res.json({ token: newSession(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- tables ----------
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newCode() {
  let c;
  do {
    c = Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  } while (tables.has(c));
  return c;
}

function tableSummary(t) {
  return {
    code: t.code, name: t.name, status: t.status,
    players: t.seats.filter(Boolean).map(s => s.name),
  };
}

app.post('/api/tables', auth, adminOnly, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30) || 'მაგიდა';
  const t = { code: newCode(), name, createdBy: req.user.id, createdAt: Date.now(), status: 'lobby', seats: [null, null, null, null], game: null };
  tables.set(t.code, t);
  saveTables();
  res.json(tableSummary(t));
});

app.get('/api/tables', auth, adminOnly, (req, res) => {
  res.json({ tables: [...tables.values()].sort((a, b) => b.createdAt - a.createdAt).map(tableSummary) });
});

app.get('/api/tables/:code', auth, (req, res) => {
  const t = tables.get(req.params.code.toLowerCase());
  if (!t) return res.status(404).json({ error: 'მაგიდა ვერ მოიძებნა' });
  res.json(tableSummary(t));
});

app.delete('/api/tables/:code', auth, adminOnly, (req, res) => {
  const code = req.params.code.toLowerCase();
  if (!tables.delete(code)) return res.status(404).json({ error: 'მაგიდა ვერ მოიძებნა' });
  clearTimeout(timers.get(code));
  timers.delete(code);
  io.to('t:' + code).emit('table:closed');
  saveTables();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/t/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- realtime ----------
const server = http.createServer(app);
const io = new Server(server);

const isOnline = uid => (conns.get(uid)?.size || 0) > 0;
const seatOf = (t, uid) => t.seats.findIndex(s => s && s.userId === uid);

function viewFor(t, uid) {
  const seat = seatOf(t, uid);
  const user = db.users[uid];
  return {
    code: t.code,
    name: t.name,
    status: t.status,
    seat,
    isAdmin: !!user?.isAdmin,
    players: t.seats.map(s => (s ? { name: s.name, online: isOnline(s.userId) } : null)),
    game: t.game ? G.viewFor(t.game, seat) : null,
  };
}

function broadcast(t) {
  for (const s of t.seats) {
    if (!s) continue;
    for (const sock of conns.get(s.userId) || []) sock.emit('table:state', viewFor(t, s.userId));
  }
}

function schedule(t) {
  clearTimeout(timers.get(t.code));
  timers.delete(t.code);
  const g = t.game;
  if (!g) return;
  if (g.phase === 'finished') { t.status = 'finished'; return; }
  const delay = g.phase === 'draw' ? g.draw.seq.length * DRAW_STEP + DRAW_END
    : g.phase === 'trickEnd' ? TRICK_DELAY
    : g.phase === 'dealEnd' ? DEAL_DELAY : null;
  if (delay === null) return;
  timers.set(t.code, setTimeout(() => {
    G.advance(g);
    schedule(t);
    saveTables();
    broadcast(t);
  }, delay));
}

function startGame(t) {
  t.status = 'playing';
  t.game = G.newGame(t.seats.map(s => s.name));
}

function userTables(uid) {
  return [...tables.values()].filter(t => seatOf(t, uid) >= 0);
}

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('auth'));
  socket.user = user;
  next();
});

io.on('connection', socket => {
  const uid = socket.user.id;
  if (!conns.has(uid)) conns.set(uid, new Set());
  conns.get(uid).add(socket);
  userTables(uid).forEach(broadcast);

  const withTable = (cb, fn) => {
    const t = tables.get(socket.tableCode);
    if (!t) return cb?.({ error: 'მაგიდა ვერ მოიძებნა' });
    try {
      const r = fn(t, seatOf(t, uid));
      saveTables();
      broadcast(t);
      cb?.(r || { ok: true });
    } catch (e) {
      cb?.({ error: e.message });
    }
  };

  socket.on('table:join', (code, cb) => {
    const t = tables.get(String(code || '').toLowerCase());
    if (!t) return cb?.({ error: 'მაგიდა ვერ მოიძებნა' });
    let seat = seatOf(t, uid);
    if (seat < 0) {
      if (t.status !== 'lobby') return cb?.({ error: 'თამაში უკვე დაიწყო' });
      seat = t.seats.findIndex(s => !s);
      if (seat < 0) return cb?.({ error: 'მაგიდა სავსეა' });
      t.seats[seat] = { userId: uid, name: socket.user.name };
    }
    if (socket.tableCode && socket.tableCode !== t.code) socket.leave('t:' + socket.tableCode);
    socket.tableCode = t.code;
    socket.join('t:' + t.code);
    if (t.status === 'lobby' && t.seats.every(Boolean)) {
      startGame(t);
      schedule(t);
    }
    saveTables();
    broadcast(t);
    cb?.({ ok: true });
  });

  socket.on('table:leave', cb => withTable(cb, (t, seat) => {
    if (t.status === 'lobby' && seat >= 0) t.seats[seat] = null;
    socket.leave('t:' + t.code);
    socket.tableCode = null;
  }));

  socket.on('game:bid', (n, cb) => withTable(cb, (t, seat) => {
    if (!t.game || seat < 0) throw new Error('თამაში არ მიდის');
    G.bid(t.game, seat, n);
  }));

  socket.on('game:play', (msg, cb) => withTable(cb, (t, seat) => {
    if (!t.game || seat < 0) throw new Error('თამაში არ მიდის');
    G.play(t.game, seat, String(msg?.id), { mode: msg?.mode, suit: msg?.suit });
    schedule(t);
  }));

  socket.on('game:rematch', cb => withTable(cb, t => {
    if (!socket.user.isAdmin) throw new Error('მხოლოდ ადმინისტრატორისთვის');
    if (!t.game || t.game.phase !== 'finished') throw new Error('თამაში ჯერ არ დასრულებულა');
    startGame(t);
    schedule(t);
  }));

  socket.on('disconnect', () => {
    const set = conns.get(uid);
    set?.delete(socket);
    if (!set?.size) conns.delete(uid);
    userTables(uid).forEach(broadcast);
  });
});

// resume pending timers after a restart
for (const t of tables.values()) schedule(t);

server.listen(PORT, () => console.log(`Joker server on http://localhost:${PORT}`));
