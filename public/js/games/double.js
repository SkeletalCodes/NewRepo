/* Double — a strip of 15 tiles spins past a marker: seven red, seven black, one green.
   Red and black pay 2×, green pays 14×. One number (0-14) is drawn per round; 0 is green. */
(function () {
  'use strict';
  const { $, $$, h, fmt, fmtMult, sleep, rand } = GG;

  const ORDER = [1, 14, 2, 13, 3, 12, 4, 0, 11, 5, 10, 6, 9, 7, 8]; // tile order along the strip
  const PAYS = { red: 2, green: 14, black: 2 };
  const LABEL = { red: 'Red', green: 'Green', black: 'Black' };
  const CYCLES = 9, SPIN_MS = 5200;
  const colorOf = (n) => (n === 0 ? 'green' : n <= 7 ? 'red' : 'black');

  let amount, pick = 'red', busy = false, alive = 0, pos = 15 + 7, jitter = 0, ticks = [];
  const history = [];

  /** Centre tile `index` of the strip under the marker. */
  function place(index, off, animate) {
    const strip = $('#db-strip');
    if (!strip) return;
    const tile = strip.firstElementChild, step = tile.offsetWidth + 8;
    strip.style.transition = animate ? `transform ${SPIN_MS}ms cubic-bezier(.12, .62, .1, 1)` : 'none';
    strip.style.transform = `translateX(${-(index * step + tile.offsetWidth / 2 + off * tile.offsetWidth)}px)`;
    if (!animate) void strip.offsetWidth;
  }

  function ui() {
    amount.lock(busy);
    $('#db-spin').disabled = busy;
    $$('#db-pick button').forEach((b) => { b.disabled = busy; b.classList.toggle('on', b.dataset.v === pick); });
    $('#db-profit').textContent = fmt(Math.max(0, amount.get() * (PAYS[pick] - 1)));
    $('#db-mult').textContent = fmtMult(PAYS[pick]);
  }

  function paintHistory() {
    $('#db-hist').innerHTML = history.slice(0, 16).map((n) => `<i class="db-h ${colorOf(n)}">${n}</i>`).join('') || '<span class="hp">No rounds yet</span>';
    const last = history.slice(0, 50), c = { red: 0, green: 0, black: 0 };
    last.forEach((n) => { c[colorOf(n)]++; });
    $('#db-count').innerHTML = ['red', 'green', 'black'].map((k) => `<div class="db-stat ${k}"><i></i><b>${c[k]}</b><small>${LABEL[k]}</small></div>`).join('');
  }

  function clearTicks() { ticks.forEach(clearTimeout); ticks = []; }

  async function spin() {
    if (busy) return;
    const bet = amount.get();
    const my = ++alive;
    busy = true;
    ui();
    const res = await GG.bet('double', bet, { pick });
    if (my !== alive) return;
    if (!res) { busy = false; ui(); return; }
    const n = res.bet.result.n, col = colorOf(n), won = col === pick;
    $$('.db-tile.hit').forEach((t) => t.classList.remove('hit'));
    $('#db-res').className = 'result-pop';
    $('.db-window').classList.remove('won', 'lost');
    ui();

    // snap back to the same tile in an early lap, then roll forward several laps to the winner
    pos = 15 + (pos % 15);
    place(pos, jitter, false);
    pos = 15 * (CYCLES - 2) + ORDER.indexOf(n);
    jitter = (rand() - 0.5) * 0.7;
    place(pos, jitter, true);
    clearTicks();
    for (let t = 40, gap = 45; t < SPIN_MS - 250; gap *= 1.085, t += gap) ticks.push(setTimeout(() => GG.sfx('tick', 0.55), t));
    await sleep(SPIN_MS + 120);
    if (my !== alive) return;

    GG.settle(res, { from: $('.db-window') });
    history.unshift(n);
    paintHistory();
    const tile = $('#db-strip').children[pos];
    if (tile) tile.classList.add('hit');
    $('.db-window').classList.add(won ? 'won' : 'lost');
    const pop = $('#db-res');
    pop.className = 'result-pop show ' + (won ? '' : 'bad');
    pop.innerHTML = `<b>${LABEL[col]} ${n}</b><span>${GG.coin('sm')}${won ? '+' + fmt((res.bet.payout - res.bet.amount) / 100) : '-' + fmt(bet)}</span>`;
    if (won && col === 'green') { GG.sfx('bigwin'); GG.confetti($('.db-wrap'), 70); } else GG.sfx(won ? 'win' : 'lose');
    busy = false;
    ui();
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
      <text x="100" y="117" font-size="34" font-weight="800" text-anchor="middle" fill="#fff" font-family="Outfit,Arial,sans-serif">14×</text>
      <text x="22" y="114" font-size="24" font-weight="800" text-anchor="middle" fill="#8c94a8" font-family="Outfit,Arial,sans-serif">2×</text>
      <text x="178" y="114" font-size="24" font-weight="800" text-anchor="middle" fill="#fff" font-family="Outfit,Arial,sans-serif">2×</text>
      <path d="M100 44l-13-22h26z" fill="#eac837" stroke="#3f0d0d" stroke-width="3" stroke-linejoin="round"/>
      <path d="M100 164l-13 22h26z" fill="#eac837" stroke="#3f0d0d" stroke-width="3" stroke-linejoin="round"/>
    </svg>`,

    mount(panel, stage) {
      busy = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Bet on</span>
          <div class="db-pick" id="db-pick">
            <button type="button" data-v="red" class="red"><b>Red</b><small>2×</small></button>
            <button type="button" data-v="green" class="green"><b>Green</b><small>14×</small></button>
            <button type="button" data-v="black" class="black"><b>Black</b><small>2×</small></button>
          </div></div>
        <div class="row2">
          <div class="gfield"><span class="gfield-l">Pays</span><div class="readout" id="db-mult"></div></div>
          <div class="gfield"><span class="gfield-l">Profit on win</span><div class="readout">${GG.coin()}<span id="db-profit">0.00</span></div></div>
        </div>
        <button class="gbtn primary lg block" id="db-spin">Spin</button>
        <p class="panel-note">Red and black each cover 7 of the 15 tiles. Green is a single tile — the high-risk pick at 14×.</p>
      </div>`));
      let tiles = '';
      for (let c = 0; c < CYCLES; c++) ORDER.forEach((n) => { tiles += `<div class="db-tile ${colorOf(n)}">${n}</div>`; });
      stage.appendChild(h(`<div class="db-wrap">
        <div class="db-hist" id="db-hist"></div>
        <div class="db-window"><div class="db-marker"></div><div class="db-strip" id="db-strip">${tiles}</div></div>
        <div class="db-count" id="db-count"></div>
        <div class="result-pop" id="db-res"></div>
      </div>`));
      $('#db-pick').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || b.disabled) return;
        pick = b.dataset.v;
        GG.sfx('click');
        ui();
      });
      $('#db-spin').addEventListener('click', spin);
      amount.onChange(ui);
      pos = 15 + (pos % 15);
      place(pos, jitter, false);
      const onResize = () => { if (!busy) place(pos, jitter, false); };
      window.addEventListener('resize', onResize);
      GG.onLeave(() => window.removeEventListener('resize', onResize));
      ui(); paintHistory();
    },

    unmount() {
      alive++;
      clearTicks();
      busy = false;
    },
  });
})();
