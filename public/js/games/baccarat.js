/* Baccarat — put chips on Player, Banker or Tie, any mix, then deal. One deal settles every spot at once:
   Player pays 1 to 1, Banker 0.95 to 1 (5% commission), Tie 8 to 1. A tie hands Player and Banker chips back.
   The server draws the cards and works out the third-card rules. */
(function () {
  'use strict';
  const { $, $$, h, fmt, sleep, round2, cents } = GG;

  const SIDES = {
    player: { label: 'Player', pays: 2, odds: '1 : 1' },
    tie: { label: 'Tie', pays: 9, odds: '8 : 1' },
    banker: { label: 'Banker', pays: 1.95, odds: '0.95 : 1' },
  };
  const val = (c) => (c.i === 0 ? 1 : c.i >= 9 ? 0 : c.i + 1);
  const total = (cs) => cs.reduce((a, c) => a + val(c), 0) % 10;

  let chip = 1, busy = false, alive = 0;
  const bets = { player: 0, banker: 0, tie: 0 };
  const history = [];

  const stake = () => round2(bets.player + bets.banker + bets.tie);

  function paintSpots() {
    for (const k of Object.keys(SIDES)) {
      const el = $(`#bc-spot-${k}`);
      if (!el) continue;
      $('.chipstack', el) && $('.chipstack', el).remove();
      if (bets[k] > 0) el.insertAdjacentHTML('beforeend', GG.chipStack(bets[k]));
      el.classList.toggle('has', bets[k] > 0);
      el.disabled = busy;
    }
    $('#bc-total').textContent = fmt(stake());
    $('#bc-deal').disabled = busy || stake() <= 0;
    $('#bc-clear').disabled = busy || stake() <= 0;
    $$('.chipbtn').forEach((b) => { b.disabled = busy; });
  }

  function paintHistory() {
    $('#bc-hist').innerHTML = history.slice(0, 22).map((w) => `<i class="bc-bead ${w}" title="${SIDES[w].label}">${SIDES[w].label[0]}</i>`).join('') || '<span class="bc-none">No hands yet</span>';
  }

  /* Chips go on a spot with a click; a right click takes them back. Nothing moves while the cards are out. */
  function place(k) {
    if (busy) return;
    if (!GG.me()) { window.GR.openAuth('register'); return; }
    if (stake() + chip > GG.balance() + 1e-9) { GG.toast('Not enough balance for that chip.', 'error'); return; }
    if (stake() + chip > GG.maxBet() + 1e-9) { GG.toast(`The most you can have down is $${fmt(GG.maxBet())}.`, 'error'); return; }
    bets[k] = round2(bets[k] + chip);
    GG.sfx('chip');
    paintSpots();
  }
  function clearSpot(k) {
    if (busy || !bets[k]) return;
    bets[k] = 0;
    GG.sfx('click');
    paintSpots();
  }
  function clearAll() {
    if (busy) return;
    bets.player = bets.banker = bets.tie = 0;
    GG.sfx('click');
    paintSpots();
  }

  async function deal() {
    if (busy || stake() <= 0) return;
    const my = ++alive;
    busy = true;
    paintSpots();
    const chips = {};
    for (const k of Object.keys(SIDES)) if (bets[k] > 0) chips[k] = cents(bets[k]);
    const res = await GG.bet('baccarat', stake(), { chips });
    if (my !== alive) return;
    if (!res) { busy = false; paintSpots(); return; }
    const x = res.bet.result;
    const cardsOf = { player: x.player, banker: x.banker };
    $$('.bc-card-row').forEach((c) => { c.innerHTML = ''; });
    $$('.bc-score').forEach((s) => { s.textContent = '0'; s.className = 'bc-score'; });
    $$('.bc-hand').forEach((x2) => x2.classList.remove('win'));
    $$('.bc-spot-tag').forEach((t) => t.classList.remove('win'));
    $('#bc-res').className = 'result-pop';
    const shown = { player: [], banker: [] };
    const give = async (who, card) => {
      shown[who].push(card);
      $(`#bc-${who[0]} .bc-card-row`).appendChild(GG.cards.el(card));
      $(`#bc-${who[0]} .bc-score`).textContent = total(shown[who]);
      GG.sfx('card');
      await sleep(420);
    };
    const order = [['player', cardsOf.player[0]], ['banker', cardsOf.banker[0]], ['player', cardsOf.player[1]], ['banker', cardsOf.banker[1]]];
    if (cardsOf.player[2]) order.push(['player', cardsOf.player[2]]);
    if (cardsOf.banker[2]) order.push(['banker', cardsOf.banker[2]]);
    for (const [who, card] of order) { await give(who, card); if (my !== alive) return; }
    await sleep(250);
    if (my !== alive) return;

    const won = res.bet.payout / 100, staked = res.bet.amount / 100;
    history.unshift(x.winner);
    paintHistory();
    if (x.winner !== 'tie') $(`#bc-${x.winner[0]}`).classList.add('win');
    $(`#bc-spot-${x.winner}`).classList.add('win');
    $('#bc-p .bc-score').classList.add(x.winner === 'player' ? 'win' : x.winner === 'tie' ? 'push' : 'lose');
    $('#bc-b .bc-score').classList.add(x.winner === 'banker' ? 'win' : x.winner === 'tie' ? 'push' : 'lose');
    const net = round2(won - staked);
    const pop = $('#bc-res');
    const title = x.winner === 'tie' ? 'Tie' : `${SIDES[x.winner].label} wins`;
    pop.className = 'result-pop show ' + (net > 0 ? '' : net === 0 ? 'push' : 'bad');
    pop.innerHTML = `<b>${title}</b><span>${GG.coin('sm')}${net > 0 ? '+' + fmt(net) : net === 0 ? 'Bets returned' : '−' + fmt(-net)}</span>`;
    GG.settle(res, { from: $('.bc-hands'), quiet: net <= 0 });
    GG.sfx(net > 0 ? (net >= staked * 2 ? 'bigwin' : 'win') : net === 0 ? 'push' : 'lose');
    busy = false;
    paintSpots();
  }

  function mount(panel, stage) {
    busy = false;
    bets.player = bets.banker = bets.tie = 0;
    panel.appendChild(h(`<div>
      <div class="gfield"><span class="gfield-l">Chip</span><div class="rl-chips">${GG.chipButtons(chip)}</div></div>
      <div class="gfield"><span class="gfield-l">Down</span><div class="readout">${GG.coin()}<span id="bc-total">0.00</span></div></div>
      <div class="bc-actions">
        <button class="gbtn ghost" id="bc-clear" disabled>Clear</button>
        <button class="gbtn primary lg" id="bc-deal" disabled>Deal</button>
      </div>
    </div>`));
    const spot = (k) => `<button type="button" class="bc-spot ${k}" id="bc-spot-${k}" data-v="${k}">
      <span class="bc-spot-tag"><b>${SIDES[k].label}</b><small>${SIDES[k].odds}</small></span></button>`;
    stage.appendChild(h(`<div class="bc-table">
      <div class="bc-hist" id="bc-hist"></div>
      <div class="bc-hands">
        <div class="bc-hand" id="bc-p"><span class="bc-name">Player</span><div class="bc-card-row"></div><div class="bc-score">0</div></div>
        <div class="bc-vs">VS</div>
        <div class="bc-hand" id="bc-b"><span class="bc-name">Banker</span><div class="bc-card-row"></div><div class="bc-score">0</div></div>
      </div>
      <div class="bc-spots">${spot('player')}${spot('tie')}${spot('banker')}</div>
      <div class="bc-hint">Click a spot to put a chip down. Right-click to take it back.</div>
      <div class="result-pop" id="bc-res"></div>
    </div>`));
    $('.rl-chips').addEventListener('click', (e) => {
      const b = e.target.closest('.chipbtn');
      if (!b || b.disabled) return;
      chip = Number(b.dataset.v);
      GG.sfx('click');
      $$('.chipbtn').forEach((x) => x.classList.toggle('on', x === b));
    });
    $$('.bc-spot').forEach((el) => {
      el.addEventListener('click', () => place(el.dataset.v));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); clearSpot(el.dataset.v); });
    });
    $('#bc-deal').addEventListener('click', deal);
    $('#bc-clear').addEventListener('click', clearAll);
    paintSpots();
    paintHistory();
  }

  GG.registerGame({
    id: 'baccarat',
    name: 'Baccarat',
    cat: 'table',
    rtp: '98.9',
    colors: ['#4f5bd5', '#12174a'],
    icon: '<svg viewBox="0 0 24 24"><rect x="4" y="3.500" width="11" height="15" rx="2" fill="currentColor" opacity=".45"/><rect x="9" y="5.500" width="11" height="15" rx="2" fill="currentColor"/><text x="14.500" y="16.500" font-size="8.500" font-weight="800" text-anchor="middle" fill="#101218" font-family="Arial,sans-serif">9</text></svg>',
    art: `<svg viewBox="0 0 200 200">
      <g transform="rotate(-10 72 104)"><rect x="24" y="44" width="88" height="124" rx="12" fill="#fff"/><text x="36" y="76" font-size="28" font-weight="800" fill="#151821" font-family="Fredoka One,Inter,Arial,sans-serif">9</text><text x="68" y="140" font-size="58" text-anchor="middle" fill="#151821" font-family="Arial,sans-serif">♣︎</text></g>
      <g transform="rotate(9 130 100)"><rect x="88" y="36" width="88" height="124" rx="12" fill="#fff" stroke="#d9dce6" stroke-width="2"/><text x="100" y="68" font-size="28" font-weight="800" fill="#e3324c" font-family="Fredoka One,Inter,Arial,sans-serif">8</text><text x="132" y="132" font-size="58" text-anchor="middle" fill="#e3324c" font-family="Arial,sans-serif">♦︎</text></g>
      <circle cx="100" cy="166" r="22" fill="#eac837" stroke="#fff" stroke-width="5" stroke-dasharray="9 8"/>
    </svg>`,
    mount,
  });
})();
