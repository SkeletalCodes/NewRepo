/* GoldRush games: the shared engine. Ported from the original game site's core: the game frame, bet amount
   control, Manual/Auto betting, hotkeys, live stats, sound effects, rules and the provably-fair window.
   Every result comes from the server (/api/games); the game files only animate what the server decided.
   Amounts inside the games are dollars (like the original's coins); the API works in cents. */
(() => {
  'use strict';

  const GR = window.GR;
  const { $, $$, esc } = GR;

  /* ---------- tiny helpers ---------- */
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

  /* Animation frames that keep running when the browser stops delivering them (background tabs and
     embedded previews can pause requestAnimationFrame, which would freeze Crash and Plinko mid-round). */
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

  /* ---------- icons (24px stroke set from the original) ---------- */
  const ICONS = {
    star: '<path d="M12 3.500l2.600 5.400 5.900.8-4.300 4.100 1 5.800-5.200-2.700-5.200 2.700 1-5.800-4.300-4.100 5.900-.8z"/>',
    info: '<circle cx="12" cy="12" r="8.500"/><path d="M12 11v5M12 8h.01"/>',
    chart: '<path d="M5 19v-8M12 19V5M19 19v-6"/>',
    expand: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
    shield: '<path d="M12 2.500l8 3v6c0 5-3.400 8.700-8 10-4.600-1.300-8-5-8-10v-6z"/><path d="M8.500 12l2.500 2.500 4.500-5"/>',
    sound: '<path d="M4 9.500h3.500L12 5.500v13l-4.500-4H4z"/><path d="M15.500 8.500a5 5 0 0 1 0 7M18 6a8.500 8.500 0 0 1 0 12"/>',
    mute: '<path d="M4 9.500h3.500L12 5.500v13l-4.500-4H4z"/><path d="M16 9.500l5 5M21 9.500l-5 5"/>',
    reset: '<path d="M5 12a7 7 0 1 0 2.200-5.100"/><path d="M5 4.500v3.500h3.500"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
  };
  const ic = (name, size) => `<svg viewBox="0 0 24 24" width="${size || 18}" height="${size || 18}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  /* =====================================================================
     Sound effects, synthesised live with the Web Audio API (from the original, minus the music)
     ===================================================================== */
  let actx = null, sfxBus, tensBus, noiseBuf;
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
    const len = actx.sampleRate * 2;
    noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
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
    const src = actx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const fl = actx.createBiquadFilter();
    fl.type = o.ft || 'highpass'; fl.Q.value = o.q || 0.7;
    fl.frequency.setValueAtTime(o.fc || 6000, o.t);
    if (o.fcTo) fl.frequency.exponentialRampToValueAtTime(o.fcTo, o.t + o.dur);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, o.t);
    g.gain.linearRampToValueAtTime(o.g || 0.1, o.t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur);
    src.connect(fl); fl.connect(g); g.connect(bus);
    src.start(o.t, Math.random() * 1.5); src.stop(o.t + o.dur + 0.05);
  }
  const SFX = {
    click(t) { tone(sfxBus, { type: 'square', f: 1100, t, dur: 0.03, g: 0.045, lp: 3000 }); },
    bet(t) { noise(sfxBus, { t, dur: 0.05, g: 0.11, ft: 'bandpass', fc: 3200, q: 2 }); tone(sfxBus, { type: 'triangle', f: 520, slide: 760, t, dur: 0.09, g: 0.09 }); },
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

  /* =====================================================================
     Balance: the server is the truth. While a result is still animating, the top bar keeps showing
     the balance from before it, so the win lands when the animation does.
     ===================================================================== */
  const bal = { inflight: 0, hidden: 0 };
  const me = () => GR.state.user;
  const balance = () => (me() ? (me().balance - bal.hidden - bal.inflight) / 100 : 0);
  function showBal() { if (me()) GR.showBalance(me().balance - bal.hidden - bal.inflight); }

  let cfg = null;
  const loadCfg = async () => { if (!cfg) cfg = await GR.api('/games/config'); return cfg; };
  const minBet = () => (cfg ? cfg.min / 100 : 0.1);
  const maxBet = () => (cfg ? cfg.max / 100 : 100);

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

  /** Place a bet on the server. Resolves to the server's answer, or null if it was refused. */
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

  /** A move in a round game (hit, reveal, cash out...). Resolves to the server's answer or null. */
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

  /** An unfinished round of this game, if the player left one (rounds survive reloads). */
  async function active(game) {
    if (!me()) return null;
    try { const { bets } = await GR.api('/games/active'); return bets.find((b) => b.game === game) || null; } catch { return null; }
  }

  /* ---------- settling: balance, live stats, effects, autobet ---------- */
  const live = { profit: 0, wagered: 0, wins: 0, losses: 0, pts: [0] };

  /** Show a finished bet: release its payout to the balance (coins fly from `from`), log it, flash the stage. */
  function settle(res, opts = {}) {
    const b = res.bet;
    if (!b || b.status !== 'settled' || b._shown) return;
    b._shown = true;
    if (b.payout > 0) bal.hidden = Math.max(0, bal.hidden - b.payout);
    const from = opts.from || $('#g-stage');
    if (b.payout > 0 && !opts.quiet && from && from.isConnected && !GR.reduced && GR.flyCoins) {
      GR.flyCoins(from, Math.min(14, 4 + Math.round(b.multiplier * 2))).then(showBal);
    } else showBal();

    const wager = b.amount / 100, payout = b.payout / 100, net = round2(payout - wager);
    live.wagered = round2(live.wagered + wager);
    live.profit = round2(live.profit + net);
    if (net > 0) live.wins++; else if (net < 0) live.losses++;
    live.pts.push(live.profit);
    if (live.pts.length > 120) live.pts.shift();
    paintLive();

    const st = $('#g-stage');
    if (st && net !== 0) { st.classList.remove('fx-win', 'fx-lose'); void st.offsetWidth; st.classList.add(net > 0 ? 'fx-win' : 'fx-lose'); }
    if (st && payout > 0 && b.multiplier >= 10) coins(st, b.multiplier >= 50 ? 44 : 26);
    autoSettled({ id: b.game, wager, payout });
    myBetsSoon();
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

  /* =====================================================================
     Shared widgets
     ===================================================================== */
  let lastAmount = null;
  /** The bet amount box (dollars) with ½, 2× and Max, and validation. Remembers the last amount. */
  function amountField(opts = {}) {
    const start = opts.value || store.get('gg.bet', 1) || 1;
    const el = h(`
      <div class="gfield">
        <span class="gfield-l">${opts.label || 'Bet Amount'}</span>
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

  /** Playing cards. The server sends { r, s, red, i }; suits get a text-style selector so phones don't draw emoji. */
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

  /* =====================================================================
     Games, the game page, leaving
     ===================================================================== */
  const games = {};
  const order = [];
  let current = null;
  let leaveHooks = [];
  const CATS = [['table', 'Table games'], ['instant', 'Instant win'], ['cashout', 'Climb & cash out']];
  const DEFAULT_CAT = { blackjack: 'table', baccarat: 'table', roulette: 'table', hilo: 'table', crash: 'cashout', mines: 'cashout', towers: 'cashout', pump: 'cashout' };
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
    // anything still animating is already settled on the server: show the real balance
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
  }
  function paintFav() {
    const b = $('#gf-fav');
    if (!b || !current) return;
    const on = isFav(current.id);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
    b.title = on ? 'Remove from favourites' : 'Add to favourites';
  }

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
    const rtp = info ? info.rtp : g.rtp;
    GR.setContent(`<div class="bbg" id="bbg">
      <div class="game-head">
        <a href="#/games" class="back" aria-label="Back to games">${ic('back', 18)}</a>
        <h1>${esc(g.name)}</h1>
        <span class="chip-tag">Originals</span>
        <span class="rtp">RTP ${Number(rtp).toFixed(1)}%</span>
      </div>
      <div class="game" data-game="${id}">
        <div class="game-panel" id="g-panel"></div>
        <div class="game-stage" id="g-stage"></div>
        <div class="game-foot">
          <div class="gf-l">
            <button class="gf-btn" id="gf-fav" aria-label="Favourite">${ic('star', 18)}</button>
            <button class="gf-btn" id="gf-rules" title="How to play" aria-label="How to play">${ic('info', 18)}</button>
            <button class="gf-btn" id="gf-stats" title="Live stats" aria-label="Live stats">${ic('chart', 18)}</button>
            <button class="gf-btn" id="gf-theatre" title="Theatre mode" aria-label="Theatre mode">${ic('expand', 18)}</button>
            <button class="gf-btn${prefs.sound ? '' : ' muted'}" id="gf-sound" title="Sound" aria-label="Sound on or off">${ic(prefs.sound ? 'sound' : 'mute', 18)}</button>
          </div>
          <div class="gf-c">GOLD<b>RUSH</b></div>
          <div class="gf-r"><button class="fair-chip" id="gf-fair" title="How results are generated">${ic('shield', 14)}Fairness</button></div>
        </div>
      </div>
      <section class="card-sec">
        <div class="sec-row"><h3>My bets</h3><span class="faint" style="font-size:12.5px;font-weight:600">${esc(g.name)} · newest first</span></div>
        <div class="table four" id="mybets"></div>
      </section>
      <p class="g-legal"><i class="fa-solid fa-circle-info"></i> 18+ only. Bets use your real balance and every result is final. Play for fun, never to make money.</p>
    </div>`);
    current = g;
    $('#gf-fav').addEventListener('click', () => { toggleFav(id); paintFav(); });
    $('#gf-rules').addEventListener('click', openRules);
    $('#gf-stats').addEventListener('click', toggleLive);
    $('#gf-fair').addEventListener('click', () => openFair());
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
    if (!NO_AUTO[id]) addAuto($('#g-panel'));
    paintMyBets();
  }

  /* ---------- my bets (from the server) ---------- */
  let myTimer = 0;
  const myBetsSoon = () => { clearTimeout(myTimer); myTimer = setTimeout(paintMyBets, 600); };
  async function paintMyBets() {
    const box = $('#mybets');
    if (!box || !current) return;
    if (!me()) { box.innerHTML = '<div class="gempty">Log in to play. Your bets will show up here.</div>'; return; }
    let list = [];
    try { list = (await GR.api(`/games/bets?game=${current.id}`)).bets.filter((b) => b.status === 'settled').slice(0, 10); } catch { return; }
    if (!$('#mybets')) return;
    const g = current;
    box.innerHTML = list.length
      ? `<div class="tr th"><span class="td g">Game</span><span class="td n">Bet</span><span class="td m">Multiplier</span><span class="td n">Profit</span></div>` + list.map((b) => {
        const net = round2((b.payout - b.amount) / 100);
        return `<div class="tr mine">
          <span class="td g"><i class="gi">${g.icon || ''}</i>${esc(g.name)}<small class="nonce" title="Bet nonce, for the fairness checker">#${b.nonce}</small><button type="button" class="verify" data-vb="${b.id}">Verify</button></span>
          <span class="td n">${coin('sm')}${fmt(b.amount / 100)}</span>
          <span class="td m">${fmtMult(b.multiplier)}</span>
          <span class="td n ${net > 0 ? 'pos' : 'neg'}">${net > 0 ? '+' : ''}${fmt(net)}</span>
        </div>`;
      }).join('')
      : '<div class="gempty">Your bets will show up here.</div>';
    $$('[data-vb]', box).forEach((btn) => btn.addEventListener('click', () => verifyBet(list.find((x) => String(x.id) === btn.dataset.vb))));
  }

  /* ---------- live stats card: profit / wagered / wins / losses since it was last reset ---------- */
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

  /* ---------- rules ---------- */
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
      <p class="fair-note">${prefs.hotkeys ? 'Shortcuts: <code>Space</code> bet · <code>A</code> halve the bet · <code>S</code> double it. ' : ''}Every result comes from your seed pair. Open <a href="#" id="rules-fair" style="color:var(--green)">Fairness</a> to check any bet.</p>
    </div>`);
    $('#rules-fair').addEventListener('click', (e) => { e.preventDefault(); openFair(); });
  }

  /* =====================================================================
     Provably fair window (seeds come from the server; the verifier recomputes on the server)
     ===================================================================== */
  const copyField = (label, value, id) => `
    <div class="gfield"><span class="gfield-l">${label}</span>
      <div class="copy"><input type="text" readonly value="${esc(value)}"${id ? ` id="${id}"` : ''}><button type="button" data-copy>Copy</button></div></div>`;
  const randomHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

  async function openFair(prefill) {
    let f = null;
    if (me()) { try { f = await GR.api('/games/fair'); } catch { /* shown as logged out */ } }
    const gameOpts = order.map((id) => `<option value="${id}">${esc(games[id].name)}</option>`).join('');
    const seeds = f ? `
        ${copyField('Active client seed', f.client_seed)}
        ${copyField('Active server seed (hashed)', f.server_hash)}
        <div class="gfield"><span class="gfield-l">Bets made with this pair</span><div class="readout">${f.nonce}</div></div>
        <div class="fair-sep"><span>Rotate seed pair</span></div>
        <div class="gfield"><span class="gfield-l">New client seed</span>
          <div class="copy"><input type="text" id="fair-new" value="${randomHex(8)}" maxlength="64" spellcheck="false"><button type="button" class="go" id="fair-rotate">Rotate</button></div></div>
        ${copyField('Next server seed (hashed)', f.next_hash)}
        ${f.previous ? `
        <div class="fair-sep"><span>Previous pair — revealed</span></div>
        ${copyField('Server seed (unhashed)', f.previous.server_seed)}
        ${copyField('Client seed', f.previous.client_seed)}
        <div class="fair-prev"><span>${f.previous.nonce} bet${f.previous.nonce === 1 ? '' : 's'} were made with it.</span><button type="button" class="gbtn ghost sm" id="fair-check">Verify one</button></div>` : `
        <p class="hint left" style="font-size:13px;color:var(--muted)">Rotate the pair to reveal the current server seed, then check any bet you made with it in the Verify tab.</p>`}`
      : '<div class="gempty">Log in to get your own seed pair.<br>The Verify tab works without an account.</div>';

    const m = GR.openModal(`<div class="bbg-modal" id="fair">
      <h2 class="modal-title">${ic('shield', 22)}Provably fair</h2>
      <div class="gtabs"><button type="button" data-tab="seeds">Seeds</button><button type="button" data-tab="verify">Verify</button></div>
      <div data-pane="seeds">${seeds}</div>
      <div data-pane="verify" hidden>
        <div class="row2">
          <div class="gfield"><span class="gfield-l">Game</span><select id="fv-game">${gameOpts}</select></div>
          <div class="gfield"><span class="gfield-l">Nonce</span><input type="text" inputmode="numeric" id="fv-nonce" value="1"></div>
        </div>
        <div class="gfield"><span class="gfield-l">Client seed</span><input type="text" id="fv-client" spellcheck="false"></div>
        <div class="gfield"><span class="gfield-l">Server seed (unhashed)</span><input type="text" id="fv-server" spellcheck="false" placeholder="Revealed after you rotate the pair"></div>
        <div class="fair-out" id="fv-out"></div>
      </div>
      <p class="fair-note">Results come from <code>HMAC-SHA256(serverSeed, clientSeed:nonce:cursor)</code>, 4 bytes per number. The hash shown before you bet is <code>SHA-256(serverSeed)</code>, so the seed can't be swapped afterwards. The server seed is kept on our server and only revealed when you rotate.</p>
    </div>`, { cls: 'wide' });

    const setTab = (t) => {
      $$('.gtabs button', m).forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      $$('[data-pane]', m).forEach((p) => { p.hidden = p.dataset.pane !== t; });
    };
    $$('.gtabs button', m).forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    m.addEventListener('click', (e) => {
      const c = e.target.closest('[data-copy]');
      if (!c) return;
      const input = c.parentElement.querySelector('input');
      input.select();
      const done = () => { c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, done);
      else { try { document.execCommand('copy'); } catch { /* ignore */ } done(); }
    });

    let vSeq = 0, vTimer = 0;
    const runVerify = () => {
      clearTimeout(vTimer);
      vTimer = setTimeout(async () => {
        const out = $('#fv-out', m);
        if (!out) return;
        const server = $('#fv-server', m).value.trim(), client = $('#fv-client', m).value.trim();
        const nonce = parseInt($('#fv-nonce', m).value, 10);
        if (!server || !client || !(nonce >= 0)) { out.innerHTML = '<div class="gempty">Enter a server seed, client seed and nonce.</div>'; return; }
        const my = ++vSeq;
        try {
          const r = await GR.api('/games/verify', { body: { game: $('#fv-game', m).value, server_seed: server, client_seed: client, nonce } });
          if (my !== vSeq || !out.isConnected) return;
          out.innerHTML = r.rows.map((x) => `<div class="fo-row"><span>${esc(x[0])}</span><b>${esc(x[1])}</b></div>`).join('');
        } catch (err) { if (my === vSeq) out.innerHTML = `<div class="gempty">${esc(err.message)}</div>`; }
      }, 220);
    };
    $$('#fv-game, #fv-nonce, #fv-client, #fv-server', m).forEach((el) => el.addEventListener('input', runVerify));
    const fillVerify = (v) => {
      $('#fv-server', m).value = v.server || '';
      $('#fv-client', m).value = v.client || '';
      $('#fv-nonce', m).value = v.nonce != null ? v.nonce : 1;
      if (v.game && games[v.game]) $('#fv-game', m).value = v.game;
      setTab('verify');
      runVerify();
    };
    const rot = $('#fair-rotate', m);
    if (rot) rot.addEventListener('click', async () => {
      try {
        await GR.api('/games/fair/rotate', { body: { client_seed: $('#fair-new', m).value } });
        GR.toast('Seed pair rotated. The old server seed is now revealed.', 'success');
        openFair();
        paintMyBets();
      } catch (err) { GR.toast(err.message, 'error'); }
    });
    const chk = $('#fair-check', m);
    if (chk) chk.addEventListener('click', () => fillVerify({ server: f.previous.server_seed, client: f.previous.client_seed, nonce: Math.max(1, f.previous.nonce), game: current && current.id }));
    if (f) $('#fv-client', m).value = f.client_seed;
    if (current) $('#fv-game', m).value = current.id;
    if (prefill) fillVerify(prefill); else { setTab('seeds'); runVerify(); }
  }

  /** Open the verifier for one of your bets. */
  function verifyBet(b) {
    if (!b) return;
    if (b.server_seed) { openFair({ server: b.server_seed, client: b.client_seed, nonce: b.nonce, game: b.game }); return; }
    openFair({ client: b.client_seed, nonce: b.nonce, game: b.game });
    GR.toast('That bet used your active seed pair. Rotate the pair (Seeds tab) to reveal its server seed.', 'info');
  }

  /* =====================================================================
     Autobet (games that settle in one press)
     ===================================================================== */
  const NO_AUTO = { blackjack: 1, roulette: 1, hilo: 1, crash: 1, mines: 1, towers: 1, pump: 1, videopoker: 1, chicken: 1 };
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
    if (lastAmount && base && $('#g-panel .gamount')) lastAmount.set(base); // put the bet back to where it started
    const box = $('#g-auto');
    if (box) {
      $('#auto-go').textContent = 'Start autobet';
      $('#auto-go').className = 'gbtn green lg block';
      $$('input', box).forEach((i) => { i.disabled = false; });
    }
    if (why) GR.toast(why, 'info');
  }
  /** Press the game's own button as soon as it's ready; stop if the bet is refused. */
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
        const pct = net > 0 ? a.onWin : a.onLoss; // 0% means "go back to the starting bet"
        lastAmount.set(pct ? lastAmount.get() * (1 + pct / 100) : a.base);
      }
      autoNext();
    }, 280);
  }
  /** Adds the Manual / Auto switch and the autobet form to a game's bet panel. */
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
      <p class="auto-stat" id="auto-stat">Set the bets to 0 to keep going until you stop it. A raise of 0% goes back to your starting bet.</p>
    </div>`));
    bindSeg($('#g-mode'), (v) => { autoStop(); $('#g-auto').hidden = v !== 'auto'; panel.classList.toggle('auto-on', v === 'auto'); });
    $('#auto-go').addEventListener('click', () => (auto ? autoStop('Autobet stopped.') : autoStart()));
    $$('#g-auto input').forEach((i) => i.addEventListener('input', () => { const c = i.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'); if (c !== i.value) i.value = c; }));
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
  // a mouse click shouldn't leave focus parked on a game button, or Space would press it again
  document.addEventListener('click', (e) => { if (e.detail > 0) { const b = e.target.closest('.bbg .game button'); if (b && document.activeElement === b) b.blur(); } });
  // keep the bet box's "more than your balance" check current
  let lastBal = null;
  setInterval(() => { const v = me() ? me().balance : null; if (v !== lastBal) { lastBal = v; emit('gg:balance'); } }, 500);

  /* =====================================================================
     Lobby
     ===================================================================== */
  let lobbyCat = 'all';
  async function lobby() {
    leave();
    GR.page(GR.skels(6, 220));
    try { await loadCfg(); } catch (err) { GR.setContent(GR.emptyHTML(err.message, 'fa-triangle-exclamation')); return; }
    const off = !cfg.enabled;
    GR.setContent(`<div class="bbg-lobby">
      <div class="gl-hero">
        <h1>Games</h1>
        <p>${order.length} originals, played with your real USD balance. Every result is provably fair: you can check any bet yourself.</p>
        <div class="row" style="justify-content:center;margin-top:16px;gap:10px;flex-wrap:wrap">
          <button class="btn btn-sm" id="gl-fair"><i class="fa-solid fa-shield-halved"></i> How fairness works</button>
          <span class="badge b-gold">18+ only</span>
        </div>
        ${off ? '<div class="notice warn mt-16" style="border-radius:14px;justify-content:center"><i class="fa-solid fa-power-off"></i><span>Games are switched off right now.</span></div>' : ''}
      </div>
      <div class="gl-tools">
        <div class="chips" id="gl-cats">
          <button class="chip ${lobbyCat === 'all' ? 'active' : ''}" data-c="all">All games</button>
          ${CATS.map(([k, l]) => `<button class="chip ${lobbyCat === k ? 'active' : ''}" data-c="${k}">${l}</button>`).join('')}
          <button class="chip ${lobbyCat === 'fav' ? 'active' : ''}" data-c="fav"><i class="fa-regular fa-star"></i> Favourites</button>
        </div>
        <label class="gl-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="gl-q" placeholder="Search games" autocomplete="off" aria-label="Search games"></label>
      </div>
      <div class="gl-grid" id="gl-grid"></div>
      <div class="gl-live">
        <div class="sec-title"><i class="fa-solid fa-bolt"></i> Live bets</div>
        <div id="gl-live">${GR.skels(1, 160)}</div>
      </div>
    </div>`);
    const paint = () => {
      const q = ($('#gl-q').value || '').trim().toLowerCase();
      const f = favs();
      const list = order.filter((id) => {
        const g = games[id];
        if (lobbyCat === 'fav' && !f.includes(id)) return false;
        if (lobbyCat !== 'all' && lobbyCat !== 'fav' && g.cat !== lobbyCat) return false;
        return !q || g.name.toLowerCase().includes(q);
      });
      $('#gl-grid').innerHTML = list.length ? list.map((id) => {
        const g = games[id];
        const info = cfg.games.find((x) => x.id === id);
        return `<a href="#/games/${id}" class="gl-tile" style="--c1:${g.colors[0]};--c2:${g.colors[1]}" data-reveal>
          ${g.badge ? `<span class="gl-flag ${g.badge === 'NEW' ? 'new' : ''}">${g.badge}</span>` : ''}
          <span class="gl-art">${g.art || ''}</span>
          <span class="gl-name"><b>${esc(g.name)}</b><small>RTP ${Number(info ? info.rtp : g.rtp).toFixed(1)}%</small></span>
        </a>`;
      }).join('') : `<div class="gl-empty">${GR.emptyHTML(lobbyCat === 'fav' ? 'No favourites yet. Tap the star under any game.' : 'No games match that.', 'fa-dice')}</div>`;
      GR.reveal($('#gl-grid'));
    };
    $('#gl-cats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      lobbyCat = b.dataset.c;
      $$('#gl-cats .chip').forEach((x) => x.classList.toggle('active', x === b));
      paint();
    });
    $('#gl-q').addEventListener('input', paint);
    $('#gl-fair').addEventListener('click', () => openFair());
    paint();
    paintLobbyLive();
  }

  async function paintLobbyLive() {
    const el = $('#gl-live');
    if (!el) return;
    try {
      const { bets } = await GR.api('/games/live');
      if (!$('#gl-live')) return;
      el.innerHTML = bets.length ? `<div class="table-wrap"><table><thead><tr><th>Game</th><th>Player</th><th>Bet</th><th>Multiplier</th><th style="text-align:right">Payout</th></tr></thead><tbody>
        ${bets.map((b) => {
          const g = games[b.game];
          return `<tr><td><a href="#/games/${esc(b.game)}" class="row" style="gap:8px"><i class="gi" style="display:inline-block;width:18px;height:18px;color:var(--gold)">${g ? g.icon : ''}</i><b>${esc(b.name)}</b></a></td>
          <td>${GR.avatar(b.username, b.avatar_color)} ${esc(b.username)}</td><td class="money">${GR.money(b.amount)}</td>
          <td><span class="badge ${b.payout > b.amount ? 'b-green' : 'b-gray'}">${fmtMult(b.multiplier)}</span></td>
          <td style="text-align:right" class="money ${b.payout > b.amount ? 'green' : ''}">${GR.money(b.payout)}</td></tr>`;
        }).join('')}</tbody></table></div>` : GR.emptyHTML('No bets yet. Be the first!', 'fa-dice');
    } catch { el.innerHTML = ''; }
  }

  /* ---------- exports ---------- */
  window.GG = {
    $, $$, h, esc, fmt, fmtMult, round2, clamp, sleep, rand, randInt, frame, unframe, coin, sfx, tension, cents,
    registerGame, games, order, onLeave, placeBet, bet, act, active, settle, balance, coins, confetti, nudge,
    toast: GR.toast, ui: { amount: amountField, seg: segHTML, bindSeg, setSeg }, cards, prefs,
    me, cfg: () => cfg, minBet, maxBet,
  };
  GR.games = { lobby, play, leave, busy };
})();
