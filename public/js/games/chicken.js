/* Chicken — cross the road one lane at a time. Every lane you cross raises the multiplier; get hit by a car
   and the bet is gone. Each lane has the same chance of a hit, and where it happens is decided by the server
   when the round starts. Multiplier after k lanes = 0.98 / P(surviving k lanes). */
(function () {
  'use strict';
  const { $, $$, h, fmt, fmtMult, sleep } = GG;

  const LEVELS = {
    easy: { p: 0.04, lanes: 24, label: 'Easy' },
    medium: { p: 0.12, lanes: 20, label: 'Medium' },
    hard: { p: 0.2, lanes: 16, label: 'Hard' },
    daredevil: { p: 0.4, lanes: 10, label: 'Daredevil' },
  };
  const CAR_COLORS = ['#ff5c7a', '#4d8dff', '#eac837', '#14f195', '#c084fc', '#f97316', '#e5e9f2'];
  const CHICKEN = `<svg viewBox="0 0 64 64" aria-hidden="true">
    <ellipse cx="32" cy="58" rx="15" ry="3.500" fill="#000" opacity=".35"/>
    <path d="M24 50l-3 7M40 50l3 7M18 57h6M40 57h6" stroke="#f59e0b" stroke-width="3" stroke-linecap="round"/>
    <path d="M32 12c11 0 19 9 19 21 0 11-8 19-19 19S13 44 13 33c0-12 8-21 19-21z" fill="#fff"/>
    <path d="M45 30c6-2 10 2 9 7-4-1-7 0-9 2z" fill="#e8ebf2"/>
    <path d="M20 34c-4 2-5 8-2 11 3-3 7-4 10-4-2-3-4-5-8-7z" fill="#e3e6ee"/>
    <path d="M26 12c0-6 4-8 6-5 1-4 6-4 6 1 3-1 5 3 2 6z" fill="#ff5c7a"/>
    <circle cx="27" cy="25" r="2.600" fill="#151821"/><circle cx="37" cy="25" r="2.600" fill="#151821"/>
    <circle cx="27.800" cy="24.200" r=".9" fill="#fff"/><circle cx="37.800" cy="24.200" r=".9" fill="#fff"/>
    <path d="M28 30l4-3 4 3-4 4z" fill="#f59e0b"/><path d="M30 34c0 4 4 4 4 0z" fill="#ff5c7a"/>
  </svg>`;
  const car = (c) => `<svg viewBox="0 0 40 72" aria-hidden="true"><rect x="2" y="2" width="36" height="68" rx="10" fill="${c}"/><rect x="7" y="13" width="26" height="14" rx="4" fill="#0b0d14" opacity=".75"/><rect x="7" y="46" width="26" height="11" rx="4" fill="#0b0d14" opacity=".6"/><rect x="5" y="64" width="8" height="4" rx="2" fill="#fff6c4"/><rect x="27" y="64" width="8" height="4" rx="2" fill="#fff6c4"/></svg>`;

  let amount, diff = 'medium', state = 'idle', lane = 0, bet = 0, betId = 0, asking = false, alive = 0, traffic = 0, dead = false;

  const cfg = () => LEVELS[diff];
  const multFor = (k) => Math.floor((0.98 / Math.pow(1 - cfg().p, k)) * 100) / 100;

  function build() {
    const c = cfg();
    let lanes = '';
    for (let k = 1; k <= c.lanes; k++) lanes += `<div class="ch-lane" data-k="${k}"><span class="ch-tag">${fmtMult(multFor(k))}</span><i class="ch-car"></i></div>`;
    $('#ch-road').innerHTML = `<div class="ch-curb start"><span>START</span></div>${lanes}<div class="ch-curb end"><span>SAFE</span></div>
      <div class="ch-hen" id="ch-hen">${CHICKEN}</div>`;
    place(false);
  }

  /** Move the chicken to the current lane and keep it in view. */
  function place(hop) {
    const hen = $('#ch-hen'), road = $('#ch-road');
    if (!hen || !road) return;
    const target = lane === 0 ? $('.ch-curb.start') : $(`.ch-lane[data-k="${lane}"]`);
    const x = target.offsetLeft + target.offsetWidth / 2 - hen.offsetWidth / 2;
    hen.style.transform = `translateX(${x}px)`;
    if (hop) { hen.classList.remove('hop'); void hen.offsetWidth; hen.classList.add('hop'); }
    const box = $('#ch-scroll');
    const want = x - box.clientWidth / 2 + hen.offsetWidth;
    box.scrollTo({ left: Math.max(0, want), behavior: hop ? 'smooth' : 'auto' });
    $$('.ch-lane').forEach((l) => {
      const k = Number(l.dataset.k);
      l.classList.toggle('done', k <= lane);
      l.classList.toggle('next', state === 'playing' && k === lane + 1);
    });
  }

  /* cars pass in lanes you haven't reached, just for life */
  function drive() {
    clearInterval(traffic);
    traffic = setInterval(() => {
      if (GG.rand() < 0.35) return;
      const free = $$('.ch-lane').filter((l) => Number(l.dataset.k) > lane + 1 && !l.classList.contains('busy'));
      if (!free.length) return;
      const l = free[GG.randInt(free.length)];
      const el = $('.ch-car', l);
      el.innerHTML = car(CAR_COLORS[GG.randInt(CAR_COLORS.length)]);
      el.style.animationDuration = (0.9 + GG.rand() * 0.9).toFixed(2) + 's';
      l.classList.add('busy');
      setTimeout(() => l.classList.remove('busy'), 1900);
    }, 420);
  }

  function ui() {
    const playing = state === 'playing', c = cfg();
    amount.lock(playing);
    $$('#ch-diff button').forEach((b) => { b.disabled = playing; });
    const btn = $('#ch-btn'), cash = $('#ch-cash');
    btn.textContent = playing ? 'Go' : 'Bet';
    btn.disabled = asking;
    cash.hidden = !playing;
    cash.disabled = !lane || asking;
    cash.innerHTML = lane && !dead ? `Cash out ${GG.coin('sm')}${fmt(bet * multFor(lane))}` : 'Cash out';
    $('#ch-cur').textContent = dead ? 'Splat' : fmtMult(lane ? multFor(lane) : 1);
    $('#ch-next').textContent = lane < c.lanes ? fmtMult(multFor(lane + 1)) : '—';
    $('#ch-chance').textContent = ((1 - c.p) * 100).toFixed(0) + '%';
    $('#ch-lanes').textContent = `${lane} / ${c.lanes}`;
  }

  function won(res) {
    const mult = multFor(lane), payout = res.bet.payout / 100;
    GG.settle(res, { from: $('#ch-hen') });
    GG.sfx('cashout');
    state = 'idle';
    $('#ch-hen').classList.add('safe');
    const pop = $('#ch-res');
    pop.className = 'result-pop show';
    pop.innerHTML = `<b>${fmtMult(mult)}</b><span>${GG.coin('sm')}+${fmt(payout - bet)}</span>`;
    if (mult >= 10) GG.confetti($('.ch-wrap'), 70);
    ui();
  }

  async function cashout() {
    if (state !== 'playing' || !lane || asking) return;
    const my = alive;
    asking = true; ui();
    const res = await GG.act(betId, 'cashout');
    asking = false;
    if (my !== alive) return;
    if (!res) { ui(); return; }
    won(res);
  }

  async function go() {
    if (state !== 'playing' || asking) return;
    const my = alive;
    asking = true; ui();
    const res = await GG.act(betId, 'step');
    asking = false;
    if (my !== alive) return;
    if (!res) { ui(); return; }
    const v = res.bet.view;
    if (v.dead) {
      // hop out, then the car comes through
      const next = $(`.ch-lane[data-k="${lane + 1}"]`);
      lane++;
      place(true);
      GG.sfx('tick');
      await sleep(220);
      if (my !== alive) return;
      if (next) { const el = $('.ch-car', next); el.innerHTML = car('#ff5c7a'); next.classList.add('hit'); }
      await sleep(260);
      if (my !== alive) return;
      $('#ch-hen').classList.add('dead');
      GG.sfx('bomb');
      $('#ch-scroll').classList.add('shake');
      setTimeout(() => { const s = $('#ch-scroll'); if (s) s.classList.remove('shake'); }, 450);
      state = 'idle'; dead = true;
      GG.settle(res);
      const pop = $('#ch-res');
      pop.className = 'result-pop show bad';
      pop.innerHTML = `<b>Splat!</b><span>${GG.coin('sm')}-${fmt(bet)}</span>`;
      ui();
      return;
    }
    lane = v.lane;
    place(true);
    GG.sfx('gem', lane);
    if (res.bet.status === 'settled') won(res); else ui(); // made it all the way across
  }

  async function start() {
    if (state !== 'idle' || asking) return;
    bet = amount.get();
    const my = alive;
    asking = true;
    $('#ch-btn').disabled = true;
    const res = await GG.bet('chicken', bet, { difficulty: diff });
    asking = false;
    if (my !== alive) return;
    if (!res) { ui(); return; }
    betId = res.bet.id;
    lane = 0; dead = false;
    state = 'playing';
    $('#ch-res').className = 'result-pop';
    build();
    ui();
  }

  /** A crossing left halfway (reload, another tab): put the chicken back where it was. */
  async function resume() {
    const b = await GG.active('chicken');
    if (!b || state !== 'idle' || !$('#ch-btn')) return;
    betId = b.id; bet = b.amount / 100; diff = b.view.difficulty; lane = b.view.lane;
    GG.ui.setSeg($('#ch-diff'), diff);
    state = 'playing';
    build();
    ui();
    GG.toast('Your chicken is still out on the road.', 'info');
  }

  GG.registerGame({
    id: 'chicken',
    name: 'Chicken',
    rtp: '98.0',
    badge: 'NEW',
    cat: 'cashout',
    colors: ['#f59e0b', '#3a2604'],
    icon: '<svg viewBox="0 0 24 24"><path d="M12 4c4.400 0 7.500 3.400 7.500 8 0 4.300-3.100 7.500-7.500 7.500S4.500 16.300 4.500 12C4.500 7.400 7.600 4 12 4z" fill="currentColor"/><path d="M10 4.500c0-2.400 1.600-3 2.400-1.800.4-1.600 2.400-1.600 2.400.4" fill="none" stroke="currentColor" stroke-width="1.600" stroke-linecap="round"/><circle cx="10" cy="10" r="1.100" fill="#101218"/><circle cx="14" cy="10" r="1.100" fill="#101218"/><path d="M10.500 12.500l1.500-1 1.500 1-1.500 1.300z" fill="#101218"/></svg>',
    art: `<svg viewBox="0 0 200 200">
      <rect x="0" y="40" width="200" height="120" fill="#2a2d37"/>
      <path d="M66 40v120M133 40v120" stroke="#eac837" stroke-width="4" stroke-dasharray="14 12"/>
      <g transform="translate(138 52) rotate(4)">${car('#ff5c7a').replace('<svg viewBox="0 0 40 72" aria-hidden="true">', '<svg width="44" height="80" viewBox="0 0 40 72">')}</g>
      <g transform="translate(26 70)"><svg width="88" height="88" viewBox="0 0 64 64">${CHICKEN.replace(/<\/?svg[^>]*>/g, '')}</svg></g>
      <rect x="74" y="146" width="52" height="20" rx="10" fill="#14f195"/><text x="100" y="160" font-size="12" font-weight="800" text-anchor="middle" fill="#0b0d14" font-family="Inter,Arial,sans-serif">2.31×</text>
    </svg>`,

    mount(panel, stage) {
      state = 'idle'; lane = 0; asking = false; dead = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Difficulty</span>${GG.ui.seg('ch-diff', Object.keys(LEVELS).map((k) => [k, LEVELS[k].label]), diff)}</div>
        <div class="row2">
          <div class="gfield"><span class="gfield-l">Multiplier</span><div class="readout" id="ch-cur">1.00×</div></div>
          <div class="gfield"><span class="gfield-l">Next lane</span><div class="readout" id="ch-next">—</div></div>
        </div>
        <div class="row2">
          <div class="gfield"><span class="gfield-l">Lane is safe</span><div class="readout" id="ch-chance">—</div></div>
          <div class="gfield"><span class="gfield-l">Lanes</span><div class="readout" id="ch-lanes">0 / 20</div></div>
        </div>
        <button class="gbtn primary lg block" id="ch-btn">Bet</button>
        <button class="gbtn green lg block" id="ch-cash" style="margin-top:10px" hidden>Cash out</button>
        <p class="panel-note">Bet, then press Go to cross one lane at a time. Every lane raises the multiplier. Cash out before a car gets you. Easy lanes are safe 96% of the time, Daredevil lanes only 60%.</p>
      </div>`));
      stage.appendChild(h(`<div class="ch-wrap">
        <div class="ch-scroll" id="ch-scroll"><div class="ch-road" id="ch-road"></div></div>
        <div class="result-pop" id="ch-res"></div>
      </div>`));
      build();
      drive();
      GG.ui.bindSeg($('#ch-diff'), (v) => { if (state === 'playing') return; diff = v; lane = 0; dead = false; $('#ch-res').className = 'result-pop'; build(); ui(); });
      $('#ch-btn').addEventListener('click', () => (state === 'playing' ? go() : start()));
      $('#ch-cash').addEventListener('click', cashout);
      const onResize = () => place(false);
      window.addEventListener('resize', onResize);
      GG.onLeave(() => window.removeEventListener('resize', onResize));
      ui();
      resume();
    },

    unmount() {
      alive++;
      clearInterval(traffic);
      state = 'idle'; // a crossing in progress stays on the server
    },
  });
})();
