/* GoldRush games: the shared engine. The game frame, the bet controls, the live feeds, the timed-round
   follower and the lobby. Every result comes from the server (/api/games); the game files only animate
   what the server decided. Dollars on screen, cents on the wire. */
(() => {
  'use strict';

  const GR = window.GR;
  const { $, $$, esc } = GR;

  /* ---------- helpers ---------- */
  const h = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtMult = (x) => (x >= 1000 ? Math.round(x).toLocaleString('en-US') : Number(x).toFixed(2)) + '×';
  const cents = (dollars) => Math.round(dollars * 100);
  const coin = (cls = '') => `<svg class="gcoin ${cls}" viewBox="0 0 64 64" aria-hidden="true"><use href="#gr-coin"/></svg>`;
  const money = (c) => `${c < 0 ? '−' : ''}$${fmt(Math.abs(c) / 100)}`;
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  /** Cosmetic randomness only (animations). Game results come from the server. */
  function rand() {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] / 4294967296;
  }
  const randInt = (n) => Math.floor(rand() * n);

  /* Animation frames that keep running when the browser stops delivering them (background tabs). */
  let frameSeq = 0;
  const frames = new Map();
  function frame(fn) {
    const id = ++frameSeq;
    const run = (t) => {
      const f = frames.get(id);
      if (!f) return;
      frames.delete(id);
      cancelAnimationFrame(f.raf);
      clearTimeout(f.timer);
      fn(typeof t === 'number' ? t : performance.now());
    };
    frames.set(id, { raf: requestAnimationFrame(run), timer: setTimeout(run, 110) });
    return id;
  }
  function unframe(id) {
    const f = frames.get(id);
    if (!f) return;
    frames.delete(id);
    cancelAnimationFrame(f.raf);
    clearTimeout(f.timer);
  }

  const prefs = Object.assign({ sound: true, hotkeys: true }, store.get('gg.prefs', {}));
  const savePrefs = () => store.set('gg.prefs', prefs);

  /* ---------- icons ---------- */
  const ICONS = {
    heart: '<path d="M12 20s-7.500-4.600-7.500-10.200C4.500 6.500 6.400 4.500 8.800 4.500c1.400 0 2.500.8 3.200 1.900.7-1.100 1.800-1.900 3.200-1.900 2.400 0 4.300 2 4.300 5.300C19.500 15.400 12 20 12 20z"/>',
    star: '<path d="M12 3.500l2.600 5.400 5.900.8-4.300 4.100 1 5.800-5.200-2.700-5.200 2.700 1-5.800-4.300-4.100 5.900-.8z"/>',
    info: '<circle cx="12" cy="12" r="8.500"/><path d="M12 11v5M12 8h.01"/>',
    chart: '<path d="M5 19v-8M12 19V5M19 19v-6"/>',
    expand: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
    sound: '<path d="M4 9.500h3.500L12 5.500v13l-4.500-4H4z"/><path d="M15.500 8.500a5 5 0 0 1 0 7M18 6a8.500 8.500 0 0 1 0 12"/>',
    mute: '<path d="M4 9.500h3.500L12 5.500v13l-4.500-4H4z"/><path d="M16 9.500l5 5M21 9.500l-5 5"/>',
    reset: '<path d="M5 12a7 7 0 1 0 2.200-5.100"/><path d="M5 4.500v3.500h3.500"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    left: '<path d="M14.500 5.500L8 12l6.500 6.500"/>',
    right: '<path d="M9.500 5.500L16 12l-6.500 6.500"/>',
    bolt: '<path d="M13 3L5 13.500h6L10 21l8-10.500h-6z"/>',
    live: '<circle cx="12" cy="12" r="4"/><path d="M6.300 6.300a8 8 0 0 0 0 11.400M17.700 6.300a8 8 0 0 1 0 11.400"/>',
  };
  const ic = (name, size) => `<svg viewBox="0 0 24 24" width="${size || 18}" height="${size || 18}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  /* ---------- sound effects (synthesised live, no audio files) ---------- */
  let actx = null, sfxBus, tensBus;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function bootAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    comp.connect(actx.destination);
    sfxBus = actx.createGain(); sfxBus.gain.value = 0.7; sfxBus.connect(comp);
    tensBus = actx.createGain(); tensBus.gain.value = 0.5; tensBus.connect(comp);
  }
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (prefs.sound && $('.bbg')) bootAudio(); }, { passive: true }));

  function tone(bus, o) {
    const t = o.t, dur = o.dur, peak = o.g == null ? 0.2 : o.g;
    const a = Math.min(o.a || 0.004, dur * 0.4);
    const osc = actx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t + dur);
    let node = osc;
    if (o.lp) {
      const fl = actx.createBiquadFilter();
      fl.type = 'lowpass'; fl.Q.value = 0.8;
      fl.frequency.setValueAtTime(o.lp, t);
      osc.connect(fl); node = fl;
    }
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g); g.connect(bus);
    osc.start(t); osc.stop(t + dur + 0.05);
  }
  function noise(bus, o) {
    const len = actx.sampleRate * 0.6;
    const buf = actx.createBuffer(1, len, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = actx.createBufferSource();
    src.buffer = buf;
    const fl = actx.createBiquadFilter();
    fl.type = o.ft || 'highpass'; fl.Q.value = o.q || 0.7;
    fl.frequency.setValueAtTime(o.fc || 6000, o.t);
    if (o.fcTo) fl.frequency.exponentialRampToValueAtTime(o.fcTo, o.t + o.dur);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, o.t);
    g.gain.linearRampToValueAtTime(o.g || 0.1, o.t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur);
    src.connect(fl); fl.connect(g); g.connect(bus);
    src.start(o.t); src.stop(o.t + o.dur + 0.05);
  }
  const SFX = {
    click(t) { tone(sfxBus, { type: 'square', f: 1100, t, dur: 0.03, g: 0.045, lp: 3000 }); },
    bet(t) { noise(sfxBus, { t, dur: 0.05, g: 0.11, ft: 'bandpass', fc: 3200, q: 2 }); tone(sfxBus, { type: 'triangle', f: 520, slide: 760, t, dur: 0.09, g: 0.09 }); },
    chip(t) { noise(sfxBus, { t, dur: 0.06, g: 0.12, ft: 'bandpass', fc: 2400, q: 2.5 }); tone(sfxBus, { type: 'triangle', f: 900, slide: 620, t, dur: 0.05, g: 0.06 }); },
    win(t) { [72, 76, 79, 84].forEach((n, i) => tone(sfxBus, { type: 'triangle', f: mtof(n), t: t + i * 0.07, dur: 0.28, g: 0.14 })); },
    bigwin(t) {
      [60, 64, 67, 72, 76, 79, 84, 88].forEach((n, i) => {
        tone(sfxBus, { type: 'triangle', f: mtof(n), t: t + i * 0.075, dur: 0.5, g: 0.15 });
        tone(sfxBus, { f: mtof(n + 12), t: t + i * 0.075, dur: 0.4, g: 0.05 });
      });
      noise(sfxBus, { t: t + 0.55, dur: 0.9, g: 0.05, fc: 6000 });
    },
    lose(t) { tone(sfxBus, { f: 190, slide: 70, t, dur: 0.3, g: 0.2 }); },
    push(t) { tone(sfxBus, { type: 'triangle', f: 440, t, dur: 0.16, g: 0.1 }); },
    card(t) { noise(sfxBus, { t, dur: 0.09, g: 0.1, ft: 'bandpass', fc: 2600, fcTo: 900, q: 0.9 }); },
    tick(t, a) { const v = a == null ? 1 : a; noise(sfxBus, { t, dur: 0.02, g: 0.07 * v, fc: 5000 }); tone(sfxBus, { type: 'triangle', f: 1500, t, dur: 0.02, g: 0.03 * v }); },
    gem(t, n) { const f = 660 * Math.pow(2, Math.min(n || 0, 18) / 12); tone(sfxBus, { f, t, dur: 0.45, g: 0.16 }); tone(sfxBus, { f: f * 1.5, t, dur: 0.3, g: 0.06 }); },
    bomb(t) { noise(sfxBus, { t, dur: 0.5, g: 0.34, ft: 'lowpass', fc: 1800, fcTo: 120 }); tone(sfxBus, { f: 120, slide: 35, t, dur: 0.45, g: 0.4 }); },
    coin(t) { for (let i = 0; i < 7; i++) tone(sfxBus, { f: 2100 + (i % 2) * 500, t: t + i * 0.1, dur: 0.08, g: 0.03 }); },
    coinLand(t) { tone(sfxBus, { f: 1500, t, dur: 0.5, g: 0.1 }); tone(sfxBus, { f: 2250, t, dur: 0.35, g: 0.05 }); },
    cashout(t) { [79, 84, 91].forEach((n, i) => tone(sfxBus, { f: mtof(n), t: t + i * 0.06, dur: 0.25, g: 0.13 })); },
    launch(t) { noise(sfxBus, { t, dur: 0.5, g: 0.08, ft: 'bandpass', fc: 400, fcTo: 2400, q: 1.2 }); },
    kenoHit(t, n) { const f = 520 * Math.pow(2, ((n || 1) * 2) / 12); tone(sfxBus, { type: 'triangle', f, t, dur: 0.4, g: 0.17 }); tone(sfxBus, { f: f * 2, t, dur: 0.3, g: 0.06 }); },
    kenoMiss(t) { tone(sfxBus, { type: 'triangle', f: 170, t, dur: 0.07, g: 0.09 }); },
    scan(t, a) { tone(sfxBus, { type: 'square', f: 700 + (a || 0) * 500, t, dur: 0.04, g: 0.035, lp: 2500 }); },
    lock(t) { tone(sfxBus, { f: 90, slide: 45, t, dur: 0.35, g: 0.34 }); noise(sfxBus, { t, dur: 0.12, g: 0.06, fc: 3000 }); },
    impact(t) { tone(sfxBus, { f: 110, slide: 38, t, dur: 0.6, g: 0.45 }); noise(sfxBus, { t, dur: 0.35, g: 0.12, ft: 'lowpass', fc: 2400, fcTo: 200 }); },
    aww(t) { tone(sfxBus, { type: 'sawtooth', f: 300, slide: 140, t, dur: 0.45, g: 0.06, lp: 900 }); },
    spin(t) { for (let i = 0; i < 6; i++) tone(sfxBus, { type: 'triangle', f: 1200 - i * 90, t: t + i * 0.05, dur: 0.04, g: 0.03 }); },
  };
  function sfx(name, arg) {
    if (!prefs.sound || !actx || actx.state !== 'running') return;
    const f = SFX[name];
    if (f) { try { f(actx.currentTime + 0.005, arg); } catch { /* never let audio break a game */ } }
  }

  /* tension layer (keno): a heartbeat that quickens, 0 = off, 1..6 = rising */
  let tLevel = 0, tBeat = 0;
  function beat() {
    if (!tLevel || !actx) return;
    if (prefs.sound && actx.state === 'running') {
      const t = actx.currentTime + 0.01;
      tone(tensBus, { f: 82, slide: 40, t, dur: 0.2, g: 0.5 });
      tone(tensBus, { f: 70, slide: 36, t: t + 0.17, dur: 0.2, g: 0.32 });
    }
    tBeat = setTimeout(beat, Math.max(400, 1050 - tLevel * 115));
  }
  function tension(level) {
    level = clamp(level | 0, 0, 6);
    if (level === tLevel) return;
    const was = tLevel;
    tLevel = level;
    if (!was && level) beat();
    if (!level) clearTimeout(tBeat);
  }

  /* ---------- balance for step games. Round games update the top bar from the server's answer. ---------- */
  const bal = { inflight: 0, hidden: 0 };
  const me = () => GR.state.user;
  const balance = () => (me() ? (me().balance - bal.hidden - bal.inflight) / 100 : 0);
  function showBal() { if (me()) GR.showBalance(me().balance - bal.hidden - bal.inflight); }

  let cfg = null;
  const loadCfg = async () => { if (!cfg) cfg = await GR.api('/games/config'); return cfg; };
  const minBet = () => (cfg ? cfg.min / 100 : 0.1);
  const maxBet = () => (cfg ? cfg.max / 100 : 100);

  /** Pull the balance from the server (after a round settles, or when a result came from elsewhere). */
  async function syncMe() {
    try { GR.setUser((await GR.api('/me')).user); } catch { /* offline: the next answer will fix it */ }
  }

  let placed = false;
  /** Check a wager and take it off the shown balance. Returns false (and says why) if it can't be placed. */
  function placeBet(amount) {
    if (!me()) { GR.openAuth('register'); return false; }
    amount = round2(amount);
    if (!(amount > 0)) { GR.toast('Enter a bet amount first.', 'error'); return false; }
    if (amount < minBet()) { GR.toast(`The minimum bet is $${fmt(minBet())}.`, 'error'); return false; }
    if (amount > maxBet()) { GR.toast(`The maximum bet is $${fmt(maxBet())}.`, 'error'); return false; }
    if (amount > balance() + 1e-9) { GR.toast('Not enough balance for that bet.', 'error'); nudge($('.balance')); return false; }
    bal.inflight += cents(amount);
    showBal();
    sfx('bet');
    placed = true;
    return true;
  }

  function took(res) {
    GR.state.user = res.user;
    if (res.bet && res.bet.status === 'settled' && res.bet.payout > 0) bal.hidden += res.bet.payout;
  }

  /** Place a bet on the server (instant and step games). Resolves to the server's answer, or null. */
  async function bet(game, amount, params) {
    if (!placeBet(amount)) return null;
    const c = cents(amount);
    try {
      const res = await GR.api(`/games/${game}/bet`, { body: { amount: c, params } });
      bal.inflight -= c;
      took(res);
      showBal();
      return res;
    } catch (err) {
      bal.inflight -= c;
      showBal();
      GR.toast(err.message, 'error');
      if (err.status === 401) GR.openAuth('login');
      return null;
    }
  }

  /** A move in a step game (hit, reveal, cash out...). Resolves to the server's answer or null. */
  async function act(betId, action, params = {}, extraStake = 0) {
    if (extraStake) {
      if (balance() + 1e-9 < extraStake) { GR.toast('Not enough balance for that.', 'error'); return null; }
      bal.inflight += cents(extraStake);
      showBal();
      sfx('bet');
    }
    try {
      const res = await GR.api(`/games/bets/${betId}/action`, { body: { action, params } });
      bal.inflight -= cents(extraStake);
      took(res);
      showBal();
      return res;
    } catch (err) {
      bal.inflight -= cents(extraStake);
      showBal();
      GR.toast(err.message, 'error');
      return null;
    }
  }

  /** An unfinished step-game round of this game, if the player left one (rounds survive reloads). */
  async function active(game) {
    if (!me()) return null;
    try { const { bets } = await GR.api('/games/active'); return bets.find((b) => b.game === game) || null; } catch { return null; }
  }

  /* ---------- timed rounds (Double, Crash) ---------- */

  /**
   * Follows a timed round. Polls the server, keeps this device's clock in step with the server's, and
   * calls onView with every answer. The server decides every bet; this only tells the page what happened.
   */
  function follow(game, onView, every = 900) {
    let stopped = false, timer = 0, offset = 0, lastSeq = null;
    const apply = (v) => {
      if (!v || !v.round) return;
      if (lastSeq !== null && v.round.seq !== lastSeq) syncMe(); // a round ended: the balance may have moved
      lastSeq = v.round.seq;
      onView(v);
    };
    const tick = async () => {
      if (stopped) return;
      const t0 = Date.now();
      try {
        const v = await GR.api(`/games/rounds/${game}`);
        offset = v.now - (t0 + Date.now()) / 2;
        apply(v);
      } catch { /* try again in a moment */ }
      if (!stopped) timer = setTimeout(tick, every);
    };
    tick();
    return {
      now: () => Date.now() + offset,
      /** Show an answer from a bet or cash out straight away. */
      push: apply,
      stop() { stopped = true; clearTimeout(timer); },
    };
  }

  /** Put a bet into the current betting window. Dollars in, the server's round view and balance out. */
  async function roundBet(game, dollars, params) {
    if (!me()) { GR.openAuth('register'); return null; }
    if (dollars < minBet() - 1e-9) { GR.toast(`The minimum bet is $${fmt(minBet())}.`, 'error'); return null; }
    if (dollars > maxBet() + 1e-9) { GR.toast(`The maximum bet is $${fmt(maxBet())}.`, 'error'); return null; }
    if (dollars > balance() + 1e-9) { GR.toast('Not enough balance for that bet.', 'error'); nudge($('.balance')); return null; }
    try {
      const res = await GR.api(`/games/rounds/${game}/bet`, { body: { amount: cents(dollars), params } });
      GR.setUser(res.user);
      sfx('chip');
      return res;
    } catch (err) {
      GR.toast(err.message, 'error');
      return null;
    }
  }

  async function roundCashout() {
    try {
      const res = await GR.api('/games/rounds/crash/cashout', { body: {} });
      GR.setUser(res.user);
      sfx('cashout');
      return res;
    } catch (err) {
      GR.toast(err.message, 'error');
      return null;
    }
  }

  /* ---------- controls ---------- */
  let lastAmount = null;
  /** The bet amount box (dollars) with ½, 2× and Max, and validation. Remembers the last amount. */
  function amountField(opts = {}) {
    const start = opts.value || store.get('gg.bet', 1) || 1;
    const el = h(`
      <div class="gfield">
        <span class="gfield-l">${opts.label || 'Bet amount'}</span>
        <div class="gamount">
          ${coin()}
          <input type="text" inputmode="decimal" value="${Number(start).toFixed(2)}" aria-label="Bet amount" maxlength="12">
          <button type="button" data-k="half">½</button>
          <button type="button" data-k="dbl">2×</button>
          <button type="button" data-k="max">Max</button>
        </div>
        <small class="gfield-hint"></small>
      </div>`);
    const input = $('input', el), hint = $('.gfield-hint', el);
    const listeners = [];
    let locked = false;
    const get = () => {
      const v = parseFloat(String(input.value).replace(/,/g, ''));
      return isFinite(v) && v > 0 ? round2(v) : 0;
    };
    const check = () => {
      let msg = '';
      if (!locked) {
        if (get() <= 0) msg = 'Enter an amount above zero.';
        else if (get() < minBet()) msg = `The minimum bet is $${fmt(minBet())}.`;
        else if (get() > maxBet()) msg = `The maximum bet is $${fmt(maxBet())}.`;
        else if (me() && get() > balance() + 1e-9) msg = 'More than your balance.';
      }
      el.classList.toggle('bad', !!msg);
      hint.textContent = msg;
    };
    const fire = () => { check(); listeners.forEach((f) => f(get())); };
    const set = (v) => {
      input.value = round2(Math.max(0, v)).toFixed(2);
      if (get() > 0) store.set('gg.bet', get());
      fire();
    };
    el.addEventListener('click', (e) => {
      const k = e.target.dataset && e.target.dataset.k;
      if (!k || locked) return;
      sfx('click');
      const cap = Math.min(maxBet(), me() ? balance() : Infinity);
      if (k === 'half') set(Math.max(minBet(), get() / 2));
      if (k === 'dbl') set(Math.min(get() * 2 || 1, Math.max(cap, minBet())));
      if (k === 'max') { if (!me()) { GR.openAuth('register'); return; } set(Math.max(0, Math.floor(cap * 100) / 100)); }
    });
    input.addEventListener('input', () => {
      const clean = input.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
      if (clean !== input.value) input.value = clean;
      fire();
    });
    input.addEventListener('blur', () => { input.value = get().toFixed(2); if (get() > 0) store.set('gg.bet', get()); check(); });
    document.addEventListener('gg:balance', check);
    onLeave(() => document.removeEventListener('gg:balance', check));
    return (lastAmount = {
      el, get, set,
      lock(on) {
        locked = !!on;
        el.classList.toggle('locked', locked);
        input.disabled = locked;
        $$('button', el).forEach((b) => { b.disabled = locked; });
        check();
      },
      isLocked: () => locked,
      onChange(f) { listeners.push(f); },
    });
  }

  /** Segmented selector markup, e.g. a risk picker. opts = [[value, label], ...] */
  const segHTML = (id, opts, cur) => `<div class="gseg${opts.length >= 4 ? ' four' : ''}" id="${id}">${opts.map((o) => `<button type="button" data-v="${o[0]}" class="${String(o[0]) === String(cur) ? 'on' : ''}">${o[1]}</button>`).join('')}</div>`;
  function bindSeg(el, cb) {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      $$('button', el).forEach((x) => x.classList.toggle('on', x === b));
      sfx('click');
      cb(b.dataset.v);
    });
  }
  const setSeg = (el, value) => $$('button', el).forEach((x) => x.classList.toggle('on', x.dataset.v === String(value)));

  /* Playing cards. The server sends { r, s, red, i }; suits use the text presentation so phones don't draw emoji. */
  const suit = (s) => String(s || '').replace(/️|︎/g, '') + (s ? '︎' : '');
  const cards = {
    el(c, down) {
      return h(`<div class="pcard${c.red ? ' red' : ''}${down ? ' down' : ''}"><div class="pcard-in">
        <div class="pcard-f"><span class="pc-r">${esc(c.r || '')}</span><span class="pc-s">${suit(c.s)}</span><span class="pc-big">${suit(c.s)}</span></div>
        <div class="pcard-b"></div></div></div>`);
    },
    text: (c) => c.r + suit(c.s),
    suit,
  };

  /* Chips, in dollars. A stack on the table shows the amount as a few discs of the largest denominations. */
  const CHIPS = [[0.1, '#56688f'], [0.5, '#22a268'], [1, '#2d7be0'], [5, '#8f55e0'], [25, '#e0832a'], [100, '#dc3350'], [500, '#1f2937']];
  const chipLabel = (n) => (n < 1 ? `${Math.round(n * 100)}¢` : n >= 1000 ? `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : `$${Number.isInteger(n) ? n : n.toFixed(2)}`);
  /** HTML for a stack of chips worth `dollars` (at most five discs, so a big stack stays on the table). */
  function chipStack(dollars) {
    let left = round2(dollars);
    const discs = [];
    for (let i = CHIPS.length - 1; i >= 0 && discs.length < 5; i--) {
      const [v, c] = CHIPS[i];
      while (left + 1e-9 >= v && discs.length < 5) { discs.push(c); left = round2(left - v); }
    }
    if (!discs.length) discs.push(CHIPS[0][1]);
    return `<span class="chipstack" aria-label="${chipLabel(dollars)}">${discs.map((c, i) => `<i class="disc" style="--cc:${c};--i:${i}"></i>`).join('')}<b>${chipLabel(dollars)}</b></span>`;
  }
  const chipButtons = (selected) => CHIPS.map(([v, c]) => `<button type="button" class="chipbtn${v === selected ? ' on' : ''}" data-v="${v}" style="--cc:${c}" aria-label="Chip ${chipLabel(v)}"><b>${chipLabel(v)}</b></button>`).join('');

  /* Bet feeds: one table layout for the lobby, the game page and the round tables. */
  const who = (name, color) => `${GR.avatar(name, color)}<span class="who-n">${esc(name)}</span>`;
  /**
   * rows: { game?, name?, who, color?, side?, amount (cents), payout (cents), mult, mine, status }
   * cols: any of 'game', 'player', 'side', 'bet', 'mult', 'payout'
   */
  function feedTable(rows, cols = ['game', 'player', 'bet', 'mult', 'payout'], empty = 'No bets yet.') {
    if (!rows.length) return `<div class="feed-empty">${esc(empty)}</div>`;
    const head = { game: 'Game', player: 'Player', side: 'Side', bet: 'Bet', mult: 'Multiplier', payout: 'Payout' };
    const cell = (c, r) => {
      if (c === 'game') return `<span class="fc-game">${r.icon ? `<i class="fi">${r.icon}</i>` : ''}<b>${esc(r.name || '')}</b>${r.open ? '<em class="open-tag">open</em>' : ''}</span>`;
      if (c === 'player') return `<span class="fc-player">${who(r.who, r.color)}</span>`;
      if (c === 'side') return `<span class="fc-side ${r.side || ''}">${esc(r.sideLabel || r.side || '')}</span>`;
      if (c === 'bet') return `<span class="fc-bet">${coin('sm')}${fmt(r.amount / 100)}</span>`;
      if (c === 'mult') return `<span class="fc-mult ${r.mult > 1 ? 'hi' : r.mult > 0 ? '' : 'zero'}">${r.status === 'active' ? '<em class="live-dot"></em>live' : fmtMult(r.mult || 0)}</span>`;
      if (c === 'payout') {
        if (r.status === 'active') return `<span class="fc-pay">—</span>`;
        const net = (r.payout || 0) - (r.amount || 0);
        return `<span class="fc-pay ${net > 0 ? 'win' : net < 0 ? 'lose' : ''}">${net > 0 ? '+' : net < 0 ? '−' : ''}${coin('sm')}${fmt(Math.abs(net) / 100)}</span>`;
      }
      return '';
    };
    return `<div class="feed${cols.includes('side') ? ' feed-side' : ''}" role="table">
      <div class="feed-row feed-head" role="row">${cols.map((c) => `<span role="columnheader">${head[c]}</span>`).join('')}</div>
      ${rows.map((r) => `<div class="feed-row${r.mine ? ' mine' : ''}" role="row">${cols.map((c) => `<span role="cell">${cell(c, r)}</span>`).join('')}</div>`).join('')}
    </div>`;
  }

  /* ---------- games, pages and the router ---------- */
  const games = {};
  const order = [];
  let current = null;
  let leaveHooks = [];
  const CATS = [['table', 'Table games'], ['instant', 'Instant win'], ['cashout', 'Climb & cash out']];
  const DEFAULT_CAT = { blackjack: 'table', baccarat: 'table', roulette: 'table', hilo: 'table', videopoker: 'table', dragontiger: 'table', crash: 'cashout', mines: 'cashout', towers: 'cashout', pump: 'cashout' };
  function registerGame(g) { g.cat = g.cat || DEFAULT_CAT[g.id] || 'instant'; games[g.id] = g; order.push(g.id); }
  function onLeave(fn) { leaveHooks.push(fn); }

  function leave() {
    autoStop();
    if (current && current.unmount) { try { current.unmount(); } catch (e) { console.error(e); } }
    current = null;
    leaveHooks.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    leaveHooks = [];
    tension(0);
    $('#live-stats') && $('#live-stats').remove();
    document.body.classList.remove('g-theatre');
    if (bal.hidden || bal.inflight) { bal.hidden = 0; showBal(); }
  }
  const busy = () => bal.hidden > 0 || bal.inflight > 0 || !!auto;

  const favs = () => store.get('gg.favs', []);
  const isFav = (id) => favs().includes(id);
  function toggleFav(id) {
    const f = favs();
    const i = f.indexOf(id);
    if (i >= 0) f.splice(i, 1); else f.unshift(id);
    store.set('gg.favs', f);
    sfx('click');
    return i < 0;
  }
  function paintFav() {
    const b = $('#gf-fav');
    if (!b || !current) return;
    const on = isFav(current.id);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
    b.title = on ? 'Remove from favourites' : 'Add to favourites';
  }

  /** Feed for one game (step games; round games draw their own table). One page at a time. */
  function paintGameFeed(id) {
    const el = $('#gp-live');
    if (!el) return;
    const cols = ['player', 'bet', 'mult', 'payout'];
    GR.pagedList(el, `/games/live?game=${id}`, 'bets', (bets) => feedTable(bets.map((b) => ({ name: b.name, who: b.username, color: b.avatar_color, amount: b.amount, payout: b.payout, mult: b.multiplier, status: 'settled' })), cols),
      feedTable([], cols, 'Nobody has played this game yet.'));
  }
  /** My bets on this game, newest first, one page at a time. Open bets carry the open tag. */
  function paintMyBets(id) {
    const box = $('#mybets');
    if (!box) return;
    if (!me()) { box.innerHTML = '<div class="feed-empty">Log in to play. Your bets will show up here.</div>'; return; }
    const name = games[id].name;
    const cols = ['player', 'bet', 'mult', 'payout'];
    GR.pagedList(box, `/games/bets?game=${id}`, 'bets', (list) => feedTable(list.map((b) => ({ name, who: me().username, color: me().avatar_color, amount: b.amount, payout: b.payout, mult: b.multiplier, mine: true, status: b.status })), cols),
      feedTable([], cols, 'Your bets will show up here.'));
  }
  const myBetsSoon = (id) => setTimeout(() => paintMyBets(id), 600);

  async function play(id) {
    leave();
    const g = games[id];
    if (!g) { GR.go('games'); return; }
    GR.page(GR.skels(1, 520));
    try { await loadCfg(); } catch (err) { GR.setContent(GR.emptyHTML(err.message, 'fa-triangle-exclamation')); return; }
    if (location.hash.replace(/^#\/?/, '').split('/')[1] !== id) return; // moved on while loading
    if (!cfg.enabled && !(me() && me().role === 'admin')) {
      GR.setContent(GR.emptyHTML('Games are switched off right now. Check back soon.', 'fa-power-off'));
      return;
    }
    const info = cfg.games.find((x) => x.id === id);
    const rtp = Number(info ? info.rtp : g.rtp).toFixed(1);
    const timed = !!(info && info.timed);
    GR.setContent(`<div class="bbg" id="bbg">
      <header class="gp-head">
        <a href="#/games" class="gp-back" aria-label="All games">${ic('back', 18)}</a>
        <span class="gp-badge" style="--c1:${g.colors[0]};--c2:${g.colors[1]}"><i>${g.icon}</i></span>
        <div class="gp-title"><h1>${esc(g.name)}</h1><small>Originals${timed ? ' · <b class="live-pill">live rounds</b>' : ''}</small></div>
        <span class="spacer"></span>
        <span class="gp-rtp">RTP <b>${rtp}%</b></span>
      </header>
      <div class="game" data-game="${id}">
        <div class="game-panel" id="g-panel"></div>
        <div class="game-stage" id="g-stage"></div>
        <div class="game-foot">
          <div class="gf-l">
            <button class="gf-btn" id="gf-fav" aria-label="Favourite">${ic('heart', 18)}</button>
            <button class="gf-btn" id="gf-rules" title="How to play" aria-label="How to play">${ic('info', 18)}</button>
            <button class="gf-btn" id="gf-stats" title="Live stats" aria-label="Live stats">${ic('chart', 18)}</button>
            <button class="gf-btn" id="gf-theatre" title="Theatre mode" aria-label="Theatre mode">${ic('expand', 18)}</button>
            <button class="gf-btn${prefs.sound ? '' : ' muted'}" id="gf-sound" title="Sound" aria-label="Sound on or off">${ic(prefs.sound ? 'sound' : 'mute', 18)}</button>
          </div>
          <div class="gf-c">GOLD<b>RUSH</b></div>
        </div>
      </div>
      ${timed ? '' : `<section class="gp-sec"><div class="gp-sec-head"><h3>${ic('live', 16)} Live bets</h3></div><div id="gp-live" class="feed-wrap"><div class="feed-empty">Loading…</div></div></section>`}
      <section class="gp-sec"><div class="gp-sec-head"><h3>My bets</h3></div><div id="mybets" class="feed-wrap"></div></section>
    </div>`);
    current = g;
    $('#gf-fav').addEventListener('click', () => { toggleFav(id); paintFav(); });
    $('#gf-rules').addEventListener('click', openRules);
    $('#gf-stats').addEventListener('click', toggleLive);
    $('#gf-theatre').addEventListener('click', (e) => {
      const on = $('#bbg').classList.toggle('theatre');
      document.body.classList.toggle('g-theatre', on);
      e.currentTarget.classList.toggle('on', on);
    });
    $('#gf-sound').addEventListener('click', (e) => {
      prefs.sound = !prefs.sound;
      savePrefs();
      if (prefs.sound) { bootAudio(); sfx('click'); }
      e.currentTarget.classList.toggle('muted', !prefs.sound);
      e.currentTarget.innerHTML = ic(prefs.sound ? 'sound' : 'mute', 18);
    });
    paintFav();
    store.set('gg.recent', [id].concat(store.get('gg.recent', []).filter((x) => x !== id)).slice(0, 8));
    try { g.mount($('#g-panel'), $('#g-stage')); } catch (e) { console.error(e); }
    if (!NO_AUTO[id] && !timed) addAuto($('#g-panel'));
    if (!timed) paintGameFeed(id);
    paintMyBets(id);
  }

  /* ---------- live stats card: profit / wagered / wins / losses since it was last reset ---------- */
  const live = { profit: 0, wagered: 0, wins: 0, losses: 0, pts: [0] };
  function paintLive() {
    const box = $('#live-stats');
    if (!box) return;
    const set = (k, v, cls) => { const el = $(`[data-k="${k}"]`, box); el.textContent = v; if (cls != null) el.className = cls; };
    set('profit', (live.profit > 0 ? '+' : live.profit < 0 ? '−' : '') + '$' + fmt(Math.abs(live.profit)), live.profit > 0 ? 'pos' : live.profit < 0 ? 'minus' : '');
    set('wagered', '$' + fmt(live.wagered));
    set('wins', live.wins);
    set('losses', live.losses);
    const cv = $('canvas', box), dpr = Math.min(2, window.devicePixelRatio || 1), W = 228, H = 64;
    cv.width = W * dpr; cv.height = H * dpr;
    const c = cv.getContext('2d');
    c.scale(dpr, dpr);
    const pts = live.pts, lo = Math.min.apply(null, pts.concat(0)), hi = Math.max.apply(null, pts.concat(0)), span = hi - lo || 1;
    const X = (i) => (pts.length > 1 ? (i / (pts.length - 1)) * W : W / 2), Y = (v) => H - 4 - ((v - lo) / span) * (H - 8);
    c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1; c.setLineDash([3, 4]);
    c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(W, Y(0)); c.stroke(); c.setLineDash([]);
    if (pts.length > 1) {
      c.beginPath();
      pts.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))));
      c.strokeStyle = live.profit >= 0 ? '#14f195' : '#ff5c7a'; c.lineWidth = 2; c.lineJoin = 'round'; c.stroke();
    }
  }
  /** Count a finished bet in the live stats card. Cents in. */
  function track(wagerCents, payoutCents) {
    const net = (payoutCents - wagerCents) / 100;
    live.wagered = round2(live.wagered + wagerCents / 100);
    live.profit = round2(live.profit + net);
    if (net > 0) live.wins++; else if (net < 0) live.losses++;
    live.pts.push(live.profit);
    if (live.pts.length > 120) live.pts.shift();
    paintLive();
  }
  function toggleLive() {
    const old = $('#live-stats');
    if (old) { old.remove(); $('#gf-stats') && $('#gf-stats').classList.remove('on'); return; }
    const box = h(`<div class="livecard bb-live" id="live-stats" role="dialog" aria-label="Live stats">
      <div class="live-h">${ic('chart', 16)}<b>Live stats</b><button type="button" id="live-reset" title="Reset" aria-label="Reset stats">${ic('reset', 15)}</button><button type="button" id="live-x" aria-label="Close">&times;</button></div>
      <div class="live-grid">
        <div><small>Profit</small><b data-k="profit">$0.00</b></div><div><small>Wagered</small><b data-k="wagered">$0.00</b></div>
        <div><small>Wins</small><b data-k="wins" class="pos">0</b></div><div><small>Losses</small><b data-k="losses" class="minus">0</b></div>
      </div><canvas></canvas></div>`);
    document.body.appendChild(box);
    $('#gf-stats') && $('#gf-stats').classList.add('on');
    $('#live-x', box).addEventListener('click', () => { box.remove(); $('#gf-stats') && $('#gf-stats').classList.remove('on'); });
    $('#live-reset', box).addEventListener('click', () => { Object.assign(live, { profit: 0, wagered: 0, wins: 0, losses: 0, pts: [0] }); paintLive(); });
    paintLive();
  }

  /* ---------- rules (the how-to-play text, from the original site) ---------- */
  function openRules() {
    const g = current;
    if (!g) return;
    const r = (window.GG.rules && window.GG.rules[g.id]) || { how: ['Place a bet and play the round.'] };
    const info = cfg && cfg.games.find((x) => x.id === g.id);
    const rtp = Number(info ? info.rtp : g.rtp);
    GR.openModal(`<div class="bbg-modal">
      <h2 class="modal-title"><span class="rules-ic" style="--c1:${g.colors[0]};--c2:${g.colors[1]}"><i>${g.icon}</i></span>${esc(g.name)}</h2>
      <ol class="rules-list">${r.how.map((x) => `<li>${x}</li>`).join('')}</ol>
      <div class="rules-facts">
        <div><small>Return to player</small><b>${rtp.toFixed(1)}%</b></div>
        <div><small>House edge</small><b>${(100 - rtp).toFixed(1)}%</b></div>
        <div><small>Top payout</small><b>${r.max || '—'}</b></div>
      </div>
      ${r.risk ? `<p class="rules-risk"><b>Risk:</b> ${r.risk}</p>` : ''}
    </div>`);
  }

  /* ---------- autobet (games that settle in one press) ---------- */
  const NO_AUTO = { blackjack: 1, roulette: 1, hilo: 1, crash: 1, mines: 1, towers: 1, pump: 1, videopoker: 1, double: 1, baccarat: 1, dragontiger: 1 };
  let auto = null;
  function autoPaint() {
    const el = $('#auto-stat');
    if (el && auto) el.innerHTML = `${auto.done} bet${auto.done === 1 ? '' : 's'} · <b class="${auto.profit > 0 ? 'pos' : auto.profit < 0 ? 'minus' : ''}">${auto.profit > 0 ? '+' : auto.profit < 0 ? '−' : ''}$${fmt(Math.abs(auto.profit))}</b>${auto.infinite ? '' : ' · ' + auto.left + ' left'}`;
  }
  function autoStop(why) {
    if (!auto) return;
    clearTimeout(auto.timer);
    const base = auto.base;
    auto = null;
    if (lastAmount && base && $('#g-panel .gamount')) lastAmount.set(base);
    const box = $('#g-auto');
    if (box) {
      $('#auto-go').textContent = 'Start autobet';
      $('#auto-go').className = 'gbtn green lg block';
      $$('input', box).forEach((i) => { i.disabled = false; });
    }
    if (why) GR.toast(why, 'info');
  }
  function autoNext(tries) {
    if (!auto) return;
    const btn = $('#g-panel .gbtn.lg');
    if (!btn || !current || current.id !== auto.id) { autoStop(); return; }
    if (btn.disabled) {
      if ((tries || 0) > 400) { autoStop('Autobet stopped: the game is not ready.'); return; }
      auto.timer = setTimeout(() => autoNext((tries || 0) + 1), 100);
      return;
    }
    placed = false;
    btn.click();
    if (!placed) autoStop('Autobet stopped.');
  }
  function autoStart() {
    if (!me()) { GR.openAuth('register'); return; }
    const num = (id) => { const v = parseFloat($('#' + id).value); return isFinite(v) && v > 0 ? v : 0; };
    const n = Math.floor(num('auto-n'));
    auto = { left: n, infinite: !n, onWin: num('auto-win'), onLoss: num('auto-loss'), stopP: num('auto-sp'), stopL: num('auto-sl'), base: lastAmount ? lastAmount.get() : 0, done: 0, profit: 0, id: current.id, timer: 0 };
    $('#auto-go').textContent = 'Stop autobet';
    $('#auto-go').className = 'gbtn danger lg block';
    $$('#g-auto input').forEach((i) => { i.disabled = true; });
    autoPaint();
    autoNext();
  }
  function autoSettled(b) {
    if (!auto || b.id !== auto.id) return;
    const net = round2(b.payout - b.wager);
    auto.done++;
    auto.profit = round2(auto.profit + net);
    if (!auto.infinite) auto.left--;
    autoPaint();
    if (!auto.infinite && auto.left <= 0) { autoStop('Autobet finished.'); return; }
    if (auto.stopP && auto.profit >= auto.stopP) { autoStop('Autobet stopped: profit target reached.'); return; }
    if (auto.stopL && auto.profit <= -auto.stopL) { autoStop('Autobet stopped: loss limit reached.'); return; }
    const a = auto;
    a.timer = setTimeout(() => {
      if (auto !== a) return;
      if (lastAmount && net !== 0) {
        const pct = net > 0 ? a.onWin : a.onLoss;
        lastAmount.set(pct ? lastAmount.get() * (1 + pct / 100) : a.base);
      }
      autoNext();
    }, 280);
  }
  function addAuto(panel) {
    panel.insertBefore(h('<div class="gseg mode-seg" id="g-mode"><button type="button" data-v="manual" class="on">Manual</button><button type="button" data-v="auto">Auto</button></div>'), panel.firstChild);
    panel.appendChild(h(`<div class="auto-box" id="g-auto" hidden>
      <div class="row2">
        <label class="gfield"><span class="gfield-l">Number of bets</span><input type="text" inputmode="numeric" id="auto-n" value="10" maxlength="5" aria-label="Number of bets"></label>
        <label class="gfield"><span class="gfield-l">Stop at profit ($)</span><input type="text" inputmode="decimal" id="auto-sp" placeholder="Off" maxlength="10" aria-label="Stop at profit"></label>
      </div>
      <div class="row2">
        <label class="gfield"><span class="gfield-l">On win, raise by %</span><input type="text" inputmode="decimal" id="auto-win" value="0" maxlength="6" aria-label="On win raise by percent"></label>
        <label class="gfield"><span class="gfield-l">On loss, raise by %</span><input type="text" inputmode="decimal" id="auto-loss" value="0" maxlength="6" aria-label="On loss raise by percent"></label>
      </div>
      <label class="gfield"><span class="gfield-l">Stop at loss ($)</span><input type="text" inputmode="decimal" id="auto-sl" placeholder="Off" maxlength="10" aria-label="Stop at loss"></label>
      <button type="button" class="gbtn green lg block" id="auto-go">Start autobet</button>
      <p class="auto-stat" id="auto-stat">Set the bets to 0 to keep going until you stop it.</p>
    </div>`));
    bindSeg($('#g-mode'), (v) => { autoStop(); $('#g-auto').hidden = v !== 'auto'; panel.classList.toggle('auto-on', v === 'auto'); });
    $('#auto-go').addEventListener('click', () => (auto ? autoStop('Autobet stopped.') : autoStart()));
    $$('#g-auto input').forEach((i) => i.addEventListener('input', () => { const c = i.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'); if (c !== i.value) i.value = c; }));
  }

  /* ---------- settling one step-game bet: balance, live stats, effects ---------- */
  function settle(res, opts = {}) {
    const b = res.bet;
    if (!b || b.status !== 'settled' || b._shown) return;
    b._shown = true;
    if (b.payout > 0) bal.hidden = Math.max(0, bal.hidden - b.payout);
    const from = opts.from || $('#g-stage');
    if (b.payout > 0 && !opts.quiet && from && from.isConnected && !GR.reduced && GR.flyCoins) {
      GR.flyCoins(from, Math.min(14, 4 + Math.round(b.multiplier * 2))).then(showBal);
    } else showBal();
    track(b.amount, b.payout);
    const st = $('#g-stage');
    const net = b.payout - b.amount;
    if (st && net !== 0) { st.classList.remove('fx-win', 'fx-lose'); void st.offsetWidth; st.classList.add(net > 0 ? 'fx-win' : 'fx-lose'); }
    if (st && b.payout > 0 && b.multiplier >= 10) coins(st, b.multiplier >= 50 ? 44 : 26);
    autoSettled({ id: b.game, wager: b.amount / 100, payout: b.payout / 100 });
    myBetsSoon(b.game);
  }

  /** Gold $ coins raining through a box: used for big wins. */
  function coins(box, count) {
    if (!box || GR.reduced) return;
    const layer = h('<div class="coin-rain"></div>');
    for (let i = 0; i < (count || 24); i++) {
      const c = h(coin());
      const size = 14 + rand() * 16;
      c.style.cssText = `position:absolute;top:-40px;left:${rand() * 100}%;--cs:${size}px;animation:g-coinFall ${1.1 + rand() * 0.9}s cubic-bezier(.4,0,.9,.6) ${rand() * 0.5}s forwards;--sway:${rand() * 80 - 40}px`;
      layer.appendChild(c);
    }
    box.appendChild(layer);
    setTimeout(() => layer.remove(), 2700);
  }

  /** Gold confetti burst inside a positioned container. */
  function confetti(box, count) {
    if (!box || GR.reduced) return;
    const layer = h('<div class="confetti"></div>');
    const cols = ['#eac837', '#d4b42e', '#fff6c4', '#14f195', '#ffffff'];
    for (let i = 0; i < (count || 60); i++) {
      const p = document.createElement('i');
      const ang = rand() * Math.PI * 2, dist = 120 + rand() * 260;
      p.style.cssText = `--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist - 80}px;--r:${rand() * 720 - 360}deg;background:${cols[randInt(cols.length)]};animation-delay:${rand() * 120}ms;width:${6 + rand() * 6}px;height:${8 + rand() * 8}px`;
      layer.appendChild(p);
    }
    box.appendChild(layer);
    setTimeout(() => layer.remove(), 2200);
  }

  /** Brief attention pulse, e.g. on the Bet button when a tile is clicked with no round running. */
  function nudge(el) {
    if (!el) return;
    el.classList.remove('nudge');
    void el.offsetWidth;
    el.classList.add('nudge');
    setTimeout(() => el.classList.remove('nudge'), 500);
  }

  /* ---------- keyboard shortcuts on game pages ---------- */
  document.addEventListener('keydown', (e) => {
    if (!current || !$('#g-panel') || e.metaKey || e.ctrlKey || e.altKey || e.repeat || !prefs.hotkeys) return;
    if ($('#modal-root') && $('#modal-root').children.length) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return;
    const k = (e.key || '').toLowerCase();
    if (k === ' ') {
      const b = $('#g-panel').classList.contains('auto-on') ? $('#auto-go') : $('#g-panel .gbtn.lg:not(:disabled):not([hidden])');
      e.preventDefault();
      if (b) b.click();
    } else if (k === 'a' || k === 's') {
      const b = $(`#g-panel .gamount [data-k="${k === 'a' ? 'half' : 'dbl'}"]:not(:disabled)`);
      if (b) b.click();
    }
  });
  document.addEventListener('click', (e) => { if (e.detail > 0) { const b = e.target.closest('.bbg .game button'); if (b && document.activeElement === b) b.blur(); } });
  let lastBal = null;
  setInterval(() => { const v = me() ? me().balance : null; if (v !== lastBal) { lastBal = v; emit('gg:balance'); } }, 500);

  /* =====================================================================
     Lobby: rows of tall game cards, live rounds, latest bets
     ===================================================================== */
  const TIMED_IDS = ['double', 'crash'];
  let feedTimer = 0, roundTimer = 0;

  const cardHTML = (id, badge) => {
    const g = games[id];
    const info = cfg.games.find((x) => x.id === id);
    const fav = isFav(id);
    return `<a href="#/games/${id}" class="gc" style="--c1:${g.colors[0]};--c2:${g.colors[1]}" data-id="${id}">
      <span class="gc-top"><span class="gc-coin">${coin()}</span>${badge ? `<span class="gc-tag ${badge.cls}">${badge.text}</span>` : ''}</span>
      <span class="gc-fav${fav ? ' on' : ''}" data-fav="${id}" role="button" tabindex="0" aria-label="${fav ? 'Remove from favourites' : 'Add to favourites'}" aria-pressed="${fav}">${ic('heart', 16)}</span>
      <span class="gc-art">${g.art || g.icon}</span>
      <span class="gc-name">${esc(g.name)}</span>
      <span class="gc-sub"${TIMED_IDS.includes(id) ? ` data-phase="${id}"` : ''}>${TIMED_IDS.includes(id) ? 'Live rounds' : `RTP ${Number(info ? info.rtp : g.rtp).toFixed(1)}%`}</span>
    </a>`;
  };

  /* v._at is when we got the answer: the server's clock moves on from there */
  const serverNow = (v) => v.now + (Date.now() - v._at);
  const phaseText = (id, v) => {
    if (!v || !v.round) return 'Live rounds';
    const r = v.round;
    if (r.phase === 'betting') return `Bets open · ${Math.max(0, Math.ceil((r.betEnd - serverNow(v)) / 1000))}s`;
    if (id === 'crash' && r.phase === 'playing') return `Flying · ${fmtMult(r.mult || 1)}`;
    if (r.phase === 'playing') return 'Spinning…';
    return 'Next round soon';
  };

  function rowsHTML(list) {
    return list.map(([key, title, ids, opts]) => `<section class="gl-row" data-row="${key}">
      <header class="gl-row-head">
        <h2>${title}</h2>
        <div class="gl-row-tools">
          <button type="button" class="gl-more" data-more="${key}">View more</button>
          <button type="button" class="gl-arrow" data-dir="-1" aria-label="Scroll left">${ic('left', 16)}</button>
          <button type="button" class="gl-arrow" data-dir="1" aria-label="Scroll right">${ic('right', 16)}</button>
        </div>
      </header>
      <div class="gl-track">${ids.map((id) => cardHTML(id, opts && opts.badge ? opts.badge(id) : null)).join('')}</div>
    </section>`).join('');
  }

  async function lobby() {
    leave();
    GR.page(GR.skels(6, 240));
    try { await loadCfg(); } catch (err) { GR.setContent(GR.emptyHTML(err.message, 'fa-triangle-exclamation')); return; }
    const off = !cfg.enabled;
    const liveBadge = { cls: 'live', text: 'Live' };
    const rows = [
      ['originals', 'Originals', order, { badge: (id) => (games[id].badge ? { cls: games[id].badge === 'NEW' ? 'new' : 'hot', text: games[id].badge } : null) }],
      ['rounds', 'Live rounds', TIMED_IDS, { badge: () => liveBadge }],
      ['table', 'Table games', order.filter((id) => games[id].cat === 'table')],
      ['instant', 'Instant win', order.filter((id) => games[id].cat === 'instant')],
      ['cashout', 'Climb & cash out', order.filter((id) => games[id].cat === 'cashout')],
    ];
    if (favs().length) rows.splice(1, 0, ['favs', 'Your favourites', favs().filter((id) => games[id]), {}]);
    GR.setContent(`<div class="gl">
      <section class="gl-hero">
        <div class="gl-hero-copy">
          <span class="gl-kicker">${ic('bolt', 14)} GoldRush originals</span>
          <h1>Nineteen games. One balance.</h1>
          <p>Bet on the house games, watch the table fill up live and cash out before the rocket goes. 18+ only.</p>
        </div>
        <div class="gl-hero-live" id="gl-hero-live"></div>
      </section>
      <div class="gl-tools">
        <div class="gl-chips" id="gl-cats">
          <button class="chip on" data-c="all">All games</button>
          ${CATS.map(([k, l]) => `<button class="chip" data-c="${k}">${l}</button>`).join('')}
          <button class="chip" data-c="fav">${ic('heart', 14)} Favourites</button>
        </div>
        <label class="gl-search">${ic('search', 16)}<input type="search" id="gl-q" placeholder="Search games" autocomplete="off" aria-label="Search games"></label>
      </div>
      ${off ? '<div class="gl-off">Games are switched off right now.</div>' : ''}
      <div id="gl-rows">${rowsHTML(rows)}</div>
      <div class="gl-grid" id="gl-grid" hidden></div>
      <section class="gl-sec">
        <div class="gl-row-head"><h2>${ic('live', 18)} Latest bets</h2><span class="gl-note">Live across every game</span></div>
        <div id="gl-live" class="feed-wrap"><div class="feed-empty">Loading…</div></div>
      </section>
    </div>`);

    const grid = () => $('#gl-grid');
    const filterGrid = (key) => {
      const q = ($('#gl-q').value || '').trim().toLowerCase();
      const f = favs();
      return order.filter((id) => {
        const g = games[id];
        if (key === 'fav' && !f.includes(id)) return false;
        if (key !== 'all' && key !== 'fav' && g.cat !== key) return false;
        return !q || g.name.toLowerCase().includes(q);
      });
    };
    /* the chips filter the grid; with no chip and no search the rows show */
    const apply = () => {
      const q = ($('#gl-q').value || '').trim();
      const chip = $('#gl-cats .chip.on').dataset.c;
      const filtered = chip !== 'all' || q;
      $('#gl-rows').hidden = !!filtered;
      grid().hidden = !filtered;
      if (filtered) {
        const ids = filterGrid(chip);
        grid().innerHTML = ids.length ? ids.map((id) => cardHTML(id, null)).join('') : `<div class="gl-empty">${GR.emptyHTML(chip === 'fav' ? 'No favourites yet. Tap the heart on any game.' : 'No games match that.', 'fa-dice')}</div>`;
      }
    };
    $('#gl-cats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      $$('#gl-cats .chip').forEach((x) => x.classList.toggle('on', x === b));
      apply();
    });
    $('#gl-q').addEventListener('input', apply);

    $('.gl').addEventListener('click', (e) => {
      const fav = e.target.closest('[data-fav]');
      if (fav) {
        e.preventDefault();
        const on = toggleFav(fav.dataset.fav);
        fav.classList.toggle('on', on);
        fav.setAttribute('aria-pressed', on);
        return;
      }
      const arrow = e.target.closest('.gl-arrow');
      if (arrow) {
        const track = arrow.closest('.gl-row').querySelector('.gl-track');
        track.scrollBy({ left: Number(arrow.dataset.dir) * track.clientWidth * 0.8, behavior: 'smooth' });
        return;
      }
      const more = e.target.closest('[data-more]');
      if (more) {
        const row = more.closest('.gl-row');
        row.classList.toggle('open');
        more.textContent = row.classList.contains('open') ? 'Show less' : 'View more';
      }
    });
    onLeave(() => { clearInterval(feedTimer); clearInterval(roundTimer); });
    paintLobbyLive();
    feedTimer = setInterval(paintLobbyLive, 6000);
    paintRoundTiles();
    roundTimer = setInterval(paintRoundTiles, 1000);
  }

  async function paintLobbyLive() {
    const el = $('#gl-live');
    if (!el) return;
    try {
      const { bets } = await GR.api('/games/live');
      if (!$('#gl-live')) return;
      el.innerHTML = feedTable(bets.map((b) => ({ name: games[b.game] ? games[b.game].name : b.name, icon: games[b.game] ? games[b.game].icon : '', who: b.username, color: b.avatar_color, amount: b.amount, payout: b.payout, mult: b.multiplier, status: 'settled' })),
        ['game', 'player', 'bet', 'mult', 'payout'], 'No bets yet. Be the first.');
    } catch { /* try again soon */ }
  }

  /** The two timed games: their phase in the hero and on their cards, refreshed every second. */
  const roundViews = {};
  async function paintRoundTiles() {
    const hero = $('#gl-hero-live');
    if (!hero) return;
    for (const id of TIMED_IDS) {
      try { roundViews[id] = { ...(await GR.api(`/games/rounds/${id}`)), _at: Date.now() }; } catch { /* keep the last */ }
      const v = roundViews[id];
      const sub = $(`[data-phase="${id}"]`);
      if (sub && v) sub.textContent = phaseText(id, v);
    }
    hero.innerHTML = TIMED_IDS.map((id) => {
      const g = games[id], v = roundViews[id];
      const bets = v ? v.bets.length : 0;
      return `<a href="#/games/${id}" class="gl-live-card" style="--c1:${g.colors[0]};--c2:${g.colors[1]}">
        <span class="gl-live-tag">${ic('live', 12)} Live</span>
        <span class="gl-live-name">${esc(g.name)}</span>
        <span class="gl-live-phase">${v ? esc(phaseText(id, v)) : 'Connecting…'}</span>
        <span class="gl-live-meta">${bets} bet${bets === 1 ? '' : 's'} this round</span>
      </a>`;
    }).join('');
  }

  /* ---------- exports ---------- */
  window.GG = {
    $, $$, h, esc, fmt, fmtMult, round2, clamp, sleep, rand, randInt, frame, unframe, coin, sfx, tension, cents, money,
    registerGame, games, order, onLeave, placeBet, bet, act, active, settle, balance, coins, confetti, nudge,
    follow, roundBet, roundCashout, syncMe, feedTable, chipStack, chipButtons, chipLabel, CHIPS, track,
    toast: GR.toast, ui: { amount: amountField, seg: segHTML, bindSeg, setSeg }, cards, prefs,
    me, cfg: () => cfg, minBet, maxBet,
  };
  GR.games = { lobby, play, leave, busy };
})();
