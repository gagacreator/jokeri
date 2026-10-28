'use strict';

const app = document.getElementById('app');
const SYM = { S: '♠', C: '♣', D: '♦', H: '♥' };
const RANKS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const isRed = s => s === 'H' || s === 'D';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let token = localStorage.getItem('joker_token');
let me = null;
let socket = null;
let tableCode = null;
let joinMode = null; // 'play' | 'watch' once the visitor chose
let st = null; // latest table state
let selected = null; // card id raised in hand
let jokerPick = null; // joker card id awaiting mode choice
let jokerMode = null; // 'high' (მიმყავს) / 'low' (არ მიმყავს) chosen while leading, before picking the suit
let showScore = false;
let showLast = false;
let turnDeadline = null; // performance.now() value at which the current player's 15 s run out

// countdown next to the status line and a ring filling around the acting player's avatar, updated without re-rendering
const TURN_MS = 15000; // must match the server's TURN_LIMIT default
function tickTimer() {
  const ms = turnDeadline === null ? null : Math.max(0, turnDeadline - performance.now());
  const el = document.querySelector('.status .tmr');
  if (el) {
    el.textContent = ms === null ? '' : ` · ${Math.ceil(ms / 1000)}`;
    el.classList.toggle('late', ms !== null && ms <= 5000);
  }
  const p = ms === null ? 0 : Math.min(100, (1 - ms / TURN_MS) * 100);
  document.querySelectorAll('.seat.turn .av, .mine-info.turn .av').forEach(a => {
    a.style.setProperty('--p', p.toFixed(1) + '%');
    a.classList.toggle('late', ms !== null && ms <= 5000);
  });
}
setInterval(tickTimer, 100);

// ---------- sounds: tap a player's avatar to play one of these for the whole table ----------
const SOUNDS = [
  { id: 'bicho', label: 'ბიჭო, დროზე!', icon: '🗣️', file: '/bicho.mp3?v=1' },
  { id: 'joker', label: 'ჯოკერი', icon: '🃏', file: '/joker.mp3?v=1' },
  { id: 'wah', label: 'სევდიანი', icon: '😢' },
  { id: 'clap', label: 'ტაში', icon: '👏' },
  { id: 'bell', label: 'ზარი', icon: '🔔' },
  { id: 'buzz', label: 'არასწორია', icon: '❌' },
];
const audioFiles = {};
SOUNDS.filter(s => s.file).forEach(s => { audioFiles[s.id] = new Audio(s.file); audioFiles[s.id].preload = 'auto'; });
let audioCtx = null;
const ctx = () => (audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)());
function tone(type, f0, f1, at, dur, vol = .3) {
  const c = ctx();
  const o = c.createOscillator();
  const gn = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, c.currentTime + at);
  if (f1 !== f0) o.frequency.linearRampToValueAtTime(f1, c.currentTime + at + dur);
  gn.gain.setValueAtTime(.0001, c.currentTime + at);
  gn.gain.exponentialRampToValueAtTime(vol, c.currentTime + at + .02);
  gn.gain.exponentialRampToValueAtTime(.0001, c.currentTime + at + dur);
  o.connect(gn).connect(c.destination);
  o.start(c.currentTime + at);
  o.stop(c.currentTime + at + dur + .02);
}
const SYNTH = {
  buzz: () => { tone('sawtooth', 150, 110, 0, .24); tone('sawtooth', 150, 110, .28, .24); },
  wah: () => { tone('sawtooth', 233, 233, 0, .4, .22); tone('sawtooth', 220, 220, .45, .4, .22); tone('sawtooth', 208, 208, .9, .4, .22); tone('sawtooth', 196, 150, 1.35, 1, .22); },
  bell: () => { [0, .5, 1].forEach(d => { tone('sine', 880, 880, d, .6, .35); tone('sine', 1760, 1760, d, .4, .12); }); },
  clap: () => {
    const c = ctx();
    for (let k = 0; k < 14; k++) {
      const len = Math.floor(c.sampleRate * .06);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = c.createBufferSource();
      const gn = c.createGain();
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1800 + Math.random() * 1200;
      gn.gain.value = .5;
      src.buffer = buf;
      src.connect(f).connect(gn).connect(c.destination);
      src.start(c.currentTime + k * .11 + Math.random() * .05);
    }
  },
};
function playSound(id) {
  try {
    if (audioFiles[id]) { audioFiles[id].currentTime = 0; audioFiles[id].play().catch(() => {}); } else SYNTH[id]?.();
  } catch { /* audio is optional */ }
}
function onSound(m) {
  const s = SOUNDS.find(x => x.id === m.id);
  toast(`${s?.icon || '🔊'} ${m.fromName} → ${m.toName}: ${s?.label || ''}`);
  playSound(m.id);
  // the target's avatar shakes while it plays
  document.querySelectorAll(`[data-seat="${m.to}"] .av`).forEach(a => {
    a.classList.remove('shake');
    void a.offsetWidth;
    a.classList.add('shake');
  });
}
let soundTarget = null; // seat whose profile was tapped (sound picker open)
function soundsHtml() {
  const g = st.game;
  return `<div class="overlay mid soundov"><div class="sheet soundsheet">
    <button class="xbtn" data-act="sounds-close" aria-label="დახურვა">✕</button>
    <h3>${esc(g.names[soundTarget])}-ს გავუგზავნო</h3>
    <div class="soundgrid">${SOUNDS.map(s => `<button class="sbtn" data-act="sound" data-id="${s.id}"><span>${s.icon}</span><b>${s.label}</b></button>`).join('')}</div>
  </div></div>`;
}
let authMode = 'login';

// ---------- helpers ----------
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'შეცდომა');
  return j;
}

