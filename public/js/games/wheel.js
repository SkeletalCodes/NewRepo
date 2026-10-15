/* Wheel — spin for a multiplier. Risk sets how the prizes are spread; segments set how many slices there are.
   Low: most slices pay a little. Medium: half pay nothing, the rest pay more. High: one slice pays everything. */
(function () {
  'use strict';
  const { $, $$, h, fmt, fmtMult, sleep, round2, rand } = GG;

  const BASE = {
    low: [1.5, 1.2, 1.2, 1.2, 0, 1.2, 1.2, 1.2, 1.2, 0],
    medium: [0, 1.9, 0, 1.5, 0, 2, 0, 1.5, 0, 3],
  };
  const SPIN_MS = 4400;
  const colorOf = (m) => (m === 0 ? '#3a4156' : m <= 1.2 ? '#e5e9f2' : m <= 1.5 ? '#14f195' : m <= 1.9 ? '#4d8dff' : m <= 2 ? '#9b6bff' : m <= 3 ? '#ff9d1c' : '#ff5c7a');

  let amount, risk = 'medium', count = 30, busy = false, alive = 0, rot = 0, ticks = [];
  const history = [];

  /** The prize on each slice. Every layout averages 0.99. */
  function slices(r, n) {
    if (r === 'high') { const a = new Array(n).fill(0); a[0] = round2(0.99 * n); return a; }
    const out = [];
    for (let i = 0; i < n; i++) out.push(BASE[r][i % 10]);
    return out;
  }

  function draw() {
    const cv = $('#wh-cv');
    if (!cv) return;
    const S = 360, dpr = Math.min(2, window.devicePixelRatio || 1), cx = S / 2, cy = S / 2;
    cv.width = S * dpr; cv.height = S * dpr;
    const c = cv.getContext('2d');
    c.scale(dpr, dpr);
    const list = slices(risk, count), a = (Math.PI * 2) / count, gap = Math.min(0.012, a * 0.12);
    c.fillStyle = '#0b0c11'; c.beginPath(); c.arc(cx, cy, 178, 0, 7); c.fill();
    for (let i = 0; i < count; i++) {
      const a0 = -Math.PI / 2 + i * a + gap, a1 = -Math.PI / 2 + (i + 1) * a - gap;
      c.beginPath(); c.arc(cx, cy, 172, a0, a1); c.arc(cx, cy, 128, a1, a0, true); c.closePath();
      c.fillStyle = colorOf(list[i]); c.fill();
    }
    const g = c.createRadialGradient(cx, cy - 30, 10, cx, cy, 124);
    g.addColorStop(0, '#232838'); g.addColorStop(1, '#12141c');
    c.fillStyle = g; c.beginPath(); c.arc(cx, cy, 122, 0, 7); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.07)'; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, 122, 0, 7); c.stroke();
  }

  function paintLegend(hit) {
    const list = slices(risk, count), seen = {};
    list.forEach((m) => { seen[m] = (seen[m] || 0) + 1; });
    $('#wh-legend').innerHTML = Object.keys(seen).map(Number).sort((x, y) => x - y).map((m) =>
      `<div class="wh-chip${hit === m ? ' on' : ''}" style="--c:${colorOf(m)}"><b>${fmtMult(m)}</b><small>${((seen[m] / count) * 100).toFixed(count >= 30 ? 1 : 0)}% chance</small></div>`).join('');
  }

  function paintHistory() {
    $('#wh-hist').innerHTML = history.slice(0, 12).map((m) => `<span class="hp" style="color:${m ? colorOf(m) : ''}">${fmtMult(m)}</span>`).join('') || '<span class="hp">No spins yet</span>';
  }

  function resetWheel() {
    const cv = $('#wh-cv');
    cv.style.transition = 'none';
    rot = 0;
    cv.style.transform = 'rotate(0deg)';
    void cv.offsetWidth;
    cv.style.transition = '';
    $('#wh-center').className = 'wh-center';
    draw(); paintLegend();
  }

  function ui() {
    amount.lock(busy);
    $('#wh-spin').disabled = busy;
    $$('#wh-risk button, #wh-count button').forEach((b) => { b.disabled = busy; });
  }

  function clearTicks() { ticks.forEach(clearTimeout); ticks = []; }

  async function spin() {
    if (busy) return;
    const bet = amount.get();
    const my = ++alive;
    busy = true;
    ui();
    const res = await GG.bet('wheel', bet, { risk, segments: count });
    if (my !== alive) return;
    if (!res) { busy = false; ui(); return; }
    const list = slices(risk, count), idx = res.bet.result.index, mult = list[idx];
    $('#wh-center').className = 'wh-center';
    paintLegend();
    ui();

    const a = 360 / count;
    const want = -(idx + 0.5 + (rand() - 0.5) * 0.7) * a; // somewhere inside the winning slice
    rot += 360 * 5 + ((((want - rot) % 360) + 360) % 360);
    $('#wh-cv').style.transform = `rotate(${rot}deg)`;
    $('.wh-box').classList.add('spinning');
    clearTicks();
    for (let t = 60, gapMs = 50; t < SPIN_MS - 300; gapMs *= 1.09, t += gapMs) ticks.push(setTimeout(() => GG.sfx('tick', 0.6), t));
    await sleep(SPIN_MS + 150);
    if (my !== alive) return;

    GG.settle(res, { from: $('#wh-center'), quiet: mult < 1 });
    $('.wh-box').classList.remove('spinning');
    const center = $('#wh-center'), net = round2((res.bet.payout - res.bet.amount) / 100);
    center.innerHTML = `<b>${fmtMult(mult)}</b><small>${mult >= 1 ? '+' + fmt(net) : mult > 0 ? fmt(net) : 'No win'}</small>`;
    center.style.setProperty('--c', colorOf(mult));
    center.className = 'wh-center show' + (mult > 0 ? '' : ' zero');
    paintLegend(mult);
    history.unshift(mult);
    paintHistory();
    if (mult >= 10) { GG.sfx('bigwin'); GG.confetti($('.wh-wrap'), 70); } else GG.sfx(mult > 1 ? 'win' : mult > 0 ? 'push' : 'lose');
    busy = false;
    ui();
  }

  function art() {
    let s = '';
    const list = slices('medium', 20), cx = 100, cy = 104, R = 82, r = 52;
    const p = (rad, ang) => `${(cx + rad * Math.cos(ang)).toFixed(1)} ${(cy + rad * Math.sin(ang)).toFixed(1)}`;
    for (let i = 0; i < 20; i++) {
      const a0 = (i / 20) * 2 * Math.PI - Math.PI / 2 + 0.02, a1 = ((i + 1) / 20) * 2 * Math.PI - Math.PI / 2 - 0.02;
      s += `<path d="M${p(R, a0)}A${R} ${R} 0 0 1 ${p(R, a1)}L${p(r, a1)}A${r} ${r} 0 0 0 ${p(r, a0)}Z" fill="${list[i] === 0 ? '#2a1140' : colorOf(list[i])}"/>`;
    }
    return `<svg viewBox="0 0 200 200"><circle cx="100" cy="104" r="90" fill="#12091c"/>${s}<circle cx="100" cy="104" r="44" fill="#1c0f2b"/><text x="100" y="114" font-size="26" font-weight="800" text-anchor="middle" fill="#fff" font-family="Outfit,Arial,sans-serif">3×</text><path d="M100 30l-12-22h24z" fill="#eac837" stroke="#12091c" stroke-width="3" stroke-linejoin="round"/></svg>`;
  }

  GG.registerGame({
    id: 'wheel',
    name: 'Wheel',
    rtp: '99.0',
    colors: ['#d946ef', '#34083d'],
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.500" fill="none" stroke="currentColor" stroke-width="2.400" stroke-dasharray="5.200 2.200"/><circle cx="12" cy="12" r="2.800" fill="currentColor"/><path d="M12 1.500l-2.200 3.800h4.400z" fill="currentColor"/></svg>',
    art: art(),

    mount(panel, stage) {
      busy = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Risk</span>${GG.ui.seg('wh-risk', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], risk)}</div>
        <div class="gfield"><span class="gfield-l">Segments</span>${GG.ui.seg('wh-count', [10, 20, 30, 40, 50].map((n) => [n, n]), count)}</div>
        <button class="gbtn primary lg block" id="wh-spin">Spin</button>
      </div>`));
      stage.appendChild(h(`<div class="wh-wrap">
        <div class="history" id="wh-hist"></div>
        <div class="wh-box">
          <div class="wh-pointer"></div>
          <canvas id="wh-cv" class="wh-cv" style="transform:rotate(${rot}deg)"></canvas>
          <div class="wh-center" id="wh-center"></div>
        </div>
        <div class="wh-legend" id="wh-legend"></div>
      </div>`));
      GG.ui.bindSeg($('#wh-risk'), (v) => { risk = v; resetWheel(); });
      GG.ui.bindSeg($('#wh-count'), (v) => { count = Number(v); resetWheel(); });
      $('#wh-spin').addEventListener('click', spin);
      draw(); paintLegend(); paintHistory(); ui();
    },

    unmount() {
      alive++;
      clearTicks();
      busy = false; rot %= 360;
    },
  });
})();
