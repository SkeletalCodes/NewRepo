/* Dragon Tiger — one card for the Dragon, one for the Tiger, the higher card wins (ace low, king high).
   Dragon and Tiger pay 1 to 1; on a tie they hand back half the bet. Tie pays 11 to 1. */
(function () {
  'use strict';
  const { $, $$, h, fmt, sleep, round2 } = GG;

  const SIDES = {
    dragon: { label: 'Dragon', pays: 2, odds: '1 : 1' },
    tie: { label: 'Tie', pays: 12, odds: '11 : 1' },
    tiger: { label: 'Tiger', pays: 2, odds: '1 : 1' },
  };
  const DRAGON = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 40c4-16 18-28 34-28 6 0 11 2 14 5-6-1-10 1-12 4 6 0 10 3 11 8-5-3-10-3-14 0 3 3 4 7 2 11-3-4-8-6-13-5 2 5 1 10-3 13 0-6-4-10-10-11-3 2-6 3-9 3z" fill="currentColor"/><circle cx="44" cy="22" r="2.400" fill="#0b0d14"/></svg>';
  const TIGER = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 18l6 6c4-3 8-4 12-4s8 1 12 4l6-6 2 14c2 4 2 9 0 13-3 7-11 11-20 11s-17-4-20-11c-2-4-2-9 0-13z" fill="currentColor"/><path d="M24 34h4M36 34h4M30 42l2 3 2-3M22 26l4 3M42 26l-4 3M18 40l7 1M46 40l-7 1" stroke="#0b0d14" stroke-width="2.600" stroke-linecap="round"/></svg>';

  let amount, side = 'dragon', busy = false, alive = 0;
  const history = [];

  function ui() {
    amount.lock(busy);
    $('#dt-deal').disabled = busy;
    $$('#dt-side button, .dt-spot').forEach((b) => { b.disabled = busy; });
    $$('.dt-spot').forEach((b) => b.classList.toggle('on', b.dataset.v === side));
    GG.ui.setSeg($('#dt-side'), side);
    $('#dt-profit').textContent = fmt(Math.max(0, amount.get() * (SIDES[side].pays - 1)));
  }

  function setSide(v) { if (busy || !SIDES[v]) return; side = v; ui(); }

  function paintHistory() {
    $('#dt-hist').innerHTML = history.slice(0, 22).map((w) => `<i class="dt-bead ${w}" title="${SIDES[w].label}">${SIDES[w].label[0]}</i>`).join('') || '<span class="hp">No hands yet</span>';
  }

  async function play() {
    if (busy) return;
    const bet = amount.get();
    const my = ++alive;
    busy = true;
    ui();
    const res = await GG.bet('dragontiger', bet, { side });
    if (my !== alive) return;
    if (!res) { busy = false; ui(); return; }
    const r = res.bet.result;
    $$('.dt-card').forEach((c) => { c.innerHTML = ''; });
    $$('.dt-hand, .dt-spot').forEach((x) => x.classList.remove('win', 'lose'));
    $('#dt-res').className = 'result-pop';
    for (const who of ['dragon', 'tiger']) {
      const el = GG.cards.el(r[who], true);
      $(`#dt-${who} .dt-card`).appendChild(el);
      GG.sfx('card');
      await sleep(320);
      if (my !== alive) return;
      el.classList.remove('down');
      await sleep(360);
      if (my !== alive) return;
    }
    await sleep(200);
    if (my !== alive) return;
    const mult = r.winner === side ? SIDES[side].pays : r.winner === 'tie' ? 0.5 : 0;
    GG.settle(res, { from: $('.dt-hands'), quiet: mult <= 1 });
    history.unshift(r.winner);
    paintHistory();
    if (r.winner !== 'tie') { $(`#dt-${r.winner}`).classList.add('win'); $(`#dt-${r.winner === 'dragon' ? 'tiger' : 'dragon'}`).classList.add('lose'); }
    $(`.dt-spot[data-v="${r.winner}"]`).classList.add('win');
    const net = round2((res.bet.payout - res.bet.amount) / 100);
    const pop = $('#dt-res');
    pop.className = 'result-pop show ' + (net > 0 ? '' : mult > 0 ? 'push' : 'bad');
    pop.innerHTML = `<b>${r.winner === 'tie' ? 'Tie' : SIDES[r.winner].label + ' wins'}</b><span>${GG.coin('sm')}${net > 0 ? '+' + fmt(net) : mult > 0 ? 'Half back' : '-' + fmt(bet)}</span>`;
    GG.sfx(mult > 2 ? 'bigwin' : mult > 1 ? 'win' : mult > 0 ? 'push' : 'lose');
    if (mult > 2) GG.confetti($('.dt-table'), 70);
    busy = false;
    ui();
  }

  GG.registerGame({
    id: 'dragontiger',
    name: 'Dragon Tiger',
    rtp: '96.2',
    badge: 'NEW',
    cat: 'table',
    colors: ['#ef4444', '#3a0a0a'],
    icon: '<svg viewBox="0 0 24 24"><rect x="2.500" y="5" width="8.500" height="14" rx="2" fill="currentColor"/><rect x="13" y="5" width="8.500" height="14" rx="2" fill="currentColor" opacity=".5"/></svg>',
    art: `<svg viewBox="0 0 200 200">
      <g transform="rotate(-10 62 104)"><rect x="18" y="42" width="88" height="124" rx="12" fill="#fff"/><g transform="translate(30 70) scale(1)" color="#e3324c"><svg width="64" height="64" viewBox="0 0 64 64">${DRAGON.replace(/<\/?svg[^>]*>/g, '')}</svg></g></g>
      <g transform="rotate(10 138 104)"><rect x="94" y="42" width="88" height="124" rx="12" fill="#fff" stroke="#d9dce6" stroke-width="2"/><g transform="translate(106 70)" color="#f59e0b"><svg width="64" height="64" viewBox="0 0 64 64">${TIGER.replace(/<\/?svg[^>]*>/g, '')}</svg></g></g>
      <circle cx="100" cy="104" r="20" fill="#eac837" stroke="#3a0a0a" stroke-width="4"/><text x="100" y="111" font-size="17" font-weight="800" text-anchor="middle" fill="#3a0a0a" font-family="Inter,Arial,sans-serif">VS</text>
    </svg>`,

    mount(panel, stage) {
      busy = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Bet on</span>${GG.ui.seg('dt-side', [['dragon', 'Dragon'], ['tie', 'Tie'], ['tiger', 'Tiger']], side)}</div>
        <div class="gfield"><span class="gfield-l">Profit on win</span><div class="readout">${GG.coin()}<span id="dt-profit">0.00</span></div></div>
        <button class="gbtn primary lg block" id="dt-deal">Deal</button>
        <p class="panel-note">One card each, highest card wins: ace is low, king is high. Dragon and Tiger pay 1 to 1 and hand back half your bet on a tie. Tie pays 11 to 1.</p>
      </div>`));
      const spot = (k) => `<button class="dt-spot ${k}" data-v="${k}"><b>${SIDES[k].label}</b><small>${SIDES[k].odds}</small></button>`;
      stage.appendChild(h(`<div class="dt-table">
        <div class="dt-hist" id="dt-hist"></div>
        <div class="dt-hands">
          <div class="dt-hand dragon" id="dt-dragon"><span class="dt-name">${DRAGON}Dragon</span><div class="dt-card"></div></div>
          <div class="dt-vs">VS</div>
          <div class="dt-hand tiger" id="dt-tiger"><span class="dt-name">${TIGER}Tiger</span><div class="dt-card"></div></div>
        </div>
        <div class="dt-spots">${spot('dragon')}${spot('tie')}${spot('tiger')}</div>
        <div class="result-pop" id="dt-res"></div>
      </div>`));
      GG.ui.bindSeg($('#dt-side'), setSide);
      $('.dt-spots').addEventListener('click', (e) => { const b = e.target.closest('.dt-spot'); if (b) { GG.sfx('click'); setSide(b.dataset.v); } });
      $('#dt-deal').addEventListener('click', play);
      amount.onChange(ui);
      ui(); paintHistory();
    },

    unmount() {
      alive++;
      busy = false;
    },
  });
})();
