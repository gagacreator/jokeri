'use strict';

// Table voice chat: WebRTC audio mesh (max 4 players), signaling relayed through the game socket.
const Voice = (() => {
  const box = document.getElementById('voice');
  let socket = null;
  let tableState = null;
  let local = null;
  let on = false;
  let muted = false;
  let iceConfig = null;
  let queue = Promise.resolve();
  let audioCtx = null;
  const peers = new Map(); // uid -> { pc, audio, pending, analyser }
  const speaking = new Set();
  let localAnalyser = null;

  const say = msg => { try { toast(msg); } catch { /* toast is optional */ } };

  function send(to, data) {
    socket.emit('voice:signal', { to, data });
  }

  function watch(stream) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      return analyser;
    } catch { return null; }
  }

  function level(analyser) {
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let max = 0;
    for (const v of buf) max = Math.max(max, Math.abs(v - 128));
    return max;
  }

  function applySpeaking() {
    document.querySelectorAll('[data-uid]').forEach(el => {
      el.classList.toggle('speaking', speaking.has(el.dataset.uid));
    });
    box.querySelector('.vmic')?.classList.toggle('speaking', speaking.has('me'));
  }

  // remote speakers are detected from WebRTC receiver stats (reliable even if WebAudio can't tap the stream)
  async function remoteLevel(pc) {
    try {
      let lvl = 0;
      (await pc.getStats()).forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && typeof r.audioLevel === 'number') lvl = Math.max(lvl, r.audioLevel);
      });
      return lvl;
    } catch { return 0; }
  }

  let polling = false;
  setInterval(async () => {
    if (polling) return;
    if (!on) { if (speaking.size) { speaking.clear(); applySpeaking(); } return; }
    polling = true;
    const next = new Set();
    await Promise.all([...peers].map(async ([uid, p]) => { if ((await remoteLevel(p.pc)) > 0.02) next.add(uid); }));
    if (!muted && level(localAnalyser) > 14) next.add('me');
    polling = false;
    if (!on) return;
    if ([...next].sort().join() !== [...speaking].sort().join()) {
      speaking.clear();
      next.forEach(u => speaking.add(u));
      applySpeaking();
    }
  }, 250);

  function closePeer(uid) {
    const p = peers.get(uid);
    if (!p) return;
    peers.delete(uid);
    try { p.pc.close(); } catch { /* already closed */ }
    if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
    render();
  }

  async function makePeer(uid, initiator) {
    const pc = new RTCPeerConnection(iceConfig);
    const entry = { pc, audio: null, pending: [] };
    peers.set(uid, entry);
    local.getTracks().forEach(t => pc.addTrack(t, local));
    pc.onicecandidate = e => { if (e.candidate) send(uid, { candidate: e.candidate }); };
    pc.ontrack = e => {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.srcObject = e.streams[0];
      audio.style.display = 'none';
      document.body.appendChild(audio);
      audio.play().catch(() => {});
      entry.audio = audio;
      render();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { say('ხმოვანი კავშირი ვერ შედგა'); closePeer(uid); }
      else render();
    };
    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send(uid, { sdp: pc.localDescription });
    }
    return entry;
  }

  async function onSignal({ from, data }) {
    if (!on || !local) return;
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        closePeer(from);
        const p = await makePeer(from, false);
        await p.pc.setRemoteDescription(data.sdp);
        for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        send(from, { sdp: p.pc.localDescription });
      } else {
        const p = peers.get(from);
        if (!p) return;
        await p.pc.setRemoteDescription(data.sdp);
        for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      }
    } else if (data.candidate) {
      const p = peers.get(from);
      if (!p) return;
      if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate).catch(() => {});
      else p.pending.push(data.candidate);
    }
  }

  async function join() {
    if (on) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      return say(window.isSecureContext ? 'ეს ბრაუზერი ხმას არ უჭერს მხარს' : 'ხმისთვის საჭიროა დაცული (https) კავშირი');
    }
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      return say('მიკროფონზე წვდომა არ მიგიცია');
    }
    try { iceConfig = await api('GET', '/api/ice'); } catch { iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; }
    on = true;
    muted = false;
    localAnalyser = watch(local);
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    socket.emit('voice:join', async r => {
      if (r?.error) { say(r.error); return stop(); }
      for (const uid of r.peers) await makePeer(uid, true).catch(() => closePeer(uid));
      render();
    });
    render();
  }

  function stop(notify = true) {
    if (notify && on) socket?.emit('voice:leave');
    on = false;
    for (const uid of [...peers.keys()]) closePeer(uid);
    local?.getTracks().forEach(t => t.stop());
    local = null;
    localAnalyser = null;
    speaking.clear();
    render();
  }

  function toggleMute() {
    if (!local) return;
    muted = !muted;
    local.getAudioTracks().forEach(t => { t.enabled = !muted; });
    render();
  }

  function render() {
    if (!tableState) { box.hidden = true; return; }
    box.hidden = false;
    box.className = 'voice ' + (tableState.game ? 'ingame' : 'lobby');
    const connected = [...peers.values()].filter(p => p.pc.connectionState === 'connected').length;
    box.innerHTML = on
      ? `<button class="vmic on ${muted ? 'muted' : ''}" data-v="mute" title="მიკროფონი">${muted ? '🔇' : '🎙️'}</button>
         <span class="vcount">${connected} 🎧</span>
         <button class="vleave" data-v="leave" title="ხმიდან გასვლა">✕</button>`
      : '<button class="vmic" data-v="join" title="ხმოვანი საუბრის ჩართვა">🎤 ხმა</button>';
    applySpeaking();
  }

  box.addEventListener('click', e => {
    const act = e.target.closest('[data-v]')?.dataset.v;
    if (act === 'join') join();
    else if (act === 'leave') stop();
    else if (act === 'mute') toggleMute();
  });

  return {
    attach(s) {
      socket = s;
      s.on('voice:signal', msg => { queue = queue.then(() => onSignal(msg)).catch(() => {}); });
      s.on('voice:left', ({ uid }) => closePeer(uid));
      s.on('disconnect', () => { for (const uid of [...peers.keys()]) closePeer(uid); });
      s.on('connect', () => {
        // after a reconnect the server forgot us: rejoin the voice room if we were in it
        if (on) { on = false; local?.getTracks().forEach(t => t.stop()); local = null; render(); say('ხმა გაითიშა, ჩართე თავიდან'); }
      });
    },
    setState(st) { tableState = st; render(); },
    leaveTable() { stop(); tableState = null; render(); },
    applySpeaking,
  };
})();
