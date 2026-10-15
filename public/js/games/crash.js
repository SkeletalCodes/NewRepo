/* Crash — one shared rocket after another. Betting is open for ten seconds: everyone who bets is in the
   same round. The rocket climbs; cash out before it crashes to take the multiplier. An auto cash-out
   takes the money at your number on its own. The crash point is decided by the server when the round opens. */
(function () {
  'use strict';
  const { $, $$, h, fmt, fmtMult, clamp, follow, round2 } = GG;

  const PRESETS = [1.5, 2, 5, 10];
  const PAD = { l: 44, r: 18, t: 22, b: 28 };

  let amount = null, sub = null, frameId = 0, view = null, bets = [], lastSeq = null;
  let flight = null, lastCrash = null, history = [], auto = 0, busy = false;
  let cv = null, ctx = null, W = 0, H = 0, ro = null;

  const now = () => (sub ? sub.now() : Date.now());
  const mine = () => bets.find((b) => b.mine) || null;
  const bettingOpen = () => !!(view && view.round.phase === 'betting' && sub && now() < view.round.betEnd);

  /** The multiplier on this device's clock, between the server's answers. Stops at the crash. */
  function multNow() {
    if (!flight) return 1;
    let el = Math.max(0, now() - flight.playAt);
    if (flight.crashed) el = Math.min(el, Math.log(flight.crashed) / flight.rate);
    return Math.max(1, Math.floor(Math.exp(flight.rate * el) * 100) / 100);
  }

  function size() {
    if (!cv) return;
    const box = cv.parentElement, dpr = Math.min(2, window.devicePixelRatio || 1);
    W = box.clientWidth; H = box.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    if (!ctx || !W) return;
    ctx.clearRect(0, 0, W, H);
    const top = H - PAD.b, plotH = H - PAD.t - PAD.b, plotW = W - PAD.l - PAD.r;
    const el = flight ? Math.max(0, now() - flight.playAt) : 0;
    const shown = flight && flight.crashed ? Math.min(el, Math.log(flight.crashed) / flight.rate) : el;
    const m = flight ? Math.exp(flight.rate * shown) : 1;
    const tMax = Math.max(8000, shown * 1.12), mMax = Math.max(2, m * 1.25);
    const X = (t) => PAD.l + (t / tMax) * plotW;
    const Y = (v) => top - ((v - 1) / (mMax - 1)) * plotH;
    ctx.font = '600 12px Inter, Arial, sans-serif';
    ctx.fillStyle = 'rgba(148,163,184,.7)';
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = 1;
    const step = mMax > 6 ? 2 : mMax > 3 ? 0.5 : 0.25;
    for (let v = 1; v <= mMax + 1e-9; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(`${v.toFixed(step < 1 ? 2 : 0)}×`, PAD.l - 8, y);
    }
    if (!flight) return;
    const col = flight.crashed ? '#ff5c7a' : '#14f195';
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const t = (shown * i) / 120, x = X(t), y = Y(Math.exp(flight.rate * t));
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    const hx = X(shown), hy = Y(m);
    ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = col;
    ctx.shadowColor = col; ctx.shadowBlur = 16; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.lineTo(hx, top); ctx.lineTo(PAD.l, top); ctx.closePath();
    const g = ctx.createLinearGradient(0, hy, 0, top);
    g.addColorStop(0, flight.crashed ? 'rgba(255,92,122,.26)' : 'rgba(20,241,149,.22)');
    g.addColorStop(1, 'rgba(20,241,149,0)');
    ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI * 2); ctx.fill();
  }

  function paintMult() {
    const el = $('#cr-mult');
    const sub2 = $('#cr-sub');
    if (!el || !view) return;
    const r = view.round;
    if (r.phase === 'betting') {
      const left = Math.max(0, (r.betEnd - now()) / 1000);
      el.textContent = `${left.toFixed(1)}s`;
      el.className = 'cr-big wait';
      sub2.textContent = lastCrash ? `Last crash ${fmtMult(lastCrash)}` : 'Place your bets';
      return;
    }
    if (flight && flight.crashed) {
      el.textContent = fmtMult(flight.crashed);
      el.className = 'cr-big crashed';
      sub2.textContent = 'Crashed';
      return;
    }
    el.textContent = fmtMult(multNow());
    el.className = 'cr-big flying';
    sub2.textContent = mine() && mine().status === 'active' ? 'Cash out before it crashes' : 'Flying';
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
  }

  function paint() {
    if (!view) return;
    paintMult();
    paintBets();
    paintControls();
  }

  let ticks = 0;
  function frame() {
    frameId = GG.frame(frame);
    draw();
    paintMult();
    if (++ticks % 12 === 0) paintControls(); // the cash out amount moves, but the buttons don't need every frame
  }

  /* ---------- the server's answers ---------- */
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
    }
    if (flight && last && last.seq === flight.seq && !flight.crashed) {
      flight.crashed = last.result.crash;
      lastCrash = flight.crashed;
      GG.sfx('bomb');
    }
    if (last && !lastCrash) lastCrash = last.result.crash;
    if (r.phase === 'betting') flight = null; // the next rocket hasn't left yet
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
        <canvas id="cr-cv"></canvas>
        <div class="cr-read"><b id="cr-mult" class="cr-big wait">—</b><span id="cr-sub">Connecting…</span></div>
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
    sub = follow('crash', onView);
    frameId = GG.frame(frame);
    GG.onLeave(() => {
      GG.unframe(frameId);
      if (ro) ro.disconnect();
      if (sub) sub.stop();
      sub = null; cv = null; ctx = null; ro = null;
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
