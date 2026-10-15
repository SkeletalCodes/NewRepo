/* Double: one shared round after another, laid out like the roulette on Duelbits. Betting is open for ten
   seconds and anyone can bet on red, green or black, as often as they like; every bet shows in the three
   columns. Then the reel rolls and every bet settles together. The server picks the number when the round
   opens and only sends it once betting has closed, so the reel can roll straight to it. */
(function () {
  'use strict';
  const { $, $$, h, fmt, esc, clamp, follow } = GG;

  const ORDER = [1, 14, 2, 13, 3, 12, 4, 0, 11, 5, 10, 6, 9, 7, 8]; // the reel, tile by tile
  const CYCLE = ORDER.length, CYCLES = 24;
  const SIDES = { red: { label: 'Red', pays: 2 }, green: { label: 'Green', pays: 14 }, black: { label: 'Black', pays: 2 } };
  const COLS = ['red', 'green', 'black'];
  const QUICK = [['clear', 'Clear'], ['1', '+1'], ['10', '+10'], ['100', '+100']];
  const SHOW_MS = 2800; // how long a result stays up before the next countdown takes over
  const colorOf = (n) => (n === 0 ? 'green' : n <= 7 ? 'red' : 'black');

  let amount = null, sub = null, frameId = 0, resizeObs = null;
  let view = null, bets = [], stats = null, parked = false;
  let pos = CYCLE * 2, stepPx = 88, tileW = 80, reelW = 600;
  let roll = null, snap = null, rolledSeq = null, rollBets = [], landed = null, lastTile = -1, lastTick = 0, hitEl = null, closedPainted = false;
  const history = [];
  const locked = { red: false, green: false, black: false }; // a short lock per button: a double-click is one bet

  const bettingOpen = () => !!(view && view.round && view.round.phase === 'betting' && sub && sub.now() < view.round.betEnd);
  const showingResult = () => !!(landed && performance.now() - landed.at < SHOW_MS);

  /* ---------- the reel ---------- */
  function buildStrip() {
    let html = '';
    for (let i = 0; i < CYCLE * CYCLES; i++) {
      const n = ORDER[i % CYCLE];
      html += `<div class="dx-tile ${colorOf(n)}">${n === 0 ? GG.coin() : `<b>${n}</b>`}</div>`;
    }
    $('#db-strip').innerHTML = html;
  }

  /** Tile size and spacing come from the CSS (smaller on phones), so they are read from the layout. */
  function measure() {
    const strip = $('#db-strip'), reel = $('.dx-reel');
    if (!strip || !reel || strip.children.length < 2) return;
    tileW = strip.children[0].offsetWidth;
    stepPx = strip.children[1].offsetLeft - strip.children[0].offsetLeft;
    reelW = reel.clientWidth;
  }

  /** Put the strip so that tile position `pos` sits under the marker. */
  function place() {
    const el = $('#db-strip');
    if (el) el.style.transform = `translate3d(${(reelW / 2 - (pos * stepPx + tileW / 2)).toFixed(1)}px, 0, 0)`;
  }

  /** The same picture, nearer the start of the strip. */
  const rewind = () => { pos = CYCLE * 2 + (((pos % CYCLE) + CYCLE) % CYCLE); };
  const clearHit = () => { if (hitEl) hitEl.classList.remove('hit'); hitEl = null; };

  /** Roll to the round's number so the reel stops when the round ends. Joining late rolls a shorter way. */
  function startRoll(r) {
    rolledSeq = r.seq;
    rollBets = bets.slice();
    landed = null;
    snap = null;
    clearHit();
    rewind();
    const left = r.endAt - sub.now();
    const laps = Math.max(1, Math.round(left / 1200));
    const target = CYCLE * (2 + laps) + ORDER.indexOf(r.result.n) + (Math.random() - 0.5) * 0.7;
    if (left < 350) { pos = target; land(r); return; }
    roll = { from: pos, to: target, t0: performance.now(), ms: left, r };
    $('.dx-reel').classList.add('rolling');
    GG.sfx('spin');
    paintColumns();
  }

  /** What the rolled round did for this player's own bets. */
  function myOutcome() {
    const mine = rollBets.filter((b) => b.mine);
    if (!mine.length || !landed) return null;
    const staked = mine.reduce((a, b) => a + b.amount, 0);
    const back = mine.reduce((a, b) => a + (b.side === landed.color ? b.amount * SIDES[b.side].pays : 0), 0);
    return (back - staked) / 100;
  }

  /** The reel has stopped on the round's number. */
  function land(r) {
    roll = null;
    snap = { from: pos, to: Math.round(pos), t0: performance.now() };
    $('.dx-reel').classList.remove('rolling');
    landed = { seq: r.seq, n: r.result.n, color: r.result.color, at: performance.now() };
    hitEl = $('#db-strip').children[Math.round(pos)] || null;
    if (hitEl) hitEl.classList.add('hit');
    if (!history.some((x) => x.seq === r.seq)) history.unshift({ seq: r.seq, n: r.result.n, color: r.result.color });
    const net = myOutcome();
    GG.sfx(net === null ? 'tick' : net > 0 ? 'win' : net < 0 ? 'lose' : 'push');
    if (net !== null && net * 100 >= 100000) GG.confetti($('.dx-reel'), 70);
    paintTop();
    paintColumns();
    paintResult();
    setTimeout(() => { if ($('.dx')) { paintColumns(); paintResult(); } }, SHOW_MS + 50);
  }

  function frame() {
    frameId = GG.frame(frame);
    if (roll) {
      const k = clamp((performance.now() - roll.t0) / roll.ms, 0, 1);
      pos = roll.from + (roll.to - roll.from) * (1 - Math.pow(1 - k, 4));
      const tile = Math.floor(pos + 0.5);
      if (tile !== lastTile) {
        lastTile = tile;
        const now = performance.now();
        if (now - lastTick > 45) { lastTick = now; GG.sfx('tick', 0.4); }
      }
      if (k >= 1) land(roll.r);
    } else if (snap) {
      const k = clamp((performance.now() - snap.t0) / 380, 0, 1);
      pos = snap.from + (snap.to - snap.from) * (1 - Math.pow(1 - k, 3));
      if (k >= 1) snap = null;
    }
    place();
    paintClock();
  }

  /* ---------- painting ---------- */
  function paintClock() {
    if (!view || !view.round || !sub) return;
    const r = view.round, st = $('#dx-status');
    if (!st) return;
    const betting = r.phase === 'betting';
    const left = betting ? Math.max(0, (r.betEnd - sub.now()) / 1000) : 0;
    $('#db-bar').style.transform = `scaleX(${clamp(left / 10, 0, 1)})`;
    const counting = betting && !roll && !showingResult();
    st.classList.toggle('on', counting);
    if (counting) $('#db-clock').textContent = left.toFixed(2);
    // the buttons close the moment the clock runs out, without waiting for the next answer
    if (betting && left <= 0 && !closedPainted) { closedPainted = true; paintButtons(); }
    if (betting && left > 0) closedPainted = false;
  }

  function paintTop() {
    const prev = $('#dx-prev');
    if (prev) {
      prev.innerHTML = history.slice(0, 10).map((x) => `<i class="dx-dot ${x.color}" title="Round #${x.seq}">${x.n === 0 ? '' : x.n}</i>`).join('')
        || '<span class="dx-none">No rolls yet</span>';
    }
    if (stats) for (const c of COLS) { const el = $(`#dx-c-${c}`); if (el) el.textContent = stats[c] || 0; }
  }

  /** "Rolled 5" and what it did for you, while the result is up. */
  function paintResult() {
    const el = $('#dx-result');
    if (!el) return;
    if (!showingResult()) { el.className = 'dx-result'; el.innerHTML = ''; return; }
    const net = myOutcome();
    el.className = 'dx-result on';
    el.innerHTML = `<span class="dx-rolled">Rolled <i class="dx-dot ${landed.color}">${landed.n === 0 ? '' : landed.n}</i> ${SIDES[landed.color].label}</span>`
      + (net === null ? '' : `<span class="dx-mine ${net >= 0 ? 'win' : 'lose'}">${net >= 0 ? 'You won' : 'You lost'} ${GG.coin('sm')}${fmt(Math.abs(net))}</span>`);
  }

  /** Each column lists the bets on its colour, one row per player, biggest first. While the reel rolls and the
      result is up, the columns show the rolled round: the winning column shows what each player gets back. */
  function paintColumns() {
    const res = showingResult() ? landed : null;
    const list = res || roll ? rollBets : bets;
    for (const side of COLS) {
      const rows = new Map();
      let count = 0;
      for (const b of list) {
        if (b.side !== side) continue;
        count++;
        const row = rows.get(b.userId) || { who: b.username, color: b.avatar, amount: 0, mine: b.mine };
        row.amount += b.amount;
        rows.set(b.userId, row);
      }
      const sorted = [...rows.values()].sort((a, b) => b.amount - a.amount);
      const total = sorted.reduce((a, x) => a + x.amount, 0);
      const won = !!res && res.color === side, lost = !!res && res.color !== side;
      const col = $(`.dx-col.${side}`);
      if (!col) continue;
      col.classList.toggle('won', won);
      col.classList.toggle('lost', lost);
      $(`#dx-n-${side}`).textContent = `${count} bet${count === 1 ? '' : 's'}`;
      $(`#dx-sum-${side}`).innerHTML = `${GG.coin('sm')}${fmt((won ? total * SIDES[side].pays : total) / 100)}`;
      $(`#dx-list-${side}`).innerHTML = sorted.length
        ? sorted.map((x) => `<div class="dx-row${x.mine ? ' mine' : ''}">${GR.avatar(x.who, x.color)}<span class="dx-name">${esc(x.who)}</span>
            <span class="dx-amt">${won ? '+' : ''}${GG.coin('sm')}${fmt((won ? x.amount * SIDES[side].pays : x.amount) / 100)}</span></div>`).join('')
        : '<div class="dx-empty">No bets yet</div>';
    }
  }

  function paintButtons() {
    const open = bettingOpen();
    for (const side of COLS) {
      const b = $(`#db-bet-${side}`);
      if (b) b.disabled = !open || locked[side];
    }
  }

  /* ---------- the server's answers ---------- */
  function onView(v) {
    const r = v.round;
    if (!r) return;
    view = v;
    bets = v.bets;
    if (v.stats) stats = v.stats;
    for (const x of v.history) {
      if (!history.some((y) => y.seq === x.seq)) history.push({ seq: x.seq, n: x.result.n, color: x.result.color });
    }
    history.sort((a, b) => b.seq - a.seq);
    if (history.length > 30) history.length = 30;
    // roll as soon as the round's number is known: betting has closed
    if (r.phase === 'playing' && r.result && rolledSeq !== r.seq) startRoll(r);
    // a fresh page opens on the last number instead of a random spot
    if (!parked && !roll && !landed && history[0]) { parked = true; pos = CYCLE * 2 + ORDER.indexOf(history[0].n); }
    $('#dx-round').textContent = `Round #${r.seq}`;
    paintTop();
    paintColumns();
    paintButtons();
  }

  /* ---------- betting ---------- */
  async function betOn(side) {
    if (!bettingOpen() || locked[side]) return;
    locked[side] = true;
    paintButtons();
    setTimeout(() => { locked[side] = false; paintButtons(); }, 220);
    const res = await GG.roundBet('double', amount.get(), { side });
    if (res && sub) sub.push(res);
  }

  function mount(panel, stage) {
    view = null; bets = []; stats = null; parked = false; history.length = 0;
    pos = CYCLE * 2; roll = null; snap = null; rolledSeq = null; rollBets = []; landed = null; hitEl = null; closedPainted = false;
    stage.appendChild(h(`<div class="dx">
      <div class="dx-top">
        <div class="dx-prevwrap"><span class="dx-label">Previous rolls</span><div class="dx-prev" id="dx-prev"></div></div>
        <div class="dx-hundred"><span class="dx-label">Last 100</span>
          ${COLS.map((c) => `<span class="dx-count ${c}"><i></i><b id="dx-c-${c}">0</b></span>`).join('')}
        </div>
      </div>
      <div class="dx-reel">
        <div class="dx-strip" id="db-strip"></div>
        <div class="dx-marker"></div>
        <div class="dx-status" id="dx-status"><small>Rolling in</small><b id="db-clock">10.00</b></div>
      </div>
      <div class="dx-bar"><i id="db-bar"></i></div>
      <div class="dx-mid"><span class="dx-round" id="dx-round">Round</span><div class="dx-result" id="dx-result"></div></div>
      <div class="dx-amount" id="dx-amount"></div>
      <div class="dx-cols">
        ${COLS.map((c) => `<section class="dx-col ${c}">
          <button type="button" class="dx-place" id="db-bet-${c}" data-side="${c}" disabled><span>Place bet</span><small>Win ${SIDES[c].pays}×</small></button>
          <div class="dx-colhead"><span id="dx-n-${c}">0 bets</span><span class="dx-sum" id="dx-sum-${c}">${GG.coin('sm')}0.00</span></div>
          <div class="dx-list" id="dx-list-${c}"><div class="dx-empty">No bets yet</div></div>
        </section>`).join('')}
      </div>
    </div>`));
    // the amount: the shared field (½, 2×, Max, checks) with Duelbits' quick buttons in front
    amount = GG.ui.amount({ label: 'Bet amount' });
    $('[data-k="half"]', amount.el).insertAdjacentHTML('beforebegin', QUICK.map(([k, l]) => `<button type="button" data-q="${k}">${l}</button>`).join(''));
    amount.el.addEventListener('click', (e) => {
      const q = e.target.closest('[data-q]');
      if (!q || q.disabled) return;
      GG.sfx('click');
      amount.set(q.dataset.q === 'clear' ? 0 : GG.round2(amount.get() + Number(q.dataset.q)));
    });
    $('#dx-amount').appendChild(amount.el);
    buildStrip();
    $$('.dx-place').forEach((b) => b.addEventListener('click', () => { GG.sfx('click'); betOn(b.dataset.side); }));
    requestAnimationFrame(() => { measure(); place(); });
    if (window.ResizeObserver) { resizeObs = new ResizeObserver(() => { measure(); place(); }); resizeObs.observe($('.dx-reel')); }
    sub = follow('double', onView);
    frameId = GG.frame(frame);
    GG.onLeave(() => { GG.unframe(frameId); if (sub) sub.stop(); sub = null; if (resizeObs) resizeObs.disconnect(); resizeObs = null; });
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
