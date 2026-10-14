/* Keno — pick 1-10 of 40 numbers, 10 are drawn.
   The draw runs at normal speed until you are sitting on 5 hits with more still possible.
   From then on every tile takes longer to land than the last: a spotlight hunts across the board,
   the board creeps closer, the heartbeat quickens and the music gives way to a rising drone. */
(function () {
  'use strict';
  const { $, $$, h, fmt, fmtMult, sleep, round2, rand, randInt } = GG;

  const N = 40, DRAWS = 10, MAX_PICKS = 10;
  const TENSION_AT = 5; // hits needed before the slow-down starts

  /* Multiplier by [risk][picks][hits]. Every row returns ~99% (checked against the hypergeometric odds). */
  const PAY = {
    low: {
      1: [0.7, 1.85], 2: [0, 2, 3.8], 3: [0, 1.1, 1.38, 26], 4: [0, 0, 2.2, 7.9, 90], 5: [0, 0, 1.5, 4.2, 13, 300],
      6: [0, 0, 1.1, 2, 6.2, 100, 700], 7: [0, 0, 1.1, 1.6, 3.5, 15, 225, 700], 8: [0, 0, 1.1, 1.5, 2, 5.5, 39, 100, 800],
      9: [0, 0, 1.1, 1.3, 1.7, 2.5, 7.5, 50, 250, 1000], 10: [0, 0, 1.1, 1.2, 1.3, 1.8, 3.5, 13, 50, 250, 1000],
    },
    medium: {
      1: [0.4, 2.75], 2: [0, 1.8, 5.1], 3: [0, 0, 2.8, 50], 4: [0, 0, 1.7, 10, 100], 5: [0, 0, 1.4, 4, 14, 390],
      6: [0, 0, 0, 3, 9, 180, 710], 7: [0, 0, 0, 2, 7, 30, 400, 800], 8: [0, 0, 0, 2, 4, 11, 67, 400, 900],
      9: [0, 0, 0, 2, 2.5, 5, 15, 100, 500, 1000], 10: [0, 0, 0, 1.6, 2, 4, 7, 26, 100, 500, 1000],
    },
    high: {
      1: [0, 3.96], 2: [0, 0, 17.1], 3: [0, 0, 0, 81.5], 4: [0, 0, 0, 10, 259], 5: [0, 0, 0, 4.5, 48, 450],
      6: [0, 0, 0, 0, 11, 350, 710], 7: [0, 0, 0, 0, 7, 90, 400, 800], 8: [0, 0, 0, 0, 5, 20, 270, 600, 900],
      9: [0, 0, 0, 0, 4, 11, 56, 500, 800, 1000], 10: [0, 0, 0, 0, 3.5, 8, 13, 63, 500, 800, 1000],
    },
  };

  let amount, stageEl, risk = 'medium', picks = new Set(), state = 'idle', alive = 0, hits = 0, showHits = false;

  const tile = (n) => $(`.kn-tile[data-n="${n}"]`);


  function paintPay() {
    const box = $('#kn-pay');
    if (!box) return;
    const n = picks.size;
    if (!n) { box.innerHTML = '<div class="kn-hint">Pick 1 to 10 numbers to see what each hit count pays</div>'; return; }
    box.innerHTML = PAY[risk][n].map((m, k) =>
      `<div class="kn-cell${m ? '' : ' zero'}${showHits && k === hits ? ' on' : ''}${showHits && k < hits ? ' past' : ''}"><b>${fmtMult(m)}</b><small>${k} hit${k === 1 ? '' : 's'}</small></div>`).join('');
  }

  function ui() {
    const busy = state === 'drawing';
    amount.lock(busy);
    $$('#kn-risk button, #kn-auto, #kn-clear').forEach((b) => { b.disabled = busy; });
    $('#kn-bet').disabled = busy;
    $('#kn-bet').textContent = busy ? 'Drawing…' : 'Bet';
    $('#kn-picks').textContent = `${picks.size} / ${MAX_PICKS}`;
    $('#kn-hits').textContent = hits;
    $('.kn-board').classList.toggle('locked', busy);
  }

  function clearMarks() {
    $$('.kn-tile').forEach((t) => t.classList.remove('hit', 'miss', 'scan', 'lock', 'faded'));
    $$('#kn-dots i').forEach((d) => { d.className = ''; });
    $('#kn-res').className = 'result-pop';
    hits = 0; showHits = false;
  }

  function setTension(level) {
    if (!stageEl) return;
    stageEl.style.setProperty('--tz', level);
    stageEl.classList.toggle('tense', level > 0);
    GG.tension(level);
  }

  function toggle(n) {
    if (state !== 'idle') return;
    if (showHits || $('.kn-tile.miss')) clearMarks(); // first touch after a round wipes the last result
    if (picks.has(n)) picks.delete(n);
    else {
      if (picks.size >= MAX_PICKS) { GG.toast('10 numbers is the most you can pick.', 'error'); return; }
      picks.add(n);
    }
    tile(n).classList.toggle('pick', picks.has(n));
    GG.sfx('click');
    paintPay(); ui();
  }

  /* The slow part: a spotlight hops across undrawn tiles, slower and slower, then locks on. */
  async function suspense(target, level, my) {
    const open = $$('.kn-tile').filter((t) => !t.classList.contains('hit') && !t.classList.contains('miss') && Number(t.dataset.n) !== target);
    const mine = open.filter((t) => picks.has(Number(t.dataset.n)));
    const rest = open.filter((t) => !picks.has(Number(t.dataset.n)));
    const hops = 5 + level * 2, dMax = 220 + level * 70;
    let last = null;
    for (let k = 0; k < hops; k++) {
      const from = mine.length && (rand() < 0.55 || !rest.length) ? mine : rest;
      if (!from.length) break;
      let t = from[randInt(from.length)];
      if (t === last && from.length > 1) t = from[(from.indexOf(t) + 1) % from.length];
      if (last) last.classList.remove('scan');
      t.classList.add('scan');
      last = t;
      GG.sfx('scan', k / hops);
      await sleep(70 + (dMax - 70) * Math.pow(k / (hops - 1), 1.6));
      if (my !== alive) return;
    }
    if (last) last.classList.remove('scan');
    const el = tile(target);
    el.classList.add('lock');
    GG.sfx('lock');
    await sleep(380 + level * 170);
    el.classList.remove('lock');
  }

  async function play() {
    if (state !== 'idle') return;
    if (!picks.size) { GG.toast('Pick at least one number first.', 'error'); GG.nudge($('.kn-board')); return; }
    const bet = amount.get();
    const my = ++alive;
    state = 'drawing';
    ui();
    const res = await GG.bet('keno', bet, { picks: [...picks], risk });
    if (my !== alive) return;
    if (!res) { state = 'idle'; ui(); return; }
    const drawn = res.bet.result.drawn;
    const mult = PAY[risk][picks.size][res.bet.result.hits];

    clearMarks();
    showHits = true;
    ui(); paintPay();
    const dots = $$('#kn-dots i');

    for (let i = 0; i < DRAWS; i++) {
      const n = drawn[i], isHit = picks.has(n);
      const level = hits - TENSION_AT + 1;
      const tense = hits >= TENSION_AT && hits < picks.size;
      if (tense) await suspense(n, level, my);
      else await sleep(i === 0 ? 280 : 170);
      if (my !== alive) return;

      const el = tile(n);
      el.classList.add(isHit ? 'hit' : 'miss');
      dots[i].className = isHit ? 'hit' : 'miss';
      if (isHit) {
        hits++;
        GG.sfx('kenoHit', hits);
        if (tense) { GG.sfx('impact'); stageEl.classList.remove('flash'); void stageEl.offsetWidth; stageEl.classList.add('flash'); }
        $('#kn-hits').textContent = hits;
        paintPay();
        if (hits >= TENSION_AT && hits < picks.size && i < DRAWS - 1) setTension(hits - TENSION_AT + 1);
      } else {
        GG.sfx(tense ? 'aww' : 'kenoMiss');
      }
    }

    await sleep(hits >= TENSION_AT ? 750 : 320);
    if (my !== alive) return;
    setTension(0);
    $$('.kn-tile').forEach((t) => { if (!t.classList.contains('hit') && !t.classList.contains('miss') && !t.classList.contains('pick')) t.classList.add('faded'); });
    GG.settle(res, { from: $('.kn-board'), quiet: mult <= 1 });
    if (mult > 0) {
      const pop = $('#kn-res'), net = round2((res.bet.payout - res.bet.amount) / 100);
      pop.className = 'result-pop show' + (net > 0 ? '' : ' push');
      pop.innerHTML = `<b>${fmtMult(mult)}</b><span>${GG.coin('sm')}${net > 0 ? '+' : ''}${fmt(net)}</span>`;
      if (mult >= 10) { GG.sfx('bigwin'); GG.confetti($('.kn-wrap'), 80); } else GG.sfx(net > 0 ? 'win' : 'push');
    } else GG.sfx('lose');
    state = 'idle';
    ui();
  }

  function art() {
    let s = '';
    const lit = { 1: 'hit', 5: 'pick', 6: 'hit', 10: 'hit', 2: 'pick' };
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const i = r * 4 + c, k = lit[i];
        const fill = k === 'hit' ? '#14f195' : k === 'pick' ? '#7b5cff' : '#1c1300';
        s += `<rect x="${22 + c * 40}" y="${44 + r * 40}" width="34" height="34" rx="9" fill="${fill}" opacity="${k ? 1 : .55}"/>`;
        if (k === 'hit') s += `<path d="M${39 + c * 40} ${52 + r * 40}l8 6-8 12-8-12z" fill="#eafff4"/>`;
      }
    }
    return `<svg viewBox="0 0 200 200">${s}</svg>`;
  }

  GG.registerGame({
    id: 'keno',
    name: 'Keno',
    rtp: '99.0',
    colors: ['#f2b01e', '#3a2500'],
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="5" height="5" rx="1.400"/><rect x="9.500" y="3" width="5" height="5" rx="1.400" opacity=".45"/><rect x="16" y="3" width="5" height="5" rx="1.400"/><rect x="3" y="9.500" width="5" height="5" rx="1.400" opacity=".45"/><rect x="9.500" y="9.500" width="5" height="5" rx="1.400"/><rect x="16" y="9.500" width="5" height="5" rx="1.400" opacity=".45"/><rect x="3" y="16" width="5" height="5" rx="1.400"/><rect x="9.500" y="16" width="5" height="5" rx="1.400" opacity=".45"/><rect x="16" y="16" width="5" height="5" rx="1.400"/></svg>',
    art: art(),

    mount(panel, stage) {
      stageEl = stage; state = 'idle'; hits = 0; showHits = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Risk</span>
          <div class="gseg" id="kn-risk">${['low', 'medium', 'high'].map((r) => `<button data-v="${r}" class="${r === risk ? 'on' : ''}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}</div></div>
        <div class="row2" style="margin-bottom:14px">
          <button class="gbtn ghost" id="kn-auto">Auto pick</button>
          <button class="gbtn ghost" id="kn-clear">Clear</button>
        </div>
        <button class="gbtn primary lg block" id="kn-bet">Bet</button>
        <p class="panel-note">Pick up to 10 numbers, then 10 are drawn. Land 5 hits with more to come and the draw slows right down — every tile after that takes longer than the last.</p>
      </div>`));

      let tiles = '', dots = '';
      for (let i = 1; i <= N; i++) tiles += `<button class="kn-tile${picks.has(i) ? ' pick' : ''}" data-n="${i}"><span>${i}</span></button>`;
      for (let i = 0; i < DRAWS; i++) dots += '<i></i>';
      stage.classList.add('kn-stage');
      stage.appendChild(h(`<div class="kn-wrap">
        <div class="kn-hud">
          <div class="kn-stat"><small>Picks</small><b id="kn-picks">0 / 10</b></div>
          <div class="kn-dots" id="kn-dots" aria-label="Draw progress">${dots}</div>
          <div class="kn-stat r"><small>Hits</small><b id="kn-hits">0</b></div>
        </div>
        <div class="kn-zoom"><div class="kn-board">${tiles}</div></div>
        <div class="kn-pay" id="kn-pay"></div>
        <div class="result-pop" id="kn-res"></div>
      </div>`));
      stage.appendChild(h('<div class="kn-vig"></div>'));

      $('.kn-board').addEventListener('click', (e) => {
        const t = e.target.closest('.kn-tile');
        if (t) toggle(Number(t.dataset.n));
      });
      $('#kn-risk').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || b.disabled) return;
        risk = b.dataset.v;
        GG.sfx('click');
        $$('#kn-risk button').forEach((x) => x.classList.toggle('on', x === b));
        paintPay();
      });
      $('#kn-auto').addEventListener('click', () => {
        if (state !== 'idle') return;
        clearMarks();
        picks = new Set();
        while (picks.size < MAX_PICKS) picks.add(1 + randInt(N));
        $$('.kn-tile').forEach((t) => t.classList.toggle('pick', picks.has(Number(t.dataset.n))));
        GG.sfx('card');
        paintPay(); ui();
      });
      $('#kn-clear').addEventListener('click', () => {
        if (state !== 'idle') return;
        clearMarks();
        picks = new Set();
        $$('.kn-tile').forEach((t) => t.classList.remove('pick'));
        paintPay(); ui();
      });
      $('#kn-bet').addEventListener('click', play);
      paintPay(); ui();
    },

    unmount() {
      alive++;
      setTension(0);
      state = 'idle'; stageEl = null;
    },
  });
})();
