/* Blackjack — infinite deck (each card is an independent seeded draw), dealer stands on 17,
   blackjack pays 3:2, double on any first two cards. The server deals; the hole card stays on the
   server until the hand is over. */
(function () {
  'use strict';
  const { $, h, fmt, sleep } = GG;

  let amount, alive = 0, phase = 'idle', player = [], dealer = [], bet = 0, doubled = false, holeDown = false, betId = 0;

  function total(cards) {
    let t = 0, aces = 0;
    for (const c of cards) {
      if (c.r === 'A') { aces++; t += 11; } else if (c.r === 'K' || c.r === 'Q' || c.r === 'J' || c.r === '10') t += 10; else t += Number(c.r);
    }
    while (t > 21 && aces) { t -= 10; aces--; }
    return t;
  }

  function scores() {
    const ps = $('#bj-p .bj-score'), ds = $('#bj-d .bj-score');
    if (!ps) return;
    ps.hidden = !player.length;
    ds.hidden = !dealer.length;
    ps.textContent = total(player);
    ds.textContent = holeDown ? total(dealer.slice(0, 1)) : total(dealer);
  }

  async function give(hand, who, c, down) {
    hand.push(c);
    GG.sfx('card');
    if (down) holeDown = true;
    $(`#bj-${who} .bj-cards`).appendChild(GG.cards.el(c, down));
    scores();
    await sleep(340);
  }

  /** Turn the face-down card over (it arrives from the server once the hand is over). */
  async function reveal(hole) {
    const el = $('#bj-d .pcard.down');
    if (el && hole) {
      // paint the face first (it's on the back of the card while it's down), then flip it
      el.classList.toggle('red', !!hole.red);
      $('.pc-r', el).textContent = hole.r;
      $('.pc-s', el).textContent = GG.cards.suit(hole.s);
      $('.pc-big', el).textContent = GG.cards.suit(hole.s);
      dealer[1] = hole;
    }
    if (el) el.classList.remove('down');
    holeDown = false;
    await sleep(380);
    scores();
  }

  function ui() {
    const idle = phase === 'idle', turn = phase === 'player';
    amount.lock(!idle);
    $('#bj-deal').disabled = !idle;
    $('#bj-hit').disabled = !turn;
    $('#bj-stand').disabled = !turn;
    $('#bj-double').disabled = !(turn && player.length === 2);
  }

  const OUTCOME = {
    blackjack: ['Blackjack!', ''], win: ['You win', ''], dealer_bust: ['Dealer busts', ''], push: ['Push', 'push'],
    bust: ['Bust', 'bad'], lose: ['Dealer wins', 'bad'], dealer_blackjack: ['Dealer blackjack', 'bad'],
  };

  function settle(res) {
    const v = res.bet.view, wager = res.bet.amount / 100, payout = res.bet.payout / 100;
    const mult = wager ? payout / wager : 0;
    const [title, cls] = OUTCOME[v.outcome] || ['Dealer wins', 'bad'];
    GG.settle(res, { from: $('#bj-p .bj-cards'), quiet: mult <= 1 });
    GG.sfx(v.outcome === 'blackjack' ? 'bigwin' : mult > 1 ? 'win' : mult === 1 ? 'push' : 'lose');
    const pop = $('#bj-res');
    pop.className = 'result-pop show ' + cls;
    pop.innerHTML = `<b>${title}</b><span>${GG.coin('sm')}${mult > 1 ? '+' + fmt(payout - wager) : mult === 1 ? 'Bet returned' : '-' + fmt(wager)}</span>`;
    $('#bj-p .bj-score').classList.add(mult > 1 ? 'win' : mult === 1 ? 'push' : 'lose');
    phase = 'idle';
    ui();
  }

  /** Play out the rest of the hand the server already finished: reveal the hole card, then the dealer's draws. */
  async function finish(res, my) {
    const v = res.bet.view;
    if (holeDown) { await reveal(v.dealer[1]); if (my !== alive) return; }
    // the dealer only draws when the player didn't bust or have a natural
    for (let i = dealer.length; i < v.dealer.length; i++) { await give(dealer, 'd', v.dealer[i]); if (my !== alive) return; }
    settle(res);
  }

  function clearTable() {
    player = []; dealer = []; holeDown = false; doubled = false;
    $('#bj-p .bj-cards').innerHTML = '';
    $('#bj-d .bj-cards').innerHTML = '';
    $('#bj-p .bj-score').className = 'bj-score';
    $('#bj-res').className = 'result-pop';
    scores();
  }

  async function deal() {
    if (phase !== 'idle') return;
    bet = amount.get();
    const my = ++alive;
    phase = 'busy';
    ui();
    const res = await GG.bet('blackjack', bet, {});
    if (my !== alive) return;
    if (!res) { phase = 'idle'; ui(); return; }
    betId = res.bet.id;
    clearTable();
    const v = res.bet.view;
    const done = res.bet.status === 'settled';
    await give(player, 'p', v.player[0]); if (my !== alive) return;
    await give(dealer, 'd', v.dealer[0]); if (my !== alive) return;
    await give(player, 'p', v.player[1]); if (my !== alive) return;
    await give(dealer, 'd', done ? v.dealer[1] : { r: '', s: '' }, true); if (my !== alive) return;
    if (done) { await reveal(v.dealer[1]); if (my !== alive) return; settle(res); return; }
    phase = 'player'; ui();
  }

  async function move(action) {
    if (phase !== 'player') return;
    if (action === 'double' && player.length !== 2) return;
    const my = alive;
    phase = 'busy'; ui();
    const res = await GG.act(betId, action, {}, action === 'double' ? bet : 0);
    if (my !== alive) return;
    if (!res) { phase = 'player'; ui(); return; }
    if (action === 'double') doubled = true;
    const v = res.bet.view;
    for (let i = player.length; i < v.player.length; i++) { await give(player, 'p', v.player[i]); if (my !== alive) return; }
    if (res.bet.status === 'settled') return finish(res, my);
    phase = 'player'; ui();
  }

  /** A hand left open (reload, another tab): put it back on the table. */
  async function resume() {
    const b = await GG.active('blackjack');
    if (!b || phase !== 'idle' || !$('#bj-deal')) return;
    betId = b.id; bet = b.amount / 100;
    clearTable();
    b.view.player.forEach((c) => { player.push(c); $('#bj-p .bj-cards').appendChild(GG.cards.el(c)); });
    dealer.push(b.view.dealer[0]);
    $('#bj-d .bj-cards').appendChild(GG.cards.el(b.view.dealer[0]));
    dealer.push({ r: '', s: '' });
    holeDown = true;
    $('#bj-d .bj-cards').appendChild(GG.cards.el({ r: '', s: '' }, true));
    scores();
    phase = 'player';
    ui();
    GG.toast('Your last hand is still open. Finish it here.', 'info');
  }

  GG.registerGame({
    id: 'blackjack',
    name: 'Blackjack',
    rtp: '99.5',
    badge: 'HOT',
    colors: ['#23a877', '#0a3324'],
    icon: '<svg viewBox="0 0 24 24"><rect x="3" y="5.500" width="10.500" height="14.500" rx="2" fill="currentColor" opacity=".45" transform="rotate(-10 8 12)"/><rect x="10.500" y="4" width="10.500" height="14.500" rx="2" fill="currentColor" transform="rotate(9 16 11)"/></svg>',
    art: `<svg viewBox="0 0 200 200">
      <g transform="rotate(-14 80 110)"><rect x="30" y="44" width="94" height="132" rx="13" fill="#fff"/><text x="42" y="76" font-size="28" font-weight="800" fill="#e3324c" font-family="Inter,Arial,sans-serif">K</text><text x="77" y="140" font-size="62" text-anchor="middle" fill="#e3324c" font-family="Arial,sans-serif">♥︎</text></g>
      <g transform="rotate(11 126 104)"><rect x="80" y="32" width="94" height="132" rx="13" fill="#fff"/><rect x="80" y="32" width="94" height="132" rx="13" fill="none" stroke="#d9dce6" stroke-width="2"/><text x="92" y="64" font-size="28" font-weight="800" fill="#151821" font-family="Inter,Arial,sans-serif">A</text><text x="127" y="130" font-size="66" text-anchor="middle" fill="#151821" font-family="Arial,sans-serif">♠︎</text></g>
    </svg>`,

    mount(panel, stage) {
      phase = 'idle'; player = []; dealer = []; holeDown = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="bj-actions">
          <button class="gbtn ghost" id="bj-hit">Hit</button>
          <button class="gbtn ghost" id="bj-stand">Stand</button>
          <button class="gbtn ghost" id="bj-double">Double</button>
        </div>
        <button class="gbtn primary lg block" id="bj-deal">Deal</button>
      </div>`));
      stage.appendChild(h(`<div class="bj-table">
        <div class="bj-hand" id="bj-d"><div class="bj-cards"></div><div class="bj-score" hidden></div></div>
        <div class="bj-mid"><span>BLACKJACK PAYS 3 TO 2</span><small>Dealer must stand on 17 and draw to 16</small></div>
        <div class="bj-hand" id="bj-p"><div class="bj-score" hidden></div><div class="bj-cards"></div></div>
        <div class="bj-shoe"><i></i><i></i><i></i></div>
        <div class="result-pop" id="bj-res"></div>
      </div>`));
      $('#bj-deal').addEventListener('click', deal);
      $('#bj-hit').addEventListener('click', () => move('hit'));
      $('#bj-stand').addEventListener('click', () => move('stand'));
      $('#bj-double').addEventListener('click', () => move('double'));
      ui();
      resume();
    },

    unmount() {
      alive++;
      phase = 'idle'; // an open hand stays on the server; it comes back next time
    },
  });
})();
