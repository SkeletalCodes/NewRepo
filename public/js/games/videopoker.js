/* Video Poker — Jacks or Better with the full-pay 9/6 table. Deal five cards, hold the ones you want,
   draw replacements for the rest. One shuffled 52-card deck per hand, dealt by the server. */
(function () {
  'use strict';
  const { $, $$, h, fmt, fmtMult, sleep } = GG;

  const PAYS = [
    ['royal', 'Royal flush', 800], ['straight_flush', 'Straight flush', 50], ['four', 'Four of a kind', 25], ['full', 'Full house', 9],
    ['flush', 'Flush', 6], ['straight', 'Straight', 4], ['three', 'Three of a kind', 3], ['two_pair', 'Two pair', 2], ['jacks', 'Jacks or better', 1],
  ];
  const NAME = Object.fromEntries(PAYS.map(([k, n]) => [k, n]));

  let amount, state = 'idle', alive = 0, betId = 0, bet = 0, hand = [], held = new Set(), asking = false;

  function paintPay(hit, final) {
    $('#vp-pay').innerHTML = PAYS.map(([k, label, m]) =>
      `<div class="vp-row${hit === k ? (final ? ' on' : ' hint') : ''}"><span>${label}</span><b>${fmtMult(m)}</b><em>${GG.coin('sm')}${fmt(amount.get() * m)}</em></div>`).join('');
  }

  function paintCards(down) {
    const box = $('#vp-cards');
    box.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const c = hand[i];
      const slot = h(`<button type="button" class="vp-slot${held.has(i) ? ' held' : ''}" data-i="${i}" aria-label="Card ${i + 1}"><span class="vp-held">Held</span></button>`);
      slot.prepend(GG.cards.el(c || { r: '', s: '' }, down || !c));
      box.appendChild(slot);
    }
  }

  function msg(text, cls) {
    const el = $('#vp-msg');
    el.className = 'vp-msg' + (text ? ' show ' + (cls || '') : '');
    el.innerHTML = text || '';
  }

  function ui() {
    const holding = state === 'hold';
    amount.lock(state !== 'idle');
    const btn = $('#vp-btn');
    btn.textContent = holding ? 'Draw' : 'Deal';
    btn.className = holding ? 'gbtn green lg block' : 'gbtn primary lg block';
    btn.disabled = asking || state === 'busy';
    $('#vp-clear').disabled = !holding || asking;
    $('#vp-cards').classList.toggle('live', holding);
  }

  async function flipIn(i, c) {
    const slot = $$('.vp-slot')[i];
    if (!slot) return;
    const card = GG.cards.el(c, true);
    slot.querySelector('.pcard').replaceWith(card);
    void card.offsetWidth;
    await sleep(60);
    card.classList.remove('down');
    GG.sfx('card');
    await sleep(140);
  }

  async function deal() {
    if (state !== 'idle' || asking) return;
    bet = amount.get();
    const my = ++alive;
    asking = true; ui();
    const res = await GG.bet('videopoker', bet, {});
    asking = false;
    if (my !== alive) return;
    if (!res) { ui(); return; }
    betId = res.bet.id;
    state = 'busy';
    held = new Set();
    hand = [];
    $('#vp-res').className = 'result-pop';
    paintCards(true);
    msg('');
    ui();
    const v = res.bet.view;
    for (let i = 0; i < 5; i++) { hand[i] = v.dealt[i]; await flipIn(i, v.dealt[i]); if (my !== alive) return; }
    state = 'hold';
    paintPay(v.dealtHand !== 'none' ? v.dealtHand : null, false);
    msg(v.dealtHand !== 'none' ? `You have <b>${NAME[v.dealtHand]}</b>. Hold the cards to keep, then draw.` : 'Tap the cards you want to keep, then draw.', '');
    ui();
  }

  async function draw() {
    if (state !== 'hold' || asking) return;
    const my = alive;
    asking = true; ui();
    const res = await GG.act(betId, 'draw', { hold: [...held] });
    asking = false;
    if (my !== alive) return;
    if (!res) { ui(); return; }
    state = 'busy'; ui();
    const v = res.bet.view;
    for (let i = 0; i < 5; i++) {
      if (held.has(i)) continue;
      const slot = $$('.vp-slot')[i];
      slot.querySelector('.pcard').classList.add('down');
    }
    await sleep(260);
    for (let i = 0; i < 5; i++) {
      if (held.has(i)) continue;
      hand[i] = v.hand[i];
      await flipIn(i, v.hand[i]);
      if (my !== alive) return;
    }
    finish(res);
  }

  function finish(res) {
    const v = res.bet.view, mult = PAYS.find((x) => x[0] === v.result);
    const m = mult ? mult[2] : 0, wager = res.bet.amount / 100, payout = res.bet.payout / 100;
    GG.settle(res, { from: $('#vp-cards'), quiet: m <= 1 });
    paintPay(v.result !== 'none' ? v.result : null, true);
    $$('.vp-slot').forEach((s) => s.classList.remove('held'));
    const pop = $('#vp-res');
    if (m > 0) {
      pop.className = 'result-pop show' + (m === 1 ? ' push' : '');
      pop.innerHTML = `<b>${NAME[v.result]}</b><span>${GG.coin('sm')}${m > 1 ? '+' + fmt(payout - wager) : 'Bet returned'}</span>`;
      GG.sfx(m >= 25 ? 'bigwin' : m > 1 ? 'win' : 'push');
      if (m >= 25) GG.confetti($('.vp-wrap'), 80);
      msg(`<b>${NAME[v.result]}</b> pays ${fmtMult(m)}.`, 'good');
    } else {
      GG.sfx('lose');
      msg('No win this hand. Deal again?', 'bad');
    }
    held = new Set();
    state = 'idle';
    ui();
  }

  function toggle(i) {
    if (state !== 'hold' || asking) return;
    if (held.has(i)) held.delete(i); else held.add(i);
    GG.sfx('click');
    $$('.vp-slot')[i].classList.toggle('held', held.has(i));
  }

  /** A hand left open (reload, another tab): put it back so you can draw. */
  async function resume() {
    const b = await GG.active('videopoker');
    if (!b || state !== 'idle' || !$('#vp-btn')) return;
    betId = b.id; bet = b.amount / 100;
    hand = b.view.dealt.slice();
    held = new Set();
    paintCards(false);
    state = 'hold';
    paintPay(b.view.dealtHand !== 'none' ? b.view.dealtHand : null, false);
    msg('Your last hand is still open. Hold, then draw.', '');
    ui();
  }

  GG.registerGame({
    id: 'videopoker',
    name: 'Video Poker',
    rtp: '99.5',
    badge: 'NEW',
    cat: 'table',
    colors: ['#3b82f6', '#0b1d45'],
    icon: '<svg viewBox="0 0 24 24"><rect x="2.500" y="6" width="6" height="12" rx="1.400" fill="currentColor" opacity=".5"/><rect x="9" y="4" width="6" height="16" rx="1.400" fill="currentColor"/><rect x="15.500" y="6" width="6" height="12" rx="1.400" fill="currentColor" opacity=".5"/></svg>',
    art: `<svg viewBox="0 0 200 200">
      <rect x="18" y="40" width="164" height="120" rx="16" fill="#0b1d45" stroke="#eac837" stroke-width="5"/>
      ${[0, 1, 2, 3, 4].map((i) => `<g transform="translate(${30 + i * 29} 62)"><rect width="25" height="38" rx="4" fill="#fff"/><text x="12.500" y="17" font-size="13" font-weight="800" text-anchor="middle" fill="${i % 2 ? '#e3324c' : '#151821'}" font-family="Inter,Arial,sans-serif">${['10', 'J', 'Q', 'K', 'A'][i]}</text><text x="12.500" y="33" font-size="13" text-anchor="middle" fill="${i % 2 ? '#e3324c' : '#151821'}" font-family="Arial,sans-serif">${i % 2 ? '♥︎' : '♠︎'}</text></g>`).join('')}
      <rect x="30" y="112" width="140" height="14" rx="7" fill="#eac837"/><text x="100" y="123" font-size="10" font-weight="800" text-anchor="middle" fill="#0b0d14" font-family="Inter,Arial,sans-serif">ROYAL FLUSH 800×</text>
      <rect x="62" y="134" width="76" height="16" rx="8" fill="#14f195"/>
    </svg>`,

    mount(panel, stage) {
      state = 'idle'; hand = []; held = new Set(); asking = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <button class="gbtn primary lg block" id="vp-btn">Deal</button>
        <button class="gbtn ghost block" id="vp-clear" style="margin-top:10px">Clear holds</button>
        <p class="panel-note">Jacks or Better. Deal five cards, tap the ones you want to keep, then draw. A pair of jacks or better gives your bet back; a royal flush pays 800×.</p>
      </div>`));
      stage.appendChild(h(`<div class="vp-wrap">
        <div class="vp-pay" id="vp-pay"></div>
        <div class="vp-cards" id="vp-cards"></div>
        <div class="vp-msg" id="vp-msg"></div>
        <div class="result-pop" id="vp-res"></div>
      </div>`));
      paintCards(true);
      paintPay(null);
      $('#vp-btn').addEventListener('click', () => (state === 'hold' ? draw() : deal()));
      $('#vp-clear').addEventListener('click', () => { held = new Set(); $$('.vp-slot').forEach((s) => s.classList.remove('held')); });
      $('#vp-cards').addEventListener('click', (e) => { const s = e.target.closest('.vp-slot'); if (s) { if (state === 'idle') GG.nudge($('#vp-btn')); else toggle(Number(s.dataset.i)); } });
      amount.onChange(() => paintPay(null));
      ui();
      resume();
    },

    unmount() {
      alive++;
      state = 'idle'; // an open hand stays on the server
    },
  });
})();
