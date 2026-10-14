/* Cases — open a case and a reel of prizes spins to a stop under the marker. The prize (a multiplier)
   is drawn by the server from the table for your risk level; every table returns 98%. */
(function () {
  'use strict';
  const { $, $$, h, fmt, fmtMult, sleep } = GG;

  /* [multiplier, chance out of 10,000] — the same tables the server uses */
  const TABLE = {
    low: [[0.4, 3887], [0.9, 2621], [1.2, 1780], [1.5, 937], [2, 562], [4, 169], [10, 37], [25, 7]],
    medium: [[0.2, 5605], [0.5, 1488], [1.1, 1339], [2, 788], [3, 438], [6, 262], [20, 70], [60, 10]],
    high: [[0, 5551], [0.3, 2485], [1.2, 1098], [3, 549], [8, 230], [25, 70], [100, 15], [500, 2]],
  };
  const TIER = ['#6b7280', '#94a3b8', '#4d8dff', '#22d3ee', '#14f195', '#c084fc', '#ff5cc8', '#eac837'];
  const TIER_NAME = ['Common', 'Common', 'Uncommon', 'Rare', 'Rare', 'Epic', 'Legendary', 'Jackpot'];
  const COUNT = 64, WIN_AT = 54, SPIN_MS = 5400;

  let amount, risk = 'medium', busy = false, alive = 0, ticks = [];
  const history = [];

  const gem = (c) => `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5L43 19L24 44L5 19Z" fill="${c}"/><path d="M24 5L33 19H15Z" fill="#fff" opacity=".55"/><path d="M5 19H15L24 44Z" fill="#000" opacity=".22"/><path d="M43 19H33L24 44Z" fill="#000" opacity=".32"/></svg>`;
  const tile = (tier) => {
    const m = TABLE[risk][tier][0];
    return `<div class="cs-item" style="--c:${TIER[tier]}"><span class="cs-gem">${gem(TIER[tier])}</span><b>${fmtMult(m)}</b><small>${TIER_NAME[tier]}</small></div>`;
  };

  /** A cosmetic tier for the reel's filler tiles: real odds, with the rare ones shown a bit more often. */
  function filler() {
    const t = TABLE[risk];
    const w = t.map(([, c], i) => Math.pow(c, 0.55) * (i >= 5 ? 1.6 : 1));
    let r = GG.rand() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < w.length; i++) { if (r < w[i]) return i; r -= w[i]; }
    return 0;
  }

  function fill(winTier) {
    const strip = $('#cs-strip');
    let html = '';
    for (let i = 0; i < COUNT; i++) html += tile(i === WIN_AT && winTier != null ? winTier : filler());
    strip.innerHTML = html;
  }

  function placeAt(index, off, animate) {
    const strip = $('#cs-strip');
    const first = strip && strip.firstElementChild;
    if (!first) return;
    const step = first.offsetWidth + 10;
    const win = $('.cs-window');
    strip.style.transition = animate ? `transform ${SPIN_MS}ms cubic-bezier(.08, .6, .1, 1)` : 'none';
    strip.style.transform = `translateX(${-(index * step + first.offsetWidth / 2 + off * first.offsetWidth) + win.clientWidth / 2}px)`;
    if (!animate) void strip.offsetWidth;
  }

  function paintTable(hit) {
    const t = TABLE[risk];
    $('#cs-table').innerHTML = t.map(([m, c], i) =>
      `<div class="cs-chip${hit === i ? ' on' : ''}" style="--c:${TIER[i]}"><b>${fmtMult(m)}</b><small>${(c / 100).toFixed(c < 100 ? 2 : 1)}%</small></div>`).join('');
  }

  function paintHistory() {
    $('#cs-hist').innerHTML = history.slice(0, 12).map((x) => `<span class="hp" style="color:${TIER[x.tier]}">${fmtMult(x.m)}</span>`).join('') || '<span class="hp">No cases opened yet</span>';
  }

  function ui() {
    amount.lock(busy);
    $('#cs-open').disabled = busy;
    $$('#cs-risk button').forEach((b) => { b.disabled = busy; });
  }

  function clearTicks() { ticks.forEach(clearTimeout); ticks = []; }

  async function open() {
    if (busy) return;
    const bet = amount.get();
    const my = ++alive;
    busy = true;
    ui();
    const res = await GG.bet('cases', bet, { risk });
    if (my !== alive) return;
    if (!res) { busy = false; ui(); return; }
    const tier = res.bet.result.tier, m = res.bet.result.mult;
    $('#cs-res').className = 'result-pop';
    $('.cs-window').classList.remove('won', 'lost');
    $('#cs-box').classList.add('open');
    fill(tier);
    placeAt(4, 0, false);
    await sleep(40);
    if (my !== alive) return;
    placeAt(WIN_AT, (GG.rand() - 0.5) * 0.7, true);
    clearTicks();
    for (let t = 40, gap = 40; t < SPIN_MS - 300; gap *= 1.075, t += gap) ticks.push(setTimeout(() => GG.sfx('tick', 0.55), t));
    await sleep(SPIN_MS + 150);
    if (my !== alive) return;
    const won = $$('.cs-item')[WIN_AT];
    if (won) won.classList.add('hit');
    GG.settle(res, { from: won || $('.cs-window'), quiet: m <= 1 });
    $('#cs-box').classList.remove('open');
    $('.cs-window').classList.add(m >= 1 ? 'won' : 'lost');
    paintTable(tier);
    history.unshift({ tier, m });
    paintHistory();
    const pop = $('#cs-res'), net = (res.bet.payout - res.bet.amount) / 100;
    pop.className = 'result-pop show' + (m >= 1 ? (m === 1 ? ' push' : '') : ' bad');
    pop.innerHTML = `<b>${fmtMult(m)}</b><span>${GG.coin('sm')}${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</span>`;
    if (m >= 20) { GG.sfx('bigwin'); GG.confetti($('.cs-wrap'), 80); } else GG.sfx(m > 1 ? 'win' : m === 1 ? 'push' : 'lose');
    busy = false;
    ui();
  }

  const ART = `<svg viewBox="0 0 200 200">
      <path d="M28 82h144v78a10 10 0 0 1-10 10H38a10 10 0 0 1-10-10z" fill="#7c3aed"/>
      <path d="M28 82h144v20H28z" fill="#000" opacity=".2"/>
      <path d="M22 60h156v26H22z" fill="#a855f7"/><path d="M22 60h156v8H22z" fill="#fff" opacity=".2"/>
      <rect x="86" y="96" width="28" height="30" rx="6" fill="#eac837"/><rect x="96" y="106" width="8" height="10" rx="2" fill="#3d2a00"/>
      <g transform="translate(64 14) scale(1.5)">${gem('#eac837').replace(/<\/?svg[^>]*>/g, '')}</g>
      <path d="M40 40l8 6M160 40l-8 6M100 6v10" stroke="#fff6c4" stroke-width="5" stroke-linecap="round"/>
    </svg>`;

  GG.registerGame({
    id: 'cases',
    name: 'Cases',
    rtp: '98.0',
    badge: 'NEW',
    colors: ['#c084fc', '#2a0f45'],
    icon: '<svg viewBox="0 0 24 24"><path d="M3 9h18v10a1.500 1.500 0 0 1-1.500 1.500h-15A1.500 1.500 0 0 1 3 19z" fill="currentColor"/><path d="M2.500 6.500h19V9h-19z" fill="currentColor" opacity=".55"/><rect x="10" y="11" width="4" height="4.500" rx="1" fill="#101218"/></svg>',
    art: ART,

    mount(panel, stage) {
      busy = false;
      amount = GG.ui.amount();
      panel.appendChild(amount.el);
      panel.appendChild(h(`<div>
        <div class="gfield"><span class="gfield-l">Risk</span>${GG.ui.seg('cs-risk', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], risk)}</div>
        <button class="gbtn primary lg block" id="cs-open">Open case</button>
        <p class="panel-note">Every case holds one prize. Low risk almost always gives something back; High risk is empty more than half the time but hides a 500× jackpot. Every risk level returns 98%.</p>
      </div>`));
      stage.appendChild(h(`<div class="cs-wrap">
        <div class="history" id="cs-hist"></div>
        <div class="cs-box" id="cs-box">${ART}</div>
        <div class="cs-window"><div class="cs-marker"></div><div class="cs-strip" id="cs-strip"></div></div>
        <div class="cs-table" id="cs-table"></div>
        <div class="result-pop" id="cs-res"></div>
      </div>`));
      GG.ui.bindSeg($('#cs-risk'), (v) => { if (busy) return; risk = v; fill(null); placeAt(WIN_AT - 2, 0, false); paintTable(); });
      $('#cs-open').addEventListener('click', open);
      fill(null);
      paintTable();
      paintHistory();
      requestAnimationFrame(() => placeAt(WIN_AT - 2, 0, false));
      const onResize = () => { if (!busy) placeAt(WIN_AT - 2, 0, false); };
      window.addEventListener('resize', onResize);
      GG.onLeave(() => window.removeEventListener('resize', onResize));
      ui();
    },

    unmount() {
      alive++;
      clearTicks();
      busy = false;
    },
  });
})();
