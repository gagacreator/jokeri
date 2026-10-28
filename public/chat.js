'use strict';

// Table text chat as a transparent layer over the game: no window, the table stays visible and playable.
// Closed: new messages float up for a few seconds. Open: a translucent feed and an input row.
// Built once, never re-rendered, so typing is never interrupted by game updates.
const Chat = (() => {
  const box = document.getElementById('chat');
  let socket = null;
  let code = null;
  let msgs = [];
  let open = false;
  let unread = 0;
  let built = false;
  let floatEl, feedEl, inputEl, badgeEl, btnEl;

  const myId = () => (typeof me !== 'undefined' && me ? me.id : null);

  function bubble(m, withTime = true) {
    const mine = m.uid === myId();
    const el = document.createElement('div');
    el.className = 'cmsg ' + (mine ? 'mine' : 'other');
    const t = document.createElement('div');
    t.className = 'ctext';
    if (!mine) {
      const n = document.createElement('b');
      n.className = 'cname';
      n.textContent = m.name + ' ';
      t.appendChild(n);
    }
    t.appendChild(document.createTextNode(m.text));
    if (withTime) {
      const ts = document.createElement('span');
      ts.className = 'ctime';
      ts.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      t.appendChild(ts);
    }
    el.appendChild(t);
    return el;
  }

  function fillFeed() {
    feedEl.innerHTML = '';
    msgs.slice(-40).forEach(m => feedEl.appendChild(bubble(m)));
    feedEl.scrollTop = feedEl.scrollHeight;
  }

  function floatMsg(m) {
    const el = bubble(m, false);
    floatEl.appendChild(el);
    while (floatEl.children.length > 3) floatEl.firstChild.remove();
    setTimeout(() => el.classList.add('out'), 6500);
    setTimeout(() => el.remove(), 7200);
  }

  function updateBadge() {
    badgeEl.textContent = unread > 9 ? '9+' : String(unread);
    badgeEl.hidden = open || unread === 0;
  }

  function setOpen(v) {
    open = v;
    if (open) { unread = 0; floatEl.innerHTML = ''; fillFeed(); }
    box.classList.toggle('open', open);
    btnEl.textContent = open ? '✕' : '💬';
    btnEl.appendChild(badgeEl);
    updateBadge();
    if (open) inputEl.focus();
    else inputEl.blur();
    adjustForKeyboard();
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    socket.emit('chat:send', text, r => {
      if (r?.error && typeof toast === 'function') toast(r.error);
    });
    inputEl.value = '';
    inputEl.focus();
  }

  // keep the input above the on-screen keyboard (iOS does not resize the layout viewport)
  function adjustForKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const off = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    box.style.transform = open && off > 80 ? `translateY(${-off}px)` : '';
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', adjustForKeyboard);
    window.visualViewport.addEventListener('scroll', adjustForKeyboard);
  }

  function build() {
    if (built) return;
    built = true;
    box.classList.add('chat');
    box.innerHTML = `
      <div class="cfloat"></div>
      <div class="cfeed"></div>
      <form class="cform">
        <input class="cinput" maxlength="300" placeholder="დაწერე…" autocomplete="off" enterkeyhint="send">
        <button class="csend" type="submit" aria-label="გაგზავნა">➤</button>
      </form>
      <button class="chatbtn" type="button" aria-label="ჩათი">💬</button>`;
    floatEl = box.querySelector('.cfloat');
    feedEl = box.querySelector('.cfeed');
    inputEl = box.querySelector('.cinput');
    btnEl = box.querySelector('.chatbtn');
    badgeEl = document.createElement('span');
    badgeEl.className = 'cbadge';
    badgeEl.hidden = true;
    btnEl.appendChild(badgeEl);
    btnEl.addEventListener('click', () => setOpen(!open));
    box.querySelector('.cform').addEventListener('submit', e => { e.preventDefault(); send(); });
  }

  function loadHistory() {
    socket?.emit('chat:history', r => {
      msgs = r?.messages || [];
      if (open) fillFeed();
    });
  }

  return {
    attach(s) {
      socket = s;
      s.on('chat:msg', m => {
        if (!built || msgs.some(x => x.id === m.id)) return;
        msgs.push(m);
        if (msgs.length > 100) msgs.shift();
        if (open) {
          const atBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 80;
          feedEl.appendChild(bubble(m));
          if (atBottom || m.uid === myId()) feedEl.scrollTop = feedEl.scrollHeight;
        } else if (m.uid !== myId()) {
          unread++;
          updateBadge();
          floatMsg(m);
        }
      });
      s.on('connect', () => { if (code) loadHistory(); });
    },
    setState(st) {
      if (!st) return this.leave();
      build();
      if (st.code !== code) {
        code = st.code;
        msgs = [];
        unread = 0;
        if (open) setOpen(false);
        floatEl.innerHTML = '';
        updateBadge();
        loadHistory();
      }
      box.hidden = false;
      box.classList.toggle('ingame', !!st.game);
      box.classList.toggle('lobby', !st.game);
    },
    leave() {
      code = null;
      msgs = [];
      unread = 0;
      if (built) { if (open) setOpen(false); floatEl.innerHTML = ''; }
      box.hidden = true;
    },
  };
})();
