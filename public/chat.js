'use strict';

// Table text chat. Lives outside #app so game re-renders never wipe what you are typing.
const Chat = (() => {
  const box = document.getElementById('chat');
  let socket = null;
  let code = null;
  let hasGame = false;
  let msgs = [];
  let open = false;
  let unread = 0;
  let listEl = null;
  let inputEl = null;

  const myId = () => (typeof me !== 'undefined' && me ? me.id : null);
  const timeOf = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function bubble(m) {
    const mine = m.uid === myId();
    const el = document.createElement('div');
    el.className = 'cmsg ' + (mine ? 'mine' : 'other');
    if (!mine) {
      const n = document.createElement('div');
      n.className = 'cname';
      n.textContent = m.name;
      el.appendChild(n);
    }
    const t = document.createElement('div');
    t.className = 'ctext';
    t.textContent = m.text;
    const ts = document.createElement('span');
    ts.className = 'ctime';
    ts.textContent = timeOf(m.ts);
    t.appendChild(ts);
    el.appendChild(t);
    return el;
  }

  function fillList() {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!msgs.length) {
      const e = document.createElement('div');
      e.className = 'cempty';
      e.textContent = 'შეტყობინებები ჯერ არ არის. დაწერე პირველმა 👋';
      listEl.appendChild(e);
    }
    msgs.forEach(m => listEl.appendChild(bubble(m)));
    listEl.scrollTop = listEl.scrollHeight;
  }

  function badge() {
    const b = box.querySelector('.cbadge');
    if (b) {
      b.textContent = unread > 9 ? '9+' : String(unread);
      b.hidden = unread === 0;
    }
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

  function renderButton() {
    box.innerHTML = '<button class="chatbtn" data-c="open" title="ჩათი">💬<span class="cbadge" hidden></span></button>';
    listEl = null;
    inputEl = null;
    badge();
  }

  function renderPanel() {
    box.innerHTML = `
      <div class="chatpanel">
        <div class="chead"><b>ჩათი</b><button class="cclose" data-c="close" aria-label="დახურვა">✕</button></div>
        <div class="clist"></div>
        <form class="cform">
          <input class="cinput" maxlength="300" placeholder="დაწერე შეტყობინება…" autocomplete="off" enterkeyhint="send">
          <button class="csend" type="submit" aria-label="გაგზავნა">➤</button>
        </form>
      </div>`;
    listEl = box.querySelector('.clist');
    inputEl = box.querySelector('.cinput');
    box.querySelector('.cform').addEventListener('submit', e => { e.preventDefault(); send(); });
    fillList();
    inputEl.focus();
  }

  function render() {
    box.className = 'chat ' + (hasGame ? 'ingame' : 'lobby') + (box.classList.contains('two') ? ' two' : '') + (open ? ' open' : '');
    if (open) { if (!listEl) renderPanel(); } else renderButton();
  }

  function loadHistory() {
    socket?.emit('chat:history', r => {
      msgs = r?.messages || [];
      if (open) fillList();
    });
  }

  box.addEventListener('click', e => {
    const act = e.target.closest('[data-c]')?.dataset.c;
    if (act === 'open') { open = true; unread = 0; render(); }
    else if (act === 'close') { open = false; render(); }
  });

  return {
    attach(s) {
      socket = s;
      s.on('chat:msg', m => {
        if (m.id && msgs.some(x => x.id === m.id)) return;
        msgs.push(m);
        if (msgs.length > 100) msgs.shift();
        if (open && listEl) {
          const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
          listEl.querySelector('.cempty')?.remove();
          listEl.appendChild(bubble(m));
          if (atBottom || m.uid === myId()) listEl.scrollTop = listEl.scrollHeight;
        } else if (m.uid !== myId()) {
          unread++;
          badge();
        }
      });
      s.on('connect', () => { if (code) loadHistory(); });
    },
    setState(st) {
      if (!st) return this.leave();
      hasGame = !!st.game;
      if (st.code !== code) {
        code = st.code;
        msgs = [];
        unread = 0;
        open = false;
        loadHistory();
      }
      box.hidden = false;
      // re-render only when the layout class changes, never while typing
      const cls = 'chat ' + (hasGame ? 'ingame' : 'lobby');
      if (!box.className.startsWith(cls) || (!open && !box.querySelector('.chatbtn'))) render();
    },
    leave() {
      code = null;
      msgs = [];
      open = false;
      unread = 0;
      listEl = null;
      inputEl = null;
      box.hidden = true;
      box.innerHTML = '';
    },
  };
})();
