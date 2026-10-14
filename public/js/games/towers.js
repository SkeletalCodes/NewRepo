/* Towers — climb 8 floors. Each floor hides a trap; every safe step multiplies the payout. */
(function () {
  'use strict';
  const { $, $$, h, fmt, fmtMult } = GG;

  const ROWS = 8;
  const LEVELS = {
    easy: { cols: 4, bombs: 1, label: 'Easy' },
    medium: { cols: 3, bombs: 1, label: 'Medium' },
    hard: { cols: 2, bombs: 1, label: 'Hard' },
    extreme: { cols: 3, bombs: 2, label: 'Extreme' },
  };
  const SAFE = '<svg viewBox="0 0 24 24"><path d="M12 2.500l2.900 6.200 6.600.8-4.900 4.600 1.300 6.600L12 17.400l-5.900 3.300 1.300-6.600L2.500 9.500l6.600-.8z" fill="currentColor"/></svg>';
  const TRAP = '<svg viewBox="0 0 24 24"><path d="M12 3a8 8 0 0 0-5 14.200V20a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.800A8 8 0 0 0 12 3zM9 14.500a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" fill="currentColor"/></svg>';

  let amount, diff = 'medium', state = 'idle', level = 0, bet = 0, traps = [], betId = 0, asking = false, alive = 0;

  const cfg = () => LEVELS[diff];
  const multFor = (k) => Math.floor(0.98 * Math.pow(cfg().cols / (cfg().cols - cfg().bombs), k) * 100) / 100;

  function build() {
    const c = cfg();
    let html = '';
    for (let r = ROWS - 1; r >= 0; r--) {
      let tiles = '';
      for (let i = 0; i < c.cols; i++) tiles += `<button class="tw-tile" data-r="${r}" data-c="${i}"><span>${fmtMult(multFor(r + 1))}</span></button>`;
      html += `<div class="tw-row" data-r="${r}" style="--cols:${c.cols}">${tiles}</div>`;
    }
    $('#tw-tower').innerHTML = html;
  }

  function ui() {
    const playing = state === 'playing';
    amount.lock(playing);
    $$('#tw-diff button').forEach((b) => { b.disabled = playing; });
    const btn = $('#tw-btn');
    if (playing) {
      btn.className = 'gbtn green lg block';
      btn.disabled = level === 0 || asking;
      btn.innerHTML = level ? `Cash out ${GG.coin('sm')}${fmt(bet * multFor(level))}` : 'Pick a tile on floor 1';
    } else {
      btn.className = 'gbtn primary lg block'; btn.disabled = false; btn.textContent = 'Bet';
    }
    $$('.tw-row').forEach((row) => row.classList.toggle('active', playing && Number(row.dataset.r) === level));
    $('#tw-mult').textContent = fmtMult(level ? multFor(level) : 1);
    $('#tw-floor').textContent = `${level} / ${ROWS}`;
  }

  function revealRow(r, pickedCol) {
    $$(`.tw-tile[data-r="${r}"]`).forEach((t) => {
      const c = Number(t.dataset.c), trap = !!traps[r] && traps[r].has(c);
      if (c === pickedCol) { t.classList.add(trap ? 'trap' : 'safe'); t.innerHTML = trap ? TRAP : SAFE; }
      else if (trap) { t.classList.add('trap', 'dim'); t.innerHTML = TRAP; }
      else t.classList.add('dim');
    });
  }

  function finish(won, mult, payout) {
    state = 'idle';
    for (let r = 0; r < ROWS; r++) {
      $$(`.tw-tile[data-r="${r}"]`).forEach((t) => {
        if (t.classList.contains('safe') || t.classList.contains('trap')) return;
        if (traps[r] && traps[r].has(Number(t.dataset.c))) { t.classList.add('trap', 'dim'); t.innerHTML = TRAP; }
      });
    }
    if (won) {
      const pop = $('#tw-res');
      pop.className = 'result-pop show';
      pop.innerHTML = `<b>${fmtMult(mult)}</b><span>${GG.coin('sm')}+${fmt(payout - bet)}</span>`;
    }
    ui();
  }

  const setTraps = (view) => { traps = view.traps.map((row) => new Set(row)); };

  async function cashout() {
    if (state !== 'playing' || !level || asking) return;
    const my = alive;
    asking = true; ui();
    const res = await GG.act(betId, 'cashout');
    asking = false;
    if (my !== alive) return;
    if (!res) { ui(); return; }
    won(res);
  }

  function won(res) {
    setTraps(res.bet.view);
    GG.settle(res, { from: $('#tw-tower') });
    GG.sfx('cashout');
    finish(true, multFor(level), res.bet.payout / 100);
  }

  async function pick(r, c) {
    if (state !== 'playing' || r !== level || asking) return;
    const my = alive;
    asking = true; ui();
    const res = await GG.act(betId, 'pick', { col: c });
    asking = false;
    if (my !== alive) return;
    if (!res) { ui(); return; }
    setTraps(res.bet.view);
    revealRow(r, c);
    if (traps[r].has(c)) {
      GG.settle(res);
      GG.sfx('bomb');
      $('#tw-tower').classList.add('shake');
      setTimeout(() => { const t = $('#tw-tower'); if (t) t.classList.remove('shake'); }, 450);
      finish(false);
      return;
    }
    level++;
    GG.sfx('gem', level * 2);
    if (res.bet.status === 'settled') won(res); else ui(); // the top floor pays out by itself
  }

  async function start() {
    if (state !== 'idle' || asking) return;
    bet = amount.get();
    const my = alive;
    asking = true;
    $('#tw-btn').disabled = true;
    const res = await GG.bet('towers', bet, { difficulty: diff });
    asking = false;
    if (my !== alive) return;
    if (!res) { ui(); return; }
    betId = res.bet.id;
    traps = [];
    level = 0;
    build();
    $('#tw-res').className = 'result-pop';
    state = 'playing';
    ui();
  }

  /** A climb left open (reload, another tab): rebuild the tower where it was. */
  async function resume() {
    const b = await GG.active('towers');
    if (!b || state !== 'idle' || !$('#tw-btn')) return;
    betId = b.id; bet = b.amount / 100; diff = b.view.difficulty;
    $$('#tw-diff button').forEach((x) => x.classList.toggle('on', x.dataset.v === diff));
    build();
    setTraps(b.view);
    b.view.picks.forEach((c, r) => revealRow(r, c));
    level = b.view.picks.length;
    state = 'playing';
    ui();
    GG.toast('Your last climb is still open.', 'info');
  }

  function art() {
    let s = '';
    const cols = ['#fff', '#fff', '#fff'];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        const lit = (r === 0 && c === 1) || (r === 1 && c === 0) || (r === 2 && c === 1) || (r === 3 && c === 2);
        s += `<rect x="${34 + c * 46}" y="${152 - r * 31}" width="40" height="25" rx="8" fill="${lit ? '#eac837' : cols[c]}" opacity="${lit ? 1 : r === 4 ? .5 : .22}"/>`;
      }
    }
    return `<svg viewBox="0 0 200 200">${s}<path d="M100 8l5 10.500 11.500 1.400-8.500 8 2.200 11.400L100 33.600l-10.200 5.700 2.200-11.400-8.500-8 11.500-1.400z" fill="#eac837"/></svg>`;
  }

  GG.registerGame({
    id: 'towers',
    name: 'Towers',
    rtp: '98.0',
    colors: ['#ff8a3d', '#3a1505'],
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="9" y="3" width="6" height="4.500" rx="1.400"/><rect x="6.500" y="9.500" width="11" height="4.500" rx="1.400"/><rect x="3.500" y="16" width="17" height="4.500" rx="1.400"/></svg>',
    art: art(),

    mount(panel, stage) {
      state = 'idle'; level = 0; traps = []; asking = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Difficulty</span>
          <div class="gseg" id="tw-diff">${Object.keys(LEVELS).map((k) => `<button data-v="${k}" class="${k === diff ? 'on' : ''}">${LEVELS[k].label}</button>`).join('')}</div></div>
        <div class="row2">
          <div class="gfield"><span class="gfield-l">Multiplier</span><div class="readout" id="tw-mult">1.00×</div></div>
          <div class="gfield"><span class="gfield-l">Floor</span><div class="readout" id="tw-floor">0 / 8</div></div>
        </div>
        <button class="gbtn primary lg block" id="tw-btn">Bet</button>
        <p class="panel-note">Start at the bottom and pick one tile per floor. Hit a skull and the run ends — cash out whenever you like.</p>
      </div>`));
      stage.appendChild(h(`<div class="tw-wrap"><div class="tw-tower" id="tw-tower"></div><div class="result-pop" id="tw-res"></div></div>`));
      build();
      $('#tw-tower').addEventListener('click', (e) => {
        const t = e.target.closest('.tw-tile');
        if (!t) return;
        if (state !== 'playing') { GG.nudge($('#tw-btn')); return; }
        pick(Number(t.dataset.r), Number(t.dataset.c));
      });
      $('#tw-btn').addEventListener('click', () => (state === 'playing' ? cashout() : start()));
      $('#tw-diff').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || b.disabled) return;
        diff = b.dataset.v;
        $$('#tw-diff button').forEach((x) => x.classList.toggle('on', x === b));
        $('#tw-res').className = 'result-pop';
        build(); ui();
      });
      ui();
      resume();
    },

    unmount() {
      alive++;
      state = 'idle'; // an open climb stays on the server
    },
  });
})();
