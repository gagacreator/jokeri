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
let st = null; // latest table state
let selected = null; // card id raised in hand
let jokerPick = null; // joker card id awaiting mode choice
let showScore = false;
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

function cardHtml(c, extra = '') {
  if (c.s === 'J') {
    return `<div class="pc joker ${extra}" data-id="${c.id}"><span class="s">🃏</span><span class="r">ჯოკერი</span></div>`;
  }
  const rank = RANKS[c.r] || c.r;
  return `<div class="pc ${isRed(c.s) ? 'red' : ''} ${extra}" data-id="${c.id}"><span class="r">${rank}</span><span class="s">${SYM[c.s]}</span></div>`;
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
  tableCode = null;
  st = null;
  selected = null;
  jokerPick = null;
  showScore = false;
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
        ${reg ? `<div><label>სახელი (როგორც გამოჩნდება მაგიდასთან)</label><input name="name" maxlength="20" autocomplete="nickname" required></div>` : ''}
        <div><label>მომხმარებლის სახელი</label><input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" required></div>
        <div><label>პაროლი</label><input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required></div>
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
  socket.on('connect', () => {
    if (tableCode) socket.emit('table:join', tableCode, handleJoinResult);
  });
  socket.on('table:state', s => {
    if (s.code !== tableCode) return;
    st = s;
    const g = s.game;
    if (selected && !(g && g.legal.includes(selected))) selected = null;
    renderTable();
  });
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
  st = null;
  app.innerHTML = '<div class="screen"><div class="muted" style="text-align:center;margin-top:40vh">იტვირთება…</div></div>';
  ensureSocket();
  if (socket.connected) socket.emit('table:join', code, handleJoinResult);
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
      <div class="slots">
        ${st.players.map(p => p ? `<div class="slot"><span class="dot ${p.online ? '' : 'off'}"></span>${esc(p.name)}</div>` : '<div class="slot empty">თავისუფალია</div>').join('')}
      </div>
      <div class="card-box">
        <div class="muted">გაუგზავნე ლინკი მეგობრებს. როცა 4 მოთამაშე შეიკრიბება, თამაში ავტომატურად დაიწყება.</div>
        <div class="row">
          <button class="btn grow" data-act="share" data-code="${st.code}" data-name="${esc(st.name)}">ლინკის გაგზავნა</button>
          <button class="btn sec" data-act="copy" data-code="${st.code}">კოპირება</button>
        </div>
      </div>
      ${st.isAdmin ? '<button class="btn sec" data-act="home">ადმინ პანელი</button>' : ''}
    </div>`;
}

// ---------- game ----------
function trumpLabel(t) {
  if (t === null) return '<span class="sym">—</span>კოზირი';
  if (t === 'N') return '<span class="sym">∅</span>უკოზირო';
  return `<span class="sym ${isRed(t) ? 'red' : ''}">${SYM[t]}</span>კოზირი`;
}

function seatBox(g, seat, pos) {
  const name = g.names[seat];
  const bid = g.bids[seat];
  const online = st.players[seat]?.online;
  const phaseBid = g.phase === 'bidding';
  return `
    <div class="seat ${pos} ${g.turn === seat ? 'turn' : ''}">
      <div class="nm">${g.dealer === seat ? '<span class="dealer">D</span>' : ''}<span class="dot ${online ? '' : 'off'}"></span>${esc(name)}</div>
      <div class="st">${bid === null ? (phaseBid ? 'ფიქრობს…' : '') : `დაკვ. <b>${bid}</b> · აღ. <b>${g.tricksWon[seat]}</b>`}</div>
      ${pos !== 'me' ? `<div class="minihand">${'🂠'.repeat(Math.min(g.handCounts[seat], 9))}</div>` : ''}
    </div>`;
}

function trickHtml(g, mySeat) {
  return g.trick.map(t => {
    const rel = (t.seat - mySeat + 4) % 4;
    let tag = '';
    if (t.card.s === 'J') {
      tag = t.mode === 'low' ? 'დაბალი' : t.suit ? `მაღალი ${SYM[t.suit]}` : 'მაღალი';
    }
    return `<div class="slotc s${rel} ${g.trickWinner === t.seat ? 'win' : ''}">${cardHtml(t.card)}${tag ? `<span class="jtag">${tag}</span>` : ''}</div>`;
  }).join('');
}

function statusText(g, mySeat) {
  if (g.phase === 'bidding') {
    return g.turn === mySeat ? 'შენი დაკვეთის რიგია' : `${g.names[g.turn]} აკვეთებს…`;
  }
  if (g.phase === 'trump') {
    return g.turn === mySeat ? 'აირჩიე კოზირი' : `${g.names[g.turn]} ირჩევს კოზირს…`;
  }
  if (g.phase === 'playing') {
    return g.turn === mySeat ? 'შენი სვლაა' : `${g.names[g.turn]}-ის სვლაა`;
  }
  if (g.phase === 'trickEnd') return `${g.names[g.trickWinner]} იღებს ხელს`;
  return '';
}

function renderGame() {
  const g = st.game;
  const mySeat = st.seat;
  if (mySeat < 0) {
    app.innerHTML = '<div class="screen"><div class="card-box"><h2>თამაში უკვე დაიწყო</h2><button class="btn" data-act="home">მთავარი გვერდი</button></div></div>';
    return;
  }
  const seatAt = rel => (mySeat + rel) % 4;
  const myTurn = g.turn === mySeat;
  const playingTurn = myTurn && g.phase === 'playing';
  const bidTxt = g.bids[mySeat] === null ? '' : `დაკვეთა <b>${g.bids[mySeat]}</b> · აღებული <b>${g.tricksWon[mySeat]}</b>`;

  app.innerHTML = `
    <div class="game">
      <div class="topbar">
        <button class="iconbtn" data-act="score">ქულები</button>
        <div class="info">პულკა <b>${g.pulka + 1}</b>/4 · დარიგება <b>${g.dealIdx + 1}</b>/${g.totalDeals}<br>${g.cards} კარტი</div>
        <div class="trumpchip">${trumpLabel(g.trump)}</div>
      </div>
      <div class="board">
        ${seatBox(g, seatAt(2), 'top')}
        ${seatBox(g, seatAt(1), 'left')}
        <div class="center">${trickHtml(g, mySeat)}</div>
        ${seatBox(g, seatAt(3), 'right')}
      </div>
      <div class="status ${myTurn ? 'mine' : ''}">${esc(statusText(g, mySeat))}</div>
      <div class="mine-info"><span class="nm">${g.dealer === mySeat ? '<span class="dealer">D</span> ' : ''}${esc(g.names[mySeat])}</span> ${bidTxt ? '· ' + bidTxt : ''}</div>
      <div class="hand" id="hand">
        ${g.hand.map(c => cardHtml(c, [
          !playingTurn || g.legal.includes(c.id) ? 'ok' : 'dim',
          playingTurn ? 'myturn' : '',
          selected === c.id ? 'sel' : '',
        ].join(' '))).join('')}
      </div>
      ${overlayHtml(g, mySeat)}
    </div>`;
  fitHand(g.hand.length);
}

function fitHand(n) {
  const hand = document.getElementById('hand');
  if (!hand || n < 2) return;
  const cardW = 56;
  const avail = hand.clientWidth - 16;
  const overlap = Math.max(0, (n * cardW - avail) / (n - 1));
  hand.querySelectorAll('.pc').forEach((el, i) => { if (i > 0) el.style.marginLeft = -overlap + 'px'; });
}

function overlayHtml(g, mySeat) {
  const myTurn = g.turn === mySeat;
  if (g.phase === 'finished') return finishedHtml(g);
  if (showScore) return scoreHtml(g);
  if (g.phase === 'dealEnd') return dealEndHtml(g);
  if (jokerPick && myTurn && g.phase === 'playing') return jokerHtml(g);
  if (myTurn && g.phase === 'bidding') {
    const nums = [...Array(g.cards + 1).keys()];
    const known = g.bids.map((b, i) => b === null ? '' : `${esc(g.names[i])}: ${b}`).filter(Boolean).join(' · ');
    return `<div class="overlay panel"><div class="sheet">
      <h3>რამდენს აიღებ?</h3>
      ${known ? `<div class="muted" style="text-align:center">${known}</div>` : ''}
      <div class="numgrid">${nums.map(n => `<button class="btn" data-act="bid" data-n="${n}" ${g.forbiddenBid === n ? 'disabled' : ''}>${n}</button>`).join('')}</div>
      ${g.forbiddenBid !== null ? `<div class="muted" style="text-align:center">შენ (დილერს) ${g.forbiddenBid} არ შეგიძლია</div>` : ''}
    </div></div>`;
  }
  if (myTurn && g.phase === 'trump') {
    return `<div class="overlay panel"><div class="sheet">
      <h3>აირჩიე კოზირი</h3>
      <div class="suitgrid">${['S', 'C', 'D', 'H'].map(s => `<button class="btn ${isRed(s) ? 'red' : 'blk'}" data-act="trump" data-s="${s}">${SYM[s]}</button>`).join('')}</div>
      <button class="btn sec" data-act="trump" data-s="N">უკოზირო</button>
    </div></div>`;
  }
  return '';
}

function jokerHtml(g) {
  const leading = g.trick.length === 0;
  if (leading) {
    return `<div class="overlay"><div class="sheet">
      <h3>ჯოკერით ხელის გახსნა</h3>
      <div class="muted" style="text-align:center">მაღალი — იღებ ხელს და ითხოვ ნიშანს:</div>
      <div class="suitgrid">${['S', 'C', 'D', 'H'].map(s => `<button class="btn ${isRed(s) ? 'red' : 'blk'}" data-act="joker" data-mode="high" data-s="${s}">${SYM[s]}</button>`).join('')}</div>
      <button class="btn sec" data-act="joker" data-mode="low">დაბალი (არ ვიღებ)</button>
      <button class="btn danger" data-act="joker-cancel">გაუქმება</button>
    </div></div>`;
  }
  return `<div class="overlay"><div class="sheet">
    <h3>ჯოკერი</h3>
    <button class="btn" data-act="joker" data-mode="high">ავიღებ (მაღალი)</button>
    <button class="btn sec" data-act="joker" data-mode="low">არ ავიღებ (დაბალი)</button>
    <button class="btn danger" data-act="joker-cancel">გაუქმება</button>
  </div></div>`;
}

function scoreTable(g) {
  const head = g.names.map(n => `<th>${esc(n)}</th>`).join('');
  let rows = '';
  let lastPulka = -1;
  const pulkaTotals = [0, 0, 0, 0];
  const flushPulka = p => {
    rows += `<tr class="pl"><td class="l">პულკა ${p + 1}</td>${pulkaTotals.map(v => `<td>${v}</td>`).join('')}</tr>`;
    pulkaTotals.fill(0);
  };
  g.history.forEach(h => {
    if (lastPulka !== -1 && h.pulka !== lastPulka) flushPulka(lastPulka);
    lastPulka = h.pulka;
    h.points.forEach((p, i) => { pulkaTotals[i] += p; });
    rows += `<tr><td class="l">${h.cards}${h.trump && h.trump !== 'N' ? ` <span class="${isRed(h.trump) ? 'neg' : ''}">${SYM[h.trump]}</span>` : ''}</td>${h.points.map((p, i) => `
      <td class="pts ${p < 0 ? 'neg' : 'pos'}">${p}<small>${h.bids[i]}/${h.taken[i]}</small></td>`).join('')}</tr>`;
  });
  if (g.history.length === g.totalDeals) flushPulka(lastPulka);
  return `<table class="score"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}
    <tr class="tot"><td class="l">ჯამი</td>${g.totals.map(v => `<td class="${v < 0 ? 'neg' : ''}">${v}</td>`).join('')}</tr></tbody></table>
    <div class="muted" style="text-align:center">უჯრაში: ქულა, ქვემოთ დაკვეთა/აღებული</div>`;
}

function scoreHtml(g) {
  return `<div class="overlay"><div class="sheet"><h3>ქულები</h3>${g.history.length ? scoreTable(g) : '<div class="muted" style="text-align:center">ქულები ჯერ არ არის</div>'}<button class="btn" data-act="score-close">დახურვა</button></div></div>`;
}

function dealEndHtml(g) {
  const d = g.dealSummary;
  return `<div class="overlay mid"><div class="sheet">
    <h3>დარიგება დასრულდა</h3>
    ${d.points.map((p, i) => `<div class="rank"><span class="nm">${esc(g.names[i])}</span><span class="muted">${d.bids[i]}/${d.taken[i]}</span><b class="${p < 0 ? 'neg' : 'pos'}">${p > 0 ? '+' : ''}${p}</b></div>`).join('')}
    <div class="muted" style="text-align:center">შემდეგი დარიგება მალე იწყება…</div>
    <button class="btn sec" data-act="score">ყველა ქულა</button>
  </div></div>`;
}

function finishedHtml(g) {
  const order = g.totals.map((t, i) => ({ t, i })).sort((a, b) => b.t - a.t);
  return `<div class="overlay mid"><div class="sheet">
    <h3>თამაში დასრულდა</h3>
    ${order.map((o, k) => `<div class="rank ${k === 0 ? 'first' : ''}"><span class="n">${['🥇', '🥈', '🥉', '4'][k]}</span><span class="nm">${esc(g.names[o.i])}</span><b class="${o.t < 0 ? 'neg' : ''}">${o.t}</b></div>`).join('')}
    ${st.isAdmin ? '<button class="btn" data-act="rematch">ახალი თამაში</button>' : ''}
    <button class="btn sec" data-act="home">მთავარი გვერდი</button>
  </div></div>`;
}

// ---------- events ----------
function playCard(id, extra = {}) {
  selected = null;
  jokerPick = null;
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
  const el = e.target.closest('[data-act], .hand .pc');
  if (!el) return;
  const act = el.dataset.act;

  // card in hand
  if (!act && el.classList.contains('pc')) {
    const g = st?.game;
    if (!g || g.phase !== 'playing' || g.turn !== st.seat) return;
    const id = el.dataset.id;
    if (!g.legal.includes(id)) return toast(g.trick.length ? 'ამ კარტს ვერ ითამაშებ — უნდა მიჰყვე ნიშანს / კოზირს' : 'ამ კარტს ვერ ითამაშებ');
    if (selected !== id) { selected = id; return renderGame(); }
    const card = g.hand.find(c => c.id === id);
    if (card.s === 'J') { jokerPick = id; return renderGame(); }
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
    case 'score': showScore = true; return renderGame();
    case 'score-close': showScore = false; return renderGame();
    case 'bid': return emit('game:bid', Number(el.dataset.n));
    case 'trump': return emit('game:trump', el.dataset.s);
    case 'joker': {
      const id = jokerPick;
      return playCard(id, { mode: el.dataset.mode, suit: el.dataset.s });
    }
    case 'joker-cancel': jokerPick = null; return renderGame();
    case 'rematch': return emit('game:rematch');
  }
});

boot();
