/* Roulette — European single-zero wheel. The wheel stays put; the ball circles the track and drops
   into the winning pocket. Straight 35:1, dozens/columns 2:1, outside bets 1:1. */
(function () {
  'use strict';
  const { $, $$, h, fmt, sleep, round2 } = GG;

  const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const SEG = 360 / 37;
  const SPIN_MS = 6000, DROP_AT = 3900;
  const colorOf = (n) => (n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black');

  let bets = {}, undo = [], chip = 1, spinning = false, alive = 0, ballRot = 0, ticks = [];
  const history = [];

  const sum = () => round2(Object.values(bets).reduce((a, b) => a + b, 0));

  /* A casino wheel: wooden rim, ball track with deflectors, number ring, pocket ring with metal frets,
     wooden cone and a silver turret. Pocket i is centred i * SEG clockwise from the top, where the ball
     lands (it rests 100px from the centre and rolls on the track at 143px). */
  function drawWheel(cv) {
    const S = 340, dpr = Math.min(2, window.devicePixelRatio || 1), cx = S / 2, cy = S / 2, seg = (Math.PI * 2) / 37, TAU = Math.PI * 2;
    cv.width = S * dpr; cv.height = S * dpr;
    const c = cv.getContext('2d');
    c.scale(dpr, dpr);
    const radial = (r0, r1, stops, ox = 0, oy = 0) => {
      const g = c.createRadialGradient(cx + ox, cy + oy, r0, cx, cy, r1);
      stops.forEach(([o, col]) => g.addColorStop(o, col));
      return g;
    };
    const disc = (r, fill) => { c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.fillStyle = fill; c.fill(); };
    const ring = (r0, r1, fill) => { c.beginPath(); c.arc(cx, cy, r1, 0, TAU); c.arc(cx, cy, r0, 0, TAU, true); c.fillStyle = fill; c.fill(); };
    const circle = (r, stroke, w) => { c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.strokeStyle = stroke; c.lineWidth = w; c.stroke(); };
    const spoke = (a, r0, r1) => { c.beginPath(); c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); c.stroke(); };
    const metal = (x0, y0, x1, y1) => {
      const g = c.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, '#f6f8fc'); g.addColorStop(.5, '#a3abbb'); g.addColorStop(1, '#e4e8f0');
      return g;
    };

    // wooden rim with gold edges
    disc(170, radial(148, 170, [[0, '#3a1d08'], [.45, '#7e461b'], [.8, '#5a2e10'], [1, '#2b1405']]));
    circle(169, '#e9c46a', 2);
    circle(158.5, '#c99a3c', 1.5);
    // the ball track: dark polished wood, lighter towards the rim, with eight diamond deflectors
    ring(132, 158, radial(132, 158, [[0, '#110904'], [.7, '#2a170a'], [1, '#41240f']]));
    c.fillStyle = '#e8c56d';
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4 + Math.PI / 8;
      c.save(); c.translate(cx + Math.cos(a) * 146, cy + Math.sin(a) * 146); c.rotate(a);
      c.beginPath(); c.moveTo(-7, 0); c.lineTo(0, -3.2); c.lineTo(7, 0); c.lineTo(0, 3.2); c.closePath(); c.fill();
      c.restore();
    }
    // number ring (outer) and pocket ring (inner, deeper colour)
    const colours = (n) => (n === 0 ? ['#14a35d', '#0b7340'] : REDS.has(n) ? ['#cc1f3a', '#8c0f24'] : ['#1b1e27', '#0c0d12']);
    for (let i = 0; i < 37; i++) {
      const a0 = -Math.PI / 2 + (i - 0.5) * seg, a1 = a0 + seg;
      const [face, deep] = colours(ORDER[i]);
      c.beginPath(); c.arc(cx, cy, 132, a0, a1); c.arc(cx, cy, 108, a1, a0, true); c.closePath(); c.fillStyle = face; c.fill();
      c.beginPath(); c.arc(cx, cy, 108, a0, a1); c.arc(cx, cy, 86, a1, a0, true); c.closePath(); c.fillStyle = deep; c.fill();
    }
    ring(86, 108, radial(86, 108, [[0, 'rgba(0, 0, 0, .5)'], [1, 'rgba(0, 0, 0, 0)']]));
    c.strokeStyle = 'rgba(233, 196, 106, .5)'; c.lineWidth = 1;
    for (let i = 0; i < 37; i++) spoke(-Math.PI / 2 + (i - 0.5) * seg, 108, 132);
    c.strokeStyle = '#dfe3ec'; c.lineWidth = 1.6;
    for (let i = 0; i < 37; i++) spoke(-Math.PI / 2 + (i - 0.5) * seg, 86, 108);
    circle(132, '#e9c46a', 2);
    circle(108, '#cfd4de', 2);
    circle(86, '#cfd4de', 2.5);
    // the numbers read outwards, like a real wheel
    c.fillStyle = '#fff'; c.font = '800 12.5px Inter, Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < 37; i++) { c.save(); c.translate(cx, cy); c.rotate(i * seg); c.fillText(String(ORDER[i]), 0, -120); c.restore(); }
    // wooden cone
    disc(85, radial(4, 85, [[0, '#d0955a'], [.35, '#9c5c28'], [.75, '#6b3816'], [1, '#3e1f0a']], -18, -22));
    circle(72, 'rgba(255, 220, 160, .08)', 1);
    circle(58, 'rgba(255, 220, 160, .08)', 1);
    circle(85, '#e9c46a', 1.5);
    // silver turret: four arms with knobs, and a centre cap
    c.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4;
      const x = cx + Math.cos(a) * 46, y = cy + Math.sin(a) * 46;
      c.strokeStyle = 'rgba(0, 0, 0, .35)'; c.lineWidth = 8; c.beginPath(); c.moveTo(cx + 2, cy + 3); c.lineTo(x + 2, y + 3); c.stroke();
      c.strokeStyle = metal(cx, cy, x, y); c.lineWidth = 6; c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y); c.stroke();
      c.fillStyle = metal(x - 6, y - 6, x + 6, y + 6); c.beginPath(); c.arc(x, y, 6.5, 0, TAU); c.fill();
    }
    c.lineCap = 'butt';
    c.fillStyle = 'rgba(0, 0, 0, .35)'; c.beginPath(); c.arc(cx + 2, cy + 3, 15, 0, TAU); c.fill();
    c.fillStyle = metal(cx - 14, cy - 14, cx + 14, cy + 14); c.beginPath(); c.arc(cx, cy, 14, 0, TAU); c.fill();
    c.fillStyle = 'rgba(255, 255, 255, .7)'; c.beginPath(); c.arc(cx - 4, cy - 5, 4, 0, TAU); c.fill();
    // a soft gloss over the whole wheel
    disc(170, radial(0, 170, [[0, 'rgba(255, 255, 255, .1)'], [.6, 'rgba(255, 255, 255, .02)'], [1, 'rgba(255, 255, 255, 0)']], -70, -90));
  }

  function boardHTML() {
    let cells = `<div class="rl-cell green zero" data-k="n:0">0</div>`;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 12; c++) {
        const n = 3 * (c + 1) - r;
        cells += `<div class="rl-cell ${colorOf(n)}" data-k="n:${n}">${n}</div>`;
      }
      cells += `<div class="rl-cell out" data-k="col${3 - r}">2:1</div>`;
    }
    cells += `<div class="rl-cell out s4 c2" data-k="doz1">1 to 12</div><div class="rl-cell out s4" data-k="doz2">13 to 24</div><div class="rl-cell out s4" data-k="doz3">25 to 36</div>`;
    cells += `<div class="rl-cell out s2 c2" data-k="low">1-18</div><div class="rl-cell out s2" data-k="even">Even</div><div class="rl-cell red s2" data-k="red">Red</div><div class="rl-cell black s2" data-k="black">Black</div><div class="rl-cell out s2" data-k="odd">Odd</div><div class="rl-cell out s2" data-k="high">19-36</div>`;
    return cells;
  }

  /* Each spot shows its chips as a stack. Only spots that changed are redrawn, so the new chip can pop. */
  function paintBets() {
    $$('.rl-cell').forEach((cell) => {
      const v = bets[cell.dataset.k] || 0;
      if (cell.dataset.v === String(v)) return;
      cell.dataset.v = String(v);
      const old = $('.chipstack', cell);
      if (!v) { if (old) old.remove(); return; }
      if (old) old.remove();
      cell.insertAdjacentHTML('beforeend', GG.chipStack(v));
    });
    $('#rl-total').textContent = fmt(sum());
  }

  function ui() {
    $('#rl-spin').disabled = spinning;
    $('#rl-undo').disabled = spinning || !undo.length;
    $('#rl-clear').disabled = spinning || !sum();
    $('.rl-board').classList.toggle('locked', spinning);
  }

  function paintHistory() {
    $('#rl-hist').innerHTML = history.slice(0, 12).map((n) => `<span class="rl-h ${colorOf(n)}">${n}</span>`).join('') || '<span class="rl-none">No spins yet</span>';
  }

  function place(key) {
    if (spinning) return;
    if (!GG.me()) { window.GR.openAuth('register'); return; }
    if (sum() + chip > GG.balance() + 1e-9) { GG.toast('Not enough balance for that chip.', 'error'); return; }
    if (sum() + chip > GG.maxBet() + 1e-9) { GG.toast(`The most you can have on the table is $${fmt(GG.maxBet())}.`, 'error'); return; }
    bets[key] = round2((bets[key] || 0) + chip);
    undo.push([key, chip]);
    GG.sfx('click');
    paintBets(); ui();
  }

  function clearTicks() { ticks.forEach(clearTimeout); ticks = []; }

  /* Clicks as the ball passes pockets: fast at first, slowing as it loses speed. */
  function scheduleTicks() {
    clearTicks();
    let t = 60, gap = 46;
    while (t < SPIN_MS - 250) {
      const vol = Math.max(0.35, 1 - t / SPIN_MS);
      ticks.push(setTimeout(() => GG.sfx('tick', vol), t));
      gap *= 1.07;
      t += gap;
    }
  }

  async function spin() {
    if (spinning) return;
    const total = sum();
    if (total <= 0) { GG.toast('Place a chip on the table first.', 'error'); GG.nudge($('.rl-board')); return; }
    const my = ++alive;
    spinning = true;
    ui();
    const chips = {};
    for (const k in bets) chips[k.replace(':', '_')] = Math.round(bets[k] * 100);
    const res = await GG.bet('roulette', total, { chips });
    if (my !== alive) return;
    if (!res) { spinning = false; ui(); return; }
    $$('.rl-cell.hit').forEach((c) => c.classList.remove('hit'));
    $('#rl-hub').className = 'rl-hub';
    $('#rl-msg').className = 'rl-msg';
    $('#rl-win').className = 'rl-win';
    ui();

    const n = res.bet.result.n;
    const idx = ORDER.indexOf(n);
    const payout = res.bet.payout / 100;
    const delta = (((idx * SEG - ballRot) % 360) + 360) % 360;
    ballRot += 360 * 6 + delta;
    const ball = $('#rl-ball');
    ball.classList.add('rolling');
    $('#rl-orbit').style.transform = `rotate(${ballRot}deg)`;
    scheduleTicks();
    await sleep(DROP_AT); if (my !== alive) return;
    ball.classList.remove('rolling');
    await sleep(SPIN_MS - DROP_AT + 250); if (my !== alive) return;

    GG.settle(res, { from: $('#rl-hub') });
    GG.sfx(payout > total ? 'win' : payout > 0 ? 'push' : 'lose');
    history.unshift(n);
    paintHistory();
    const hub = $('#rl-hub');
    hub.textContent = n;
    hub.className = 'rl-hub show ' + colorOf(n);
    const w = $('#rl-win');
    w.style.setProperty('--a', idx * SEG + 'deg');
    w.className = 'rl-win show';
    const cell = $(`.rl-cell[data-k="n:${n}"]`);
    if (cell) cell.classList.add('hit');
    const msg = $('#rl-msg');
    msg.className = 'rl-msg show ' + (payout > 0 ? 'good' : 'bad');
    msg.innerHTML = payout > 0
      ? `<b>${n} ${colorOf(n)}</b> — you won ${GG.coin('sm')}${fmt(payout)}`
      : `<b>${n} ${colorOf(n)}</b> — no win this spin`;
    spinning = false;
    ui();
  }

  function wheelArt() {
    let s = '';
    const R = 86, r = 54, cx = 100, cy = 100;
    const p = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(1)} ${(cy + rad * Math.sin(a)).toFixed(1)}`;
    for (let i = 0; i < 37; i++) {
      const a0 = (i / 37) * 2 * Math.PI - Math.PI / 2, a1 = ((i + 1) / 37) * 2 * Math.PI - Math.PI / 2;
      const col = i === 0 ? '#1fae6a' : i % 2 ? '#d02c47' : '#191c26';
      s += `<path d="M${p(R, a0)}A${R} ${R} 0 0 1 ${p(R, a1)}L${p(r, a1)}A${r} ${r} 0 0 0 ${p(r, a0)}Z" fill="${col}" stroke="#e2bd66" stroke-width=".6"/>`;
    }
    return `<svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="97" fill="#e2bd66"/><circle cx="100" cy="100" r="91" fill="#2a1e0e"/>${s}
      <circle cx="100" cy="100" r="54" fill="#e2bd66"/><circle cx="100" cy="100" r="50" fill="#3a280f"/>
      <path d="M100 62v76M62 100h76" stroke="#e2bd66" stroke-width="5" stroke-linecap="round"/><circle cx="100" cy="100" r="13" fill="#f3d98c"/>
      <circle cx="147" cy="50" r="8" fill="#fff"/></svg>`;
  }

  GG.registerGame({
    id: 'roulette',
    name: 'Roulette',
    rtp: '97.3',
    colors: ['#d8344f', '#3a0d18'],
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.400"/><circle cx="12" cy="12" r="2.600" fill="currentColor"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    art: wheelArt(),

    mount(panel, stage) {
      spinning = false;
      panel.appendChild(h(`<div>
        <div class="gfield">
          <span class="gfield-l">Chip value</span>
          <div class="rl-chips">${GG.chipButtons(chip)}</div>
        </div>
        <div class="gfield">
          <span class="gfield-l">Total bet</span>
          <div class="readout">${GG.coin()}<span id="rl-total">0.00</span></div>
        </div>
        <button class="gbtn primary lg block" id="rl-spin">Spin</button>
        <div class="row2" style="margin-top:10px">
          <button class="gbtn ghost" id="rl-undo">Undo</button>
          <button class="gbtn ghost" id="rl-clear">Clear</button>
        </div>
      </div>`));

      stage.classList.add('rl-stage');
      stage.appendChild(h(`<div class="rl-wrap">
        <div class="rl-top">
          <div class="rl-wheelbox">
            <canvas id="rl-wheel" class="rl-wheel"></canvas>
            <div class="rl-win" id="rl-win"></div>
            <div class="rl-orbit" id="rl-orbit" style="transform:rotate(${ballRot}deg)"><i class="rl-ball" id="rl-ball"></i></div>
            <div class="rl-hub" id="rl-hub"></div>
          </div>
          <div class="rl-side">
            <span class="gfield-l">Previous spins</span>
            <div class="rl-hist" id="rl-hist"></div>
            <div class="rl-msg" id="rl-msg"></div>
          </div>
        </div>
        <div class="rl-scroll"><div class="rl-board">${boardHTML()}</div></div>
      </div>`));

      const cv = $('#rl-wheel');
      drawWheel(cv);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (cv.isConnected) drawWheel(cv); });

      $('.rl-chips').addEventListener('click', (e) => {
        const b = e.target.closest('.chipbtn');
        if (!b) return;
        chip = Number(b.dataset.v);
        GG.sfx('click');
        $$('.chipbtn').forEach((x) => x.classList.toggle('on', x === b));
      });
      const board = $('.rl-board');
      board.addEventListener('click', (e) => {
        const cell = e.target.closest('.rl-cell');
        if (cell) place(cell.dataset.k);
      });
      board.addEventListener('contextmenu', (e) => {
        const cell = e.target.closest('.rl-cell');
        if (!cell) return;
        e.preventDefault();
        if (spinning || !bets[cell.dataset.k]) return;
        delete bets[cell.dataset.k];
        undo = undo.filter((u) => u[0] !== cell.dataset.k);
        paintBets(); ui();
      });
      $('#rl-spin').addEventListener('click', spin);
      $('#rl-undo').addEventListener('click', () => {
        const last = undo.pop();
        if (!last) return;
        bets[last[0]] = round2(bets[last[0]] - last[1]);
        if (bets[last[0]] <= 0) delete bets[last[0]];
        paintBets(); ui();
      });
      $('#rl-clear').addEventListener('click', () => { bets = {}; undo = []; paintBets(); ui(); });
      paintBets(); paintHistory(); ui();
    },

    unmount() {
      alive++;
      clearTicks();
      spinning = false;
      ballRot %= 360;
    },
  });
})();
