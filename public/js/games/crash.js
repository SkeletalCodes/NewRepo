/* Crash — multiplier climbs until it busts. P(crash >= x) = 0.99 / x. */
(function () {
  'use strict';
  const { $, h, fmt, round2 } = GG;

  const RATE = 0.00009; // multiplier = e^(RATE * ms)
  let amount, cv, ctx, W = 0, H = 0, ro = null, raf = 0, endTimer = 0;
  let state = 'idle', t0 = 0, crashAt = 0, bet = 0, cashed = 0, auto = 0, betId = 0, pollTimer = 0, alive = 0, asking = false, final = null;
  const history = [];

  const RISK = [['1.5', 'Low'], ['2', 'Medium'], ['5', 'High'], ['20', 'Extreme']]; // auto cash-out presets
  function paintRisk() {
    const el = $('#cr-auto'), a = parseFloat(el.value), ok = isFinite(a) && a >= 1.01;
    GG.ui.setSeg($('#cr-risk'), ok ? String(a) : '');
    $('#cr-odds').innerHTML = ok ? `Reaches <b>${a.toFixed(2)}×</b> about <b>${Math.min(99, 99 / a).toFixed(1)}%</b> of the time` : 'No auto cash out — you decide when to bail';
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
  }

  function draw(el, m, dead) {
    if (!ctx) return;
    const c = ctx, pl = 54, pr = 26, pt = 26, pb = 34;
    c.clearRect(0, 0, W, H);
    const tMax = Math.max(8000, el * 1.12), mMax = Math.max(2, 1 + (m - 1) * 1.3);
    const X = (t) => pl + (t / tMax) * (W - pl - pr);
    const Y = (v) => H - pb - ((v - 1) / (mMax - 1)) * (H - pt - pb);

    c.font = '600 12px Outfit, Arial, sans-serif';
    c.fillStyle = '#5a6174'; c.strokeStyle = 'rgba(255,255,255,.055)'; c.lineWidth = 1;
    c.textAlign = 'right'; c.textBaseline = 'middle';
    const ms = niceStep((mMax - 1) / 4);
    for (let v = 1; v <= mMax + 1e-9; v += ms) {
      const y = Math.round(Y(v)) + .5;
      c.beginPath(); c.moveTo(pl, y); c.lineTo(W - pr, y); c.stroke();
      c.fillText(v.toFixed(ms < 1 ? 1 : 0) + '×', pl - 10, y);
    }
    c.textAlign = 'center'; c.textBaseline = 'top';
    const ts = niceStep(tMax / 1000 / 5);
    for (let s = 0; s <= tMax / 1000 + 1e-9; s += ts) c.fillText(Math.round(s) + 's', X(s * 1000), H - pb + 10);

    const col = dead ? '#ff5c7a' : cashed ? '#14f195' : '#eac837';
    const N = 90;
    c.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = (el * i) / N, x = X(t), y = Y(Math.exp(RATE * t));
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
    const hx = X(el), hy = Y(m);
    c.lineWidth = 4; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = col;
    c.shadowColor = col; c.shadowBlur = 18; c.stroke(); c.shadowBlur = 0;
    c.lineTo(hx, Y(1)); c.lineTo(X(0), Y(1)); c.closePath();
    const g = c.createLinearGradient(0, hy, 0, Y(1));
    g.addColorStop(0, dead ? 'rgba(255,77,103,.28)' : cashed ? 'rgba(47,224,138,.25)' : 'rgba(255,201,60,.3)');
    g.addColorStop(1, 'rgba(255,201,60,0)');
    c.fillStyle = g; c.fill();

    if (el > 0) {
      const tp = Math.max(0, el - 120);
      const ang = Math.atan2(hy - Y(Math.exp(RATE * tp)), hx - X(tp));
      c.save();
      c.translate(hx, hy);
      if (dead) {
        c.font = '30px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('💥', 0, 0);
      } else {
        c.rotate(ang + Math.PI / 4);
        c.font = '30px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('🚀', 0, 0);
      }
      c.restore();
    } else {
      c.fillStyle = col; c.beginPath(); c.arc(hx, hy, 6, 0, 7); c.fill();
    }
  }

  function size() {
    if (!cv) return;
    const box = cv.parentElement, dpr = Math.min(2, window.devicePixelRatio || 1);
    W = box.clientWidth; H = box.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state === 'idle') draw(0, 1, false);
    else if (state === 'crashed' && crashAt) draw(Math.log(crashAt) / RATE, crashAt, true);
  }

  function paintHistory() {
    $('#cr-hist').innerHTML = history.slice(0, 14).map((v) => `<span class="hp ${v >= 2 ? 'good' : 'bad'}">${v.toFixed(2)}×</span>`).join('') || '<span class="hp">No rounds yet</span>';
  }

  function ui() {
    const btn = $('#cr-btn');
    amount.lock(state === 'running');
    $('#cr-auto').disabled = state === 'running';
    GG.$$('#cr-risk button').forEach((b) => { b.disabled = state === 'running'; });
    if (state === 'idle') { btn.className = 'gbtn primary lg block'; btn.disabled = false; btn.textContent = 'Bet'; }
    else if (state === 'running' && !cashed) { btn.className = 'gbtn green lg block'; btn.disabled = asking; if (btn.textContent === 'Bet') btn.textContent = 'Cash out'; }
    else if (state === 'running') { btn.className = 'gbtn ghost lg block'; btn.disabled = true; btn.textContent = 'Cashed out'; }
    else { btn.className = 'gbtn ghost lg block'; btn.disabled = true; btn.textContent = 'Next round…'; }
  }

  /** The server says the round is over: either we cashed out (and the rocket flies on to its crash point) or it crashed. */
  function over(res) {
    if (final) return;
    final = res;
    clearInterval(pollTimer);
    const v = res.bet.view;
    crashAt = v.crashedAt;
    if (v.cashedAt > 0) {
      cashed = v.cashedAt;
      const payout = res.bet.payout / 100;
      GG.settle(res, { from: $('#cr-read') });
      GG.sfx('cashout');
      $('#cr-sub').innerHTML = `Cashed out at <b>${cashed.toFixed(2)}×</b> · +${fmt(payout - bet)}`;
      $('#cr-read').className = 'cr-read won';
    }
    ui();
  }

  async function poll() {
    if (state !== 'running' || asking || final) return;
    const my = alive;
    try {
      const res = await window.GR.api(`/games/bets/${betId}/action`, { body: { action: 'poll' } });
      if (my !== alive) return;
      window.GR.state.user = res.user;
      if (res.bet.status === 'settled') over(res);
    } catch { /* try again next tick */ }
  }

  function bust() {
    state = 'crashed';
    clearInterval(pollTimer);
    history.unshift(crashAt);
    paintHistory();
    if (!cashed) { if (final) GG.settle(final); $('#cr-sub').textContent = 'Crashed — bet lost'; }
    GG.sfx('bomb');
    $('#cr-mult').textContent = crashAt.toFixed(2) + '×';
    $('#cr-read').className = 'cr-read ' + (cashed ? 'won dead' : 'dead');
    ui();
    endTimer = setTimeout(() => { state = 'idle'; ui(); }, 1700);
  }

  function tick(now) {
    const el = now - t0;
    let m = Math.exp(RATE * el);
    if (crashAt && m >= crashAt) { draw(Math.log(crashAt) / RATE, crashAt, true); bust(); return; }
    draw(el, m, false);
    $('#cr-mult').textContent = m.toFixed(2) + '×';
    if (!cashed) $('#cr-btn').innerHTML = `Cash out ${GG.coin('sm')}${fmt(bet * m)}`;
    raf = GG.frame(tick);
  }

  /** Start the rocket from where the server's clock says the round is. */
  function launch(v, sent) {
    const lag = Math.max(0, (performance.now() - sent) / 2);
    t0 = performance.now() - (v.server_now - v.started_at) - lag;
    state = 'running'; cashed = 0; crashAt = 0; final = null; auto = v.auto || 0;
    GG.sfx('launch');
    $('#cr-read').className = 'cr-read live';
    $('#cr-sub').textContent = auto ? `Auto cash out at ${auto.toFixed(2)}×` : 'Cash out before it crashes';
    ui();
    GG.unframe(raf);
    raf = GG.frame(tick);
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 350);
  }

  async function press() {
    if (state === 'running') {
      if (cashed || final || asking) return;
      const my = alive;
      asking = true; ui();
      const res = await GG.act(betId, 'cashout');
      asking = false;
      if (my !== alive) return;
      if (res && res.bet.status === 'settled') over(res); else ui();
      return;
    }
    if (state !== 'idle' || asking) return;
    const raw = $('#cr-auto').value.trim(), a = parseFloat(raw);
    if (raw && !(isFinite(a) && a >= 1.01)) { GG.toast('Auto cash out must be 1.01× or higher.', 'error'); $('#cr-auto').focus(); return; }
    bet = amount.get();
    const my = alive;
    asking = true;
    $('#cr-btn').disabled = true;
    const sent = performance.now();
    const res = await GG.bet('crash', bet, { auto: raw ? round2(a) : '' });
    asking = false;
    if (my !== alive) return;
    if (!res) { ui(); return; }
    betId = res.bet.id;
    launch(res.bet.view, sent);
  }

  /** A round still flying (reload, another tab): rejoin it. */
  async function resume() {
    const sent = performance.now();
    const b = await GG.active('crash');
    if (!b || state !== 'idle' || !$('#cr-btn')) return;
    betId = b.id; bet = b.amount / 100;
    launch(b.view, sent);
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

    mount(panel, stage) {
      state = 'idle'; cashed = 0; crashAt = 0; final = null; asking = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Risk <em style="font-style:normal;color:var(--dim)">sets auto cash out</em></span>${GG.ui.seg('cr-risk', RISK, '')}</div>
        <label class="gfield"><span class="gfield-l">Auto cash out <em style="font-style:normal;color:var(--dim)">optional</em></span>
          <input type="text" inputmode="decimal" id="cr-auto" placeholder="e.g. 2.00" maxlength="9"></label>
        <p class="risk-note" id="cr-odds"></p>
        <button class="gbtn primary lg block" id="cr-btn">Bet</button>
        <p class="panel-note">Bet, then cash out before the rocket blows. The longer you wait, the bigger the multiplier — and the risk.</p>
      </div>`));
      stage.appendChild(h(`<div class="cr-wrap">
        <div class="cr-top"><div class="history" id="cr-hist"></div></div>
        <div class="cr-graph">
          <canvas id="cr-cv"></canvas>
          <div class="cr-read" id="cr-read"><b id="cr-mult">1.00×</b><span id="cr-sub">Place a bet to launch</span></div>
        </div>
      </div>`));
      cv = $('#cr-cv');
      $('#cr-btn').addEventListener('click', press);
      // presets fill the auto cash-out box; tapping the active one clears it again
      $('#cr-risk').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || b.disabled) return;
        const el = $('#cr-auto');
        el.value = parseFloat(el.value) === Number(b.dataset.v) ? '' : Number(b.dataset.v).toFixed(2);
        GG.sfx('click');
        paintRisk();
      });
      $('#cr-auto').addEventListener('input', (e) => {
        const clean = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
        if (clean !== e.target.value) e.target.value = clean;
        paintRisk();
      });
      paintRisk();
      paintHistory(); ui(); size();
      ro = new ResizeObserver(size);
      ro.observe(cv.parentElement);
      resume();
    },

    unmount() {
      alive++;
      GG.unframe(raf); clearTimeout(endTimer); clearInterval(pollTimer);
      if (ro) ro.disconnect();
      // a round in the air keeps going on the server (auto cash out still applies); it settles by itself
      state = 'idle'; cv = null; ctx = null; ro = null;
    },
  });
})();
