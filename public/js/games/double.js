/* Double — one shared round after another. Betting is open for ten seconds: anyone can put money on red,
   black or green, as many times as they like. Then the wheel spins and every bet settles together.
   The server decides the colour when the round opens; the wheel only shows what was decided. */
(function () {
  'use strict';
  const { $, $$, h, fmt, esc, clamp, follow } = GG;

  const ORDER = [1, 14, 2, 13, 3, 12, 4, 0, 11, 5, 10, 6, 9, 7, 8]; // the wheel, in the order the strip shows it
  const CYCLE = ORDER.length, CYCLES = 12, TILE = 54, GAP = 8;
  const SPEED = 0.0135; // tiles per millisecond while the wheel turns
  const EASE_MS = 2600;
  const SIDES = { red: { label: 'Red', pays: 2 }, black: { label: 'Black', pays: 2 }, green: { label: 'Green', pays: 14 } };
  const colorOf = (n) => (n === 0 ? 'green' : n <= 7 ? 'red' : 'black');

  let amount = null, sub = null, frameId = 0;
  let view = null, bets = [], lastBets = [], lastSeq = null;
  let pos = CYCLE * 3, spinning = false, spinSeq = null, easing = false, easeFrom = 0, easeTo = 0, easeT0 = 0, lastT = 0;
  let shownResult = null, reveal = null;
  const history = [];
  const locked = { red: false, black: false, green: false }; // a short lock per button: a double-click is one bet

  /* Betting is open while the round says so and the clock hasn't run out. */
  const bettingOpen = () => !!(view && view.round.phase === 'betting' && sub && sub.now() < view.round.betEnd);

  function buildStrip() {
    let html = '';
    for (let i = 0; i < CYCLE * CYCLES; i++) {
      const n = ORDER[i % CYCLE];
      html += `<div class="db-tile ${colorOf(n)}">${n}</div>`;
    }
    $('#db-strip').innerHTML = html;
  }

  /** Put the strip so that tile position `p` sits under the marker. */
  function place() {
    const el = $('#db-strip'), win = $('.db-window');
    if (!el || !win) return;
    const x = win.clientWidth / 2 - (pos * (TILE + GAP) + TILE / 2);
    el.style.transform = `translate3d(${x}px, 0, 0)`;
  }

  /** The strip position that shows `n`, a few laps ahead of where the wheel is now. */
  const targetFor = (n) => (Math.floor(pos / CYCLE) + 3) * CYCLE + ORDER.indexOf(n);

  function startSpin(seq) {
    spinning = true;
    spinSeq = seq;
    easing = false;
    lastBets = bets.slice(); // the bets this spin decides
    $('#db-res').className = 'result-pop';
    $('.db-window').classList.remove('won', 'lost');
    GG.sfx('spin');
  }

  function stopSpin(result) {
    spinning = false;
    easeFrom = pos;
    easeTo = targetFor(result.n);
    easeT0 = performance.now();
    easing = true;
    shownResult = result;
  }

  /** The wheel has stopped: say what happened to the bets that were on this round. */
  function showResult(result) {
    const mine = lastBets.filter((b) => b.mine);
    const pop = $('#db-res');
    const name = SIDES[result.color] ? SIDES[result.color].label : '';
    if (!mine.length) {
      pop.className = 'result-pop show push';
      pop.innerHTML = `<b class="${result.color}">${name} ${result.n}</b><span>${lastBets.length ? `${lastBets.length} bets settled` : 'No bets this round'}</span>`;
      return;
    }
    const staked = mine.reduce((a, b) => a + b.amount, 0);
    const back = mine.reduce((a, b) => a + (b.side === result.color ? b.amount * SIDES[b.side].pays : 0), 0);
    const net = (back - staked) / 100;
    pop.className = 'result-pop show ' + (net >= 0 ? '' : 'bad');
    pop.innerHTML = `<b class="${result.color}">${name} ${result.n}</b><span>${GG.coin('sm')}${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</span>`;
    $('.db-window').classList.add(net >= 0 ? 'won' : 'lost');
    GG.sfx(net > 0 ? 'win' : net < 0 ? 'lose' : 'push');
    if (back >= 100000) GG.confetti($('.dbl-wrap'), 70);
  }

  function frame(t) {
    frameId = GG.frame(frame);
    const dt = Math.min(64, t - lastT);
    lastT = t;
    if (spinning) {
      pos += dt * SPEED;
      if (pos >= CYCLE * (CYCLES / 2)) pos -= CYCLE * 3; // the same picture three laps earlier
    } else if (easing) {
      const k = clamp((performance.now() - easeT0) / EASE_MS, 0, 1);
      pos = easeFrom + (easeTo - easeFrom) * (1 - Math.pow(1 - k, 3));
      if (k >= 1) { easing = false; GG.sfx('tick'); showResult(shownResult); }
    }
    place();
    paintClock();
  }

  /* ---------- painting ---------- */
  function totals() {
    const t = { red: { n: 0, sum: 0, mine: 0 }, black: { n: 0, sum: 0, mine: 0 }, green: { n: 0, sum: 0, mine: 0 } };
    for (const b of bets) {
      if (!t[b.side]) continue;
      t[b.side].n++;
      t[b.side].sum += b.amount;
      if (b.mine) t[b.side].mine += b.amount;
    }
    return t;
  }

  function paintClock() {
    const el = $('#db-clock');
    if (!el || !view) return;
    const r = view.round;
    if (r.phase === 'betting' && sub) {
      const left = Math.max(0, (r.betEnd - sub.now()) / 1000);
      el.textContent = `${left.toFixed(1)}s`;
      $('#db-bar').style.transform = `scaleX(${clamp(left / 10, 0, 1)})`;
      if (left <= 0) paintButtons();
    } else {
      el.textContent = spinning || easing ? 'Spinning' : '—';
      $('#db-bar').style.transform = 'scaleX(0)';
    }
  }

  function paintButtons() {
    const open = bettingOpen();
    for (const side of Object.keys(SIDES)) {
      const b = $(`#db-bet-${side}`);
      if (b) b.disabled = !open || locked[side];
    }
  }

  function paint() {
    if (!view) return;
    const r = view.round;
    $('#db-round').textContent = `Round #${r.seq}`;
    $('#db-phase').textContent = bettingOpen() ? 'Place your bets' : spinning || easing ? 'No more bets' : r.phase === 'betting' ? 'Opening…' : 'Spinning…';
    const t = totals();
    for (const side of Object.keys(SIDES)) {
      $(`#db-tot-${side}`).innerHTML = `${GG.coin('sm')}${fmt(t[side].sum / 100)}<small>${t[side].n} bet${t[side].n === 1 ? '' : 's'}</small>${t[side].mine ? `<em>you ${fmt(t[side].mine / 100)}</em>` : ''}`;
    }
    $('#db-feed').innerHTML = GG.feedTable(bets.map((b) => ({
      who: b.username, color: b.avatar, side: b.side, sideLabel: SIDES[b.side] ? SIDES[b.side].label : b.side,
      amount: b.amount, payout: 0, mult: 0, mine: b.mine, status: 'active',
    })), ['player', 'side', 'bet'], 'No bets yet. Be the first.');
    $('#db-history').innerHTML = history.slice(0, 14).map((x) => `<span class="db-h ${colorOf(x.n)}" title="Round #${x.seq}">${x.n}</span>`).join('') || '<span class="db-none">No rounds yet</span>';
    paintButtons();
  }

  /* ---------- the server's answers ---------- */
  function onView(v) {
    const r = v.round;
    if (!r) return;
    if (lastSeq !== null && r.seq !== lastSeq) lastBets = bets.slice();
    lastSeq = r.seq;
    view = v;
    bets = v.bets;
    for (const x of v.history) {
      if (!history.some((y) => y.seq === x.seq)) history.push({ seq: x.seq, n: x.result.n, color: x.result.color });
    }
    history.sort((a, b) => b.seq - a.seq);
    if (r.phase === 'playing' && spinSeq !== r.seq) startSpin(r.seq);
    const last = v.history[0];
    if (spinning && last && last.seq === spinSeq) stopSpin(last.result);
    if (!spinning && !easing && shownResult === null && last) {
      shownResult = last.result;
      pos = targetFor(last.result.n) - CYCLE * 2; // show the last result without spinning
    }
    paint();
  }

  /* ---------- betting ---------- */
  async function betOn(side) {
    if (!bettingOpen() || locked[side]) return;
    locked[side] = true;
    paintButtons();
    setTimeout(() => { locked[side] = false; paintButtons(); }, 220);
    const res = await GG.roundBet('double', amount.get(), { side });
    if (res && sub) sub.push(res);
    paint();
  }

  function mount(panel, stage) {
    view = null; bets = []; lastBets = []; lastSeq = null; pos = CYCLE * 3; spinning = false; spinSeq = null; easing = false;
    shownResult = null; reveal = null;
    amount = GG.ui.amount();
    panel.appendChild(amount.el);
    panel.appendChild(h(`<div class="dbl-bets">
      ${Object.keys(SIDES).map((side) => `<button type="button" class="dbl-bet ${side}" id="db-bet-${side}" data-side="${side}" disabled>
        <b>${SIDES[side].label}</b><small>pays ${SIDES[side].pays}×</small>
        <span class="dbl-bet-tot" id="db-tot-${side}">${GG.coin('sm')}0.00</span></button>`).join('')}
    </div>`));
    stage.appendChild(h(`<div class="dbl-wrap">
      <div class="dbl-top">
        <div class="dbl-round"><span id="db-round">Round</span><b id="db-phase">Connecting…</b></div>
        <div class="dbl-clock"><span id="db-clock">—</span></div>
      </div>
      <div class="dbl-bar"><i id="db-bar"></i></div>
      <div class="db-window dbl-window"><div class="db-marker"></div><div class="db-strip" id="db-strip"></div></div>
      <div class="dbl-history" id="db-history"></div>
      <div class="dbl-res-anchor"><div class="result-pop" id="db-res"></div></div>
      <div class="dbl-feed-head"><span>Bets this round</span></div>
      <div class="feed-wrap" id="db-feed"></div>
    </div>`));
    buildStrip();
    $$('.dbl-bet').forEach((b) => b.addEventListener('click', () => { GG.sfx('click'); betOn(b.dataset.side); }));
    sub = follow('double', onView);
    lastT = performance.now();
    frameId = GG.frame(frame);
    GG.onLeave(() => { GG.unframe(frameId); if (sub) sub.stop(); sub = null; });
  }

  GG.registerGame({
    id: 'double',
    name: 'Double',
    rtp: '93.3',
    colors: ['#ef4444', '#3f0d0d'],
    icon: '<svg viewBox="0 0 24 24"><rect x="2.500" y="7" width="8" height="10" rx="2" fill="currentColor" opacity=".5"/><rect x="13.500" y="7" width="8" height="10" rx="2" fill="currentColor"/><path d="M12 2.500v4M12 17.500v4" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/></svg>',
    art: `<svg viewBox="0 0 200 200">
      <rect x="-8" y="62" width="62" height="84" rx="14" fill="#191c26" stroke="rgba(255,255,255,.18)" stroke-width="2"/>
      <rect x="64" y="50" width="72" height="108" rx="16" fill="#1fae6a" stroke="#fff" stroke-width="4"/>
      <rect x="146" y="62" width="62" height="84" rx="14" fill="#d02c47" stroke="rgba(255,255,255,.18)" stroke-width="2"/>
      <text x="100" y="117" font-size="34" font-weight="800" text-anchor="middle" fill="#fff" font-family="Fredoka One,Inter,Arial,sans-serif">14×</text>
      <text x="22" y="114" font-size="24" font-weight="800" text-anchor="middle" fill="#8c94a8" font-family="Fredoka One,Inter,Arial,sans-serif">2×</text>
      <text x="178" y="114" font-size="24" font-weight="800" text-anchor="middle" fill="#fff" font-family="Fredoka One,Inter,Arial,sans-serif">2×</text>
      <path d="M100 44l-13-22h26z" fill="#eac837" stroke="#3f0d0d" stroke-width="3" stroke-linejoin="round"/>
      <path d="M100 164l-13 22h26z" fill="#eac837" stroke="#3f0d0d" stroke-width="3" stroke-linejoin="round"/>
    </svg>`,
    mount,
  });
})();
