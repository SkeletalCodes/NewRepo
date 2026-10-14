/* Baccarat — bet on Player, Banker or a Tie. Standard third-card rules, infinite deck.
   Player pays 1:1, Banker 0.95:1 (5% commission), Tie 8:1. A tie returns Player/Banker bets. */
(function () {
  'use strict';
  const { $, $$, h, fmt, sleep, round2 } = GG;

  const SIDES = {
    player: { label: 'Player', pays: 2, odds: '1 : 1' },
    tie: { label: 'Tie', pays: 9, odds: '8 : 1' },
    banker: { label: 'Banker', pays: 1.95, odds: '0.95 : 1' },
  };
  const val = (c) => (c.i === 0 ? 1 : c.i >= 9 ? 0 : c.i + 1);
  const total = (cs) => cs.reduce((a, c) => a + val(c), 0) % 10;

  let amount, side = 'player', busy = false, alive = 0;
  const history = [];

  function ui() {
    amount.lock(busy);
    $('#bc-deal').disabled = busy;
    $$('#bc-side button, .bc-spot').forEach((b) => { b.disabled = busy; });
    $$('.bc-spot').forEach((b) => b.classList.toggle('on', b.dataset.v === side));
    GG.ui.setSeg($('#bc-side'), side);
    $('#bc-profit').textContent = fmt(Math.max(0, amount.get() * (SIDES[side].pays - 1)));
  }

  function setSide(v) { if (busy || !SIDES[v]) return; side = v; ui(); }

  function paintHistory() {
    $('#bc-hist').innerHTML = history.slice(0, 22).map((w) => `<i class="bc-bead ${w}" title="${SIDES[w].label}">${SIDES[w].label[0]}</i>`).join('') || '<span class="hp">No hands yet</span>';
  }

  async function play() {
    if (busy) return;
    const bet = amount.get();
    const my = ++alive;
    busy = true;
    ui();
    const res = await GG.bet('baccarat', bet, { side });
    if (my !== alive) return;
    if (!res) { busy = false; ui(); return; }
    const x = res.bet.result, r = { p: x.player, b: x.banker, pt: x.pt, bt: x.bt, winner: x.winner };
    const mult = r.winner === side ? SIDES[side].pays : r.winner === 'tie' ? 1 : 0;
    $$('.bc-cards').forEach((c) => { c.innerHTML = ''; });
    $$('.bc-score').forEach((s) => { s.textContent = '0'; s.className = 'bc-score'; });
    $$('.bc-hand, .bc-spot').forEach((x) => x.classList.remove('win'));
    $('#bc-res').className = 'result-pop';
    ui();

    const shownP = [], shownB = [];
    const give = async (who, card) => {
      (who === 'p' ? shownP : shownB).push(card);
      $(`#bc-${who} .bc-cards`).appendChild(GG.cards.el(card));
      $(`#bc-${who} .bc-score`).textContent = total(who === 'p' ? shownP : shownB);
      GG.sfx('card');
      await sleep(400);
    };
    const order = [['p', r.p[0]], ['b', r.b[0]], ['p', r.p[1]], ['b', r.b[1]]];
    if (r.p[2]) order.push(['p', r.p[2]]);
    if (r.b[2]) order.push(['b', r.b[2]]);
    for (const [who, card] of order) { await give(who, card); if (my !== alive) return; }
    await sleep(250); if (my !== alive) return;

    GG.settle(res, { from: $('.bc-hands'), quiet: mult <= 1 });
    const p = { mult, payout: res.bet.payout / 100 };
    history.unshift(r.winner);
    paintHistory();
    if (r.winner !== 'tie') $(`#bc-${r.winner[0]}`).classList.add('win');
    $(`.bc-spot[data-v="${r.winner}"]`).classList.add('win');
    $('#bc-p .bc-score').classList.add(r.winner === 'player' ? 'win' : r.winner === 'tie' ? 'push' : 'lose');
    $('#bc-b .bc-score').classList.add(r.winner === 'banker' ? 'win' : r.winner === 'tie' ? 'push' : 'lose');
    const pop = $('#bc-res');
    const title = r.winner === 'tie' ? 'Tie' : SIDES[r.winner].label + ' wins';
    pop.className = 'result-pop show ' + (p.mult > 1 ? '' : p.mult === 1 ? 'push' : 'bad');
    pop.innerHTML = `<b>${title}</b><span>${GG.coin('sm')}${p.mult > 1 ? '+' + fmt(p.payout - bet) : p.mult === 1 ? 'Bet returned' : '-' + fmt(bet)}</span>`;
    GG.sfx(p.mult > 2 ? 'bigwin' : p.mult > 1 ? 'win' : p.mult === 1 ? 'push' : 'lose');
    busy = false;
    ui();
  }

  GG.registerGame({
    id: 'baccarat',
    name: 'Baccarat',
    cat: 'table',
    rtp: '98.9',
    colors: ['#4f5bd5', '#12174a'],
    icon: '<svg viewBox="0 0 24 24"><rect x="4" y="3.500" width="11" height="15" rx="2" fill="currentColor" opacity=".45"/><rect x="9" y="5.500" width="11" height="15" rx="2" fill="currentColor"/><text x="14.500" y="16.500" font-size="8.500" font-weight="800" text-anchor="middle" fill="#101218" font-family="Arial,sans-serif">9</text></svg>',
    art: `<svg viewBox="0 0 200 200">
      <g transform="rotate(-10 72 104)"><rect x="24" y="44" width="88" height="124" rx="12" fill="#fff"/><text x="36" y="76" font-size="28" font-weight="800" fill="#151821" font-family="Outfit,Arial,sans-serif">9</text><text x="68" y="140" font-size="58" text-anchor="middle" fill="#151821" font-family="Arial,sans-serif">♣︎</text></g>
      <g transform="rotate(9 130 100)"><rect x="88" y="36" width="88" height="124" rx="12" fill="#fff" stroke="#d9dce6" stroke-width="2"/><text x="100" y="68" font-size="28" font-weight="800" fill="#e3324c" font-family="Outfit,Arial,sans-serif">8</text><text x="132" y="132" font-size="58" text-anchor="middle" fill="#e3324c" font-family="Arial,sans-serif">♦︎</text></g>
      <circle cx="100" cy="166" r="22" fill="#eac837" stroke="#fff" stroke-width="5" stroke-dasharray="9 8"/>
    </svg>`,

    mount(panel, stage) {
      busy = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Bet on</span>${GG.ui.seg('bc-side', [['player', 'Player'], ['tie', 'Tie'], ['banker', 'Banker']], side)}</div>
        <div class="gfield"><span class="gfield-l">Profit on win</span><div class="readout">${GG.coin()}<span id="bc-profit">0.00</span></div></div>
        <button class="gbtn primary lg block" id="bc-deal">Deal</button>
        <p class="panel-note">Closest to 9 wins. Player and Banker are the steady bets; Tie is the long shot at 8 to 1. A tie hands Player and Banker bets back.</p>
      </div>`));
      const spot = (k) => `<button class="bc-spot ${k}" data-v="${k}"><b>${SIDES[k].label}</b><small>${SIDES[k].odds}</small></button>`;
      stage.appendChild(h(`<div class="bc-table">
        <div class="bc-hist" id="bc-hist"></div>
        <div class="bc-hands">
          <div class="bc-hand" id="bc-p"><span class="bc-name">Player</span><div class="bc-cards"></div><div class="bc-score">0</div></div>
          <div class="bc-vs">VS</div>
          <div class="bc-hand" id="bc-b"><span class="bc-name">Banker</span><div class="bc-cards"></div><div class="bc-score">0</div></div>
        </div>
        <div class="bc-spots">${spot('player')}${spot('tie')}${spot('banker')}</div>
        <div class="result-pop" id="bc-res"></div>
      </div>`));
      GG.ui.bindSeg($('#bc-side'), setSide);
      $('.bc-spots').addEventListener('click', (e) => { const b = e.target.closest('.bc-spot'); if (b) { GG.sfx('click'); setSide(b.dataset.v); } });
      $('#bc-deal').addEventListener('click', play);
      amount.onChange(ui);
      ui(); paintHistory();
    },

    unmount() {
      alive++;
      busy = false;
    },
  });
})();
