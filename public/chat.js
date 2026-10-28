'use strict';

// Table text chat as a transparent layer over the game.
// The latest messages are always visible (translucent, top-right under the trump card).
// The 💬 button unfolds the feed and shows the input row. Built once, never re-rendered,
// so game updates never interrupt typing.
const Chat = (() => {
  const box = document.getElementById('chat'); // holds only the toggle button
  let socket = null;
  let code = null;
  let msgs = [];
  let open = false;
  let built = false;
  let panel, feedEl, inputEl, btnEl;

  const SHOW_CLOSED = 5; // messages visible while folded

  const myId = () => (typeof me !== 'undefined' && me ? me.id : null);

  function bubble(m, withTime) {
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
    const list = open ? msgs.slice(-60) : msgs.slice(-SHOW_CLOSED);
    list.forEach(m => feedEl.appendChild(bubble(m, open)));
    feedEl.scrollTop = feedEl.scrollHeight;
  }

  function setOpen(v) {
    open = v;
    panel.classList.toggle('open', open);
    btnEl.textContent = open ? '✕' : '💬';
    fillFeed();
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

  function build() {
    if (built) return;
    built = true;
    box.classList.add('chat');
    box.innerHTML = '<button class="chatbtn" type="button" aria-label="ჩათი">💬</button>';
    btnEl = box.querySelector('.chatbtn');
    btnEl.addEventListener('click', () => setOpen(!open));

    panel = document.createElement('div');
    panel.id = 'chatfeed';
    panel.innerHTML = `
      <div class="cfeed"></div>
      <form class="cform">
        <input class="cinput" maxlength="300" placeholder="დაწერე…" autocomplete="off" enterkeyhint="send">
        <button class="csend" type="submit" aria-label="გაგზავნა">➤</button>
      </form>`;
    document.body.appendChild(panel);
    feedEl = panel.querySelector('.cfeed');
    inputEl = panel.querySelector('.cinput');
    panel.querySelector('.cform').addEventListener('submit', e => { e.preventDefault(); send(); });
  }

  // the input now sits near the bottom: lift it above the on-screen keyboard (iOS keeps the layout viewport)
  function adjustForKeyboard() {
    const vv = window.visualViewport;
    if (!vv || !panel) return;
    const off = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    panel.style.transform = open && off > 80 ? `translateY(${-off}px)` : '';
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', adjustForKeyboard);
    window.visualViewport.addEventListener('scroll', adjustForKeyboard);
  }

  function loadHistory() {
    socket?.emit('chat:history', r => {
      msgs = r?.messages || [];
      fillFeed();
    });
  }

  function layout(inGame) {
    box.classList.toggle('ingame', inGame);
    box.classList.toggle('lobby', !inGame);
    panel.classList.toggle('ingame', inGame);
    panel.classList.toggle('lobby', !inGame);
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
          feedEl.appendChild(bubble(m, true));
          if (atBottom || m.uid === myId()) feedEl.scrollTop = feedEl.scrollHeight;
        } else {
          fillFeed(); // keep the latest few visible
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
        if (open) setOpen(false);
        fillFeed();
        loadHistory();
      }
      box.hidden = false;
      panel.hidden = false;
      layout(!!st.game);
    },
    leave() {
      code = null;
      msgs = [];
      if (built) { if (open) setOpen(false); fillFeed(); panel.hidden = true; }
      box.hidden = true;
    },
  };
})();
