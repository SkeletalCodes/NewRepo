/* Limbo — set a target multiplier; a result is generated and you win if it lands at or above your target.
   P(result >= x) = 0.99 / x, so a higher target pays more and hits less often. */
(function () {
  'use strict';
  const { $, h, fmt, sleep, round2, clamp } = GG;

  const RISK = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['extreme', 'Extreme']];
  const TARGETS = { low: 1.5, medium: 2, high: 10, extreme: 100 };
  const MAX_TARGET = 1000000;

  let amount, target = 2, busy = false, alive = 0, counter = 0;
  const history = [];

  const chance = () => 99 / target;
  const riskOf = (t) => { for (const k in TARGETS) if (TARGETS[k] === t) return k; return ''; };
  const show = (v) => (v >= 10000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)) + '×';

  function paint() {
    $('#lb-chance').textContent = (chance() >= 0.01 ? chance().toFixed(chance() < 1 ? 4 : 2) : chance().toFixed(6)) + '%';
    $('#lb-profit').textContent = fmt(Math.max(0, amount.get() * target - amount.get()));
    $('#lb-goal').textContent = 'Target ' + show(target);
    GG.ui.setSeg($('#lb-risk'), riskOf(target));
  }

  function readTarget() {
    const v = parseFloat($('#lb-target').value);
    if (!isFinite(v) || v < 1.01 || v > MAX_TARGET) return false;
    target = round2(v);
    return true;
  }

  function paintHistory() {
    $('#lb-hist').innerHTML = history.slice(0, 12).map((r) => `<span class="hp ${r.won ? 'good' : 'bad'}">${show(r.v)}</span>`).join('') || '<span class="hp">No rounds yet</span>';
  }

  async function play() {
    if (busy) return;
    if (!readTarget()) { GG.toast('Target must be between 1.01× and 1,000,000×.', 'error'); $('#lb-target').focus(); return; }
    const bet = amount.get();
    const my = alive;
    busy = true;
    $('#lb-bet').disabled = true;
    const res = await GG.bet('limbo', bet, { target });
    if (my !== alive) return;
    if (!res) { busy = false; $('#lb-bet').disabled = false; return; }
    const result = res.bet.result.value, won = res.bet.payout > 0;

    // quick count-up to the result
    const num = $('#lb-num');
    num.className = 'lb-num rolling';
    const steps = 14;
    clearInterval(counter);
    let i = 0;
    await new Promise((done) => {
      counter = setInterval(() => {
        i++;
        const v = Math.pow(result, Math.pow(i / steps, 1.6));
        if (num.isConnected) num.textContent = show(v);
        if (i % 3 === 0) GG.sfx('tick', 0.5);
        if (i >= steps) { clearInterval(counter); done(); }
      }, 30);
    });
    if (my !== alive) return;
    GG.settle(res, { from: num });
    num.textContent = show(result);
    num.className = 'lb-num ' + (won ? 'won' : 'lost');
    GG.sfx(won ? 'win' : 'lose');
    history.unshift({ v: result, won });
    paintHistory();
    await sleep(120);
    busy = false;
    if ($('#lb-bet')) $('#lb-bet').disabled = false;
  }

  GG.registerGame({
    id: 'limbo',
    name: 'Limbo',
    rtp: '99.0',
    colors: ['#14b8a6', '#052a27'],
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.200"/><circle cx="12" cy="12" r="4.500" fill="none" stroke="currentColor" stroke-width="2.200"/><circle cx="12" cy="12" r="1.400" fill="currentColor"/></svg>',
    art: `<svg viewBox="0 0 200 200">
      <circle cx="100" cy="104" r="78" fill="#fff" opacity=".14"/><circle cx="100" cy="104" r="78" fill="none" stroke="#fff" stroke-width="7"/>
      <circle cx="100" cy="104" r="52" fill="none" stroke="#fff" stroke-width="7" opacity=".75"/><circle cx="100" cy="104" r="26" fill="#eac837"/>
      <path d="M158 40L112 92" stroke="#12141c" stroke-width="9" stroke-linecap="round"/><path d="M158 40L112 92" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
      <path d="M150 26l22 2-2 22-20 6 6-20z" fill="#ff5c7a"/><path d="M100 104l12-12" stroke="#12141c" stroke-width="5" stroke-linecap="round"/>
    </svg>`,

    mount(panel, stage) {
      busy = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Risk</span>${GG.ui.seg('lb-risk', RISK, riskOf(target))}</div>
        <div class="row2">
          <label class="gfield"><span class="gfield-l">Target</span><input type="text" inputmode="decimal" id="lb-target" value="${target.toFixed(2)}" maxlength="10"></label>
          <div class="gfield"><span class="gfield-l">Win chance</span><div class="readout" id="lb-chance"></div></div>
        </div>
        <div class="gfield"><span class="gfield-l">Profit on win</span><div class="readout">${GG.coin()}<span id="lb-profit">0.00</span></div></div>
        <button class="gbtn primary lg block" id="lb-bet">Bet</button>
      </div>`));
      stage.appendChild(h(`<div class="lb-wrap">
        <div class="history" id="lb-hist"></div>
        <div class="lb-num" id="lb-num">1.00×</div>
        <div class="lb-goal" id="lb-goal"></div>
      </div>`));
      GG.ui.bindSeg($('#lb-risk'), (v) => { if (busy) return; target = TARGETS[v]; $('#lb-target').value = target.toFixed(2); paint(); });
      $('#lb-target').addEventListener('input', (e) => {
        const clean = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
        if (clean !== e.target.value) e.target.value = clean;
        e.target.classList.toggle('bad', !readTarget());
        if (readTarget()) paint();
      });
      $('#lb-target').addEventListener('blur', (e) => { target = clamp(target, 1.01, MAX_TARGET); e.target.value = target.toFixed(2); e.target.classList.remove('bad'); paint(); });
      $('#lb-bet').addEventListener('click', play);
      amount.onChange(paint);
      paint(); paintHistory();
    },

    unmount() {
      alive++;
      clearInterval(counter);
      busy = false;
    },
  });
})();
