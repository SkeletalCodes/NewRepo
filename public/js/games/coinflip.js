/* Coinflip — call skull (heads) or crossbones (tails). One correct flip pays 1.98×.
   Raise the risk to need a streak: 2, 3 or 5 correct flips in a row for 3.96×, 7.92× or 31.68×.
   The coin is a real 3D object: two faces plus a stack of discs for its reeded edge. */
(function () {
  'use strict';
  const { $, $$, h, fmt, sleep } = GG;

  const RISK = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['extreme', 'Extreme']];
  const STREAK = { low: 1, medium: 2, high: 3, extreme: 5 }; // correct flips needed in a row
  const DARK = '#0b0c11';

  /* ---- artwork (gold relief on black enamel) ---- */
  const SKULL_OUT = 'M60 12C35 12 20 30 20 52c0 10 3.5 18 9 23l1 10c.4 4 3.5 7 7.5 7H41v6c0 3.300 2.700 6 6 6h26c3.300 0 6-2.700 6-6v-6h3.500c4 0 7.100-3 7.500-7l1-10c5.500-5 9-13 9-23 0-22-15-40-40-40z';
  const SKULL_HOLES = 'M29 58c0-8 6-12 14-11 7 .8 11 5.500 10 12.500-1 7.500-6 11.500-13 10.500-6.500-.9-11-5-11-12zM91 58c0-8-6-12-14-11-7 .8-11 5.500-10 12.500 1 7.500 6 11.500 13 10.500 6.500-.9 11-5 11-12zM60 66l-6 13c2 2 4.500 1.500 6-.5 1.500 2 4 2.500 6 .5z';
  const SKULL_IN = `
    <path d="${SKULL_OUT}" fill="url(#g-gold)" stroke="#6e4a06" stroke-width="1.400"/>
    <path d="M24 60c-2-14 4-30 18-38M96 60c2-14-4-30-18-38" fill="none" stroke="#8a5f0c" stroke-width="3" stroke-linecap="round" opacity=".35"/>
    <path d="M26 49c6-7 16-9 27-4M94 49c-6-7-16-9-27-4" fill="none" stroke="#7a5208" stroke-width="2.200" stroke-linecap="round" opacity=".75"/>
    <path d="${SKULL_HOLES}" fill="${DARK}"/>
    <path d="M31 77c3 3 6 4 10 4M89 77c-3 3-6 4-10 4" fill="none" stroke="#7a5208" stroke-width="1.600" stroke-linecap="round" opacity=".8"/>
    <path d="M41 92h38" stroke="${DARK}" stroke-width="2"/>
    <path d="M47.500 87v16M54 86v18M60 86v18M66 86v18M72.500 87v16" stroke="${DARK}" stroke-width="2" stroke-linecap="round"/>
    <path d="M33 37c5-10 15-17 27-18" fill="none" stroke="#fffbe0" stroke-width="3.200" stroke-linecap="round" opacity=".75"/>
    <path d="M72 14l-3 9 5 6-3 8" fill="none" stroke="#7a5208" stroke-width="1.400" stroke-linecap="round" stroke-linejoin="round"/>`;
  const BONE = '<rect x="22" y="53.500" width="76" height="13" rx="6.500"/><circle cx="20" cy="51.500" r="9.500"/><circle cx="20" cy="68.500" r="9.500"/><circle cx="100" cy="51.500" r="9.500"/><circle cx="100" cy="68.500" r="9.500"/>';
  const bone = (rot, shadow) => `<g transform="rotate(${rot} 60 60)">
      ${shadow ? `<g transform="translate(1.500 3)" fill="#000" opacity=".45">${BONE}</g>` : ''}
      <g fill="url(#g-gold)" stroke="#6e4a06" stroke-width="2.600">${BONE}</g><g fill="url(#g-gold)">${BONE}</g>
      <path d="M27 57h66" stroke="#fffbe0" stroke-width="2" stroke-linecap="round" opacity=".55"/>
      <circle cx="17.500" cy="48.500" r="2.600" fill="#fffbe0" opacity=".6"/><circle cx="97.500" cy="48.500" r="2.600" fill="#fffbe0" opacity=".6"/>
    </g>`;
  const BONES_IN = bone(38) + bone(-38, true);
  const SKULL = `<svg viewBox="0 0 120 120">${SKULL_IN}</svg>`;
  const BONES = `<svg viewBox="0 0 120 120">${BONES_IN}</svg>`;
  /* single-colour versions for the small history / picker coins */
  const SKULL_MINI = `<svg viewBox="0 0 120 120"><path fill="currentColor" fill-rule="evenodd" d="${SKULL_OUT}${SKULL_HOLES}"/></svg>`;
  const BONES_MINI = `<svg viewBox="0 0 120 120"><g fill="currentColor"><g transform="rotate(38 60 60)">${BONE}</g><g transform="rotate(-38 60 60)">${BONE}</g></g></svg>`;
  const mini = (s) => `<span class="cf-mini ${s}">${s === 'heads' ? SKULL_MINI : BONES_MINI}</span>`;
  const label = (s) => (s === 'heads' ? 'Skull' : 'Bones');

  let edges = '';
  for (let z = -6; z <= 6; z += 1.5) edges += `<i class="cf-edge" style="--z:${z}px"></i>`;

  let amount, side = 'heads', risk = 'low', busy = false, alive = 0, rot = 0;
  const history = [];

  const need = () => STREAK[risk];
  const payout = () => Math.floor(0.99 * Math.pow(2, need()) * 100) / 100; // 1.98, 3.96, 7.92, 31.68

  function paintStreak(done, state) {
    const box = $('#cf-streak'), n = need();
    if (!box) return;
    let out = '';
    for (let i = 0; n > 1 && i < n; i++) out += `<i class="${i < done ? 'ok' : i === done ? state || '' : ''}"></i>`;
    box.innerHTML = out;
  }

  function ui() {
    amount.lock(busy);
    $('#cf-flip').disabled = busy;
    $$('#cf-side button').forEach((b) => { b.disabled = busy; b.classList.toggle('on', b.dataset.v === side); });
    $$('#cf-risk button').forEach((b) => { b.disabled = busy; });
    $('#cf-profit').textContent = fmt(Math.max(0, amount.get() * (payout() - 1)));
    $('#cf-pays').textContent = payout().toFixed(2) + '×';
    $('#cf-need').innerHTML = need() === 1 ? 'One flip. Call it right and win — a <b>50%</b> chance.' : `<b>${need()}</b> correct flips in a row — a <b>${(100 / Math.pow(2, need())).toFixed(need() > 3 ? 2 : 1)}%</b> chance.`;
  }

  function paintHistory() {
    $('#cf-hist').innerHTML = history.slice(0, 16).map(mini).join('') || '<span class="hp">No flips yet</span>';
  }

  async function flip() {
    if (busy) return;
    const bet = amount.get();
    const my = alive;
    busy = true; ui();
    const res = await GG.bet('coinflip', bet, { side, risk });
    if (my !== alive) return;
    if (!res) { busy = false; ui(); return; }
    // the whole streak is decided up front on the server; the coin plays it out until the first miss
    const n = need(), flips = res.bet.result.flips, miss = flips.findIndex((f) => f !== side);
    const won = miss < 0, shownFlips = flips.length;
    const fast = n > 1, dur = fast ? 1150 : 1700;
    const coin = $('#cf-coin'), toss = $('#cf-toss'), shadow = $('.cf-shadow');
    coin.style.transitionDuration = toss.style.animationDuration = shadow.style.animationDuration = dur + 'ms';
    $('#cf-msg').className = 'cf-msg';
    let last = flips[0];
    for (let i = 0; i < shownFlips; i++) {
      last = flips[i];
      rot = Math.ceil(rot / 360) * 360 + (fast ? 1080 : 1800) + (last === 'tails' ? 180 : 0);
      coin.style.transform = `rotateX(${rot}deg)`;
      toss.classList.remove('go'); void toss.offsetWidth; toss.classList.add('go');
      paintStreak(i, 'now');
      GG.sfx('coin');
      await sleep(dur + 50);
      if (my !== alive) return; // unmount already settled it
      GG.sfx('coinLand');
      history.unshift(last);
      paintHistory();
      const ok = last === side;
      paintStreak(ok ? i + 1 : i, ok ? '' : 'no');
      if (ok && i < shownFlips - 1) { GG.sfx('gem', i * 3); await sleep(280); if (my !== alive) return; }
    }
    GG.settle(res, { from: coin });
    setTimeout(() => GG.sfx(won ? (n >= 3 ? 'bigwin' : 'win') : 'lose'), 140);
    if (won && n >= 3) GG.confetti($('.cf-wrap'), 60);
    const msg = $('#cf-msg');
    msg.className = 'cf-msg show ' + (won ? 'good' : 'bad');
    msg.innerHTML = won
      ? `<b>${n > 1 ? n + ' in a row!' : label(last) + '!'}</b> You won ${GG.coin('sm')}${fmt((res.bet.payout - res.bet.amount) / 100)}`
      : `<b>${label(last)}.</b> ${n > 1 ? (miss === 0 ? 'Missed on the first flip' : 'Streak ended on flip ' + (miss + 1) + ' of ' + n) : 'Not this time'}`;
    busy = false; ui();
  }

  GG.registerGame({
    id: 'coinflip',
    name: 'Coin Flip',
    rtp: '99.0',
    colors: ['#8492b3', '#191f2e'],
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor"/><circle cx="12" cy="12" r="5.500" fill="none" stroke="#101218" stroke-width="1.800"/></svg>',
    art: `<svg viewBox="0 0 200 200">
      <circle cx="100" cy="112" r="80" fill="#6e4a06"/><circle cx="100" cy="108" r="80" fill="#a8730f"/>
      <circle cx="100" cy="100" r="80" fill="url(#g-gold-rim)"/>
      <circle cx="100" cy="100" r="67" fill="#14151b"/><circle cx="100" cy="100" r="67" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="3"/>
      <circle cx="100" cy="100" r="70.500" fill="none" stroke="#fff3c0" stroke-opacity=".7" stroke-width="1.200"/>
      <g transform="translate(46 44) scale(.9)">${SKULL_IN}</g>
    </svg>`,

    mount(panel, stage) {
      busy = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Your call</span>
          <div class="cf-side" id="cf-side">
            <button data-v="heads">${mini('heads')}Skull</button>
            <button data-v="tails">${mini('tails')}Bones</button>
          </div></div>
        <div class="gfield"><span class="gfield-l">Risk</span>${GG.ui.seg('cf-risk', RISK, risk)}</div>
        <p class="risk-note" id="cf-need"></p>
        <div class="gfield"><span class="gfield-l">Profit on win <em style="font-style:normal;color:var(--dim)" id="cf-pays">1.98×</em></span>
          <div class="readout">${GG.coin()}<span id="cf-profit">0.00</span></div></div>
        <button class="gbtn primary lg block" id="cf-flip">Flip coin</button>
        <p class="panel-note">Skull is heads, crossbones is tails. Higher risk needs a streak: every flip has to land on your call.</p>
      </div>`));
      stage.appendChild(h(`<div class="cf-wrap">
        <div class="cf-hist" id="cf-hist"></div>
        <div class="cf-streak" id="cf-streak"></div>
        <div class="cf-arena">
          <div class="cf-toss" id="cf-toss">
            <div class="cf-tilt">
              <div class="cf-coin" id="cf-coin" style="transform:rotateX(${rot}deg)">
                <div class="cf-face heads"><div class="cf-enamel"></div>${SKULL}</div>
                ${edges}
                <div class="cf-face tails"><div class="cf-enamel"></div>${BONES}</div>
              </div>
            </div>
          </div>
          <div class="cf-shadow"></div>
        </div>
        <div class="cf-msg" id="cf-msg"></div>
      </div>`));
      $('#cf-side').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || b.disabled) return;
        side = b.dataset.v;
        GG.sfx('click');
        ui();
      });
      $('#cf-flip').addEventListener('click', flip);
      GG.ui.bindSeg($('#cf-risk'), (v) => { if (busy) return; risk = v; paintStreak(0); ui(); });
      amount.onChange(ui);
      ui(); paintHistory(); paintStreak(0);
    },

    unmount() {
      alive++;
      busy = false; rot %= 360;
    },
  });
})();
