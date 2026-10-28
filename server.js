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
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || process.env.ADMIN_USERNAME || '').trim().toLowerCase();

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TABLES_FILE = path.join(DATA_DIR, 'tables.json');

function load(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function save(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); // the data dir may have been removed while running
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post('/api/register', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 20) || email.split('@')[0];
  if (!EMAIL_RE.test(email) || email.length > 80) return res.status(400).json({ error: 'ჩაწერე სწორი ელფოსტა' });
  if (password.length < 6) return res.status(400).json({ error: 'პაროლი მინიმუმ 6 სიმბოლო უნდა იყოს' });
  if (Object.values(db.users).some(u => u.username === email)) return res.status(409).json({ error: 'ამ ელფოსტით უკვე არის რეგისტრაცია' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    username: email, // the email is the login
    name, salt,
    hash: hashPw(password, salt),
    // the very first account (or ADMIN_EMAIL) becomes the admin
    isAdmin: Object.keys(db.users).length === 0 || email === ADMIN_EMAIL,
  };
  db.users[user.id] = user;
  const token = newSession(user);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = Object.values(db.users).find(u => u.username === email);
  const ok = user && crypto.timingSafeEqual(Buffer.from(hashPw(password, user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
  if (!ok) return res.status(401).json({ error: 'არასწორი ელფოსტა ან პაროლი' });
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

// STUN is enough for most networks; set TURN_URL / TURN_USERNAME / TURN_CREDENTIAL for strict mobile NATs
app.get('/api/ice', auth, (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.json({ iceServers });
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
    players: t.seats.map(s => (s ? { uid: s.userId, name: s.name, online: isOnline(s.userId) } : null)),
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

const roomOf = t => 't:' + t.code;
const voiceSockets = t => [...(io.sockets.adapter.rooms.get(roomOf(t)) || [])]
  .map(id => io.sockets.sockets.get(id)).filter(s => s && s.voice);

function leaveVoice(socket) {
  if (!socket.voice) return;
  socket.voice = false;
  if (socket.tableCode) io.to('t:' + socket.tableCode).emit('voice:left', { uid: socket.user.id });
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

  // ---- text chat: messages live with the table (last 100) ----
  socket.on('chat:history', cb => {
    const t = tables.get(socket.tableCode);
    if (!t || seatOf(t, uid) < 0) return cb?.({ messages: [] });
    cb?.({ messages: t.chat || [] });
  });
  let lastChat = 0;
  socket.on('chat:send', (text, cb) => {
    const t = tables.get(socket.tableCode);
    const seat = t ? seatOf(t, uid) : -1;
    const body = typeof text === 'string' ? text.trim().slice(0, 300) : '';
    if (seat < 0 || !body) return cb?.({ error: 'შეტყობინება ცარიელია' });
    const now = Date.now();
    if (now - lastChat < 400) return cb?.({ error: 'ძალიან სწრაფად წერ' });
    lastChat = now;
    const msg = { id: crypto.randomBytes(4).toString('hex'), uid, name: t.seats[seat].name, text: body, ts: now };
    t.chat = [...(t.chat || []), msg].slice(-100);
    saveTables();
    io.to(roomOf(t)).emit('chat:msg', msg);
    cb?.({ ok: true });
  });

  // ---- voice chat: the server only relays WebRTC signaling between seated players ----
  socket.on('voice:join', cb => {
    const t = tables.get(socket.tableCode);
    if (!t || seatOf(t, uid) < 0) return cb?.({ error: 'მაგიდასთან არ ზიხარ' });
    const peers = [...new Set(voiceSockets(t).map(s => s.user.id))].filter(id => id !== uid);
    socket.voice = true;
    socket.to(roomOf(t)).emit('voice:joined', { uid });
    cb?.({ peers });
  });
  socket.on('voice:leave', () => leaveVoice(socket));
  socket.on('voice:signal', msg => {
    const t = tables.get(socket.tableCode);
    if (!t || !socket.voice || typeof msg?.to !== 'string' || typeof msg.data !== 'object') return;
    for (const s of voiceSockets(t)) if (s.user.id === msg.to) s.emit('voice:signal', { from: uid, data: msg.data });
  });

  socket.on('table:leave', cb => withTable(cb, (t, seat) => {
    leaveVoice(socket);
    if (t.status === 'lobby' && seat >= 0) t.seats[seat] = null;
    socket.leave('t:' + t.code);
    socket.tableCode = null;
  }));

  socket.on('game:bid', (n, cb) => withTable(cb, (t, seat) => {
    if (!t.game || seat < 0) throw new Error('თამაში არ მიდის');
    G.bid(t.game, seat, n);
  }));

  socket.on('game:trump', (suit, cb) => withTable(cb, (t, seat) => {
    if (!t.game || seat < 0) throw new Error('თამაში არ მიდის');
    G.chooseTrump(t.game, seat, suit);
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
    leaveVoice(socket);
    const set = conns.get(uid);
    set?.delete(socket);
    if (!set?.size) conns.delete(uid);
    userTables(uid).forEach(broadcast);
  });
});

// resume pending timers after a restart
for (const t of tables.values()) schedule(t);

server.listen(PORT, () => console.log(`Joker server on http://localhost:${PORT}`));
