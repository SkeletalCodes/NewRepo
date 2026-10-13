/* GoldRush games: lobby + 16 games. Every result comes from the server (/api/games); this file only animates it. */
(() => {
  'use strict';

  const GR = window.GR;
  const { $, $$, esc, money, api, toast } = GR;
  const sleep = (ms) => new Promise((r) => setTimeout(r, GR.reduced ? Math.min(ms, 60) : ms));
  const fmtMult = (m) => `${Number(m).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;
  const pct = (x) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

  /* Order, icons and blurbs for the lobby. */
  const LIST = [
    ['crash', 'Crash', 'fa-rocket', '#ff5c7a', 'Cash out before it crashes.'],
    ['mines', 'Mines', 'fa-bomb', '#14f195', 'Find gems, dodge mines.'],
    ['plinko', 'Plinko', 'fa-circle-nodes', '#eac837', 'Drop the ball, hit the edges.'],
    ['dice', 'Dice', 'fa-dice', '#7dd3fc', 'Roll under or over your number.'],
    ['blackjack', 'Blackjack', 'fa-diamond', '#14f195', 'Beat the dealer to 21.'],
    ['roulette', 'Roulette', 'fa-circle-dot', '#ff5c7a', 'European single-zero wheel.'],
    ['limbo', 'Limbo', 'fa-arrow-trend-up', '#a78bfa', 'Pick a target, hope it clears.'],
    ['towers', 'Towers', 'fa-chess-rook', '#f59e0b', 'Climb eight floors.'],
    ['hilo', 'Hi-Lo', 'fa-arrows-up-down', '#7dd3fc', 'Higher or lower, again and again.'],
    ['keno', 'Keno', 'fa-table-cells', '#eac837', 'Pick numbers, watch the draw.'],
    ['wheel', 'Wheel', 'fa-dharmachakra', '#f472b6', 'Spin for a multiplier.'],
    ['pump', 'Pump', 'fa-wind', '#ff5c7a', 'Inflate it, don\'t pop it.'],
    ['coinflip', 'Coin Flip', 'fa-coins', '#eac837', 'Call it, or call a streak.'],
    ['diamonds', 'Diamonds', 'fa-gem', '#a78bfa', 'Five gems, poker hands.'],
    ['baccarat', 'Baccarat', 'fa-clone', '#14f195', 'Player, Banker or Tie.'],
    ['double', 'Double', 'fa-circle-half-stroke', '#ff5c7a', 'Red, black or green.'],
  ];
  const INFO = Object.fromEntries(LIST.map(([id, name, icon, color, blurb]) => [id, { id, name, icon, color, blurb }]));

  const HOW = {
    blackjack: ['Get closer to 21 than the dealer without going over.', 'Hit takes a card, Stand stops, Double doubles your bet for exactly one more card.', 'Face cards count 10, aces 1 or 11. The dealer stands on 17.', 'Blackjack pays 3 to 2. A tie returns your bet.'],
    baccarat: ['Bet on Player, Banker or Tie before the deal.', 'Tens and faces count zero and only the last digit counts. Closest to 9 wins.', 'Third cards follow the standard rules.', 'Player pays 1:1, Banker 0.95:1, Tie 8:1. A tie returns Player and Banker bets.'],
    roulette: ['Pick a chip, click the table to place it. Right-click a spot to remove chips.', 'A single number pays 35:1, dozens and columns 2:1, red/black, odd/even and high/low 1:1.', 'Zero loses every outside bet.'],
    hilo: ['Bet to draw a card. Ace is lowest, King highest.', 'Call higher-or-same or lower-or-same. On an Ace or King it becomes strict higher/lower, plus a long-shot Same.', 'Each button shows the multiplier you\'ll have if that call lands. Skip swaps the card for free.', 'Cash out whenever you like. One wrong call loses the bet.'],
    keno: ['Pick 1 to 10 numbers from 40.', 'Ten numbers are drawn. More hits pay more.', 'The pay table shows what each number of hits pays at your risk level.'],
    dice: ['A number from 0.00 to 100.00 is rolled.', 'Set your target and choose roll under or over.', 'The multiplier is 99 divided by your win chance.'],
    limbo: ['Set a target multiplier.', 'If the result lands at or above your target, you win bet × target.', 'Win chance is 99 ÷ target.'],
    plinko: ['Choose rows and risk, then drop balls.', 'Each ball bounces left or right at every peg and lands in a bucket.', 'Edge buckets pay the most and are the hardest to reach.'],
    wheel: ['Choose risk and number of segments.', 'The pointer lands on one segment and pays its multiplier.'],
    diamonds: ['Five gems are drawn, each one of seven colours.', 'Matching colours make hands like poker: pair, two pair, three, full house, four, five.', 'The pay table shows each hand\'s multiplier.'],
    double: ['Pick red, black or green.', 'The strip lands on one of 15 tiles: 7 red, 7 black, 1 green.', 'Red and black pay 2×, green pays 14×.'],
    coinflip: ['Call heads or tails.', 'One flip pays 1.98×. Raise the streak to need 2, 3 or 5 correct flips in a row for more.', 'The first miss ends it.'],
    crash: ['Bet to launch. The multiplier climbs from 1.00×.', 'Cash out before it crashes to win bet × multiplier.', 'Set an auto cash out to bank a target automatically.'],
    mines: ['Choose how many mines hide in the 5×5 grid.', 'Every gem raises the multiplier. Cash out any time after your first gem.', 'Hit a mine and the bet is lost.'],
    towers: ['Pick a difficulty and climb one floor at a time.', 'Each floor hides a trap. Every safe step multiplies your payout.', 'Cash out any time, or reach the top.'],
    pump: ['Each pump inflates the balloon and raises the multiplier.', 'Cash out before it pops.', 'Difficulty sets how soon a pop is likely.'],
  };

  let cfg = null;
  let alive = 0; // bumped when you leave a game, so its animations stop
  const loadCfg = async () => { if (!cfg) cfg = await api('/games/config'); return cfg; };

  /* -------------------------------------------------------------- helpers */

  const me = () => GR.state.user;
  const needLogin = () => { if (me()) return false; GR.openAuth('register'); return true; };

  /** Show the balance minus the stake right away; the real balance arrives with the result. */
  const predebit = (cents) => { if (me()) GR.showBalance(me().balance - cents); };

  /** Apply the server's balance once the animation is done; wins fly coins from `fromEl`. */
  function settleFx(res, fromEl) {
    const b = res.bet;
    const stage = $('#g-stage');
    const net = b.payout - b.amount;
    if (stage && b.status === 'settled') {
      stage.classList.remove('fx-win', 'fx-lose');
      void stage.offsetWidth;
      if (net !== 0) stage.classList.add(net > 0 ? 'fx-win' : 'fx-lose');
    }
    if (b.payout > 0 && fromEl && fromEl.isConnected) GR.creditFx(fromEl, res.user, Math.min(16, 5 + Math.round(b.multiplier)));
    else GR.setUser(res.user);
    if (b.status === 'settled' && b.multiplier >= 10 && b.payout > 0) GR.coinRain(Math.min(40, 18 + Math.round(b.multiplier / 5)));
    if (b.status === 'settled') refreshBets();
  }

  async function bet(game, amount, params) {
    if (needLogin()) return null;
    try {
      const res = await api(`/games/${game}/bet`, { body: { amount, params } });
      return res;
    } catch (err) {
      toast(err.message, 'error');
      if (me()) GR.showBalance(me().balance);
      return null;
    }
  }

  async function act(id, action, params = {}) {
    try { return await api(`/games/bets/${id}/action`, { body: { action, params } }); } catch (err) { toast(err.message, 'error'); return null; }
  }

  /** Bet amount box (dollars) with ½, 2× and max. Remembers the last amount. */
  function amountField() {
    let saved = 1;
    try { saved = Number(localStorage.getItem('gr_bet')) || 1; } catch { /* ignore */ }
    const el = document.createElement('div');
    el.className = 'g-field';
    el.innerHTML = `<label>Bet amount</label><div class="g-amount"><i class="fa-solid fa-dollar-sign"></i>
      <input type="number" min="0.01" step="0.01" inputmode="decimal" value="${saved.toFixed(2)}" aria-label="Bet amount">
      <button type="button" data-a="half">½</button><button type="button" data-a="double">2×</button><button type="button" data-a="max">Max</button></div>`;
    const input = $('input', el);
    const listeners = [];
    const set = (v) => {
      const max = cfg ? cfg.max / 100 : 100;
      const min = cfg ? cfg.min / 100 : 0.1;
      input.value = Math.max(min, Math.min(max, Math.round(v * 100) / 100)).toFixed(2);
      try { localStorage.setItem('gr_bet', input.value); } catch { /* ignore */ }
      listeners.forEach((f) => f());
    };
    $$('button', el).forEach((b) => b.addEventListener('click', () => {
      const v = Number(input.value) || 0;
      if (b.dataset.a === 'half') set(v / 2);
      if (b.dataset.a === 'double') set(v * 2);
      if (b.dataset.a === 'max') set(Math.min(me() ? me().balance / 100 : 1, cfg ? cfg.max / 100 : 100));
    }));
    input.addEventListener('change', () => set(Number(input.value) || 0));
    input.addEventListener('input', () => listeners.forEach((f) => f()));
    return {
      el,
      get: () => Math.round((Number(input.value) || 0) * 100),
      lock: (on) => { input.disabled = on; $$('button', el).forEach((b) => { b.disabled = on; }); },
      onChange: (f) => listeners.push(f),
    };
  }

  const seg = (id, opts, cur) => `<div class="g-seg" id="${id}">${opts.map(([v, l]) => `<button type="button" data-v="${esc(v)}" class="${String(v) === String(cur) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  function bindSeg(el, cb) {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      $$('button', el).forEach((x) => x.classList.toggle('on', x === b));
      cb(b.dataset.v);
    });
  }
  const segLock = (el, on) => $$('button', el).forEach((b) => { b.disabled = on; });
  const readout = (label, id, val = '') => `<div class="g-field"><label>${label}</label><div class="g-readout" id="${id}">${val}</div></div>`;
  const RISK3 = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

  /* ----------------------------------------------------------------- cards */

  const cardHTML = (c, down = false, cls = '') => `<div class="pcard ${c && c.red ? 'red' : ''} ${down ? 'down' : ''} ${cls}">
    <div class="pc-in"><div class="pc-f"><span class="pc-r">${c ? esc(c.r) : ''}</span><span class="pc-s">${c ? esc(c.s) : ''}</span><span class="pc-big">${c ? esc(c.s) : ''}</span></div><div class="pc-b"></div></div></div>`;

  const GEM_COLORS = [['#ff4d67', '#ffc2cb', '#b01f3a'], ['#2fe08a', '#b8f7d6', '#149454'], ['#4d8dff', '#c3d8ff', '#2456c2'], ['#ffb52e', '#ffe6ad', '#c27a05'],
    ['#9b6bff', '#ddd0ff', '#5f35c9'], ['#22d3ee', '#baf2fa', '#0b8ea3'], ['#ff5cc8', '#ffc9ee', '#b8248a']];
  const gemSVG = (i) => { const [a, l, d] = GEM_COLORS[i]; return `<svg viewBox="0 0 48 48"><path d="M24 5L43 19L24 44L5 19Z" fill="${a}"/><path d="M24 5L33 19H15Z" fill="${l}"/><path d="M5 19H15L24 44Z" fill="${d}"/><path d="M43 19H33L24 44Z" fill="${d}" opacity=".75"/><path d="M5 19L24 5L15 19Z" fill="${l}" opacity=".6"/></svg>`; };

  /* ------------------------------------------------------------ game page */

  function shellHTML(id) {
    const g = INFO[id];
    const c = cfg.games.find((x) => x.id === id);
    return `<div class="g-head">
        <a href="#/games" class="muted" style="font-weight:600"><i class="fa-solid fa-arrow-left"></i> All games</a>
        <div class="row" style="gap:14px"><span class="g-badge" style="--c:${g.color}"><i class="fa-solid ${g.icon}"></i></span>
          <div><h1>${esc(g.name)}</h1><small class="faint">RTP ${c ? c.rtp : 99}% · max win ${money(cfg.maxWin)} per bet</small></div></div>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="g-how"><i class="fa-solid fa-circle-question"></i> How to play</button>
        <button class="btn btn-sm" id="g-fair"><i class="fa-solid fa-shield-halved"></i> Provably fair</button>
      </div>
      <div class="g-layout">
        <aside class="press quiet g-panel" id="g-panel"></aside>
        <section class="g-stage" id="g-stage"></section>
      </div>
      <div class="sec-title"><i class="fa-solid fa-clock-rotate-left"></i> Your ${esc(g.name)} bets</div>
      <div id="g-bets"></div>
      <p class="g-legal"><i class="fa-solid fa-circle-info"></i> 18+ only. Bets use your real balance and results are final. Play for fun, not to make money.</p>`;
  }

  let currentGame = null;

  async function play(id) {
    alive++;
    if (!INFO[id]) { GR.go('games'); return; }
    GR.page(GR.skels(1, 420));
    try { await loadCfg(); } catch (err) { GR.setContent(GR.emptyHTML(err.message, 'fa-triangle-exclamation')); return; }
    if (!cfg.enabled && !(me() && me().role === 'admin')) {
      GR.setContent(GR.emptyHTML('Games are switched off right now. Check back soon.', 'fa-power-off'));
      return;
    }
    currentGame = id;
    GR.setContent(shellHTML(id));
    $('#g-how').addEventListener('click', () => GR.openModal(`<div class="modal-body"><div class="modal-head"><h2>How to play ${esc(INFO[id].name)}</h2></div>
      <ul class="g-how">${HOW[id].map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`));
    $('#g-fair').addEventListener('click', () => openFair());
    const token = alive;
    GAMES[id].mount($('#g-panel'), $('#g-stage'), token);
    refreshBets();
  }

  async function refreshBets() {
    const el = $('#g-bets');
    if (!el || !currentGame) return;
    if (!me()) { el.innerHTML = GR.emptyHTML('Log in to play and see your bets here.', 'fa-user'); return; }
    try {
      const { bets } = await api(`/games/bets?game=${currentGame}`);
      if (!$('#g-bets')) return;
      el.innerHTML = bets.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Bet</th><th>Multiplier</th><th style="text-align:right">Payout</th><th></th></tr></thead><tbody>
        ${bets.filter((b) => b.status === 'settled').slice(0, 15).map((b) => `<tr><td class="faint">${esc(GR.dateTime(b.created_at))}</td><td class="money">${money(b.amount)}</td>
          <td><span class="badge ${b.payout > b.amount ? 'b-green' : b.payout === b.amount ? 'b-gray' : 'b-red'}">${fmtMult(b.multiplier)}</span></td>
          <td style="text-align:right" class="money ${b.payout > b.amount ? 'green' : b.payout < b.amount ? 'red' : ''}">${b.payout >= b.amount ? '+' : '−'}${money(Math.abs(b.payout - b.amount))}</td>
          <td><button class="btn btn-sm" data-vb="${b.id}">Verify</button></td></tr>`).join('')}</tbody></table></div>` : GR.emptyHTML('No bets yet. Good luck!', 'fa-dice');
      $$('[data-vb]', el).forEach((btn) => btn.addEventListener('click', () => openFair(bets.find((x) => String(x.id) === btn.dataset.vb))));
    } catch { /* ignore */ }
  }

  /* -------------------------------------------------------- provably fair */

  async function openFair(forBet) {
    let seeds = null;
    if (me()) { try { seeds = await api('/games/fair'); } catch { /* ignore */ } }
    const copyRow = (label, value, id = '') => `<div class="field"><label>${label}</label><div class="copy-box"><input class="input mono" readonly value="${esc(value)}" ${id ? `id="${id}"` : ''}><button class="btn btn-sm" data-copy><i class="fa-solid fa-copy"></i></button></div></div>`;
    GR.openModal(`<div class="modal-body"><div class="modal-head"><h2><i class="fa-solid fa-shield-halved gold"></i> Provably fair</h2>
        <p>Every result comes from <span class="code inline">HMAC-SHA256(server seed, client seed:nonce:block)</span>. You see the server seed's hash before you bet, so it can't be changed afterwards.</p></div>
      <div class="tabs" style="margin-bottom:18px"><a href="#" class="tab active" data-t="seeds">Seeds</a><a href="#" class="tab" data-t="verify">Verify a bet</a></div>
      <div data-p="seeds">${seeds ? `
        ${copyRow('Your client seed', seeds.client_seed)}
        ${copyRow('Server seed (hashed)', seeds.server_hash)}
        <div class="field"><label>Bets made with this pair</label><div class="g-readout">${seeds.nonce}</div></div>
        <div class="field"><label>New client seed</label><div class="copy-box"><input class="input mono" id="fr-new" maxlength="64" value="${Math.random().toString(36).slice(2, 12)}"><button class="btn btn-gold btn-sm" id="fr-rotate">Rotate</button></div>
          <small class="faint">Rotating reveals the current server seed so you can check every bet made with it.</small></div>
        ${copyRow('Next server seed (hashed)', seeds.next_hash)}
        ${seeds.previous ? `<div class="form-sec"><div class="label"><i class="fa-solid fa-lock-open"></i> Previous pair, revealed</div>
          ${copyRow('Server seed', seeds.previous.server_seed)}${copyRow('Client seed', seeds.previous.client_seed)}
          <small class="faint">${seeds.previous.nonce} bets were made with it.</small></div>` : ''}`
    : '<div class="empty">Log in to get your own seed pair. The Verify tab works for anyone.</div>'}</div>
      <div data-p="verify" hidden>
        <div class="grid-2">
          <div class="field"><label>Game</label><select class="input" id="fv-game">${LIST.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></div>
          <div class="field"><label>Nonce</label><input class="input" id="fv-nonce" type="number" min="0" value="1"></div>
        </div>
        <div class="field"><label>Client seed</label><input class="input mono" id="fv-client"></div>
        <div class="field"><label>Server seed (revealed)</label><input class="input mono" id="fv-server" placeholder="Shown after you rotate your seed pair"></div>
        <input type="hidden" id="fv-params" value="{}">
        <button class="btn btn-gold btn-block" id="fv-go">Verify</button>
        <div id="fv-out" class="mt-16"></div>
      </div></div>`, { cls: 'wide' });
    const setTab = (t) => {
      $$('[data-t]').forEach((a) => a.classList.toggle('active', a.dataset.t === t));
      $$('[data-p]').forEach((p) => { p.hidden = p.dataset.p !== t; });
    };
    $$('[data-t]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); setTab(a.dataset.t); }));
    $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      const i = b.parentElement.querySelector('input');
      try { await navigator.clipboard.writeText(i.value); } catch { i.select(); document.execCommand('copy'); }
      toast('Copied.', 'success');
    }));
    const rot = $('#fr-rotate');
    if (rot) rot.addEventListener('click', async () => {
      try { await api('/games/fair/rotate', { body: { client_seed: $('#fr-new').value } }); toast('Seed pair rotated. The old server seed is revealed.', 'success'); openFair(); refreshBets(); } catch (err) { toast(err.message, 'error'); }
    });
    if (seeds) $('#fv-client').value = seeds.client_seed;
    $('#fv-go').addEventListener('click', async () => {
      const out = $('#fv-out');
      try {
        const r = await api('/games/verify', { body: { game: $('#fv-game').value, server_seed: $('#fv-server').value.trim(), client_seed: $('#fv-client').value.trim(), nonce: Number($('#fv-nonce').value), params: JSON.parse($('#fv-params').value || '{}') } });
        out.innerHTML = `<div class="code">${esc(JSON.stringify(r, null, 2))}</div>`;
      } catch (err) { out.innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
    });
    if (forBet) {
      setTab('verify');
      $('#fv-game').value = forBet.game;
      $('#fv-nonce').value = forBet.nonce;
      $('#fv-client').value = forBet.client_seed;
      $('#fv-params').value = JSON.stringify(forBet.params || {});
      if (forBet.server_seed) { $('#fv-server').value = forBet.server_seed; $('#fv-go').click(); } else {
        $('#fv-out').innerHTML = '<p class="faint" style="font-size:13px"><i class="fa-solid fa-lock gold"></i> This bet used your current seed pair. Rotate your seeds (Seeds tab) to reveal its server seed, then verify it.</p>';
      }
    }
  }

  /* ================================================================ GAMES */

  const GAMES = {};

  /* ---------------------------------------------------------------- dice */
  GAMES.dice = {
    mount(panel, stage) {
      let target = 50;
      let mode = 'under';
      let busy = false;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `
        <div class="g-field"><label>Risk</label>${seg('dc-risk', [['75', 'Low'], ['50', 'Med'], ['10', 'High'], ['2', 'Max']], '50')}</div>
        ${readout('Profit on win', 'dc-profit')}
        <button class="btn btn-gold btn-block btn-lg" id="g-go">Roll</button>`);
      stage.innerHTML = `<div class="dc-wrap"><div class="g-hist" id="dc-hist"></div>
        <div class="dc-big" id="dc-big">50.00</div>
        <div class="dc-track"><div class="dc-scale"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
          <div class="dc-rail" id="dc-rail"><div class="dc-marker" id="dc-marker"><b id="dc-mval"></b></div>
          <input type="range" id="dc-range" min="2" max="98" step="1" value="50" aria-label="Target"></div></div>
        <div class="dc-stats">${readout('Multiplier', 'dc-mult')}<div class="g-field"><label id="dc-mode-l">Roll under</label><button class="g-readout dc-swap" id="dc-swap"><span id="dc-target"></span> <i class="fa-solid fa-right-left"></i></button></div>${readout('Win chance', 'dc-chance')}</div></div>`;
      const chance = () => (mode === 'under' ? target : 100 - target);
      const mult = () => Math.floor((99 / chance()) * 10000) / 10000;
      const paint = () => {
        $('#dc-rail').style.setProperty('--t', target);
        $('#dc-rail').dataset.mode = mode;
        $('#dc-range').value = target;
        $('#dc-mult').textContent = `${mult().toFixed(4)}×`;
        $('#dc-mode-l').textContent = mode === 'under' ? 'Roll under' : 'Roll over';
        $('#dc-target').textContent = target.toFixed(2);
        $('#dc-chance').textContent = `${chance().toFixed(2)}%`;
        $('#dc-profit').textContent = money(Math.max(0, Math.floor(amt.get() * mult()) - amt.get()));
      };
      const hist = [];
      $('#dc-range').addEventListener('input', (e) => { if (busy) return; target = Number(e.target.value); paint(); });
      $('#dc-swap').addEventListener('click', () => { if (busy) return; mode = mode === 'under' ? 'over' : 'under'; target = 100 - target; paint(); });
      bindSeg($('#dc-risk'), (v) => { target = mode === 'under' ? Number(v) : 100 - Number(v); paint(); });
      amt.onChange(paint);
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const btn = $('#g-go');
        btn.disabled = true;
        predebit(amt.get());
        const res = await bet('dice', amt.get(), { target, mode });
        if (!res) { busy = false; btn.disabled = false; return; }
        const r = res.bet.result;
        const big = $('#dc-big');
        big.className = 'dc-big rolling';
        const t0 = performance.now();
        await new Promise((done) => {
          const tick = () => {
            if (!big.isConnected) return done();
            const k = (performance.now() - t0) / 450;
            if (k >= 1) return done();
            big.textContent = (Math.random() * 100).toFixed(2);
            requestAnimationFrame(tick);
          };
          tick();
        });
        if (!big.isConnected) return;
        const won = res.bet.payout > 0;
        big.textContent = r.roll.toFixed(2);
        big.className = `dc-big ${won ? 'won' : 'lost'}`;
        const mk = $('#dc-marker');
        mk.style.left = `${r.roll}%`;
        mk.className = `dc-marker show ${won ? 'won' : 'lost'}`;
        $('#dc-mval').textContent = r.roll.toFixed(2);
        hist.unshift({ v: r.roll, won });
        $('#dc-hist').innerHTML = hist.slice(0, 10).map((h) => `<span class="${h.won ? 'good' : 'bad'}">${h.v.toFixed(2)}</span>`).join('');
        settleFx(res, big);
        busy = false;
        btn.disabled = false;
      });
      paint();
    },
  };

  /* --------------------------------------------------------------- limbo */
  GAMES.limbo = {
    mount(panel, stage) {
      let busy = false;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `
        <div class="g-field"><label>Target multiplier</label><div class="g-amount"><input type="number" id="lb-t" min="1.01" step="0.01" value="2.00"><span class="g-suffix">×</span></div></div>
        <div class="g-field"><label>Quick picks</label>${seg('lb-risk', [['1.5', '1.5×'], ['2', '2×'], ['10', '10×'], ['100', '100×']], '2')}</div>
        ${readout('Win chance', 'lb-chance')}${readout('Profit on win', 'lb-profit')}
        <button class="btn btn-gold btn-block btn-lg" id="g-go">Play</button>`);
      stage.innerHTML = '<div class="lb-wrap"><div class="g-hist" id="lb-hist"></div><div class="lb-big" id="lb-big">1.00×</div><div class="lb-sub" id="lb-sub">Beat your target to win</div></div>';
      const target = () => Math.max(1.01, Math.floor((Number($('#lb-t').value) || 1.01) * 100) / 100);
      const paint = () => {
        $('#lb-chance').textContent = `${Math.min(99, 99 / target()).toFixed(4)}%`;
        $('#lb-profit').textContent = money(Math.floor(amt.get() * target()) - amt.get());
      };
      $('#lb-t').addEventListener('input', paint);
      bindSeg($('#lb-risk'), (v) => { $('#lb-t').value = Number(v).toFixed(2); paint(); });
      amt.onChange(paint);
      const hist = [];
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        $('#g-go').disabled = true;
        predebit(amt.get());
        const res = await bet('limbo', amt.get(), { target: target() });
        if (!res) { busy = false; $('#g-go').disabled = false; return; }
        const v = res.bet.result.value;
        const big = $('#lb-big');
        big.className = 'lb-big';
        const t0 = performance.now();
        const dur = 650;
        await new Promise((done) => {
          const tick = () => {
            if (!big.isConnected) return done();
            const k = Math.min(1, (performance.now() - t0) / dur);
            big.textContent = fmtMult(1 + (v - 1) * (1 - (1 - k) ** 3));
            if (k < 1) requestAnimationFrame(tick); else done();
          };
          tick();
        });
        if (!big.isConnected) return;
        const won = res.bet.payout > 0;
        big.textContent = fmtMult(v);
        big.className = `lb-big ${won ? 'won' : 'lost'}`;
        $('#lb-sub').textContent = won ? `Cleared ${fmtMult(target())} — you won ${money(res.bet.payout)}` : `Needed ${fmtMult(target())}`;
        hist.unshift({ v, won });
        $('#lb-hist').innerHTML = hist.slice(0, 10).map((h) => `<span class="${h.won ? 'good' : 'bad'}">${fmtMult(h.v)}</span>`).join('');
        settleFx(res, big);
        busy = false;
        $('#g-go').disabled = false;
      });
      paint();
    },
  };

  /* ------------------------------------------------------------ coinflip */
  GAMES.coinflip = {
    mount(panel, stage) {
      const STREAK = { low: 1, medium: 2, high: 3, extreme: 5 };
      let side = 'heads';
      let risk = 'low';
      let busy = false;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `
        <div class="g-field"><label>Your call</label>${seg('cf-side', [['heads', '<i class="fa-solid fa-dollar-sign"></i> Heads'], ['tails', '<i class="fa-solid fa-crown"></i> Tails']], side)}</div>
        <div class="g-field"><label>Streak needed</label>${seg('cf-risk', [['low', '1'], ['medium', '2'], ['high', '3'], ['extreme', '5']], risk)}</div>
        ${readout('Pays', 'cf-pay')}
        <button class="btn btn-gold btn-block btn-lg" id="g-go">Flip</button>`);
      stage.innerHTML = `<div class="cf-wrap"><div class="cf-coin" id="cf-coin"><div class="cf-face heads"><i class="fa-solid fa-dollar-sign"></i></div><div class="cf-face tails"><i class="fa-solid fa-crown"></i></div></div>
        <div class="cf-dots" id="cf-dots"></div><div class="lb-sub" id="cf-msg">Call it</div></div>`;
      const pays = () => Math.floor(0.99 * 2 ** STREAK[risk] * 100) / 100;
      const dots = (results = []) => {
        $('#cf-dots').innerHTML = Array.from({ length: STREAK[risk] }, (_, i) => `<i class="${results[i] === undefined ? '' : results[i] === side ? 'ok' : 'miss'}"></i>`).join('');
      };
      const paint = () => { $('#cf-pay').textContent = `${fmtMult(pays())} · ${money(Math.floor(amt.get() * pays()))}`; dots(); };
      bindSeg($('#cf-side'), (v) => { side = v; paint(); });
      bindSeg($('#cf-risk'), (v) => { risk = v; paint(); });
      amt.onChange(paint);
      let rot = 0;
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        $('#g-go').disabled = true;
        predebit(amt.get());
        const res = await bet('coinflip', amt.get(), { side, risk });
        if (!res) { busy = false; $('#g-go').disabled = false; return; }
        const flips = res.bet.result.flips;
        const coin = $('#cf-coin');
        const shown = [];
        for (const f of flips) {
          if (!coin.isConnected) return;
          // land on heads at a multiple of 360, tails at +180
          const base = Math.ceil(rot / 360) * 360 + 1440;
          rot = base + (f === 'tails' ? 180 : 0);
          coin.style.transform = `rotateY(${rot}deg)`;
          await sleep(flips.length > 1 ? 950 : 1300);
          shown.push(f);
          if ($('#cf-dots')) dots(shown);
        }
        const won = res.bet.payout > 0;
        if ($('#cf-msg')) $('#cf-msg').innerHTML = won ? `<span class="green">You called it! +${money(res.bet.payout - res.bet.amount)}</span>` : '<span class="red">Missed</span>';
        settleFx(res, coin);
        busy = false;
        if ($('#g-go')) $('#g-go').disabled = false;
      });
      paint();
    },
  };

  /* -------------------------------------------------------------- double */
  GAMES.double = {
    mount(panel, stage) {
      const ORDER = [1, 14, 2, 13, 3, 12, 4, 0, 11, 5, 10, 6, 9, 7, 8];
      const colorOf = (n) => (n === 0 ? 'green' : n <= 7 ? 'red' : 'black');
      let pick = 'red';
      let busy = false;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<div class="g-field"><label>Pick a colour</label>${seg('db-pick', [['red', 'Red 2×'], ['green', 'Green 14×'], ['black', 'Black 2×']], pick)}</div>
        ${readout('Profit on win', 'db-profit')}<button class="btn btn-gold btn-block btn-lg" id="g-go">Spin</button>`);
      let tiles = '';
      for (let c = 0; c < 10; c++) ORDER.forEach((n) => { tiles += `<div class="db-tile ${colorOf(n)}">${n}</div>`; });
      stage.innerHTML = `<div class="db-wrap"><div class="g-hist" id="db-hist"></div><div class="db-window"><div class="db-strip" id="db-strip">${tiles}</div><div class="db-pointer"></div></div><div class="lb-sub" id="db-msg">Place your bet</div></div>`;
      const strip = $('#db-strip');
      const TILE = 78; // width + gap, matches CSS
      let pos = ORDER.length * 2;
      const place = (index, jitter, anim) => {
        const w = strip.parentElement.offsetWidth;
        strip.style.transition = anim ? 'transform 4.2s cubic-bezier(.12,.75,.1,1)' : 'none';
        strip.style.transform = `translateX(${w / 2 - (index * TILE + 35 + jitter)}px)`;
      };
      place(pos, 0, false);
      const paint = () => { $('#db-profit').textContent = money(Math.floor(amt.get() * (pick === 'green' ? 14 : 2)) - amt.get()); };
      bindSeg($('#db-pick'), (v) => { pick = v; paint(); });
      amt.onChange(paint);
      const hist = [];
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        $('#g-go').disabled = true;
        predebit(amt.get());
        const res = await bet('double', amt.get(), { pick });
        if (!res) { busy = false; $('#g-go').disabled = false; return; }
        const n = res.bet.result.n;
        // reset near the start, then spin ~6 cycles ahead to a tile showing n
        pos = ORDER.length * 2 + ORDER.indexOf(n);
        place(ORDER.length + (pos % ORDER.length), 0, false);
        void strip.offsetWidth;
        place(ORDER.length * 8 + ORDER.indexOf(n), (Math.random() - 0.5) * 50, true);
        await sleep(4300);
        if (!strip.isConnected) return;
        const won = res.bet.payout > 0;
        $('#db-msg').innerHTML = `Landed on <b class="db-dot ${colorOf(n)}">${n}</b> ${won ? `<span class="green">+${money(res.bet.payout - res.bet.amount)}</span>` : ''}`;
        hist.unshift(n);
        $('#db-hist').innerHTML = hist.slice(0, 14).map((x) => `<span class="db-dot ${colorOf(x)}">${x}</span>`).join('');
        settleFx(res, $('.db-pointer'));
        busy = false;
        $('#g-go').disabled = false;
      });
      paint();
    },
  };

  /* ------------------------------------------------------------ diamonds */
  GAMES.diamonds = {
    mount(panel, stage) {
      const HANDS = [['five', 'Five of a kind'], ['four', 'Four of a kind'], ['full', 'Full house'], ['three', 'Three of a kind'], ['twopair', 'Two pairs'], ['pair', 'One pair'], ['none', 'No match']];
      let risk = 'medium';
      let busy = false;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<div class="g-field"><label>Risk</label>${seg('dm-risk', RISK3, risk)}</div><button class="btn btn-gold btn-block btn-lg" id="g-go">Play</button>`);
      stage.innerHTML = `<div class="dm-wrap"><div class="dm-row" id="dm-row">${'<div class="dm-slot"></div>'.repeat(5)}</div><div class="lb-sub" id="dm-msg">Draw five gems</div><div class="dm-pay" id="dm-pay"></div></div>`;
      const paintPay = (hit) => { $('#dm-pay').innerHTML = HANDS.map(([k, l]) => `<div class="${hit === k ? 'on' : ''}"><span>${l}</span><b>${fmtMult(cfg.tables.diamonds[risk][k])}</b></div>`).join(''); };
      bindSeg($('#dm-risk'), (v) => { risk = v; paintPay(); });
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        $('#g-go').disabled = true;
        $$('.dm-slot').forEach((s) => { s.innerHTML = ''; s.className = 'dm-slot'; });
        predebit(amt.get());
        const res = await bet('diamonds', amt.get(), { risk });
        if (!res) { busy = false; $('#g-go').disabled = false; return; }
        const { gems, hand } = res.bet.result;
        const count = {};
        gems.forEach((g) => { count[g] = (count[g] || 0) + 1; });
        const slots = $$('.dm-slot');
        for (let i = 0; i < 5; i++) {
          if (!slots[i].isConnected) return;
          slots[i].innerHTML = gemSVG(gems[i]);
          slots[i].className = `dm-slot show ${count[gems[i]] > 1 ? 'match' : ''}`;
          await sleep(170);
        }
        paintPay(hand);
        $('#dm-msg').innerHTML = `${esc(HANDS.find((h) => h[0] === hand)[1])} · <b class="${res.bet.payout > res.bet.amount ? 'green' : ''}">${fmtMult(res.bet.multiplier)}</b>`;
        settleFx(res, $('#dm-row'));
        busy = false;
        $('#g-go').disabled = false;
      });
      paintPay();
    },
  };

  /* --------------------------------------------------------------- wheel */
  const multColor = (m) => (m === 0 ? '#2a2d37' : m <= 1.2 ? '#e8edf5' : m <= 1.5 ? '#14f195' : m <= 1.9 ? '#7dd3fc' : m <= 2 ? '#a78bfa' : m <= 3 ? '#eac837' : '#ff5c7a');
  GAMES.wheel = {
    mount(panel, stage) {
      let risk = 'medium';
      let segments = 30;
      let busy = false;
      let rot = 0;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<div class="g-field"><label>Risk</label>${seg('wh-risk', RISK3, risk)}</div>
        <div class="g-field"><label>Segments</label>${seg('wh-seg', [10, 20, 30, 40, 50].map((n) => [n, n]), segments)}</div>
        <button class="btn btn-gold btn-block btn-lg" id="g-go">Spin</button>`);
      stage.innerHTML = '<div class="wh-wrap"><div class="wh-box"><svg id="wh-svg" viewBox="-110 -110 220 220"></svg><div class="wh-pointer"></div><div class="wh-center" id="wh-center"></div></div><div class="wh-legend" id="wh-legend"></div></div>';
      const list = () => cfg.tables.wheel[risk][segments];
      const draw = () => {
        const L = list();
        const a = (Math.PI * 2) / segments;
        let s = '<circle r="106" fill="#0b0d14"/>';
        L.forEach((m, i) => {
          const a0 = -Math.PI / 2 + i * a + 0.01;
          const a1 = -Math.PI / 2 + (i + 1) * a - 0.01;
          const p = (r, t) => `${(r * Math.cos(t)).toFixed(2)} ${(r * Math.sin(t)).toFixed(2)}`;
          s += `<path d="M${p(100, a0)}A100 100 0 0 1 ${p(100, a1)}L${p(70, a1)}A70 70 0 0 0 ${p(70, a0)}Z" fill="${multColor(m)}"/>`;
        });
        s += '<circle r="64" fill="#14171c" stroke="#1e2028" stroke-width="3"/>';
        $('#wh-svg').innerHTML = s;
        const seen = {};
        L.forEach((m) => { seen[m] = (seen[m] || 0) + 1; });
        $('#wh-legend').innerHTML = Object.keys(seen).map(Number).sort((x, y) => x - y)
          .map((m) => `<div class="wh-chip" style="--c:${multColor(m)}"><b>${fmtMult(m)}</b><small>${((seen[m] / segments) * 100).toFixed(segments >= 30 ? 1 : 0)}%</small></div>`).join('');
      };
      bindSeg($('#wh-risk'), (v) => { risk = v; draw(); });
      bindSeg($('#wh-seg'), (v) => { segments = Number(v); draw(); });
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        $('#g-go').disabled = true;
        segLock($('#wh-risk'), true); segLock($('#wh-seg'), true);
        predebit(amt.get());
        const res = await bet('wheel', amt.get(), { risk, segments });
        if (!res) { busy = false; $('#g-go').disabled = false; segLock($('#wh-risk'), false); segLock($('#wh-seg'), false); return; }
        const idx = res.bet.result.index;
        const a = 360 / segments;
        const want = -(idx + 0.5 + (Math.random() - 0.5) * 0.7) * a;
        rot = rot - (rot % 360) - 360 * 5 + want - 360;
        const svg = $('#wh-svg');
        svg.style.transition = 'transform 4s cubic-bezier(.15,.8,.15,1)';
        svg.style.transform = `rotate(${rot}deg)`;
        $('#wh-center').className = 'wh-center';
        await sleep(4050);
        if (!svg.isConnected) return;
        const c = $('#wh-center');
        c.textContent = fmtMult(res.bet.multiplier);
        c.className = `wh-center show ${res.bet.payout > res.bet.amount ? 'won' : res.bet.payout === 0 ? 'lost' : ''}`;
        settleFx(res, c);
        busy = false;
        $('#g-go').disabled = false;
        segLock($('#wh-risk'), false); segLock($('#wh-seg'), false);
      });
      draw();
    },
  };

  /* -------------------------------------------------------------- plinko */
  GAMES.plinko = {
    mount(panel, stage, token) {
      let rows = 12;
      let risk = 'medium';
      let inFlight = 0;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<div class="g-field"><label>Risk</label>${seg('pl-risk', RISK3, risk)}</div>
        <div class="g-field"><label>Rows</label>${seg('pl-rows', [[8, 8], [12, 12], [16, 16]], rows)}</div>
        <button class="btn btn-gold btn-block btn-lg" id="g-go">Drop ball</button>
        <p class="faint mt-8" style="font-size:12px">Tap again to drop more balls at once.</p>`);
      stage.innerHTML = '<div class="pl-wrap"><canvas id="pl-cv"></canvas><div class="pl-buckets" id="pl-buckets"></div><div class="g-hist" id="pl-hist"></div></div>';
      const cv = $('#pl-cv');
      const ctx = cv.getContext('2d');
      let W = 0;
      let H = 0;
      const balls = [];
      const flash = new Map();
      const geo = () => {
        const s = Math.min((W - 20) / (rows + 1.5), (H - 30) / (rows + 0.6));
        return { s, x0: W / 2, y0: s * 0.9 };
      };
      const pegPos = (g, r, k) => ({ x: g.x0 + (k - r / 2) * g.s, y: g.y0 + r * g.s });
      const resize = () => {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        W = cv.clientWidth; H = cv.clientHeight;
        cv.width = W * dpr; cv.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      const buckets = () => {
        const pays = cfg.tables.plinko[rows][risk];
        const g = geo();
        const el = $('#pl-buckets');
        el.style.width = `${(rows + 1) * g.s}px`;
        el.innerHTML = pays.map((m, i) => { const t = Math.abs(i - rows / 2) / (rows / 2); return `<div class="pl-b" data-i="${i}" style="--t:${t.toFixed(2)}">${m >= 100 ? Math.round(m) : m}×</div>`; }).join('');
      };
      const frame = () => {
        if (!cv.isConnected || token !== alive) return;
        ctx.clearRect(0, 0, W, H);
        const g = geo();
        for (let r = 0; r < rows; r++) {
          for (let k = 0; k <= r + 2; k++) {
            const p = pegPos(g, r + 2, k);
            const key = `${r + 2}:${k}`;
            const f = flash.get(key) || 0;
            ctx.beginPath();
            ctx.arc(p.x, p.y - g.s * 2, Math.max(2.2, g.s * 0.1) + f * 2, 0, Math.PI * 2);
            ctx.fillStyle = f > 0 ? `rgba(234,200,55,${0.5 + f / 2})` : '#e8edf5';
            ctx.fill();
            if (f > 0) flash.set(key, Math.max(0, f - 0.06));
          }
        }
        const now = performance.now();
        for (let i = balls.length - 1; i >= 0; i--) {
          const b = balls[i];
          const step = 140;
          const t = (now - b.t0) / step;
          const r = Math.floor(t);
          if (r >= rows) {
            balls.splice(i, 1);
            b.done();
            continue;
          }
          const k0 = b.pre[r];
          const k1 = b.pre[r + 1];
          const p0 = pegPos(g, r + 2, k0 + 1);
          const p1 = pegPos(g, r + 3, k1 + 1);
          const f = t - r;
          if (b.last !== r) { b.last = r; flash.set(`${r + 2}:${k0 + 1}`, 1); }
          const x = p0.x + (p1.x - p0.x) * f;
          const y = p0.y + (p1.y - p0.y) * f - Math.sin(f * Math.PI) * g.s * 0.45 - g.s * 2 - g.s * 0.35;
          ctx.beginPath();
          ctx.arc(x, y, Math.max(4, g.s * 0.22), 0, Math.PI * 2);
          ctx.fillStyle = '#eac837';
          ctx.shadowColor = '#eac837'; ctx.shadowBlur = 12;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        requestAnimationFrame(frame);
      };
      const lock = () => { const on = inFlight > 0; segLock($('#pl-risk'), on); segLock($('#pl-rows'), on); };
      bindSeg($('#pl-risk'), (v) => { risk = v; buckets(); });
      bindSeg($('#pl-rows'), (v) => { rows = Number(v); buckets(); });
      const hist = [];
      $('#g-go').addEventListener('click', async () => {
        if (inFlight >= 20) return;
        inFlight++; lock();
        predebit(amt.get() * 1);
        const res = await bet('plinko', amt.get(), { rows, risk });
        if (!res) { inFlight--; lock(); return; }
        const path = res.bet.result.path;
        const pre = [0];
        path.forEach((d, i) => pre.push(pre[i] + d));
        await new Promise((done) => balls.push({ pre, t0: performance.now(), last: -1, done }));
        inFlight--; lock();
        const bEl = $(`.pl-b[data-i="${res.bet.result.bucket}"]`);
        if (bEl) { bEl.classList.remove('hit'); void bEl.offsetWidth; bEl.classList.add('hit'); }
        hist.unshift(res.bet.multiplier);
        if ($('#pl-hist')) $('#pl-hist').innerHTML = hist.slice(0, 12).map((m) => `<span class="${m >= 1 ? 'good' : 'bad'}">${fmtMult(m)}</span>`).join('');
        settleFx(res, bEl);
      });
      resize(); buckets(); frame();
      const ro = new ResizeObserver(() => { if (!cv.isConnected) { ro.disconnect(); return; } resize(); buckets(); });
      ro.observe(cv);
    },
  };

  /* ---------------------------------------------------------------- keno */
  GAMES.keno = {
    mount(panel, stage) {
      let risk = 'medium';
      let busy = false;
      const picks = new Set();
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<div class="g-field"><label>Risk</label>${seg('kn-risk', RISK3, risk)}</div>
        <div class="row" style="gap:8px"><button class="btn btn-sm btn-block" id="kn-auto">Auto pick</button><button class="btn btn-sm btn-block" id="kn-clear">Clear</button></div>
        <button class="btn btn-gold btn-block btn-lg mt-16" id="g-go">Play</button>`);
      stage.innerHTML = `<div class="kn-wrap"><div class="kn-board" id="kn-board">${Array.from({ length: 40 }, (_, i) => `<button class="kn-t" data-n="${i + 1}">${i + 1}</button>`).join('')}</div>
        <div class="kn-pay" id="kn-pay"></div><div class="lb-sub" id="kn-msg">Pick up to 10 numbers</div></div>`;
      const paint = () => {
        $$('.kn-t').forEach((t) => t.classList.toggle('pick', picks.has(Number(t.dataset.n))));
        const row = picks.size ? cfg.tables.keno[risk][picks.size] : [];
        $('#kn-pay').innerHTML = row.map((m, h) => `<div data-h="${h}"><small>${h}×</small><b>${fmtMult(m)}</b></div>`).join('');
        $('#g-go').disabled = busy || !picks.size;
      };
      $('#kn-board').addEventListener('click', (e) => {
        const t = e.target.closest('.kn-t');
        if (!t || busy) return;
        const n = Number(t.dataset.n);
        if (picks.has(n)) picks.delete(n); else if (picks.size < 10) picks.add(n); else toast('Up to 10 numbers.', 'info');
        $$('.kn-t').forEach((x) => x.classList.remove('hit', 'drawn'));
        paint();
      });
      $('#kn-auto').addEventListener('click', () => {
        if (busy) return;
        picks.clear();
        while (picks.size < 10) picks.add(1 + Math.floor(Math.random() * 40));
        $$('.kn-t').forEach((x) => x.classList.remove('hit', 'drawn'));
        paint();
      });
      $('#kn-clear').addEventListener('click', () => { if (busy) return; picks.clear(); $$('.kn-t').forEach((x) => x.classList.remove('hit', 'drawn')); paint(); });
      bindSeg($('#kn-risk'), (v) => { risk = v; paint(); });
      $('#g-go').addEventListener('click', async () => {
        if (busy || !picks.size) return;
        busy = true; paint();
        $$('.kn-t').forEach((x) => x.classList.remove('hit', 'drawn'));
        predebit(amt.get());
        const res = await bet('keno', amt.get(), { picks: [...picks], risk });
        if (!res) { busy = false; paint(); return; }
        let hits = 0;
        for (const n of res.bet.result.drawn) {
          const t = $(`.kn-t[data-n="${n}"]`);
          if (!t) return;
          const hit = picks.has(n);
          if (hit) hits++;
          t.classList.add(hit ? 'hit' : 'drawn');
          $$('#kn-pay div').forEach((d) => d.classList.toggle('on', Number(d.dataset.h) === hits));
          await sleep(hits >= 4 && hit ? 320 : 150);
        }
        $('#kn-msg').innerHTML = `${hits} hit${hits === 1 ? '' : 's'} · <b class="${res.bet.payout > res.bet.amount ? 'green' : ''}">${fmtMult(res.bet.multiplier)}</b>`;
        settleFx(res, $('#kn-pay'));
        busy = false; paint();
      });
      paint();
    },
  };

  /* ------------------------------------------------------------ roulette */
  GAMES.roulette = {
    mount(panel, stage) {
      const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
      const REDS = new Set(cfg.tables.roulette_reds);
      const colorOf = (n) => (n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black');
      const CHIPS = [10, 50, 100, 500, 1000, 2500]; // cents
      let chip = 100;
      let chips = {};
      let undo = [];
      let busy = false;
      let rot = 0;
      panel.innerHTML = `<div class="g-field"><label>Chip value</label><div class="rl-chips" id="rl-chips">${CHIPS.map((c) => `<button class="rl-chip ${c === chip ? 'on' : ''}" data-c="${c}">${c >= 100 ? `$${c / 100}` : `${c}¢`}</button>`).join('')}</div></div>
        ${readout('Total bet', 'rl-total', '$0.00')}
        <div class="row" style="gap:8px"><button class="btn btn-sm btn-block" id="rl-undo"><i class="fa-solid fa-rotate-left"></i> Undo</button><button class="btn btn-sm btn-block" id="rl-clear">Clear</button><button class="btn btn-sm btn-block" id="rl-x2">2×</button></div>
        <button class="btn btn-gold btn-block btn-lg mt-16" id="g-go">Spin</button>`;
      const cell = (key, label, cls = '') => `<button class="rl-cell ${cls}" data-k="${key}"><span>${label}</span></button>`;
      let grid = '';
      for (let row = 3; row >= 1; row--) {
        for (let col = 0; col < 12; col++) { const n = col * 3 + row; grid += cell(`n_${n}`, n, colorOf(n)); }
        grid += cell(`col${row}`, '2:1', 'out');
      }
      stage.innerHTML = `<div class="rl-wrap">
        <div class="rl-top"><div class="rl-wheel"><svg id="rl-svg" viewBox="-110 -110 220 220"></svg><div class="rl-ball-track" id="rl-track"><i class="rl-ball"></i></div><div class="rl-result" id="rl-res"></div></div>
          <div class="g-hist rl-hist" id="rl-hist"></div></div>
        <div class="rl-table"><div class="rl-zero">${cell('n_0', '0', 'green')}</div><div class="rl-grid">${grid}</div>
          <div class="rl-dozens">${cell('doz1', '1 to 12', 'out')}${cell('doz2', '13 to 24', 'out')}${cell('doz3', '25 to 36', 'out')}</div>
          <div class="rl-outs">${cell('low', '1-18', 'out')}${cell('even', 'Even', 'out')}${cell('red', '<i class="rl-dia red"></i>', 'out')}${cell('black', '<i class="rl-dia black"></i>', 'out')}${cell('odd', 'Odd', 'out')}${cell('high', '19-36', 'out')}</div></div></div>`;
      // wheel
      const seg2 = (Math.PI * 2) / 37;
      let svg = '<circle r="108" fill="#3d2a10"/><circle r="100" fill="#0b0d14"/>';
      ORDER.forEach((n, i) => {
        const a0 = -Math.PI / 2 + (i - 0.5) * seg2;
        const a1 = a0 + seg2;
        const p = (r, t) => `${(r * Math.cos(t)).toFixed(2)} ${(r * Math.sin(t)).toFixed(2)}`;
        svg += `<path d="M${p(98, a0)}A98 98 0 0 1 ${p(98, a1)}L${p(66, a1)}A66 66 0 0 0 ${p(66, a0)}Z" fill="${n === 0 ? '#12a35b' : REDS.has(n) ? '#d02c47' : '#191c23'}" stroke="#eac83755" stroke-width=".6"/>`;
        const mid = -Math.PI / 2 + i * seg2;
        svg += `<text x="${(86 * Math.cos(mid)).toFixed(1)}" y="${(86 * Math.sin(mid)).toFixed(1)}" transform="rotate(${(i * 360) / 37} ${(86 * Math.cos(mid)).toFixed(1)} ${(86 * Math.sin(mid)).toFixed(1)})" font-size="8" fill="#fff" text-anchor="middle" dominant-baseline="middle" font-family="Inter,Arial" font-weight="700">${n}</text>`;
      });
      svg += '<circle r="62" fill="#14171c" stroke="#eac837" stroke-width="2"/><circle r="20" fill="#eac837"/>';
      $('#rl-svg').innerHTML = svg;
      const total = () => Object.values(chips).reduce((a, b) => a + b, 0);
      const paint = () => {
        $$('.rl-cell').forEach((c) => {
          const v = chips[c.dataset.k];
          let tag = c.querySelector('.rl-stack');
          if (v) {
            if (!tag) { tag = document.createElement('em'); tag.className = 'rl-stack'; c.appendChild(tag); }
            tag.textContent = v >= 100 ? `$${(v / 100).toFixed(v % 100 ? 2 : 0)}` : `${v}¢`;
          } else if (tag) tag.remove();
        });
        $('#rl-total').textContent = money(total());
      };
      $('#rl-chips').addEventListener('click', (e) => {
        const b = e.target.closest('.rl-chip');
        if (!b) return;
        chip = Number(b.dataset.c);
        $$('.rl-chip').forEach((x) => x.classList.toggle('on', x === b));
      });
      const tableEl = $('.rl-table');
      tableEl.addEventListener('click', (e) => {
        const c = e.target.closest('.rl-cell');
        if (!c || busy) return;
        if (total() + chip > cfg.max) { toast(`The maximum bet is ${money(cfg.max)}.`, 'error'); return; }
        chips[c.dataset.k] = (chips[c.dataset.k] || 0) + chip;
        undo.push([c.dataset.k, chip]);
        paint();
      });
      tableEl.addEventListener('contextmenu', (e) => {
        const c = e.target.closest('.rl-cell');
        if (!c || busy) return;
        e.preventDefault();
        delete chips[c.dataset.k];
        undo = undo.filter(([k]) => k !== c.dataset.k);
        paint();
      });
      $('#rl-undo').addEventListener('click', () => {
        if (busy || !undo.length) return;
        const [k, v] = undo.pop();
        chips[k] -= v;
        if (chips[k] <= 0) delete chips[k];
        paint();
      });
      $('#rl-clear').addEventListener('click', () => { if (!busy) { chips = {}; undo = []; paint(); } });
      $('#rl-x2').addEventListener('click', () => {
        if (busy) return;
        if (total() * 2 > cfg.max) { toast(`The maximum bet is ${money(cfg.max)}.`, 'error'); return; }
        for (const k of Object.keys(chips)) { undo.push([k, chips[k]]); chips[k] *= 2; }
        paint();
      });
      const hist = [];
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        if (!total()) { toast('Place chips on the table first.', 'info'); return; }
        busy = true;
        $('#g-go').disabled = true;
        predebit(total());
        const res = await bet('roulette', total(), { chips });
        if (!res) { busy = false; $('#g-go').disabled = false; return; }
        const n = res.bet.result.n;
        const i = ORDER.indexOf(n);
        const track = $('#rl-track');
        $('#rl-res').className = 'rl-result';
        rot = rot - (rot % 360) + 360 * 6 - (i * 360) / 37;
        track.style.transition = 'transform 4.4s cubic-bezier(.12,.7,.15,1)';
        track.style.transform = `rotate(${rot}deg)`;
        await sleep(4500);
        if (!track.isConnected) return;
        const r = $('#rl-res');
        r.textContent = n;
        r.className = `rl-result show ${colorOf(n)}`;
        $$('.rl-cell').forEach((c) => c.classList.toggle('win', c.dataset.k === `n_${n}`));
        hist.unshift(n);
        $('#rl-hist').innerHTML = hist.slice(0, 12).map((x) => `<span class="db-dot ${colorOf(x)}">${x}</span>`).join('');
        settleFx(res, r);
        busy = false;
        $('#g-go').disabled = false;
      });
      paint();
    },
  };

  /* ------------------------------------------------------------ baccarat */
  GAMES.baccarat = {
    mount(panel, stage) {
      let side = 'player';
      let busy = false;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<div class="g-field"><label>Bet on</label>${seg('bc-side', [['player', 'Player 2×'], ['tie', 'Tie 9×'], ['banker', 'Banker 1.95×']], side)}</div>
        <button class="btn btn-gold btn-block btn-lg" id="g-go">Deal</button>`);
      stage.innerHTML = `<div class="bc-wrap"><div class="bc-hand" id="bc-p"><div class="bc-label">Player <b class="bc-score">0</b></div><div class="bc-cards"></div></div>
        <div class="bc-hand" id="bc-b"><div class="bc-label">Banker <b class="bc-score">0</b></div><div class="bc-cards"></div></div><div class="lb-sub" id="bc-msg">Pick a side and deal</div></div>`;
      bindSeg($('#bc-side'), (v) => { side = v; });
      const val = (c) => (c.i === 0 ? 1 : c.i >= 9 ? 0 : c.i + 1);
      const tot = (cs) => cs.reduce((a, c) => a + val(c), 0) % 10;
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        $('#g-go').disabled = true;
        $$('.bc-cards').forEach((x) => { x.innerHTML = ''; });
        $$('.bc-hand').forEach((x) => x.classList.remove('win'));
        $$('.bc-score').forEach((x) => { x.textContent = '0'; });
        predebit(amt.get());
        const res = await bet('baccarat', amt.get(), { side });
        if (!res) { busy = false; $('#g-go').disabled = false; return; }
        const r = res.bet.result;
        const order = [['p', r.player[0]], ['b', r.banker[0]], ['p', r.player[1]], ['b', r.banker[1]]];
        if (r.player[2]) order.push(['p', r.player[2]]);
        if (r.banker[2]) order.push(['b', r.banker[2]]);
        const shown = { p: [], b: [] };
        for (const [who, c] of order) {
          const box = $(`#bc-${who} .bc-cards`);
          if (!box) return;
          box.insertAdjacentHTML('beforeend', cardHTML(c, false, 'deal'));
          shown[who].push(c);
          $(`#bc-${who} .bc-score`).textContent = tot(shown[who]);
          await sleep(380);
        }
        const winner = r.winner;
        if (winner !== 'tie') $(`#bc-${winner === 'player' ? 'p' : 'b'}`).classList.add('win');
        $('#bc-msg').innerHTML = `${winner === 'tie' ? 'Tie' : `${winner[0].toUpperCase()}${winner.slice(1)} wins`} · <b class="${res.bet.payout > res.bet.amount ? 'green' : ''}">${fmtMult(res.bet.multiplier)}</b>`;
        settleFx(res, $('#bc-msg'));
        busy = false;
        $('#g-go').disabled = false;
      });
    },
  };

  /* ========================================================= round games */

  /** Resume an unfinished round of this game after a reload. */
  async function activeRound(game) {
    if (!me()) return null;
    try { const { bets } = await api('/games/active'); return bets.find((b) => b.game === game) || null; } catch { return null; }
  }

  /* --------------------------------------------------------------- mines */
  GAMES.mines = {
    mount(panel, stage) {
      let count = 3;
      let round = null;
      let busy = false;
      const GEM = gemSVG(1);
      const BOMB = '<i class="fa-solid fa-bomb"></i>';
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<div class="g-field"><label>Mines</label>${seg('mn-risk', [[1, '1'], [3, '3'], [5, '5'], [10, '10'], [20, '20']], count)}
          <input type="range" id="mn-count" min="1" max="24" value="${count}" class="g-range"></div>
        ${readout('Multiplier', 'mn-mult', '1.00×')}${readout('Next gem', 'mn-next')}
        <button class="btn btn-gold btn-block btn-lg" id="g-go">Bet</button>
        <button class="btn btn-block mt-8" id="mn-random">Pick a random tile</button>`);
      stage.innerHTML = `<div class="mn-wrap"><div class="mn-grid" id="mn-grid">${Array.from({ length: 25 }, (_, i) => `<button class="mn-t" data-i="${i}"><span></span></button>`).join('')}</div><div class="lb-sub" id="mn-msg">Choose your mines and bet</div></div>`;
      const mult = (k, m) => { let x = 1; for (let i = 0; i < k; i++) x *= (25 - i) / (25 - m - i); return Math.floor(x * 0.99 * 100) / 100; };
      const ui = () => {
        const playing = round && round.status === 'active';
        amt.lock(playing);
        segLock($('#mn-risk'), playing);
        $('#mn-count').disabled = playing;
        const k = playing ? round.view.revealed.length : 0;
        $('#mn-mult').textContent = fmtMult(playing ? round.view.multiplier : 1);
        $('#mn-next').textContent = fmtMult(mult(k + 1, playing ? round.view.mines : count));
        const btn = $('#g-go');
        if (playing) {
          btn.className = 'btn btn-green btn-block btn-lg';
          btn.disabled = !k || busy;
          btn.innerHTML = k ? `Cash out ${money(Math.floor(round.amount * round.view.multiplier))}` : 'Pick a tile';
        } else { btn.className = 'btn btn-gold btn-block btn-lg'; btn.disabled = busy; btn.textContent = 'Bet'; }
        $('#mn-random').disabled = !playing || busy;
      };
      const paintBoard = (b, fresh) => {
        const v = b.view;
        $$('.mn-t').forEach((t) => {
          const i = Number(t.dataset.i);
          const rev = v.revealed.includes(i);
          const isMine = v.layout && v.layout.includes(i);
          t.className = 'mn-t';
          if (rev) { t.classList.add('gem', 'open'); t.innerHTML = `<span>${GEM}</span>`; if (fresh === i) t.classList.add('pop'); } else if (b.status === 'settled' && v.layout) {
            t.classList.add('open', 'dim', isMine ? 'bomb' : 'gem');
            t.innerHTML = `<span>${isMine ? BOMB : GEM}</span>`;
            if (v.hit === i) t.classList.add('boom');
          } else t.innerHTML = '<span></span>';
        });
      };
      const setCount = (c) => {
        count = Math.max(1, Math.min(24, c));
        $('#mn-count').value = count;
        $$('#mn-risk button').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) === count));
        ui();
      };
      bindSeg($('#mn-risk'), (v) => setCount(Number(v)));
      $('#mn-count').addEventListener('input', (e) => setCount(Number(e.target.value)));
      const finish = (res) => {
        round = res.bet;
        const won = round.payout > 0;
        $('#mn-msg').innerHTML = won ? `<span class="green">Cashed out ${fmtMult(round.multiplier)} · +${money(round.payout - round.amount)}</span>` : '<span class="red">Boom. That was a mine.</span>';
        settleFx(res, won ? $('#g-go') : null);
      };
      const reveal = async (i) => {
        if (!round || round.status !== 'active' || busy || round.view.revealed.includes(i)) return;
        busy = true; ui();
        const res = await act(round.id, 'reveal', { tile: i });
        busy = false;
        if (!res) { ui(); return; }
        paintBoard(res.bet, i);
        if (res.bet.status === 'settled') {
          if (res.bet.payout === 0) { const st = $('#mn-grid'); st.classList.add('shake'); setTimeout(() => st.classList.remove('shake'), 450); }
          finish(res);
        } else { round = res.bet; $('#mn-msg').textContent = `${round.view.revealed.length} gem${round.view.revealed.length === 1 ? '' : 's'} · next pays ${fmtMult(round.view.next)}`; }
        ui();
      };
      $('#mn-grid').addEventListener('click', (e) => { const t = e.target.closest('.mn-t'); if (t) reveal(Number(t.dataset.i)); });
      $('#mn-random').addEventListener('click', () => {
        if (!round || round.status !== 'active') return;
        const left = Array.from({ length: 25 }, (_, i) => i).filter((i) => !round.view.revealed.includes(i));
        reveal(left[Math.floor(Math.random() * left.length)]);
      });
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        if (round && round.status === 'active') {
          busy = true; ui();
          const res = await act(round.id, 'cashout');
          busy = false;
          if (res) { paintBoard(res.bet); finish(res); }
          ui();
          return;
        }
        busy = true; ui();
        predebit(amt.get());
        const res = await bet('mines', amt.get(), { mines: count });
        busy = false;
        if (!res) { ui(); return; }
        round = res.bet;
        GR.setUser(res.user);
        paintBoard(round);
        $('#mn-msg').textContent = `${round.view.mines} mine${round.view.mines === 1 ? '' : 's'} hidden. Find the gems.`;
        ui();
      });
      ui();
      activeRound('mines').then((b) => { if (b && $('#mn-grid')) { round = b; setCount(b.view.mines); paintBoard(b); $('#mn-msg').textContent = 'Picking up where you left off.'; ui(); } });
    },
  };

  /* -------------------------------------------------------------- towers */
  GAMES.towers = {
    mount(panel, stage) {
      const LEVELS = cfg.tables.towers;
      let diff = 'medium';
      let round = null;
      let busy = false;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<div class="g-field"><label>Difficulty</label>${seg('tw-diff', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['extreme', 'Extreme']], diff)}</div>
        ${readout('Multiplier', 'tw-mult', '1.00×')}<button class="btn btn-gold btn-block btn-lg" id="g-go">Bet</button>`);
      stage.innerHTML = '<div class="tw-wrap"><div class="tw-tower" id="tw-tower"></div><div class="lb-sub" id="tw-msg">Climb as high as you dare</div></div>';
      const mult = (d, k) => { const c = LEVELS[d]; return Math.floor(0.98 * (c.cols / (c.cols - c.bombs)) ** k * 100) / 100; };
      const build = () => {
        const d = round ? round.view.difficulty : diff;
        const c = LEVELS[d];
        let html = '';
        for (let r = 7; r >= 0; r--) {
          html += `<div class="tw-row" data-r="${r}" style="--cols:${c.cols}">${Array.from({ length: c.cols }, (_, i) => `<button class="tw-t" data-r="${r}" data-c="${i}"><span>${fmtMult(mult(d, r + 1))}</span></button>`).join('')}</div>`;
        }
        $('#tw-tower').innerHTML = html;
      };
      const paint = () => {
        const playing = round && round.status === 'active';
        if (round) {
          const v = round.view;
          $$('.tw-row').forEach((row) => {
            const r = Number(row.dataset.r);
            row.classList.toggle('cur', playing && r === v.floor);
            $$('.tw-t', row).forEach((t) => {
              const c = Number(t.dataset.c);
              const picked = v.picks[r] === c;
              const traps = v.traps && v.traps[r];
              t.className = 'tw-t';
              if (traps) {
                if (traps.includes(c)) t.classList.add('trap', picked ? 'boom' : 'dim');
                else if (picked) t.classList.add('safe');
                else if (r < v.picks.length || round.status !== 'active') t.classList.add('dim');
              }
            });
          });
          $('#tw-mult').textContent = fmtMult(v.multiplier);
        }
        amt.lock(playing);
        segLock($('#tw-diff'), playing);
        const btn = $('#g-go');
        if (playing) {
          btn.className = 'btn btn-green btn-block btn-lg';
          btn.disabled = !round.view.picks.length || busy;
          btn.innerHTML = round.view.picks.length ? `Cash out ${money(Math.floor(round.amount * round.view.multiplier))}` : 'Pick a tile on the bottom floor';
        } else { btn.className = 'btn btn-gold btn-block btn-lg'; btn.disabled = busy; btn.textContent = 'Bet'; }
      };
      bindSeg($('#tw-diff'), (v) => { diff = v; build(); paint(); });
      const done = (res) => {
        round = res.bet;
        const won = round.payout > 0;
        $('#tw-msg').innerHTML = won ? `<span class="green">${round.view.floor === 8 ? 'Top of the tower!' : 'Cashed out'} ${fmtMult(round.multiplier)} · +${money(round.payout - round.amount)}</span>` : '<span class="red">Trap! Round over.</span>';
        if (!won) { const t = $('#tw-tower'); t.classList.add('shake'); setTimeout(() => t.classList.remove('shake'), 450); }
        settleFx(res, won ? $('#g-go') : null);
      };
      $('#tw-tower').addEventListener('click', async (e) => {
        const t = e.target.closest('.tw-t');
        if (!t || !round || round.status !== 'active' || busy || Number(t.dataset.r) !== round.view.floor) return;
        busy = true; paint();
        const res = await act(round.id, 'pick', { col: Number(t.dataset.c) });
        busy = false;
        if (res) { round = res.bet; if (round.status === 'settled') done(res); else $('#tw-msg').textContent = `Floor ${round.view.floor} cleared · next pays ${fmtMult(round.view.next)}`; }
        paint();
      });
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true; paint();
        if (round && round.status === 'active') {
          const res = await act(round.id, 'cashout');
          busy = false;
          if (res) done(res);
          paint();
          return;
        }
        predebit(amt.get());
        const res = await bet('towers', amt.get(), { difficulty: diff });
        busy = false;
        if (!res) { paint(); return; }
        round = res.bet;
        GR.setUser(res.user);
        build();
        $('#tw-msg').textContent = 'Pick a tile on the bottom floor';
        paint();
      });
      build(); paint();
      activeRound('towers').then((b) => { if (b && $('#tw-tower')) { round = b; diff = b.view.difficulty; build(); paint(); $('#tw-msg').textContent = 'Picking up where you left off.'; } });
    },
  };

  /* ---------------------------------------------------------------- pump */
  GAMES.pump = {
    mount(panel, stage) {
      let diff = 'medium';
      let round = null;
      let busy = false;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<div class="g-field"><label>Difficulty</label>${seg('pm-diff', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['expert', 'Expert']], diff)}</div>
        ${readout('Multiplier', 'pm-mult', '1.00×')}${readout('Next pump', 'pm-next')}
        <button class="btn btn-gold btn-block btn-lg" id="g-go">Bet</button>
        <button class="btn btn-green btn-block btn-lg mt-8" id="pm-cash" disabled>Cash out</button>`);
      stage.innerHTML = `<div class="pm-wrap"><div class="pm-balloon" id="pm-b"><svg viewBox="0 0 100 130"><defs><radialGradient id="pm-g" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#fff4b8"/><stop offset=".3" stop-color="#f2d55a"/><stop offset="1" stop-color="#b8860b"/></radialGradient></defs>
        <path d="M50 4C24 4 8 24 8 48c0 26 22 46 38 52l-4 8h16l-4-8c16-6 38-26 38-52C92 24 76 4 50 4z" fill="url(#pm-g)"/><ellipse cx="34" cy="30" rx="9" ry="14" fill="#fff" opacity=".35" transform="rotate(-25 34 30)"/>
        <path d="M50 108c-2 6 4 10 0 16" stroke="#94a3b8" stroke-width="2" fill="none"/></svg><div class="pm-burst" id="pm-burst"></div></div>
        <div class="lb-sub" id="pm-msg">Pump it up. Stop before it pops.</div></div>`;
      const ui = () => {
        const playing = round && round.status === 'active';
        const v = round ? round.view : null;
        amt.lock(playing);
        segLock($('#pm-diff'), playing);
        $('#pm-mult').textContent = fmtMult(v ? v.multiplier : 1);
        $('#pm-next').textContent = v && playing ? fmtMult(v.next) : '—';
        const go = $('#g-go');
        go.textContent = playing ? 'Pump' : 'Bet';
        go.disabled = busy;
        const cash = $('#pm-cash');
        cash.disabled = !playing || !v.pumps || busy;
        cash.innerHTML = playing && v.pumps ? `Cash out ${money(Math.floor(round.amount * v.multiplier))}` : 'Cash out';
        const b = $('#pm-b');
        const k = v ? v.pumps : 0;
        b.style.setProperty('--s', (0.55 + 0.75 * (1 - 0.88 ** k)).toFixed(3));
      };
      bindSeg($('#pm-diff'), (v) => { diff = v; });
      const finish = (res) => {
        round = res.bet;
        const won = round.payout > 0;
        const b = $('#pm-b');
        if (!won) { b.classList.add('popped'); const burst = $('#pm-burst'); burst.classList.remove('go'); void burst.offsetWidth; burst.classList.add('go'); }
        $('#pm-msg').innerHTML = won ? `<span class="green">Cashed out ${fmtMult(round.multiplier)} · +${money(round.payout - round.amount)}</span>` : `<span class="red">Pop! It would have held ${round.view.safe} pump${round.view.safe === 1 ? '' : 's'}.</span>`;
        settleFx(res, won ? $('#pm-cash') : null);
      };
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true; ui();
        if (round && round.status === 'active') {
          const res = await act(round.id, 'pump');
          busy = false;
          if (res) {
            if (res.bet.status === 'settled') finish(res);
            else { round = res.bet; const b = $('#pm-b'); b.classList.remove('wob'); void b.offsetWidth; b.classList.add('wob'); $('#pm-msg').textContent = `${round.view.pumps} pump${round.view.pumps === 1 ? '' : 's'} · ${fmtMult(round.view.multiplier)}`; }
          }
          ui();
          return;
        }
        $('#pm-b').classList.remove('popped');
        predebit(amt.get());
        const res = await bet('pump', amt.get(), { difficulty: diff });
        busy = false;
        if (res) { round = res.bet; GR.setUser(res.user); $('#pm-msg').textContent = 'Pump it up. Stop before it pops.'; }
        ui();
      });
      $('#pm-cash').addEventListener('click', async () => {
        if (busy || !round || round.status !== 'active') return;
        busy = true; ui();
        const res = await act(round.id, 'cashout');
        busy = false;
        if (res) finish(res);
        ui();
      });
      ui();
      activeRound('pump').then((b) => { if (b && $('#pm-b')) { round = b; ui(); } });
    },
  };

  /* ---------------------------------------------------------------- hilo */
  GAMES.hilo = {
    mount(panel, stage) {
      let round = null;
      let busy = false;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `${readout('Multiplier', 'hl-mult', '1.00×')}
        <button class="btn btn-gold btn-block btn-lg" id="g-go">Bet</button>`);
      stage.innerHTML = `<div class="hl-wrap"><div class="hl-main"><button class="hl-call" id="hl-lo" disabled><i class="fa-solid fa-arrow-down"></i><b>Lower</b><small></small></button>
        <div class="hl-card" id="hl-card">${cardHTML(null, true)}</div>
        <button class="hl-call" id="hl-hi" disabled><i class="fa-solid fa-arrow-up"></i><b>Higher</b><small></small></button></div>
        <button class="btn btn-sm" id="hl-skip" disabled><i class="fa-solid fa-forward"></i> Skip card</button>
        <div class="hl-trail" id="hl-trail"></div><div class="lb-sub" id="hl-msg">Bet to draw a card</div></div>`;
      const ui = () => {
        const playing = round && round.status === 'active';
        const v = round && round.view;
        amt.lock(playing);
        $('#hl-mult').textContent = fmtMult(v ? v.multiplier : 1);
        const go = $('#g-go');
        if (playing) {
          go.className = 'btn btn-green btn-block btn-lg';
          go.disabled = !v.steps || busy;
          go.innerHTML = v.steps ? `Cash out ${money(Math.floor(round.amount * v.multiplier))}` : 'Make a call';
        } else { go.className = 'btn btn-gold btn-block btn-lg'; go.disabled = busy; go.textContent = 'Bet'; }
        for (const k of ['hi', 'lo']) {
          const b = $(`#hl-${k}`);
          b.disabled = !playing || busy;
          if (playing) { b.querySelector('b').textContent = v.options[k].label; b.querySelector('small').textContent = `${fmtMult(v.options[k].mult)} · ${pct(v.options[k].chance)}`; }
        }
        $('#hl-skip').disabled = !playing || busy;
        if (v) $('#hl-trail').innerHTML = v.trail.slice(-12).map((t) => `<span class="hl-mini ${t.c.red ? 'red' : ''} ${t.ok === false ? 'miss' : ''}">${esc(t.c.r)}<i>${esc(t.c.s)}</i></span>`).join('');
      };
      const showCard = (c, cls) => { $('#hl-card').innerHTML = cardHTML(c, false, cls); };
      const move = async (action) => {
        if (busy || !round || round.status !== 'active') return;
        busy = true; ui();
        const res = await act(round.id, action);
        busy = false;
        if (!res) { ui(); return; }
        round = res.bet;
        showCard(round.view.card, `deal ${action === 'skip' ? '' : round.view.lost ? 'bad' : 'good'}`);
        if (round.status === 'settled') {
          $('#hl-msg').innerHTML = round.payout > 0 ? `<span class="green">Cashed out ${fmtMult(round.multiplier)} · +${money(round.payout - round.amount)}</span>` : '<span class="red">Wrong call.</span>';
          settleFx(res, round.payout > 0 ? $('#g-go') : null);
        } else $('#hl-msg').textContent = action === 'skip' ? 'Card skipped.' : `Correct! Now at ${fmtMult(round.view.multiplier)}`;
        ui();
      };
      $('#hl-hi').addEventListener('click', () => move('hi'));
      $('#hl-lo').addEventListener('click', () => move('lo'));
      $('#hl-skip').addEventListener('click', () => move('skip'));
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        if (round && round.status === 'active') { move('cashout'); return; }
        busy = true; ui();
        predebit(amt.get());
        const res = await bet('hilo', amt.get(), {});
        busy = false;
        if (res) { round = res.bet; GR.setUser(res.user); showCard(round.view.card, 'deal'); $('#hl-msg').textContent = 'Higher or lower?'; }
        ui();
      });
      ui();
      activeRound('hilo').then((b) => { if (b && $('#hl-card')) { round = b; showCard(b.view.card); ui(); } });
    },
  };

  /* ----------------------------------------------------------- blackjack */
  GAMES.blackjack = {
    mount(panel, stage) {
      let round = null;
      let busy = false;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<button class="btn btn-gold btn-block btn-lg" id="g-go">Deal</button>
        <div class="bj-acts"><button class="btn" id="bj-hit" disabled>Hit</button><button class="btn" id="bj-stand" disabled>Stand</button><button class="btn" id="bj-double" disabled>Double</button></div>`);
      stage.innerHTML = `<div class="bj-wrap"><div class="bj-hand" id="bj-d"><div class="bc-label">Dealer <b class="bc-score" hidden></b></div><div class="bc-cards"></div></div>
        <div class="bj-mid" id="bj-res"></div>
        <div class="bj-hand" id="bj-p"><div class="bc-cards"></div><div class="bc-label">You <b class="bc-score" hidden></b></div></div></div>`;
      const OUT = { blackjack: ['Blackjack!', 'good'], win: ['You win', 'good'], dealer_bust: ['Dealer busts', 'good'], push: ['Push', ''], lose: ['Dealer wins', 'bad'], bust: ['Bust', 'bad'], dealer_blackjack: ['Dealer blackjack', 'bad'] };
      let shown = { p: 0, d: 0 };
      const ui = () => {
        const playing = round && round.status === 'active';
        amt.lock(playing);
        $('#g-go').disabled = playing || busy;
        $('#bj-hit').disabled = !playing || busy;
        $('#bj-stand').disabled = !playing || busy;
        $('#bj-double').disabled = !playing || busy || round.view.player.length !== 2;
      };
      /** Deal any new cards one by one, then reveal the dealer's hole card when the round is over. */
      const render = async (b) => {
        const v = b.view;
        const pBox = $('#bj-p .bc-cards');
        const dBox = $('#bj-d .bc-cards');
        if (!pBox) return;
        const seq = [];
        for (let i = shown.p; i < v.player.length; i++) seq.push(['p', v.player[i]]);
        if (shown.d === 0 && v.dealer.length) seq.splice(Math.min(1, seq.length), 0, ['d', v.dealer[0]]);
        for (const [who, c] of seq) {
          const box = who === 'p' ? pBox : dBox;
          if (!box.isConnected) return;
          box.insertAdjacentHTML('beforeend', cardHTML(c, false, 'deal'));
          if (who === 'p') shown.p++; else shown.d++;
          if (who === 'd' && v.hidden && !$('.pcard.down', dBox)) dBox.insertAdjacentHTML('beforeend', cardHTML(null, true, 'deal'));
          await sleep(300);
        }
        if (!v.hidden) {
          const down = $('.pcard.down', dBox);
          if (down) down.remove();
          for (let i = shown.d; i < v.dealer.length; i++) {
            if (!dBox.isConnected) return;
            dBox.insertAdjacentHTML('beforeend', cardHTML(v.dealer[i], false, 'deal'));
            shown.d++;
            await sleep(380);
          }
        } else if (!$('.pcard.down', dBox) && shown.d === 1) dBox.insertAdjacentHTML('beforeend', cardHTML(null, true, 'deal'));
        const ps = $('#bj-p .bc-score');
        const ds = $('#bj-d .bc-score');
        ps.hidden = false; ds.hidden = false;
        ps.textContent = v.playerTotal;
        ds.textContent = v.dealerTotal;
        if (b.status === 'settled') {
          const [txt, cls] = OUT[v.outcome] || ['Done', ''];
          $('#bj-res').innerHTML = `<div class="bj-pop ${cls}"><b>${txt}</b><span>${b.payout > b.amount ? `+${money(b.payout - b.amount)}` : b.payout === b.amount ? 'Bet returned' : `−${money(b.amount)}`}</span></div>`;
        }
      };
      const after = async (res) => {
        round = res.bet;
        await render(round);
        if (round.status === 'settled') settleFx(res, round.payout > 0 ? $('#bj-res') : null);
        busy = false;
        ui();
      };
      $('#g-go').addEventListener('click', async () => {
        if (busy || (round && round.status === 'active')) return;
        busy = true; ui();
        $('#bj-p .bc-cards').innerHTML = ''; $('#bj-d .bc-cards').innerHTML = ''; $('#bj-res').innerHTML = '';
        $$('.bc-score').forEach((x) => { x.hidden = true; });
        shown = { p: 0, d: 0 };
        predebit(amt.get());
        const res = await bet('blackjack', amt.get(), {});
        if (!res) { busy = false; ui(); return; }
        if (res.bet.status === 'active') GR.setUser(res.user);
        await after(res);
      });
      const move = async (a) => {
        if (busy || !round || round.status !== 'active') return;
        busy = true; ui();
        if (a === 'double') predebit(round.amount);
        const res = await act(round.id, a);
        if (!res) { busy = false; ui(); if (me()) GR.showBalance(me().balance); return; }
        if (res.bet.status === 'active') GR.setUser(res.user);
        await after(res);
      };
      $('#bj-hit').addEventListener('click', () => move('hit'));
      $('#bj-stand').addEventListener('click', () => move('stand'));
      $('#bj-double').addEventListener('click', () => move('double'));
      ui();
      activeRound('blackjack').then(async (b) => { if (b && $('#bj-p')) { round = b; busy = true; await render(b); busy = false; ui(); } });
    },
  };

  /* --------------------------------------------------------------- crash */
  GAMES.crash = {
    mount(panel, stage, token) {
      let round = null;
      let busy = false;
      let offset = 0; // server clock minus ours
      let raf = 0;
      let polling = 0;
      const RATE = 0.00009;
      const amt = amountField();
      panel.appendChild(amt.el);
      panel.insertAdjacentHTML('beforeend', `<div class="g-field"><label>Auto cash out</label><div class="g-amount"><input type="number" id="cr-auto" min="1.01" step="0.01" placeholder="Off"><span class="g-suffix">×</span></div></div>
        <div class="g-field"><label>Quick picks</label>${seg('cr-risk', [['1.5', '1.5×'], ['2', '2×'], ['5', '5×'], ['20', '20×']], '')}</div>
        <button class="btn btn-gold btn-block btn-lg" id="g-go">Bet</button>`);
      stage.innerHTML = '<div class="cr-wrap"><div class="g-hist" id="cr-hist"></div><canvas id="cr-cv"></canvas><div class="cr-big" id="cr-big">1.00×</div><div class="cr-sub" id="cr-sub">Place a bet to launch</div></div>';
      bindSeg($('#cr-risk'), (v) => { $('#cr-auto').value = Number(v).toFixed(2); });
      const cv = $('#cr-cv');
      const ctx = cv.getContext('2d');
      let W = 0;
      let H = 0;
      const resize = () => {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        W = cv.clientWidth; H = cv.clientHeight;
        cv.width = W * dpr; cv.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      const draw = (el, m, mode) => {
        ctx.clearRect(0, 0, W, H);
        const tMax = Math.max(8000, el * 1.15);
        const mMax = Math.max(2, 1 + (m - 1) * 1.25);
        const X = (t) => 40 + (t / tMax) * (W - 60);
        const Y = (v) => H - 30 - ((v - 1) / (mMax - 1)) * (H - 50);
        ctx.strokeStyle = 'rgba(255,255,255,.05)';
        ctx.fillStyle = '#6b7280';
        ctx.font = '600 11px Inter, sans-serif';
        for (let i = 0; i <= 4; i++) {
          const v = 1 + ((mMax - 1) * i) / 4;
          const y = Y(v);
          ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(W - 20, y); ctx.stroke();
          ctx.fillText(`${v.toFixed(1)}×`, 4, y + 4);
        }
        const col = mode === 'crash' ? '#ff5c7a' : mode === 'won' ? '#14f195' : '#eac837';
        ctx.beginPath();
        for (let i = 0; i <= 80; i++) {
          const t = (el * i) / 80;
          const x = X(t);
          const y = Y(Math.exp(RATE * t));
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.lineWidth = 4; ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 16; ctx.stroke(); ctx.shadowBlur = 0;
        ctx.lineTo(X(el), Y(1)); ctx.lineTo(X(0), Y(1)); ctx.closePath();
        const g = ctx.createLinearGradient(0, Y(m), 0, Y(1));
        g.addColorStop(0, `${col}55`); g.addColorStop(1, `${col}00`);
        ctx.fillStyle = g; ctx.fill();
        // rocket
        const hx = X(el);
        const hy = Y(m);
        ctx.save(); ctx.translate(hx, hy);
        ctx.font = '900 22px "Font Awesome 6 Free"';
        ctx.fillStyle = mode === 'crash' ? '#ff5c7a' : '#fff';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(mode === 'crash' ? '' : '', 0, 0);
        ctx.restore();
      };
      const ui = () => {
        const flying = round && round.status === 'active';
        amt.lock(flying);
        $('#cr-auto').disabled = flying;
        segLock($('#cr-risk'), flying);
        const go = $('#g-go');
        if (flying) { go.className = 'btn btn-green btn-block btn-lg'; go.textContent = 'Cash out'; go.disabled = busy; } else { go.className = 'btn btn-gold btn-block btn-lg'; go.textContent = 'Bet'; go.disabled = busy; }
      };
      const hist = [];
      const end = (res) => {
        cancelAnimationFrame(raf);
        round = res.bet;
        const v = round.view;
        const won = round.payout > 0;
        const el = Math.log(v.crashedAt) / RATE;
        draw(el, v.crashedAt, 'crash');
        const big = $('#cr-big');
        big.textContent = fmtMult(v.crashedAt);
        big.className = 'cr-big crashed';
        $('#cr-sub').innerHTML = won ? `<span class="green">Cashed out at ${fmtMult(v.cashedAt)} · +${money(round.payout - round.amount)}</span>` : `Crashed at ${fmtMult(v.crashedAt)}`;
        hist.unshift(v.crashedAt);
        $('#cr-hist').innerHTML = hist.slice(0, 12).map((m) => `<span class="${m >= 2 ? 'good' : 'bad'}">${fmtMult(m)}</span>`).join('');
        settleFx(res, won ? big : null);
        ui();
      };
      const loop = () => {
        if (!cv.isConnected || token !== alive || !round || round.status !== 'active') return;
        const el = Date.now() + offset - round.view.started_at;
        const m = Math.floor(Math.exp(RATE * Math.max(0, el)) * 100) / 100;
        draw(Math.max(0, el), m, 'fly');
        const big = $('#cr-big');
        big.textContent = fmtMult(m);
        big.className = 'cr-big';
        raf = requestAnimationFrame(loop);
      };
      const poll = async () => {
        if (token !== alive || !round || round.status !== 'active') return;
        const res = await act(round.id, 'poll');
        if (!res || token !== alive) return;
        if (res.bet.status === 'settled') { end(res); return; }
        polling = setTimeout(poll, 350);
      };
      const start = (b) => {
        round = b;
        offset = b.view.server_now - Date.now();
        $('#cr-sub').textContent = b.view.auto ? `Auto cash out at ${fmtMult(b.view.auto)}` : 'Cash out before it crashes';
        cancelAnimationFrame(raf);
        loop();
        clearTimeout(polling);
        polling = setTimeout(poll, 350);
        ui();
      };
      $('#g-go').addEventListener('click', async () => {
        if (busy) return;
        if (round && round.status === 'active') {
          busy = true; ui();
          const res = await act(round.id, 'cashout');
          busy = false;
          if (res && res.bet.status === 'settled') end(res); else ui();
          return;
        }
        const auto = $('#cr-auto').value ? Number($('#cr-auto').value) : '';
        busy = true; ui();
        predebit(amt.get());
        const res = await bet('crash', amt.get(), { auto });
        busy = false;
        if (!res) { ui(); return; }
        GR.setUser(res.user);
        start(res.bet);
      });
      resize();
      draw(0, 1, 'fly');
      const ro = new ResizeObserver(() => { if (!cv.isConnected) { ro.disconnect(); return; } resize(); if (!round || round.status !== 'active') draw(0, 1, 'fly'); });
      ro.observe(cv);
      ui();
      activeRound('crash').then((b) => { if (b && cv.isConnected) start(b); });
    },
  };

  /* =============================================================== LOBBY */

  async function lobby() {
    alive++;
    currentGame = null;
    GR.page(`<div class="press quiet games-hero gl-hero" data-reveal>
        <div class="games-dice"><i class="fa-solid fa-dice-five"></i><i class="fa-solid fa-dice-three"></i></div>
        <h1>Games</h1>
        <p class="muted mt-8">Sixteen originals, played with your balance. Every result is provably fair: you can check any bet yourself.</p>
        <div class="row wrap" style="justify-content:center;gap:10px;margin-top:16px">
          <button class="btn btn-sm" id="gl-fair"><i class="fa-solid fa-shield-halved"></i> How fairness works</button>
          <span class="badge b-gold">18+ only</span></div>
      </div>
      <div class="gl-grid" id="gl-grid">${LIST.map(([id, name, icon, color, blurb]) => `<a href="#/games/${id}" class="press gl-card" style="--c:${color}" data-reveal>
        <span class="gl-icon"><i class="fa-solid ${icon}"></i></span><b>${name}</b><small>${blurb}</small><span class="gl-rtp" data-rtp="${id}"></span></a>`).join('')}</div>
      <div class="sec-title"><i class="fa-solid fa-bolt"></i> Live bets</div>
      <div id="gl-live">${GR.skels(1, 120)}</div>
      <p class="g-legal"><i class="fa-solid fa-circle-info"></i> 18+ only. Bets use your real balance and results are final. Play for fun, not to make money.</p>`);
    $('#gl-fair').addEventListener('click', () => openFair());
    try {
      await loadCfg();
      cfg.games.forEach((g) => { const el = $(`[data-rtp="${g.id}"]`); if (el) el.textContent = `RTP ${g.rtp}%`; });
      if (!cfg.enabled) $('#gl-grid').insertAdjacentHTML('beforebegin', '<div class="notice warn mt-16" style="border-radius:14px"><i class="fa-solid fa-power-off"></i><span>Games are switched off right now.</span></div>');
      const { bets } = await api('/games/live');
      const el = $('#gl-live');
      if (!el) return;
      el.innerHTML = bets.length ? `<div class="table-wrap"><table><thead><tr><th>Game</th><th>Player</th><th>Bet</th><th>Multiplier</th><th style="text-align:right">Payout</th></tr></thead><tbody>
        ${bets.map((b) => `<tr><td><a href="#/games/${esc(b.game)}"><i class="fa-solid ${INFO[b.game] ? INFO[b.game].icon : 'fa-dice'} gold"></i> <b>${esc(b.name)}</b></a></td><td>${GR.avatar(b.username, b.avatar_color)} ${esc(b.username)}</td>
          <td class="money">${money(b.amount)}</td><td><span class="badge ${b.payout > b.amount ? 'b-green' : 'b-gray'}">${fmtMult(b.multiplier)}</span></td>
          <td style="text-align:right" class="money ${b.payout > b.amount ? 'green' : 'faint'}">${money(b.payout)}</td></tr>`).join('')}</tbody></table></div>`
        : GR.emptyHTML('No bets yet. Be the first.', 'fa-dice');
    } catch (err) { toast(err.message, 'error'); }
  }

  GR.games = { lobby, play };
  // Leaving the games pages stops any running animation loops.
  window.addEventListener('hashchange', () => { if (!/^#\/games\//.test(location.hash)) { alive++; currentGame = null; } });
})();
