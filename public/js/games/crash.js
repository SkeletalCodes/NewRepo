/* Crash — one shared rocket after another. Betting is open for ten seconds: everyone who bets is in the
   same round. The rocket climbs; cash out before it crashes to take the multiplier. An auto cash-out
   takes the money at your number on its own. The crash point is decided by the server when the round opens.

   The stage is one canvas (sky, stars, grid, curve, rocket, cash-out labels, explosion) with the big
   multiplier and the countdown as plain text over it. The canvas only shows what the round says; nothing
   drawn here decides anything. */
(function () {
  'use strict';
  const { $, $$, h, fmt, fmtMult, clamp, follow, round2 } = GG;

  const PRESETS = [1.5, 2, 5, 10];
  const BET_MS = 10000; // the betting window the countdown bar measures (the server's default)
  const HOLD = 3200; // the wreck stays on screen this long after a crash, while the next window is open
  const MARK_MS = 3000; // how long a cash-out label stays on the curve
  const PULSES = [2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const Y_STEPS = [0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 50000];
  const X_STEPS = [1000, 2000, 10000, 20000, 60000, 120000, 600000];
  const TAU = Math.PI * 2;
  const FONT = 'Inter, system-ui, sans-serif';
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const wrap = (v) => v - Math.floor(v);
  const smooth = (a, b, v) => { const k = clamp((v - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
  const easeOut = (k) => 1 - Math.pow(1 - clamp(k, 0, 1), 3);

  let amount = null, sub = null, frameId = 0, view = null, bets = [], lastSeq = null;
  let flight = null, lastCrash = null, history = [], auto = 0, busy = false;
  let cv = null, ctx = null, W = 0, H = 0, dpr = 1, ro = null, sky = null;
  /* the look only */
  let wreck = null, marks = new Map(), parts = [], rings = [], axes = null, heading = null, lastT = 0, starV = 6;
  let shownSeq = null, padSince = 0, pulsed = -1, flashAt = -1e9, shakeUntil = 0, tip = null;
  let smokeAcc = 0, sparkAcc = 0, puffAcc = 0;

  /* two layers of stars in 0..1 space: the near ones are bigger and move about three times faster */
  const stars = [];
  for (let i = 0; i < 260; i++) {
    const near = i % 4 === 0, c = Math.random();
    stars.push({
      x: Math.random(), y: Math.random(), near, tw: rnd(0, TAU),
      r: near ? rnd(1.1, 1.9) : rnd(0.5, 1.15), a: near ? rnd(0.55, 0.95) : rnd(0.22, 0.65),
      col: c < 0.12 ? '255,226,170' : c < 0.35 ? '180,200,255' : '236,241,255',
    });
  }

  const now = () => (sub ? sub.now() : Date.now());
  const mine = () => bets.find((b) => b.mine) || null;
  const bettingOpen = () => !!(view && view.round.phase === 'betting' && sub && now() < view.round.betEnd);
  const wrecked = (t = performance.now()) => !!(wreck && t - wreck.at < HOLD && (!flight || flight.crashed));

  /** The multiplier on this device's clock, between the server's answers. Stops at the crash. */
  function multNow() {
    if (!flight) return 1;
    let el = Math.max(0, now() - flight.playAt);
    if (flight.crashed) el = Math.min(el, Math.log(flight.crashed) / flight.rate);
    return Math.max(1, Math.floor(Math.exp(flight.rate * el) * 100) / 100);
  }

  /** What the stage shows: the rocket on its pad, the rocket flying, or the wreck of the round that just ended. */
  function scene(t) {
    if (flight && !flight.crashed) {
      const el = Math.max(0, now() - flight.playAt);
      return { mode: 'fly', el, m: Math.exp(flight.rate * el), rate: flight.rate };
    }
    if (wrecked(t)) return { mode: 'wreck', el: wreck.tEnd, m: wreck.crash, rate: wreck.rate };
    return { mode: 'pad', el: 0, m: 1, rate: (view && view.round && view.round.rate) || 0.00009 };
  }

  function size() {
    if (!cv) return;
    const box = cv.parentElement;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = box.clientWidth; H = box.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sky = W && H ? paintSky() : null;
  }

  /** The deep-space backdrop, painted once per size: a dark gradient, two soft nebulas and a warm glow at the launch pad. */
  function paintSky() {
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const base = g.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, '#04050d'); base.addColorStop(0.55, '#090a1b'); base.addColorStop(1, '#141026');
    g.fillStyle = base; g.fillRect(0, 0, W, H);
    const big = Math.max(W, H);
    const blob = (x, y, r, col) => {
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(0, 0, W, H);
    };
    blob(W * 0.8, H * 0.12, big * 0.55, 'rgba(124,92,255,.17)');
    blob(W * 0.42, H * 0.02, big * 0.38, 'rgba(56,120,255,.08)');
    blob(W * 0.02, H, big * 0.42, 'rgba(234,200,55,.11)');
    const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, big * 0.78);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.5)');
    g.fillStyle = v; g.fillRect(0, 0, W, H);
    return c;
  }

  /* ---------- drawing ---------- */
  function drawStars(t, dt, dx, dy) {
    const n = clamp(Math.round((W * H) / 2600), 60, stars.length);
    const k = dt / 1000;
    for (let i = 0; i < n; i++) {
      const s = stars[i], f = s.near ? 1 : 0.32;
      if (!reduced) { s.x = wrap(s.x + (dx * starV * f * k) / W); s.y = wrap(s.y + (dy * starV * f * k) / H); }
      const x = s.x * W, y = s.y * H;
      const a = s.a * (reduced ? 1 : 0.72 + 0.28 * Math.sin(t / 650 + s.tw));
      const len = s.near && !reduced ? Math.min(46, starV * 0.085) : 0;
      if (len > 3) { // a streak: a faint long tail and a brighter short head
        ctx.lineCap = 'round'; ctx.lineWidth = s.r;
        ctx.strokeStyle = `rgba(${s.col},${(a * 0.35).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dx * len, y - dy * len); ctx.stroke();
        ctx.strokeStyle = `rgba(${s.col},${a.toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dx * len * 0.35, y - dy * len * 0.35); ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(${s.col},${a.toFixed(3)})`;
        if (s.near) { ctx.beginPath(); ctx.arc(x, y, s.r, 0, TAU); ctx.fill(); } else ctx.fillRect(x - s.r / 2, y - s.r / 2, s.r, s.r);
      }
    }
  }

  /** Grid lines at "nice" steps. A finer step fades in as it gets room and out as it gets crowded, so the
      grid rescales smoothly while the curve grows. fn(value, lineAlpha, labelAlpha, decimals). */
  function lod(steps, perUnit, from, max, small, fn) {
    if (!(perUnit > 0) || !Number.isFinite(perUnit)) return;
    const lineA = (st) => smooth(14, 40, st * perUnit);
    const textA = (st) => smooth(small ? 30 : 38, small ? 46 : 60, st * perUnit);
    let fine = steps.length - 1, label = steps[steps.length - 1];
    for (let i = steps.length - 1; i >= 0; i--) if (lineA(steps[i]) > 0) fine = i;
    for (let i = steps.length - 1; i >= 0; i--) if (textA(steps[i]) > 0) label = steps[i];
    const base = steps[fine], dec = label < 1 ? 1 : 0;
    for (let k = Math.floor(from / base + 1e-9) + 1, n = 0; k * base <= max + 1e-9 && n < 80; k++, n++) {
      const v = k * base;
      let la = 0, ta = 0;
      for (let i = fine; i < steps.length; i++) {
        const q = v / steps[i];
        if (Math.abs(q - Math.round(q)) < 1e-6) { la = Math.max(la, lineA(steps[i])); ta = Math.max(ta, textA(steps[i])); }
      }
      fn(v, la, ta, dec);
    }
  }

  function drawGrid(L, X, Y, small) {
    ctx.lineWidth = 1;
    ctx.font = `600 ${small ? 10 : 11}px ${FONT}`;
    ctx.textBaseline = 'middle';
    lod(Y_STEPS, L.ph / (axes.m - 1), 1, axes.m, small, (v, la, ta, dec) => {
      const y = Math.round(Y(v)) + 0.5;
      if (y < L.yt - 2) return;
      if (la > 0) { ctx.strokeStyle = `rgba(255,255,255,${(0.065 * la).toFixed(3)})`; ctx.beginPath(); ctx.moveTo(L.x0, y); ctx.lineTo(L.x1, y); ctx.stroke(); }
      if (ta > 0.02) { ctx.fillStyle = `rgba(148,163,184,${(0.85 * ta).toFixed(3)})`; ctx.textAlign = 'right'; ctx.fillText(`${v.toFixed(dec)}×`, L.x0 - 7, y); }
    });
    lod(X_STEPS, L.pw / axes.t, 0, axes.t, small, (v, la, ta) => {
      const x = Math.round(X(v)) + 0.5;
      if (x > L.x1 + 1) return;
      if (la > 0) { ctx.strokeStyle = `rgba(255,255,255,${(0.045 * la).toFixed(3)})`; ctx.beginPath(); ctx.moveTo(x, L.yt); ctx.lineTo(x, L.yb); ctx.stroke(); }
      if (ta > 0.02 && x < L.x1 - 8) { ctx.fillStyle = `rgba(148,163,184,${(0.85 * ta).toFixed(3)})`; ctx.textAlign = 'center'; ctx.fillText(`${Math.round(v / 1000)}s`, x, L.yb + (small ? 13 : 16)); }
    });
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.beginPath(); ctx.moveTo(L.x0, L.yb + 0.5); ctx.lineTo(L.x1, L.yb + 0.5); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.beginPath(); ctx.moveTo(L.x0 + 0.5, L.yt); ctx.lineTo(L.x0 + 0.5, L.yb); ctx.stroke();
  }

  function drawCurve(sc, L, X, Y, s, dead) {
    const N = 96, pts = new Array((N + 1) * 2);
    for (let i = 0; i <= N; i++) { const t = (sc.el * i) / N; pts[i * 2] = X(t); pts[i * 2 + 1] = Y(Math.exp(sc.rate * t)); }
    const path = () => { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); };
    const hx = pts[N * 2], hy = pts[N * 2 + 1];
    path(); ctx.lineTo(hx, L.yb); ctx.lineTo(pts[0], L.yb); ctx.closePath();
    const f = ctx.createLinearGradient(0, Math.min(hy, L.yb - 1), 0, L.yb);
    if (dead) { f.addColorStop(0, 'rgba(255,92,122,.24)'); f.addColorStop(0.45, 'rgba(255,92,122,.07)'); f.addColorStop(1, 'rgba(255,92,122,0)'); }
    else { f.addColorStop(0, 'rgba(255,150,46,.26)'); f.addColorStop(0.45, 'rgba(234,200,55,.08)'); f.addColorStop(1, 'rgba(234,200,55,0)'); }
    ctx.fillStyle = f; ctx.fill();
    const g = ctx.createLinearGradient(pts[0], pts[1], Math.max(hx, pts[0] + 80), Math.min(hy, pts[1] - 40));
    if (dead) { g.addColorStop(0, '#ff9aac'); g.addColorStop(1, '#ff2d55'); }
    else { g.addColorStop(0, '#eac837'); g.addColorStop(0.55, '#ffad2e'); g.addColorStop(1, '#ff6a2d'); }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    /* the glow: wide, faint strokes under the line (cheaper than shadowBlur, and the same on every device) */
    const glow = dead ? '255,60,95' : '255,150,50';
    for (const [w, a] of [[26, 0.05], [17, 0.08], [10, 0.16]]) {
      path(); ctx.strokeStyle = `rgba(${glow},${a})`; ctx.lineWidth = w * s; ctx.stroke();
    }
    path(); ctx.strokeStyle = g; ctx.lineWidth = Math.max(3.5, 5.2 * s); ctx.stroke();
    path(); ctx.strokeStyle = dead ? 'rgba(255,225,232,.45)' : 'rgba(255,248,222,.6)'; ctx.lineWidth = Math.max(1, 1.5 * s); ctx.stroke();
  }

  function rr(x, y, w, hh, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, hh, r); else ctx.rect(x, y, w, hh);
  }

  /** Everyone who cashed out this flight: a dot on the curve at their multiplier and a name tag, fading after a moment. */
  function drawMarks(t, sc, L, X, Y, small, blocked) {
    const placed = [], fs = small ? 10 : 11, bh = fs + 11;
    const over = (b, q) => Math.max(0, Math.min(b.x + b.w + 4, q.x + q.w) - Math.max(b.x, q.x - 4))
      * Math.max(0, Math.min(b.y + b.h + 3, q.y + q.h) - Math.max(b.y, q.y - 3));
    /* how much a label box would cover: the text over the canvas counts triple, other labels once */
    const cost = (b) => (b.x < L.x0 + 2 || b.y < 4 || b.x + b.w > W - 4 || b.y + b.h > L.yb + 6 ? Infinity
      : blocked.reduce((a, q) => a + 3 * over(b, q), 0) + placed.reduce((a, q) => a + over(b, q), 0));
    const live = [...marks.values()].filter((mk) => t - mk.at <= MARK_MS).sort((a, b) => b.at - a.at);
    const labelled = new Set(live.filter((mk) => !mk.mine).slice(0, small ? 2 : 5));
    for (const [id, mk] of [...marks].sort((a, b) => a[1].mine - b[1].mine)) { // yours is drawn last, on top
      const age = t - mk.at;
      if (age > MARK_MS) { marks.delete(id); continue; }
      const a = Math.min(1, age / 160) * Math.min(1, (MARK_MS - age) / 700);
      const at = Math.min(mk.t, sc.el), x = X(at), y = Y(Math.exp(sc.rate * at));
      const col = mk.mine ? '234,200,55' : '20,241,149';
      ctx.globalAlpha = a;
      if (age < 650) {
        const k = age / 650;
        ctx.strokeStyle = `rgba(${col},${(0.85 * (1 - k)).toFixed(3)})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 5 + 18 * easeOut(k), 0, TAU); ctx.stroke();
      }
      if (mk.mine || labelled.has(mk)) {
        const name = mk.mine ? 'You' : mk.name.length > 11 ? `${mk.name.slice(0, 10)}…` : mk.name;
        const mt = fmtMult(mk.mult);
        ctx.font = `700 ${fs}px ${FONT}`; const nw = ctx.measureText(name).width;
        ctx.font = `800 ${fs}px ${FONT}`; const mw = ctx.measureText(mt).width;
        const bw = nw + mw + 24, g = 12;
        /* above-left of the dot first (away from the climb), then the other corners, then one step higher */
        const spots = [[-bw - g, -bh - g], [g, g], [-bw - g, g], [g, -bh - g], [-bw - g, -bh / 2], [g + 4, -bh / 2],
          [g, 2 * g + bh], [-bw - g, 2 * g + bh], [-bw - g, -2 * bh - g - 5], [-bw / 2, -bh - g - 8], [-bw / 2, g + 8]];
        const order = mk.slot != null ? [mk.slot, ...spots.keys()] : [...spots.keys()];
        let box = null, best = null, bestCost = Infinity;
        for (const i of order) {
          const b = { x: x + spots[i][0], y: y + spots[i][1], w: bw, h: bh }, c = cost(b);
          if (c === 0) { box = b; mk.slot = i; break; }
          if (c < bestCost) { best = b; bestCost = c; }
        }
        if (!box && mk.mine) box = best; // your own label always shows, where it covers the least
        if (box) {
          placed.push(box);
          const bx = box.x, by = box.y + (1 - easeOut(age / 240)) * 6;
          ctx.strokeStyle = `rgba(${col},.5)`; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(bx < x ? bx + bw - bh / 2 : bx + bh / 2, by < y ? by + bh : by); ctx.stroke();
          rr(bx, by, bw, bh, bh / 2);
          ctx.fillStyle = 'rgba(7,9,20,.9)'; ctx.fill();
          ctx.strokeStyle = `rgba(${col},.7)`; ctx.lineWidth = 1.2; ctx.stroke();
          ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
          ctx.font = `700 ${fs}px ${FONT}`; ctx.fillStyle = '#e8edf5'; ctx.fillText(name, bx + 10, by + bh / 2 + 0.5);
          ctx.font = `800 ${fs}px ${FONT}`; ctx.fillStyle = `rgb(${col})`; ctx.fillText(mt, bx + 14 + nw, by + bh / 2 + 0.5);
        }
      }
      ctx.fillStyle = `rgb(${col})`; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#070914'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** The launch pad at the origin: a little deck with landing lights and a pool of light. */
  function drawPad(x, y, s, alpha, glow, t) {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    const w = 34 * s;
    /* two searchlights sweeping slowly behind the rocket */
    ctx.globalCompositeOperation = 'lighter';
    for (const k of [-1, 1]) {
      const a = -Math.PI / 2 + k * (0.32 + (reduced ? 0 : 0.12 * Math.sin(t / 1700 + (k > 0 ? 1.7 : 0))));
      const len = H * 0.95, spread = 0.07, bx = x + k * (w - 4 * s);
      const beam = ctx.createLinearGradient(bx, y, bx + Math.cos(a) * len, y + Math.sin(a) * len);
      beam.addColorStop(0, `rgba(234,200,55,${(0.1 + 0.08 * glow).toFixed(3)})`); beam.addColorStop(1, 'rgba(234,200,55,0)');
      ctx.fillStyle = beam;
      ctx.beginPath(); ctx.moveTo(bx, y - 4 * s);
      ctx.lineTo(bx + Math.cos(a - spread) * len, y + Math.sin(a - spread) * len);
      ctx.lineTo(bx + Math.cos(a + spread) * len, y + Math.sin(a + spread) * len);
      ctx.closePath(); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    const pool = ctx.createRadialGradient(x, y, 0, x, y, 80 * s);
    pool.addColorStop(0, `rgba(234,200,55,${(0.22 + 0.3 * glow).toFixed(3)})`); pool.addColorStop(1, 'rgba(234,200,55,0)');
    ctx.fillStyle = pool; ctx.fillRect(x - 80 * s, y - 80 * s, 160 * s, 80 * s);
    const deck = ctx.createLinearGradient(0, y - 10 * s, 0, y);
    deck.addColorStop(0, '#2e3650'); deck.addColorStop(1, '#161b2a');
    ctx.fillStyle = deck;
    ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x - w + 8 * s, y - 9 * s); ctx.lineTo(x + w - 8 * s, y - 9 * s); ctx.lineTo(x + w, y); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - w * 0.45, y - 9 * s); ctx.lineTo(x - w * 0.6, y); ctx.moveTo(x + w * 0.45, y - 9 * s); ctx.lineTo(x + w * 0.6, y); ctx.stroke();
    ctx.fillStyle = '#eac837'; ctx.fillRect(x - w + 8 * s, y - 10.5 * s, 2 * w - 16 * s, 2 * s);
    for (const k of [-1, 1]) {
      const on = reduced || Math.sin(t / 280 + (k > 0 ? Math.PI : 0)) > 0;
      ctx.fillStyle = on ? '#14f195' : 'rgba(20,241,149,.22)';
      ctx.beginPath(); ctx.arc(x + k * (w - 10 * s), y - 4 * s, 1.7 * s, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  /** The rocket, nose along +x with the nozzle at (0, 0), so it can sit on the curve's tip and turn with it. */
  function drawRocket(x, y, ang, s, thrust, t, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y); ctx.rotate(ang); ctx.scale(s, s);
    if (thrust > 0.02) {
      const fl = reduced ? 0.9 : 0.8 + 0.13 * Math.sin(t / 29) + 0.09 * Math.sin(t / 11 + 2);
      const L = (10 + 30 * thrust) * fl, wd = 4 + 2.6 * thrust;
      ctx.globalCompositeOperation = 'lighter';
      const halo = ctx.createRadialGradient(-L * 0.3, 0, 0, -L * 0.3, 0, L * 0.9 + 10);
      halo.addColorStop(0, `rgba(255,160,60,${(0.4 * thrust).toFixed(3)})`); halo.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(-L * 0.3, 0, L * 0.9 + 10, 0, TAU); ctx.fill();
      let g = ctx.createLinearGradient(0, 0, -L, 0);
      g.addColorStop(0, 'rgba(255,235,160,.95)'); g.addColorStop(0.35, 'rgba(255,165,48,.9)'); g.addColorStop(1, 'rgba(255,70,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(1, -wd); ctx.quadraticCurveTo(-L * 0.5, -wd * 1.6, -L, 0); ctx.quadraticCurveTo(-L * 0.5, wd * 1.6, 1, wd); ctx.closePath(); ctx.fill();
      g = ctx.createLinearGradient(0, 0, -L * 0.55, 0);
      g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(1, 'rgba(255,230,140,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(1, -wd * 0.5); ctx.quadraticCurveTo(-L * 0.3, -wd * 0.75, -L * 0.55, 0); ctx.quadraticCurveTo(-L * 0.3, wd * 0.75, 1, wd * 0.5); ctx.closePath(); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    const fin = ctx.createLinearGradient(0, 0, 14, 0);
    fin.addColorStop(0, '#c4304f'); fin.addColorStop(1, '#ff5c7a');
    ctx.fillStyle = fin;
    for (const k of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(16, 8 * k); ctx.lineTo(5, 17.5 * k); ctx.quadraticCurveTo(0.5, 19 * k, 0, 15 * k); ctx.lineTo(3, 7 * k); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#4a5068';
    ctx.beginPath(); ctx.moveTo(5, -5.8); ctx.lineTo(-0.5, -4.6); ctx.lineTo(-0.5, 4.6); ctx.lineTo(5, 5.8); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(4, -7.2);
    ctx.bezierCurveTo(10, -9.6, 22, -10, 29, -8.6);
    ctx.bezierCurveTo(37, -6.6, 43, -3, 46, 0);
    ctx.bezierCurveTo(43, 3, 37, 6.6, 29, 8.6);
    ctx.bezierCurveTo(22, 10, 10, 9.6, 4, 7.2);
    ctx.closePath();
    const body = ctx.createLinearGradient(0, -10, 0, 10);
    body.addColorStop(0, '#ffffff'); body.addColorStop(0.45, '#e7ecf6'); body.addColorStop(1, '#9aa5bd');
    ctx.fillStyle = body; ctx.fill();
    ctx.save(); ctx.clip();
    const nose = ctx.createLinearGradient(0, -10, 0, 10);
    nose.addColorStop(0, '#ff8199'); nose.addColorStop(1, '#d42e52');
    ctx.fillStyle = nose; ctx.fillRect(34, -12, 14, 24);
    ctx.fillStyle = '#eac837'; ctx.fillRect(9, -12, 3, 24);
    ctx.restore();
    ctx.strokeStyle = 'rgba(8,10,25,.45)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.arc(22, 0, 4.4, 0, TAU);
    const win = ctx.createRadialGradient(20.6, -1.6, 0.4, 22, 0, 4.4);
    win.addColorStop(0, '#d8f0ff'); win.addColorStop(0.55, '#4d8dff'); win.addColorStop(1, '#1c3b8f');
    ctx.fillStyle = win; ctx.fill();
    ctx.strokeStyle = '#dfe6f3'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.restore();
  }

  /* particles: 0 smoke (drawn under the rocket), 1 sparks and debris, 2 fireball (both added on top) */
  function emit(k, x, y, vx, vy, life, r0, r1, a, col, drag = 1.6, g = 0) {
    if (parts.length < 700) parts.push({ k, x, y, vx, vy, life, max: life, r0, r1, a, col, drag, g });
  }

  function stepParts(dt) {
    const k = dt / 1000;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
      const d = Math.exp(-p.drag * k);
      p.vx *= d; p.vy = p.vy * d + p.g * k;
      p.x += p.vx * k; p.y += p.vy * k;
    }
  }

  function drawParts(kind) {
    if (kind) ctx.globalCompositeOperation = 'lighter';
    for (const p of parts) {
      const kk = p.k === 2 ? 1 : p.k;
      if (kk !== kind) continue;
      const l = p.life / p.max, r = p.r1 + (p.r0 - p.r1) * l;
      if (p.k === 0) {
        const a = p.a * l * Math.min(1, (1 - l) * 8);
        ctx.fillStyle = `rgba(${p.col},${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
      } else if (p.k === 1) {
        ctx.strokeStyle = `rgba(${p.col},${(p.a * l).toFixed(3)})`; ctx.lineWidth = Math.max(0.6, r * (0.4 + 0.6 * l)); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.028, p.y - p.vy * 0.028); ctx.stroke();
      } else {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `rgba(255,236,190,${(p.a * l).toFixed(3)})`); g.addColorStop(0.4, `rgba(${p.col},${(p.a * l * 0.7).toFixed(3)})`); g.addColorStop(1, `rgba(${p.col},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawRings(t) {
    for (let i = rings.length - 1; i >= 0; i--) {
      const q = rings[i], k = (t - q.at) / q.dur;
      if (k >= 1) { rings.splice(i, 1); continue; }
      if (k < 0) continue;
      ctx.strokeStyle = `rgba(${q.col},${(0.9 * (1 - k)).toFixed(3)})`; ctx.lineWidth = q.w * (1 - k) + 0.5;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.r * easeOut(k), 0, TAU); ctx.stroke();
    }
  }

  /** The rocket blows up where the curve ends: a burst of sparks, a fireball, smoke, two shock rings and a flash. */
  function boom(x, y, s, t) {
    const cols = ['255,240,200', '255,214,90', '255,150,60', '255,92,122'];
    const n = reduced ? 40 : 90;
    for (let i = 0; i < n; i++) {
      const a = rnd(0, TAU), v = rnd(70, 440) * s;
      emit(1, x, y, Math.cos(a) * v, Math.sin(a) * v, rnd(450, 1250), rnd(1.4, 3.4) * s, rnd(1.4, 3.4) * s, 1, cols[i % 4], 2.3, 240);
    }
    for (let i = 0; i < 9; i++) {
      const a = rnd(0, TAU), v = rnd(10, 70) * s;
      emit(2, x + rnd(-6, 6) * s, y + rnd(-6, 6) * s, Math.cos(a) * v, Math.sin(a) * v, rnd(380, 720), rnd(16, 26) * s, rnd(34, 58) * s, 0.9, i % 2 ? '255,120,50' : '255,80,90', 2.5);
    }
    for (let i = 0; i < 22; i++) {
      const a = rnd(0, TAU), v = rnd(20, 110) * s;
      emit(0, x, y, Math.cos(a) * v, Math.sin(a) * v - 10, rnd(1100, 2100), rnd(6, 10) * s, rnd(28, 48) * s, 0.42, i % 3 ? '62,54,80' : '120,70,80', 1.4, -8);
    }
    rings.push({ x, y, at: t, dur: 620, r: 140 * s, col: '255,200,120', w: 4 });
    rings.push({ x, y, at: t + 90, dur: 950, r: 230 * s, col: '255,92,122', w: 2.5 });
    flashAt = t;
    shakeUntil = reduced ? 0 : t + 520;
  }

  /** A far planet low on the right: drawn after the stars so they pass behind it. */
  function drawPlanet(L, s) {
    const r = Math.min(W, H) * 0.17, x = L.x1 - r * 0.2, y = L.yb - r * 0.15;
    const glow = ctx.createRadialGradient(x, y, r * 0.9, x, y, r * 1.7);
    glow.addColorStop(0, 'rgba(124,92,255,.12)'); glow.addColorStop(1, 'rgba(124,92,255,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, r * 1.7, 0, TAU); ctx.fill();
    const body = ctx.createRadialGradient(x - r * 0.45, y - r * 0.5, r * 0.1, x, y, r);
    body.addColorStop(0, '#3a2f6e'); body.addColorStop(0.65, '#1b163c'); body.addColorStop(1, '#0d0b22');
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(170,150,255,.28)'; ctx.lineWidth = 1.5 * s;
    ctx.beginPath(); ctx.arc(x, y, r - 0.75, Math.PI * 1.02, Math.PI * 1.62); ctx.stroke();
    ctx.save();
    ctx.translate(x, y); ctx.rotate(-0.32); ctx.scale(1, 0.22);
    ctx.strokeStyle = 'rgba(190,170,255,.16)'; ctx.lineWidth = 5 * s;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.55, Math.PI * 1.04, Math.PI * 1.96); ctx.stroke();
    ctx.restore();
  }

  /** Where the text over the canvas sits, so cash-out labels can keep out of its way. */
  function blockers() {
    if (!cv) return [];
    const c = cv.getBoundingClientRect(), out = [];
    for (const sel of ['.cr-read > b', '#cr-sub', '.cr-hud']) {
      const el = cv.parentElement.querySelector(sel);
      if (!el || el.hidden) continue;
      const b = el.getBoundingClientRect();
      if (b.width) out.push({ x: b.left - c.left - 4, y: b.top - c.top - 2, w: b.width + 8, h: b.height + 4 });
    }
    return out;
  }

  function draw(t) {
    if (!ctx || !W || !H) return;
    const dt = lastT ? clamp(t - lastT, 0, 50) : 16;
    lastT = t;
    const sc = scene(t);
    const small = W < 520;
    const s = clamp(Math.min(W / 760, H / 430), 0.66, 1.15);
    const P = small ? { l: 34, r: 14, t: 16, b: 24 } : { l: 48, r: 24, t: 22, b: 32 };
    const L = { x0: P.l, x1: W - P.r, yt: P.t, yb: H - P.b };
    L.pw = L.x1 - L.x0; L.ph = L.yb - L.yt;

    /* the axes follow the rocket (about 80% across and 72% up) and ease back to 10s / 2× between rounds */
    if (!axes) axes = { t: 10000, m: 2 };
    if (sc.mode !== 'wreck') {
      const tT = Math.max(10000, sc.el / 0.8), mT = Math.max(2, 1 + (sc.m - 1) / 0.72);
      const ease = (cur, tgt) => cur + (tgt - cur) * (1 - Math.exp(-dt / (tgt > cur ? 90 : 300)));
      axes.t = ease(axes.t, tT); axes.m = ease(axes.m, mT);
    }
    const X = (v) => L.x0 + (v / axes.t) * L.pw;
    const Y = (v) => L.yb - ((v - 1) / (axes.m - 1)) * L.ph;

    const rs = s * 1.2; // the rocket's own scale
    const padX = L.x0 + 30 * s, padY = L.yb;
    const rest = { x: padX, y: padY - 11 * s };

    /* mode changes: a launch, a new pad */
    if (sc.mode === 'fly' && shownSeq !== flight.seq) {
      shownSeq = flight.seq;
      if (sc.el < 1500) for (let i = 0; i < 26; i++) emit(0, padX + rnd(-10, 10) * s, L.yb - 4 * s, rnd(-120, 120) * s, rnd(-40, -5) * s, rnd(900, 1700), 5 * s, rnd(16, 30) * s, 0.3, '210,200,228', 2.2, -6);
    }
    if (sc.mode === 'pad' && shownSeq !== 'pad') { shownSeq = 'pad'; padSince = wreck ? t : 0; heading = null; }

    /* the rocket's heading: the curve's direction on screen, pitched over from upright during lift-off */
    const curveAng = clamp(Math.atan2(-sc.rate * sc.m * L.ph / (axes.m - 1), L.pw / axes.t), -1.35, -0.12);
    const lift = sc.mode === 'fly' ? easeOut(sc.el / 1100) : 0;
    const want = -Math.PI / 2 + (curveAng + Math.PI / 2) * lift;
    heading = heading == null ? want : heading + (want - heading) * (1 - Math.exp(-dt / 70));

    /* the starfield speeds up with the multiplier and streams away from the rocket */
    const spd = sc.mode === 'fly' ? 14 + 160 * (1 - 1 / sc.m) + 46 * Math.log(sc.m) : 6;
    starV += (spd - starV) * (1 - Math.exp(-dt / (spd > starV ? 250 : 700)));
    const dx = sc.mode === 'fly' ? -Math.cos(heading) * 0.85 - 0.15 : -1, dy = sc.mode === 'fly' ? -Math.sin(heading) * 0.85 : 0.12;

    if (sky) ctx.drawImage(sky, 0, 0, W, H); else { ctx.fillStyle = '#070814'; ctx.fillRect(0, 0, W, H); }
    drawStars(t, dt, dx, dy);

    let ox = 0, oy = 0;
    if (!reduced && t < shakeUntil) { const k = (shakeUntil - t) / 520, a = 9 * k * k; ox = rnd(-a, a); oy = rnd(-a, a); }
    ctx.save();
    ctx.translate(ox, oy);
    drawPlanet(L, s);
    drawGrid(L, X, Y, small);

    const r = view && view.round;
    const left = r && r.phase === 'betting' ? Math.max(0, r.betEnd - now()) : BET_MS;
    const ignite = sc.mode === 'pad' ? clamp(1 - left / 2200, 0, 1) : 0;
    const padA = sc.mode === 'pad' ? easeOut((t - padSince) / 450) : sc.mode === 'fly' ? 1 - clamp(sc.el / 1400, 0, 1) : 0;
    drawPad(padX, padY, s, padA, ignite, t);

    if (sc.mode !== 'pad') drawCurve(sc, L, X, Y, s, sc.mode === 'wreck');
    const hx = X(sc.el), hy = Y(sc.m);
    tip = { x: hx, y: hy };
    stepParts(dt);

    let rx = rest.x, ry = rest.y, thrust = 0, alpha = 1;
    if (sc.mode === 'fly') {
      const k = easeOut(sc.el / 900);
      rx = hx + (rest.x - hx) * (1 - k); ry = hy + (rest.y - hy) * (1 - k);
      thrust = 0.7 + 0.3 * Math.min(1, Math.log(sc.m) / 2);
      const bx = -Math.cos(heading), by = -Math.sin(heading);
      smokeAcc += dt * (reduced ? 0.03 : 0.07);
      while (smokeAcc >= 1) {
        smokeAcc -= 1;
        const v = rnd(40, 90) * s, n = rnd(-14, 14) * s;
        emit(0, rx + bx * 8 * rs, ry + by * 8 * rs, bx * v - by * n + dx * starV * 0.4, by * v + bx * n + dy * starV * 0.4, rnd(700, 1300), 2.5 * s, rnd(9, 17) * s, 0.2, '205,196,226', 1.2, -6);
      }
      sparkAcc += dt * (reduced ? 0.01 : 0.04);
      while (sparkAcc >= 1) {
        sparkAcc -= 1;
        const v = rnd(90, 190) * s, n = rnd(-40, 40) * s;
        emit(1, rx + bx * 10 * rs, ry + by * 10 * rs, bx * v - by * n, by * v + bx * n, rnd(220, 450), rnd(1, 2) * s, rnd(1, 2) * s, 1, Math.random() < 0.5 ? '255,214,90' : '255,140,60', 2, 0);
      }
    } else if (sc.mode === 'pad') {
      const k = easeOut((t - padSince) / 450);
      alpha = k; ry -= (1 - k) * 26 * s;
      thrust = ignite > 0 ? 0.15 + 0.45 * ignite : 0;
      if (!reduced && ignite > 0) { rx += rnd(-0.7, 0.7) * ignite; ry += rnd(-0.5, 0.5) * ignite; }
      puffAcc += dt * (ignite > 0 ? 0.008 + 0.05 * ignite : 0.0025) * (reduced ? 0.5 : 1);
      while (puffAcc >= 1) {
        puffAcc -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        emit(0, padX + side * rnd(4, 18) * s, padY - 6 * s, side * rnd(25, 80 + 90 * ignite) * s, rnd(-22, -4) * s, rnd(900, 1600), 4 * s, rnd(12, 22 + 12 * ignite) * s, 0.16 + 0.12 * ignite, '214,206,232', 1.6, -4);
      }
    }
    if (sc.mode === 'wreck' && wreck.boom) { wreck.boom = false; boom(hx, hy, s, t); }

    drawParts(0);
    if (sc.mode !== 'wreck') drawRocket(rx, ry, heading, rs, thrust, t, alpha);
    if (marks.size) drawMarks(t, sc, L, X, Y, small, blockers());
    drawParts(1);
    drawRings(t);
    if (sc.mode === 'fly') tip = { x: rx, y: ry };
    ctx.restore();

    /* the flash and a red edge while the wreck is on screen */
    const fk = (t - flashAt) / 460;
    if (fk >= 0 && fk < 1) {
      const a = (1 - fk) * (1 - fk) * (reduced ? 0.3 : 0.62);
      const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, Math.max(W, H) * 0.9);
      g.addColorStop(0, `rgba(255,240,215,${a.toFixed(3)})`); g.addColorStop(0.22, `rgba(255,140,90,${(a * 0.55).toFixed(3)})`); g.addColorStop(1, `rgba(255,60,90,${(a * 0.12).toFixed(3)})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (sc.mode === 'wreck') {
      const a = 0.22 * Math.min(1, (HOLD - (t - wreck.at)) / 500);
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, 'rgba(255,40,80,0)'); g.addColorStop(1, `rgba(255,40,80,${a.toFixed(3)})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }

  /* ---------- the text over the canvas ---------- */
  function setHTML(el, html, cls) {
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    if (cls != null && el.className !== cls) el.className = cls;
  }
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

  /** A little pop of the big number as it passes 2×, 5×, 10×, 20×… */
  function pulse(m, el) {
    let hit = 0;
    for (const p of PULSES) if (m >= p) hit = p;
    if (pulsed < 0) { pulsed = hit; return; }
    if (hit <= pulsed) return;
    pulsed = hit;
    if (reduced || !el.animate) return;
    el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.22)', offset: 0.3 }, { transform: 'scale(1)' }], { duration: 520, easing: 'cubic-bezier(.2,.9,.3,1)' });
    if (tip) rings.push({ x: tip.x, y: tip.y, at: performance.now(), dur: 750, r: 80, col: '234,200,55', w: 3 });
  }

  function paintMult() {
    const el = $('#cr-mult');
    const sub2 = $('#cr-sub');
    const bar = $('#cr-count');
    if (!el || !view) return;
    const r = view.round;
    const left = r.phase === 'betting' ? Math.max(0, (r.betEnd - now()) / 1000) : 0;
    const wait = left > 0 ? `Next round in ${left.toFixed(1)}s` : 'Launching…';
    if (bar) {
      bar.hidden = r.phase !== 'betting';
      bar.firstElementChild.style.transform = `scaleX(${clamp((left * 1000) / BET_MS, 0, 1).toFixed(4)})`;
    }
    if (wrecked()) {
      setHTML(el, `<small class="cr-tag">Crashed @</small><span>${fmtMult(wreck.crash)}</span>`, 'cr-big crashed');
      setText(sub2, r.phase === 'betting' ? wait : 'Crashed');
      return;
    }
    if (r.phase === 'betting') {
      setHTML(el, fmtMult(1), 'cr-big wait');
      setText(sub2, wait);
      return;
    }
    if (flight && flight.crashed) {
      setHTML(el, `<small class="cr-tag">Crashed @</small><span>${fmtMult(flight.crashed)}</span>`, 'cr-big crashed');
      setText(sub2, 'Crashed');
      return;
    }
    const m = multNow();
    setHTML(el, fmtMult(m), 'cr-big flying');
    pulse(m, el);
    const me = mine();
    setText(sub2, me && me.status === 'active' ? 'Cash out before it crashes'
      : me && me.status === 'settled' && me.payout > 0 ? `You cashed out at ${fmtMult(me.multiplier)}` : 'Flying');
  }

  function paintControls() {
    const btn = $('#cr-go');
    if (!btn || !view) return;
    const m = mine();
    const r = view.round;
    if (r.phase === 'playing' && m && m.status === 'active') {
      btn.className = 'gbtn green lg block cr-cash';
      btn.disabled = busy;
      btn.innerHTML = `Cash out ${GG.coin('sm')}${fmt((m.amount * multNow()) / 100)}`;
      btn.dataset.act = 'cash';
    } else if (bettingOpen() && !m) {
      btn.className = 'gbtn primary lg block';
      btn.disabled = busy;
      btn.innerHTML = `Bet ${GG.coin('sm')}${fmt(amount.get())}`;
      btn.dataset.act = 'bet';
    } else if (m && m.status === 'settled') {
      btn.className = 'gbtn ghost lg block';
      btn.disabled = true;
      btn.innerHTML = m.payout > 0 ? `Cashed out ${fmtMult(m.multiplier)}` : 'Crashed';
      btn.dataset.act = '';
    } else {
      btn.className = m ? 'gbtn ghost lg block' : 'gbtn primary lg block';
      btn.disabled = true;
      btn.innerHTML = m ? 'In this round' : (r.phase === 'playing' ? 'Round in progress' : 'Betting opens soon');
      btn.dataset.act = '';
    }
    $$('#cr-presets button').forEach((b) => { b.disabled = !bettingOpen() || !!m; });
    $('#cr-auto').disabled = !bettingOpen() || !!m;
  }

  function paintBets() {
    $('#cr-feed').innerHTML = GG.feedTable(bets.map((b) => ({
      who: b.username, color: b.avatar, side: b.auto ? 'auto' : '', sideLabel: b.auto ? `auto ${fmtMult(b.auto)}` : 'manual',
      amount: b.amount, payout: b.payout, mult: b.status === 'settled' ? b.multiplier : 0, mine: b.mine, status: b.status,
    })), ['player', 'side', 'bet', 'mult', 'payout'], 'No one is in this round yet.');
    $('#cr-history').innerHTML = history.slice(0, 14).map((x) => `<span class="cr-h ${x.result.crash >= 2 ? 'good' : 'bad'}" title="Round #${x.seq}">${fmtMult(x.result.crash)}</span>`).join('') || '<span class="cr-none">No rounds yet</span>';
    const pot = bets.reduce((a, b) => a + b.amount, 0);
    const pill = $('#cr-pot');
    if (pill) setHTML(pill, `<i class="fa-solid fa-user-group" aria-hidden="true"></i><b>${bets.length}</b> ${bets.length === 1 ? 'player' : 'players'}<span class="cr-dot"></span>${GG.coin('sm')}<b>${fmt(pot / 100)}</b>`);
  }

  function paint() {
    if (!view) return;
    paintMult();
    paintBets();
    paintControls();
  }

  let ticks = 0;
  function frame(t) {
    frameId = GG.frame(frame);
    draw(typeof t === 'number' ? t : performance.now());
    paintMult();
    if (++ticks % 12 === 0) paintControls(); // the cash out amount moves, but the buttons don't need every frame
  }

  /* ---------- the server's answers ---------- */

  /** Cash-outs in this flight become labels on the curve. Auto cash-outs are settled when the round ends, so
      they show once the server's own clock (its multiplier, which only exists while the rocket still flies)
      has passed them. */
  function collectMarks(r) {
    if (!flight || r.phase !== 'playing' || r.seq !== flight.seq) return;
    const at = performance.now();
    for (const b of bets) {
      if (marks.has(b.id)) continue;
      let mult = 0;
      if (b.status === 'settled' && b.payout > 0) mult = b.multiplier;
      else if (b.status === 'active' && b.auto && r.mult >= b.auto) mult = b.auto;
      if (mult >= 1) marks.set(b.id, { name: b.username || 'player', mult, t: Math.log(mult) / flight.rate, at, mine: b.mine });
    }
  }

  function onView(v) {
    const r = v.round;
    if (!r) return;
    lastSeq = r.seq;
    view = v;
    bets = v.bets;
    history = v.history;
    const last = v.history[0];
    if (r.phase === 'playing' && (!flight || flight.seq !== r.seq)) {
      flight = { seq: r.seq, playAt: r.playAt, rate: r.rate, crashed: null };
      marks.clear(); pulsed = -1; wreck = null;
    }
    if (flight && last && last.seq === flight.seq && !flight.crashed) {
      flight.crashed = last.result.crash;
      lastCrash = flight.crashed;
      GG.sfx('bomb');
      wreck = { seq: flight.seq, rate: flight.rate, crash: flight.crashed, tEnd: Math.log(flight.crashed) / flight.rate, at: performance.now(), boom: true };
    }
    if (last && !lastCrash) lastCrash = last.result.crash;
    if (r.phase === 'betting') flight = null; // the next rocket hasn't left yet
    collectMarks(r);
    paint();
  }

  /* ---------- actions ---------- */
  async function act() {
    if (busy || !view) return;
    const kind = $('#cr-go').dataset.act;
    if (!kind) return;
    busy = true;
    paintControls();
    const res = kind === 'cash'
      ? await GG.roundCashout()
      : await GG.roundBet('crash', amount.get(), { auto: auto || '' });
    busy = false;
    if (res && sub) sub.push(res);
    if (kind === 'bet' && res) GG.sfx('chip');
    paint();
  }

  function mount(panel, stage) {
    view = null; bets = []; lastSeq = null; flight = null; lastCrash = null; history = []; auto = 0; busy = false;
    wreck = null; marks = new Map(); parts = []; rings = []; axes = null; heading = null; lastT = 0; starV = 6;
    shownSeq = null; padSince = 0; pulsed = -1; flashAt = -1e9; shakeUntil = 0; tip = null;
    amount = GG.ui.amount();
    panel.appendChild(amount.el);
    panel.appendChild(h(`<div class="cr-auto">
      <div class="gfield-l">Auto cash out <em>optional</em></div>
      <div class="cr-auto-row">
        <input type="text" inputmode="decimal" id="cr-auto" placeholder="e.g. 2.00" maxlength="9" aria-label="Auto cash out">
        <div class="cr-presets" id="cr-presets">${PRESETS.map((p) => `<button type="button" data-v="${p}">${p}×</button>`).join('')}</div>
      </div>
    </div>`));
    panel.appendChild(h(`<div><button type="button" class="gbtn primary lg block" id="cr-go" data-act="">Bet</button></div>`));
    stage.appendChild(h(`<div class="cr-wrap">
      <div class="cr-top">
        <div class="cr-history" id="cr-history"></div>
      </div>
      <div class="cr-graph">
        <canvas id="cr-cv" role="img" aria-label="Crash rocket and multiplier curve"></canvas>
        <div class="cr-hud"><span class="cr-pill" id="cr-pot"></span></div>
        <div class="cr-read">
          <b id="cr-mult" class="cr-big wait">—</b>
          <span id="cr-sub">Connecting…</span>
          <div class="cr-count" id="cr-count" hidden><i></i></div>
        </div>
      </div>
      <div class="dbl-feed-head"><span>Everyone in this round</span></div>
      <div class="feed-wrap" id="cr-feed"></div>
    </div>`));
    cv = $('#cr-cv');
    size();
    ro = new ResizeObserver(size);
    ro.observe(cv.parentElement);
    $('#cr-go').addEventListener('click', () => { GG.sfx('click'); act(); });
    $('#cr-auto').addEventListener('input', (e) => {
      const clean = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
      if (clean !== e.target.value) e.target.value = clean;
      auto = round2(parseFloat(clean) || 0);
      $$('#cr-presets button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === auto));
    });
    $('#cr-presets').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const v = Number(b.dataset.v);
      auto = auto === v ? 0 : v;
      $('#cr-auto').value = auto ? auto.toFixed(2) : '';
      $$('#cr-presets button').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) === auto));
      GG.sfx('click');
    });
    amount.onChange(() => paintControls());
    // poll faster while the rocket flies, so the crash shows up within a few hundred ms of the server's crash point
    sub = follow('crash', onView, (v) => (v && v.round && v.round.phase === 'playing' ? 300 : 900));
    frameId = GG.frame(frame);
    GG.onLeave(() => {
      GG.unframe(frameId);
      if (ro) ro.disconnect();
      if (sub) sub.stop();
      sub = null; cv = null; ctx = null; ro = null; sky = null; parts = []; rings = []; marks = new Map();
    });
  }

  GG.registerGame({
    id: 'crash',
    name: 'Crash',
    rtp: '99.0',
    badge: 'HOT',
    colors: ['#7c5cff', '#170f3f'],
    icon: '<svg viewBox="0 0 24 24"><path d="M3 20c7.500 0 12-3.500 15.500-14" fill="none" stroke="currentColor" stroke-width="2.400" stroke-linecap="round"/><circle cx="19" cy="5" r="2.800" fill="currentColor"/></svg>',
    art: `<svg viewBox="0 0 200 200">
      <g fill="#fff"><circle cx="34" cy="40" r="3" opacity=".7"/><circle cx="78" cy="22" r="2" opacity=".5"/><circle cx="56" cy="92" r="2.500" opacity=".45"/><circle cx="112" cy="58" r="2" opacity=".6"/><circle cx="28" cy="120" r="2" opacity=".4"/></g>
      <path d="M16 172C92 170 138 144 166 70" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="16" stroke-linecap="round"/>
      <path d="M16 172C92 170 138 144 166 70" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/>
      <g transform="translate(160 62) rotate(24)">
        <path d="M-8 26Q0 62 8 26Z" fill="#eac837"/><path d="M-4 26Q0 46 4 26Z" fill="#ff6a3d"/>
        <path d="M-13 4L-30 30L-12 24ZM13 4L30 30L12 24Z" fill="#ff5c7a"/>
        <path d="M0-52C18-34 20-4 13 26L-13 26C-20-4-18-34 0-52Z" fill="#fff"/>
        <path d="M0-52C8-44 12-36 14-28L-14-28C-12-36-8-44 0-52Z" fill="#ff5c7a"/>
        <circle cx="0" cy="-8" r="8" fill="#4d8dff" stroke="#c9d6f5" stroke-width="3"/>
      </g>
    </svg>`,
    mount,
  });
})();