function go(path) {
  history.pushState({}, '', path);
  route();
}
window.addEventListener('popstate', route);

function tableLink(code) {
  return location.origin + '/t/' + code;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('ლინკი დაკოპირდა');
}

async function shareLink(code, name) {
  const url = tableLink(code);
  if (navigator.share) {
    try { await navigator.share({ title: 'ჯოკერი', text: `შემოდი ჯოკერის მაგიდაზე: ${name}`, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copyText(url);
}

// ---------- routing ----------
async function boot() {
  if (token) {
    try { me = (await api('GET', '/api/me')).user; } catch { token = null; localStorage.removeItem('joker_token'); }
  }
  route();
}

function route() {
  const m = location.pathname.match(/^\/t\/([a-z0-9]+)\/?$/i);
  if (!me) return renderAuth();
  if (m) return enterTable(m[1].toLowerCase());
  leaveTableView();
  renderHome();
}

function leaveTableView() {
  Voice.leaveTable();
  Chat.leave();
  soundTarget = null;
  tableCode = null;
  joinMode = null;
  st = null;
  selected = null;
  jokerPick = null;
  jokerMode = null;
  showScore = false;
  showLast = false;
}

function logout() {
  localStorage.removeItem('joker_token');
  token = null;
  me = null;
  socket?.disconnect();
  socket = null;
  leaveTableView();
  renderAuth();
}

// ---------- auth ----------
function renderAuth(error = '') {
  const reg = authMode === 'register';
  app.innerHTML = `
    <div class="screen">
      <div class="logo">♠ ჯოკერი ♥<small>გასართობი ბანქოს თამაში</small></div>
      <div class="tabs">
        <button data-act="mode-login" class="${reg ? '' : 'on'}">შესვლა</button>
        <button data-act="mode-register" class="${reg ? 'on' : ''}">რეგისტრაცია</button>
      </div>
      <form class="card-box" id="authForm">
        ${reg ? `<div><label>სახელი (როგორც გამოჩნდება მაგიდასთან)</label><input name="name" maxlength="20" autocomplete="name" required></div>` : ''}
        <div><label>ელფოსტა (Mail)</label><input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" autocorrect="off" placeholder="name@example.com" required></div>
        <div><label>პაროლი${reg ? ' (მინიმუმ 6 სიმბოლო)' : ''}</label><input name="password" type="password" minlength="${reg ? 6 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}" required></div>
        <div class="err" id="authErr">${esc(error)}</div>
        <button class="btn" type="submit">${reg ? 'რეგისტრაცია' : 'შესვლა'}</button>
      </form>
    </div>`;
}

async function submitAuth(form) {
  const f = Object.fromEntries(new FormData(form));
  const err = document.getElementById('authErr');
  try {
    const r = await api('POST', authMode === 'register' ? '/api/register' : '/api/login', f);
    token = r.token;
    me = r.user;
    localStorage.setItem('joker_token', token);
    route();
  } catch (e) {
    err.textContent = e.message;
  }
}

// ---------- home ----------
async function renderHome() {
  app.innerHTML = `
    <div class="screen">
      <div class="topline">
        <div><b>${esc(me.name)}</b> ${me.isAdmin ? '<span class="badge live">ადმინი</span>' : ''}</div>
        <button class="btn sm sec" data-act="logout">გასვლა</button>
      </div>
      <div class="logo">♠ ჯოკერი ♥</div>
      ${me.isAdmin ? `
        <form class="card-box" id="createForm">
          <h2>ახალი მაგიდა</h2>
          <input name="name" maxlength="30" placeholder="მაგიდის სახელი (არასავალდებულო)">
          <button class="btn" type="submit">მაგიდის შექმნა</button>
          <div class="err" id="homeErr"></div>
        </form>
        <div id="tableList" class="col"><div class="muted">იტვირთება…</div></div>
      ` : `
        <form class="card-box" id="joinForm">
          <h2>მაგიდასთან შესვლა</h2>
          <div class="muted">გახსენი ადმინისტრატორის გამოგზავნილი ლინკი, ან ჩასვი აქ:</div>
          <input name="link" placeholder="ლინკი ან კოდი" autocapitalize="none" autocorrect="off">
          <button class="btn" type="submit">შესვლა</button>
          <div class="err" id="homeErr"></div>
        </form>`}
    </div>`;
  if (me.isAdmin) loadTables();
}

async function loadTables() {
  const box = document.getElementById('tableList');
  if (!box) return;
  try {
    const { tables } = await api('GET', '/api/tables');
    if (!document.getElementById('tableList')) return;
    box.innerHTML = tables.length ? tables.map(t => `
      <div class="tbl" style="margin-bottom:10px">
        <div class="topline">
          <span class="name">${esc(t.name)}</span>
          <span class="badge ${t.status === 'playing' ? 'live' : ''}">${t.status === 'lobby' ? `ელოდება ${t.players.length}/4` : t.status === 'playing' ? 'თამაში მიდის' : 'დასრულდა'}</span>
        </div>
        <div class="link">${esc(tableLink(t.code))}</div>
        ${t.players.length ? `<div class="muted">${t.players.map(esc).join(', ')}</div>` : ''}
        <div class="row wrap">
          <button class="btn sm" data-act="share" data-code="${t.code}" data-name="${esc(t.name)}">გაგზავნა</button>
          <button class="btn sm sec" data-act="copy" data-code="${t.code}">კოპირება</button>
          <button class="btn sm sec" data-act="open" data-code="${t.code}">გახსნა</button>
          <button class="btn sm danger" data-act="del" data-code="${t.code}">წაშლა</button>
        </div>
      </div>`).join('') : '<div class="muted">მაგიდები ჯერ არ არის</div>';
  } catch (e) {
    box.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

// ---------- table / socket ----------
function ensureSocket() {
  if (socket) return;
  socket = io({ auth: { token } });
  Voice.attach(socket);
  Chat.attach(socket);
  socket.on('connect', () => {
    if (tableCode) joinMode ? socket.emit('table:join', tableCode, joinMode, handleJoinResult) : startEntry();
  });
  socket.on('table:state', s => {
    if (s.code !== tableCode) return;
    st = s;
    turnDeadline = s.turnLeft === null || s.turnLeft === undefined ? null : performance.now() + s.turnLeft;
    Voice.setState(s);
    Chat.setState(s);
    const g = s.game;
    if (selected && !(g && g.legal.includes(selected))) selected = null;
    renderTable();
  });
  socket.on('sound:play', onSound);
  socket.on('table:closed', () => {
    toast('მაგიდა დაიხურა');
    go('/');
  });
  socket.on('connect_error', err => {
    if (err.message === 'auth') logout();
  });
}

function handleJoinResult(r) {
  if (r?.error) {
    app.innerHTML = `
      <div class="screen">
        <div class="logo">♠ ჯოკერი ♥</div>
        <div class="card-box"><h2>${esc(r.error)}</h2><button class="btn" data-act="home">მთავარი გვერდი</button></div>
      </div>`;
    tableCode = null;
  }
}

function enterTable(code) {
  if (tableCode === code && st) return renderTable();
  tableCode = code;
  joinMode = null;
  st = null;
  app.innerHTML = '<div class="screen"><div class="muted" style="text-align:center;margin-top:40vh">იტვირთება…</div></div>';
  ensureSocket();
  if (socket.connected) startEntry();
}

// seated players rejoin at once; others pick "play" or "watch" (a started or full table can only be watched)
function startEntry() {
  const code = tableCode;
  socket.emit('table:info', code, info => {
    if (code !== tableCode) return;
    if (info?.error) return handleJoinResult(info);
    joinAs('play'); // no watching; the server refuses the admin
  });
}

function joinAs(mode) {
  joinMode = mode;
  socket.emit('table:join', tableCode, mode, handleJoinResult);
}

function emit(ev, payload) {
  socket.emit(ev, payload, r => { if (r?.error) toast(r.error); });
}

function renderTable() {
  if (!st) return;
  if (!st.game) return renderLobby();
  renderGame();
}

function renderLobby() {
  const missing = st.players.filter(p => !p).length;
  app.innerHTML = `
    <div class="screen">
      <div class="topline">
        <b>${esc(st.name)}</b>
        <button class="btn sm sec" data-act="leave">გასვლა</button>
      </div>
      <div class="logo">♠ ჯოკერი ♥<small>${missing ? `ელოდება კიდევ ${missing} მოთამაშეს` : 'იწყება…'}</small></div>
      ${st.spectator ? '<div class="muted" style="text-align:center">👁 უყურებ როგორც მაყურებელი</div>' : ''}
      <div class="slots">
        ${st.players.map(p => p ? `<div class="slot" data-uid="${p.uid}"><span class="dot ${p.online ? '' : 'off'}"></span>${esc(p.name)}</div>` : '<div class="slot empty">თავისუფალია</div>').join('')}
      </div>
      <div class="card-box">
        <div class="muted">გაუგზავნე ლინკი მეგობრებს. როცა 4 მოთამაშე შეიკრიბება, თამაში ავტომატურად დაიწყება.${st.watchers ? ` 👁 მაყურებელი: ${st.watchers}` : ''}</div>
        ${st.spectator && missing && !st.isAdmin ? '<button class="btn" data-act="sit">მინდა ვითამაშო</button>' : ''}
        <div class="row">
          <button class="btn grow" data-act="share" data-code="${st.code}" data-name="${esc(st.name)}">ლინკის გაგზავნა</button>
          <button class="btn sec" data-act="copy" data-code="${st.code}">კოპირება</button>
        </div>
      </div>
      ${st.isAdmin ? '<button class="btn sec" data-act="home">ადმინ პანელი</button>' : ''}
    </div>`;
}

// ---------- game ----------
const DRAW_STEP = 1000; // must match the server's DRAW_STEP default
const JOKER_EXTRA = 1500; // must match the server's JOKER_EXTRA default

// time since an animation key was first rendered; lets re-renders continue animations instead of restarting them
const seen = new Map();
function elapsed(key) {
  const now = performance.now();
  if (!seen.has(key)) seen.set(key, now);
  return now - seen.get(key);
}

let rerenderTimer = null;
function rerenderIn(ms) {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => { if (st?.game) renderGame(); }, Math.max(20, ms));
}

function card3d(c, { cls = '', style = '', attrs = '' } = {}) {
  const red = isRed(c.s) ? 'red' : '';
  if (c.s === 'J') {
    return `<div class="c3 joker ${cls}" style="${style}" ${attrs}><div class="cf front"><span class="cr">JOKER</span><span class="cc">🃏</span></div><div class="cf back"></div></div>`;
  }
  const rank = RANKS[c.r] || c.r;
  return `<div class="c3 ${red} ${cls}" style="${style}" ${attrs}><div class="cf front"><span class="cr">${rank}<br>${SYM[c.s]}</span><span class="cc">${SYM[c.s]}</span><span class="cr br">${rank}<br>${SYM[c.s]}</span></div><div class="cf back"></div></div>`;
}

// spectators see every hand face up: small overlapping chips (rank over suit)
function specCards(cards, size = '', perRow = 5) {
  const chip = c => c.s === 'J'
    ? '<i class="sc jk">🃏</i>'
    : `<i class="sc ${isRed(c.s) ? 'red' : ''}"><b>${RANKS[c.r] || c.r}</b>${SYM[c.s]}</i>`;
  const rows = [];
  for (let i = 0; i < cards.length; i += perRow) rows.push(cards.slice(i, i + perRow));
  return `<div class="spec-hand ${size}">${rows.map(r => `<div class="spec-row">${r.map(chip).join('')}</div>`).join('')}</div>`;
}

function backs(n) {
  return '<i></i>'.repeat(Math.min(n, 9));
}

// trump is shown once, as a card: the turned-up card in pulkas 1/3, a suit tile when a player named it (pulkas 2/4)
function suitTile(sym, cls = '') {
  return `<div class="c3 tile ${cls}"><div class="cf front"><span class="cc">${sym}</span></div><div class="cf back"></div></div>`;
}

function trumpChip(g) {
  if (g.trump === null || g.trump === undefined) return `<span class="tl">კოზირი</span>${suitTile('—')}`;
  if (g.trump === 'N') return `<span class="tl">უკოზირო</span>${suitTile('∅', 'tn')}`;
  if (!g.trumpCard) return `<span class="tl">კოზირი</span>${suitTile(SYM[g.trump], isRed(g.trump) ? 'red' : '')}`;
  const delay = dealTotalMs(g) - elapsed(dealKey(g));
  return `<span class="tl">კოზირი</span>${card3d(g.trumpCard, { cls: 'flipin', style: `animation-delay:${delay}ms` })}`;
}

const AVATAR_COLORS = ['#e8b04a', '#62b0e0', '#d58bc8', '#82cc86'];
function avatar(seat, name, inner = '', cls = '') {
  const initial = [...String(name)][0] || '?';
  return `<div class="av ${cls}" style="--c:${AVATAR_COLORS[seat % 4]}">${esc(initial)}${inner}</div>`;
}

// bid as a number badge, tricks taken as filled pips (gold within the bid, red beyond it)
function tally(g, seat) {
  const bid = g.bids[seat];
  if (bid === null) return g.phase === 'bidding' ? '<div class="tally"><span class="bn wait">…</span></div>' : '';
  const taken = g.tricksWon[seat];
  const n = Math.max(bid, taken);
  let pips = '';
  for (let i = 0; i < n; i++) pips += `<i class="${i < taken ? (i < bid ? 'on' : 'over') : ''}"></i>`;
  // no number: the rings are the bid, filled ones are the tricks taken; a pass shows a small "პასი" until it takes something
  // above 5 the rings are hard to count, so the bid number comes back
  const num = bid > 5 ? `<span class="bn ${taken > bid ? 'over' : taken === bid ? 'ok' : ''}">${bid}</span>` : '';
  return `<div class="tally">${num}${pips ? `<span class="pips">${pips}</span>` : num ? '' : '<span class="bn wait">პასი</span>'}</div>`;
}

const gameId = g => g.draw.seq.map(x => x.card.id).join('');
const dealKey = g => `deal:${gameId(g)}:${g.dealIdx}`;
const dealStep = g => Math.min(80, 1800 / (4 * Math.max(1, g.cards)));
const dealTotalMs = g => 4 * g.cards * dealStep(g) + 600;

function seatBox(g, seat, pos) {
  const online = st.players[seat]?.online;
  const dealer = g.dealer === seat ? '<span class="dealer">D</span>' : '';
  return `
    <div class="seat ${pos} ${g.turn === seat ? 'turn' : ''}" data-uid="${st.players[seat]?.uid || ''}" data-seat="${seat}">
      <div class="avtap" data-act="sounds" data-seat="${seat}">${avatar(seat, g.names[seat], `${dealer}<span class="dot ${online ? '' : 'off'}"></span>`)}</div>
      <div class="nm">${esc(g.names[seat])}</div>
      ${tally(g, seat)}
      ${g.allHands ? specCards(g.allHands[seat]) : `<div class="minihand">${backs(g.handCounts[seat])}</div>`}
    </div>`;
}

function trickHtml(g, mySeat) {
  const trickNo = g.tricksWon.reduce((a, b) => a + b, 0);
  const wRel = g.trickWinner === null ? 0 : (g.trickWinner - mySeat + 4) % 4;
  // one shared clock for the sweep so all four cards leave together as a pile
  const se = g.phase === 'trickEnd' ? elapsed(`sw:${dealKey(g)}:${trickNo}`) : 0;
  // a trick with a joker is held longer before it is swept away, so its animation is clearly visible
  const sweepAt = 1150 + (g.trick.some(t => t.card.s === 'J') ? JOKER_EXTRA : 0);
  return g.trick.map((t, i) => {
    const rel = (t.seat - mySeat + 4) % 4;
    const e = elapsed(`tc:${dealKey(g)}:${trickNo}:${t.seat}`);
    // playIn runs right away, sweep (only while the trick is ending) starts late in the pause
    const style = `animation-delay:${-e}ms,${sweepAt - se}ms`;
    const joker = t.card.s === 'J';
    const take = joker && t.mode !== 'low';
    let badge = '';
    if (joker) {
      const suit = t.suit ? `<i class="${isRed(t.suit) ? 'red' : ''}">${SYM[t.suit]}</i>` : '';
      badge = `<span class="jbadge ${take ? 'take' : 'give'}">${take ? 'მიმყავს' : 'არ მიმყავს'}${suit}</span>`;
    }
    // take: the joker slams onto the pile from above; give: it slides in from below and ends up underneath
    const z = joker ? (take ? 10 + i : 0) : i + 1; // a taking joker stays on top of the pile, a giving one stays under it
    const cls = `slotc s${rel} w${wRel} ${g.trickWinner === t.seat ? 'win' : ''} ${joker ? (take ? 'jtake' : 'jgive') : ''}`;
    const sparks = joker && take ? `<span class="jsparks">${Array.from({ length: 16 }, (_, k) => `<i style="--a:${k * 22.5}deg;--d:${34 + (k % 3) * 14}px"></i>`).join('')}</span>` : '';
    return `<div class="${cls}" style="z-index:${z};--e:${-e}ms">${joker ? '<span class="jaura"></span>' : ''}${sparks}${card3d(t.card, { style })}${badge}</div>`;
  }).join('');
}

function lastTrickHtml(g) {
  if (!g.lastTrick) return '';
  const items = g.lastTrick.map(t => `<div class="lt-item ${g.lastWinner === t.seat ? 'win' : ''}">${card3d(t.card)}<span>${esc(g.names[t.seat])}${g.lastWinner === t.seat ? ' ★' : ''}</span></div>`).join('');
  return `<div class="ltc">
    <button class="lt-toggle ${showLast ? 'open' : ''}" data-act="last">↺ ბოლო ხელი</button>
    ${showLast ? `<div class="lt-row">${items}</div>` : ''}
  </div>`;
}

function statusText(g, mySeat) {
  if (g.phase === 'bidding') return g.turn === mySeat ? 'შენი დაკვეთის რიგია' : `${g.names[g.turn]} აკვეთებს…`;
  if (g.phase === 'trump') return g.turn === mySeat ? 'აირჩიე კოზირი' : `${g.names[g.turn]} ირჩევს კოზირს…`;
  if (g.phase === 'playing') return g.turn === mySeat ? 'შენი სვლაა' : `${g.names[g.turn]}-ის სვლაა`;
  if (g.phase === 'trickEnd') return `${g.names[g.trickWinner]} იღებს ხელს`;
  return '';
}

function renderDraw(g, mySeat) {
  const seq = g.draw.seq;
  const key = `draw:${gameId(g)}`;
  const e = elapsed(key);
  const shown = Math.min(seq.length, Math.floor(e / DRAW_STEP) + 1);
  const done = shown === seq.length && e >= (seq.length - 1) * DRAW_STEP + 900;
  if (shown < seq.length || !done) rerenderIn(shown < seq.length ? DRAW_STEP - (e % DRAW_STEP) : (seq.length - 1) * DRAW_STEP + 900 - e);
  const seatAt = rel => (mySeat + rel) % 4;
  const posOf = ['me', 'left', 'top', 'right'];
  const box = rel => {
    const seat = seatAt(rel);
    const mine = seq.slice(0, shown).map((x, i) => ({ ...x, i })).filter(x => x.seat === seat);
    const win = done && g.draw.winner === seat;
    return `<div class="seat ${posOf[rel]} ${win ? 'winner' : ''}" data-uid="${st.players[seat]?.uid || ''}">
      ${avatar(seat, g.names[seat], win ? '<span class="dealer">D</span>' : '')}
      <div class="nm">${esc(g.names[seat])}</div>
      <div class="drawrow">${mine.map(x => card3d(x.card, {
        cls: `drawfly r${rel}`,
        style: `animation-delay:${-elapsed(`${key}:${x.i}`)}ms`,
      })).join('')}</div>
    </div>`;
  };
  const banner = done
    ? `🂡 ${esc(g.names[g.draw.winner])}-ს ამოუვიდა ტუზი!<br><span style="font-size:13px;font-weight:500;color:#fff">ის დილერია და ყველაზე ბოლოს აკვეთებს</span>`
    : 'ვინ ამოიღებს ტუზს…';
  app.innerHTML = `
    <div class="game">
      <div class="felt3d"></div>
      <div class="topbar"></div>
      <div class="board drawing">
        ${box(2)}${box(1)}
        <div class="center"><div class="deck"><i></i><i></i><i></i><i></i></div></div>
        ${box(3)}${box(0)}
      </div>
      <div class="drawbanner">${banner}</div>
      <div class="acehint">პირველი ტუზის მიღებამდე კარტებს სათითაოდ ვაჩვენებთ</div>
    </div>`;
}

// one row while the cards fit without heavy overlap, otherwise two rows
function handRows(n) {
  const avail = Math.min(window.innerWidth, 520) - 56; // margin for the fan rotation
  const needOverlap = n > 1 ? (n * 56 - avail) / (n - 1) : 0;
  return n >= 2 && needOverlap > 8 ? 2 : 1;
}

function handHtml(g, playingTurn, dealT) {
  const n = g.hand.length;
  const cardW = 56;
  const avail = Math.min(window.innerWidth, 520) - 56; // margin for the fan rotation
  const rows = handRows(n);
  const perRow = rows === 2 ? [Math.ceil(n / 2), Math.floor(n / 2)] : [n];
  const step = dealStep(g);
  const pos = (st.seat - g.dealer - 1 + 4) % 4;
  const dealing = dealT < dealTotalMs(g);
  let idx = 0;
  return perRow.map(count => {
    const overlap = count > 1 ? Math.max(rows === 2 ? -4 : 4, (count * cardW - avail) / (count - 1)) : 0;
    const ang = rows === 2 ? Math.min(2.5, 14 / count) : Math.min(5, 36 / Math.max(count, 1));
    const cards = g.hand.slice(idx, idx + count).map((c, j) => {
      const i = idx + j;
      const off = j - (count - 1) / 2;
      const cls = ['hc', !playingTurn || g.legal.includes(c.id) ? 'ok' : 'dim', playingTurn ? 'myturn' : '', c.s === 'J' ? 'jk' : '', selected === c.id ? 'sel' : ''].join(' ');
      const delay = (i * 4 + pos) * step - dealT; // order in which this card is dealt out
      const style = `--rot:${(off * ang).toFixed(1)}deg;--ty:${(off * off * (rows === 2 ? 0.4 : 0.9)).toFixed(1)}px;${j ? `margin-left:${-overlap}px` : ''}`;
      const inner = card3d(c, { cls: dealing ? 'dealin' : '', style: dealing ? `animation-delay:${delay}ms` : '' });
      return `<div class="${cls}" style="${style}" data-id="${c.id}">${inner}</div>`;
    }).join('');
    idx += count;
    return `<div class="hrow">${cards}</div>`;
  }).join('');
}

function ghostsHtml(g, mySeat, dealT) {
  const dirs = [[0, 36, 8], [-40, 4, -20], [0, -30, 10], [40, 4, 25]]; // vw/vh offsets per relative seat
  const step = dealStep(g);
  let out = '';
  for (let k = 0; k < 4 * g.cards; k++) {
    const seat = (g.dealer + 1 + (k % 4)) % 4;
    const rel = (seat - mySeat + 4) % 4;
    if (rel === 0) continue; // own cards fly into the hand itself
    const [x, y, r] = dirs[rel];
    out += `<div class="ghost" style="--tx:${x}vw;--ty:${y}vh;--gr:${r}deg;animation-delay:${k * step - dealT}ms"></div>`;
  }
  return out;
}

function renderGame() {
  const g = st.game;
  const spectator = st.seat < 0;
  const mySeat = spectator ? 0 : st.seat; // spectators see the table from seat 0's side, without any hand
  if (g.phase === 'draw') return renderDraw(g, mySeat);

  const seatAt = rel => (mySeat + rel) % 4;
  const myTurn = !spectator && g.turn === mySeat;
  const playingTurn = myTurn && g.phase === 'playing';
  const dealT = elapsed(dealKey(g));
  const dealing = dealT < dealTotalMs(g);
  if (dealing) rerenderIn(dealTotalMs(g) - dealT + 30);

  const two = handRows(g.hand.length) === 2;
  // joker cinematic: the camera pushes in on the joker, follows it down and pulls back; the clock continues across re-renders
  const jt = g.trick.find(t => t.card.s === 'J');
  const jmode = jt ? (jt.mode === 'low' ? 'give' : 'take') : '';
  const jdelay = jt ? `animation-delay:${-elapsed(`tc:${dealKey(g)}:${g.tricksWon.reduce((a, b) => a + b, 0)}:${jt.seat}`)}ms` : '';
  app.innerHTML = `
    <div class="game ${two ? 'two' : ''}">
      <div class="felt3d"></div>
      <div class="topbar">
        <button class="iconbtn" data-act="score">ცხრილი</button>
        <div class="trump">${trumpChip(g)}</div>
      </div>
      ${jt ? `<div class="jvig ${jmode}" style="${jdelay}"></div>` : ''}
      <div class="board ${jt ? 'jcam ' + jmode : ''}" style="${jdelay}">
        ${seatBox(g, seatAt(2), 'top')}
        ${seatBox(g, seatAt(1), 'left')}
        <div class="center ${g.phase === 'trickEnd' ? 'ending' : ''} ${g.trick.some(t => t.card.s === 'J') ? 'hasjoker' : ''}">${dealing ? '<div class="deck"><i></i><i></i><i></i><i></i></div>' : ''}${trickHtml(g, mySeat)}</div>
        ${seatBox(g, seatAt(3), 'right')}
        ${dealing ? ghostsHtml(g, mySeat, dealT) : ''}
      </div>
      <div class="status ${myTurn ? 'mine' : ''}">${spectator ? '👁 ' : ''}${esc(dealing ? 'კარტებს ვარიგებთ…' : statusText(g, spectator ? -1 : mySeat))}<b class="tmr"></b></div>
      <div class="mine-info ${myTurn || (spectator && g.turn === 0) ? 'turn' : ''}" data-seat="${mySeat}">${avatar(mySeat, g.names[mySeat], g.dealer === mySeat ? '<span class="dealer">D</span>' : '', 'sm')}<span class="nm">${esc(g.names[mySeat])}</span>${tally(g, mySeat)}</div>
      ${spectator ? `<div class="hand spec" id="hand">${specCards(g.allHands[0], 'lg', 9)}</div>` : `<div class="hand" id="hand">${handHtml(g, playingTurn, dealT)}</div>`}
      ${lastTrickHtml(g)}
      ${overlayHtml(g, spectator ? -1 : mySeat, dealing)}
      ${soundTarget !== null && !spectator ? soundsHtml() : ''}
    </div>`;
  tickTimer();
  document.getElementById('chat')?.classList.toggle('two', two);
  document.getElementById('chatfeed')?.classList.toggle('two', two);
  document.body.classList.toggle('modal-open', !!document.querySelector('.overlay:not(.panel)'));
}

function overlayHtml(g, mySeat, dealing) {
  const myTurn = g.turn === mySeat;
  if (g.phase === 'finished') return finishedHtml(g);
  if (showScore) return scoreHtml(g);
  if (g.phase === 'dealEnd') return dealEndHtml(g);
  if (jokerPick && myTurn && g.phase === 'playing') return jokerHtml(g);
  if (myTurn && g.phase === 'bidding' && !dealing) {
    const nums = [...Array(g.cards + 1).keys()];
    return `<div class="overlay panel"><div class="sheet bidsheet">
      <h3>რამდენს აიღებ?</h3>
      <div class="numgrid">${nums.map(n => `<button class="btn" data-act="bid" data-n="${n}" ${g.forbiddenBid === n ? 'disabled' : ''}>${n}</button>`).join('')}</div>
      ${g.forbiddenBid !== null ? `<div class="bidnote">დილერს ${g.forbiddenBid} არ შეუძლია</div>` : ''}
    </div></div>`;
  }
  if (myTurn && g.phase === 'trump' && !dealing) {
    return `<div class="overlay panel"><div class="sheet trumpsheet">
      <h3>აირჩიე კოზირი</h3>
      <div class="suitrow">${['D', 'C', 'H', 'S'].map(x => `<button class="suitbtn ${isRed(x) ? 'red' : 'blk'}" data-act="trump" data-s="${x}">${SYM[x]}</button>`).join('')}</div>
      <button class="suitbtn jbtn" data-act="trump" data-s="N"><span class="jstar">★</span><span class="jl">J</span><span class="jt">უკოზირო</span></button>
    </div></div>`;
  }
  return '';
}

function jokerHtml(g) {
  const leading = g.trick.length === 0;
  const suits = leading && jokerMode ? `
    <div class="jsuits">
      <div class="jhint">${jokerMode === 'high' ? 'აირჩიე ნიშანი, რომელსაც დანარჩენები მოგყვებიან' : 'აირჩიე ნიშანი, რომელიც მოთხოვნილი იქნება'}</div>
      <div class="jsuitrow">${['S', 'C', 'D', 'H'].map(x => `<button class="jsuit ${isRed(x) ? 'red' : ''}" data-act="joker" data-s="${x}">${SYM[x]}</button>`).join('')}</div>
    </div>` : '';
  return `<div class="overlay jover"><div class="sheet jsheet">
    <div class="jhead">${card3d({ id: 'J1', s: 'J', r: 15 }, { cls: 'jspin' })}<h3>ჯოკერი</h3></div>
    <div class="jopts">
      <button class="jopt take ${jokerMode === 'high' ? 'on' : ''}" data-act="jmode" data-mode="high"><span class="jico mini take"><i class="mc base"></i><i class="mc jk">J</i><i class="ring"></i></span><b>მიმყავს</b><small>ხელს ვიღებ</small></button>
      <button class="jopt give ${jokerMode === 'low' ? 'on' : ''}" data-act="jmode" data-mode="low"><span class="jico mini give"><i class="mc jk">J</i><i class="mc base"></i></span><b>არ მიმყავს</b><small>ხელს ვუთმობ</small></button>
    </div>
    ${suits}
    <button class="jcancel" data-act="joker-cancel">გაუქმება</button>
  </div></div>`;
}

function scoreTable(g) {
  const head = g.names.map((n, i) => `<th colspan="2" class="${i === st.seat ? 'me' : ''}">${esc(n)}</th>`).join('');
  // full layout from the start: 1..8, 9x4, 8..1, 9x4; per player: bid, then points (green made / red failed)
  const plan = [];
  for (let c = 1; c <= 8; c++) plan.push([0, c]);
  for (let i = 0; i < 4; i++) plan.push([1, 9]);
  for (let c = 8; c >= 1; c--) plan.push([2, c]);
  for (let i = 0; i < 4; i++) plan.push([3, 9]);
  let rows = '';
  const pulkaTotals = [0, 0, 0, 0];
  const running = [0, 0, 0, 0];
  const flushPulka = p => {
    const bn = g.bonuses[p] || [0, 0, 0, 0];
    const ct = (g.cuts && g.cuts[p]) || [0, 0, 0, 0];
    // running total: this pulka plus all the previous ones
    pulkaTotals.forEach((v, i) => { running[i] += v + bn[i] - ct[i]; });
    rows += `<tr class="pl"><td class="l"></td>${running.map((v, i) => `<td colspan="2" class="pt">${v}${bn[i] ? ` <small>+${bn[i]}</small>` : ''}${ct[i] ? ` <small class="cut">−${ct[i]}</small>` : ''}</td>`).join('')}</tr>`;
    pulkaTotals.fill(0);
  };
  plan.forEach(([pulka, cards], idx) => {
    const h = g.history[idx];
    if (h) {
      h.points.forEach((p, i) => { pulkaTotals[i] += p; });
      rows += `<tr><td class="l">${h.cards}</td>${h.points.map((p, i) => `<td class="b">${h.bids[i] || '–'}</td><td class="p ${p > 0 ? 'ok' : 'bad'}">${p}</td>`).join('')}</tr>`;
    } else {
      const cur = idx === g.history.length && g.phase !== 'finished' ? g.bids : null; // bids of the deal in progress
      rows += `<tr><td class="l">${cards}</td>${[0, 1, 2, 3].map(i => `<td class="b">${cur && cur[i] !== null && cur[i] !== undefined ? (cur[i] || '–') : ''}</td><td class="p"></td>`).join('')}</tr>`;
    }
    if (idx + 1 === plan.length || plan[idx + 1][0] !== pulka) {
      if (g.history.length > idx) flushPulka(pulka);
      else { rows += `<tr class="pl"><td class="l"></td><td colspan="8" class="pt"></td></tr>`; pulkaTotals.fill(0); }
    }
  });
  const tot = g.totals.map(v => `<td colspan="2" class="${v > 0 ? 'ok' : v < 0 ? 'bad' : ''}">${v}</td>`).join('');
  return `<table class="score"><thead><tr><th class="l"></th>${head}</tr></thead><tbody>${rows}</tbody><tfoot><tr class="tot"><td class="l"></td>${tot}</tr></tfoot></table>`;
}

function scoreHtml(g) {
  return `<div class="overlay mid scoreov"><div class="sheet wide scoresheet"><button class="xbtn" data-act="score-close" aria-label="დახურვა">✕</button><h3>ცხრილი</h3>${scoreTable(g)}</div></div>`;
}

function dealEndHtml(g) {
  const d = g.dealSummary;
  return `<div class="overlay mid"><div class="sheet">
    <h3>დარიგება დასრულდა</h3>
    ${d.points.map((p, i) => `<div class="rank"><span class="nm">${esc(g.names[i])}</span><span class="muted">${d.bids[i]}/${d.taken[i]}</span><b class="${p < 0 ? 'neg' : 'pos'}">${p > 0 ? '+' : ''}${p}</b></div>${d.bonus && d.bonus[i] ? `<div class="muted" style="text-align:right">🎉 პულკის პრემია: +${d.bonus[i]}</div>` : ''}${d.cut && d.cut[i] ? `<div class="muted" style="text-align:right">პულკაში წაიშალა: −${d.cut[i]}</div>` : ''}`).join('')}
    <div class="muted" style="text-align:center">შემდეგი დარიგება მალე იწყება…</div>
    <button class="btn sec" data-act="score">ცხრილი</button>
  </div></div>`;
}

function finishedHtml(g) {
  const order = g.totals.map((t, i) => ({ t, i })).sort((a, b) => b.t - a.t);
  return `<div class="overlay mid"><div class="sheet">
    <h3>თამაში დასრულდა</h3>
    ${order.map((o, k) => `<div class="rank ${k === 0 ? 'first' : ''}"><span class="n">${['🥇', '🥈', '🥉', '4'][k]}</span><span class="nm">${esc(g.names[o.i])}</span><b class="${o.t < 0 ? 'neg' : ''}">${o.t}</b></div>`).join('')}
    <button class="btn" data-act="rematch">ახალი თამაში</button>
    <button class="btn sec" data-act="home">მთავარი გვერდი</button>
  </div></div>`;
}

// ---------- events ----------
function playCard(id, extra = {}) {
  selected = null;
  jokerPick = null;
  jokerMode = null;
  emit('game:play', { id, ...extra });
}

document.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'authForm') return submitAuth(f);
  if (f.id === 'createForm') {
    api('POST', '/api/tables', { name: f.elements.name.value }).then(t => {
      f.reset();
      loadTables();
      shareLink(t.code, t.name);
    }).catch(err => { document.getElementById('homeErr').textContent = err.message; });
  }
  if (f.id === 'joinForm') {
    const raw = f.elements.link.value.trim();
    const m = raw.match(/([a-z0-9]{4,})\/?$/i);
    if (m) go('/t/' + m[1].toLowerCase());
    else document.getElementById('homeErr').textContent = 'ჩასვი მაგიდის ლინკი';
  }
});

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act], .hand .hc');
  if (!el) return;
  const act = el.dataset.act;

  // card in hand
  if (!act && el.classList.contains('hc')) {
    const g = st?.game;
    if (!g || g.phase !== 'playing' || g.turn !== st.seat) return;
    const id = el.dataset.id;
    if (!g.legal.includes(id)) return toast(g.trick.length ? 'ამ კარტს ვერ ითამაშებ — უნდა მიჰყვე ნიშანს (ან დაკრა კოზირი)' : 'ამ კარტს ვერ ითამაშებ');
    const card = g.hand.find(c => c.id === id);
    // a joker opens its choice sheet right away (მიმყავს / არ მიმყავს); other cards: tap once to lift, twice to play
    if (card.s === 'J') { selected = null; jokerPick = id; jokerMode = null; return renderGame(); }
    if (selected !== id) { selected = id; return renderGame(); }
    return playCard(id);
  }

  switch (act) {
    case 'mode-login': authMode = 'login'; return renderAuth();
    case 'mode-register': authMode = 'register'; return renderAuth();
    case 'logout': return logout();
    case 'home':
      if (tableCode && st?.status === 'lobby' && !st.isAdmin) socket.emit('table:leave');
      leaveTableView();
      history.pushState({}, '', '/');
      return route();
    case 'sounds':
      if (!st?.game || st.seat < 0 || Number(el.dataset.seat) === st.seat) return;
      soundTarget = Number(el.dataset.seat);
      return renderGame();
    case 'sounds-close': soundTarget = null; return renderGame();
    case 'sound': {
      const seat = soundTarget;
      soundTarget = null;
      renderGame();
      return socket.emit('sound:send', { seat, id: el.dataset.id }, r => { if (r?.error) toast(r.error); });
    }
    case 'choose-play': return joinAs('play');
    case 'choose-watch': return joinAs('watch');
    case 'sit': return socket.emit('table:join', tableCode, 'play', r => { if (r?.error) toast(r.error); else joinMode = 'play'; });
    case 'leave':
      socket.emit('table:leave', () => { leaveTableView(); history.pushState({}, '', '/'); route(); });
      return;
    case 'copy': return copyText(tableLink(el.dataset.code));
    case 'share': return shareLink(el.dataset.code, el.dataset.name);
    case 'open': return go('/t/' + el.dataset.code);
    case 'del':
      if (confirm('წავშალო მაგიდა?')) {
        try { await api('DELETE', '/api/tables/' + el.dataset.code); } catch (err) { toast(err.message); }
        loadTables();
      }
      return;
    case 'last': showLast = !showLast; return renderGame();
    case 'score': showScore = true; return renderGame();
    case 'score-close': showScore = false; return renderGame();
    case 'bid': return emit('game:bid', Number(el.dataset.n));
    case 'trump': return emit('game:trump', el.dataset.s);
    case 'jmode': {
      const g = st.game;
      if (g.trick.length === 0) { jokerMode = el.dataset.mode; return renderGame(); } // leading: pick the suit next
      return playCard(jokerPick, { mode: el.dataset.mode });
    }
    case 'joker': return playCard(jokerPick, { mode: jokerMode || el.dataset.mode, suit: el.dataset.s });
    case 'joker-cancel': jokerPick = null; jokerMode = null; return renderGame();
    case 'rematch': return emit('game:rematch');
  }
});

boot();

// iOS Safari ignores user-scalable=no: block pinch and double-tap zoom by hand
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
