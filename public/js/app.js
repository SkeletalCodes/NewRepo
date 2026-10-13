/* GoldRush front-end: a hash-routed single-page app with no build step. All money values are US cents. */
(() => {
  'use strict';

  /* =============================================================== helpers */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const moneyShort = (cents) => (cents % 100 === 0 ? `$${fmt(cents / 100)}` : money(cents));
  const toCents = (dollars) => Math.round(parseFloat(String(dollars).replace(/[$,]/g, '')) * 100) || 0;
  const dollars = (cents) => (Number(cents || 0) / 100).toFixed(2);
  const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : '#eac837');
  const avatar = (name, color, cls = '') => `<span class="avatar ${cls}" style="background:${safeColor(color)}">${esc(String(name || '?').charAt(0))}</span>`;
  const date = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const dateTime = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Icon spec: 'fa-name', 'fa-brands fa-name', 'img:/path.svg' (or https URL). Anything else is shown as text. */
  function icon(spec) {
    const s = String(spec || '').trim();
    if (s.startsWith('img:')) {
      const src = s.slice(4);
      if (/^(\/[\w./-]+|https:\/\/[^\s"'<>]+)$/.test(src)) return `<img src="${esc(src)}" alt="" loading="lazy">`;
    }
    if (/^(fa-(solid|regular|brands) )?fa-[a-z0-9-]+$/.test(s)) return `<i class="${s.includes(' ') ? s : `fa-solid ${s}`}"></i>`;
    return esc(s);
  }
  const logo = (spec, color, cls = '') => `<span class="logo ${cls}" style="color:${safeColor(color)}">${icon(spec)}</span>`;

  /** A 3D gold coin. Classes: (default) gentle tilt + shine, 'spin' full turns, 'fast' quick spin, 'still'. */
  function coin(cls = '', size) {
    let edges = '';
    for (let k = -3; k <= 3; k++) edges += `<i style="transform:translateZ(calc(var(--s) * ${(k * 0.014).toFixed(3)}))"></i>`;
    const face = (side) => `<span class="face ${side}"><svg viewBox="0 0 64 64" aria-hidden="true"><use href="#gr-coin"/></svg><span class="shine"></span></span>`;
    return `<span class="coin ${cls}"${size ? ` style="--s:${size}px"` : ''} aria-hidden="true">${edges}${face('front')}${face('back')}</span>`;
  }

  function duration(mins) {
    if (mins < 60) return `${mins} min`;
    if (mins < 1440) return `${Math.round(mins / 60)} hr`;
    return `${Math.round(mins / 1440)} days`;
  }

  async function api(path, opts = {}) {
    const method = opts.method || (opts.body ? 'POST' : 'GET');
    const body = method === 'GET' ? undefined : JSON.stringify(opts.body || {});
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg, type = 'info') {
    const ic = { success: 'fa-circle-check', error: 'fa-triangle-exclamation', info: 'fa-circle-info' }[type];
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${ic}"></i><div>${esc(msg)}</div>`;
    $('#toast-root').appendChild(el);
    setTimeout(() => el.classList.add('out'), 3600);
    setTimeout(() => el.remove(), 4000);
  }

  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return out;
  }

  async function withBusy(btn, fn) {
    const label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch spin"></i>'; }
    try { return await fn(); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
  }

  /* ============================================================ animation */

  /** Animate a number from its last value to `to`. */
  function countTo(el, to, format = money, ms = 900) {
    if (!el) return;
    const from = Number(el.dataset.v || 0);
    el.dataset.v = to;
    if (reduced || from === to) { el.textContent = format(to); return; }
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = format(Math.round(from + (to - from) * e));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Coins burst out of `fromEl` and arc into the balance in the top bar. Resolves when they land. */
  function flyCoins(fromEl, n = 10) {
    const target = $('#bal-coin');
    if (!fromEl || !target || reduced) return Promise.resolve();
    const a = fromEl.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const sx = a.left + a.width / 2;
    const sy = a.top + a.height / 2;
    const ex = b.left + b.width / 2;
    const ey = b.top + b.height / 2;
    const flights = [];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('span');
      el.className = 'fly-coin';
      el.innerHTML = coin('fast', 22);
      document.body.appendChild(el);
      const spread = (Math.random() - 0.5) * 160;
      const lift = 80 + Math.random() * 120;
      const anim = el.animate([
        { transform: `translate(${sx - 11}px, ${sy - 11}px) scale(.4)`, opacity: 0 },
        { transform: `translate(${sx - 11 + spread * 0.6}px, ${sy - 11 - lift}px) scale(1.15)`, opacity: 1, offset: 0.35 },
        { transform: `translate(${ex - 11}px, ${ey - 11}px) scale(.6)`, opacity: 1 },
      ], { duration: 850 + Math.random() * 250, delay: i * 55, easing: 'cubic-bezier(.45,.05,.4,1)', fill: 'forwards' });
      flights.push(anim.finished.then(() => el.remove()));
    }
    return Promise.all(flights).then(() => {
      target.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 350, easing: 'ease-out' });
    });
  }

  /** Coins falling from the top of the screen. */
  function coinRain(n = 26) {
    if (reduced) return;
    for (let i = 0; i < n; i++) {
      const el = document.createElement('span');
      el.className = 'rain';
      el.style.left = `${Math.random() * 100}vw`;
      el.innerHTML = coin('fast', 16 + Math.round(Math.random() * 20));
      document.body.appendChild(el);
      const drift = (Math.random() - 0.5) * 140;
      el.animate([
        { transform: 'translate(0, 0) rotate(0deg)' },
        { transform: `translate(${drift}px, ${window.innerHeight + 80}px) rotate(${(Math.random() - 0.5) * 120}deg)` },
      ], { duration: 1600 + Math.random() * 1400, delay: Math.random() * 700, easing: 'cubic-bezier(.3,.1,.6,1)', fill: 'forwards' })
        .finished.then(() => el.remove());
    }
  }

  const observer = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      observer.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -40px 0px' }) : null;

  /** Fade/slide elements with [data-reveal] in as they scroll into view, staggered per container. */
  function reveal(root = document) {
    const els = $$('[data-reveal]:not(.in)', root);
    const counts = new Map();
    for (const el of els) {
      const i = counts.get(el.parentElement) || 0;
      counts.set(el.parentElement, i + 1);
      const delay = Math.min(i, 8) * 60;
      el.style.transitionDelay = `${delay}ms`;
      setTimeout(() => { el.style.transitionDelay = ''; }, delay + 700);
      if (observer && !reduced) observer.observe(el); else el.classList.add('in');
    }
  }

  function setBars(root = document) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $$('[data-w]', root).forEach((el) => { el.style.width = `${el.dataset.w}%`; });
      $$('[data-h]', root).forEach((el) => { el.style.height = `${el.dataset.h}%`; });
    }));
  }

  function afterRender(root = document) {
    reveal(root);
    setBars(root);
    $$('[data-count]', root).forEach((el) => countTo(el, Number(el.dataset.count), el.dataset.fmt === 'n' ? fmt : money, 1200));
  }

  /* ================================================================= state */

  const state = { config: {}, user: null, feed: [], route: [] };
  const actions = {};

  /** Animate the top-bar balance to `to`: count up/down, flip the coin, pop a +$x label, glow and sparks. */
  function showBalance(to) {
    const el = $('#bal-amt');
    if (!el) return;
    const from = Number(el.dataset.v || 0);
    countTo(el, to, money, 1100);
    const delta = to - from;
    if (!delta || reduced) return;
    const pill = el.closest('.balance');
    const coinEl = $('#bal-coin .coin');
    const restart = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };
    if (coinEl && delta > 0) restart(coinEl, 'pop');
    restart(pill, delta > 0 ? 'glow' : 'loss');
    // Float the +$x label over the page (the top bar clips its own overflow for the clouds).
    const chip = document.createElement('span');
    const pr = pill.getBoundingClientRect();
    chip.className = `bal-float ${delta < 0 ? 'neg' : ''}`;
    chip.textContent = `${delta > 0 ? '+' : '−'}${money(Math.abs(delta))}`;
    chip.style.left = `${pr.left + pr.width / 2}px`;
    chip.style.top = `${pr.bottom + 4}px`;
    document.body.appendChild(chip);
    setTimeout(() => chip.remove(), 1700);
    if (delta > 0 && coinEl) {
      const box = pill.getBoundingClientRect();
      const c = coinEl.getBoundingClientRect();
      for (let i = 0; i < 10; i++) {
        const sp = document.createElement('span');
        sp.className = 'spark';
        sp.style.left = `${c.left - box.left + c.width / 2 - 3}px`;
        sp.style.top = `${c.top - box.top + c.height / 2 - 3}px`;
        pill.appendChild(sp);
        const ang = (i / 10) * Math.PI * 2;
        const dist = 22 + Math.random() * 18;
        sp.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist}px) scale(0)`, opacity: 0 }],
          { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.2,.8,.3,1)' }).finished.then(() => sp.remove());
      }
    }
  }

  function setUser(user) {
    state.user = user;
    if (user) showBalance(user.balance);
  }

  /** Update the balance right away, but let the top-bar number tick up once the coins land. */
  function creditFx(fromEl, user, n = 10) {
    state.user = user;
    flyCoins(fromEl, n).then(() => showBalance(state.user.balance));
  }

  const pct = (have, need) => Math.max(0, Math.min(100, (have / Math.max(1, need)) * 100));

  /* ================================================================ modals */

  function openModal(html, { cls = '', onClose } = {}) {
    closeModal();
    const root = $('#modal-root');
    root.innerHTML = `<div class="overlay" data-overlay><div class="modal ${cls}" role="dialog" aria-modal="true">
      <button class="icon-btn modal-close" data-act="close-modal" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>${html}</div></div>`;
    root._onClose = onClose;
    document.body.style.overflow = 'hidden';
    const first = $('input:not([type=checkbox]), select, textarea', root);
    if (first) setTimeout(() => first.focus(), 60);
    return $('.modal', root);
  }

  function closeModal() {
    const root = $('#modal-root');
    if (!root.innerHTML) return;
    const cb = root._onClose;
    root._onClose = null;
    root.innerHTML = '';
    document.body.style.overflow = '';
    if (cb) cb();
  }
  actions['close-modal'] = closeModal;

  function confirmModal(title, text, okLabel = 'Confirm', danger = false) {
    return new Promise((resolve) => {
      let answered = false;
      openModal(`<div class="modal-body"><div class="modal-head"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>
        <div class="row"><button class="btn btn-block" data-act="close-modal">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-gold'} btn-block" id="confirm-ok">${esc(okLabel)}</button></div></div>`,
      { onClose: () => { if (!answered) resolve(false); } });
      $('#confirm-ok').addEventListener('click', () => { answered = true; closeModal(); resolve(true); });
    });
  }

  /* ================================================================ router */

  function go(path) {
    if (location.hash === `#/${path}`) render();
    else location.hash = `#/${path}`;
  }

  function requireAuth(mode = 'register') {
    if (state.user) return true;
    openAuth(mode);
    return false;
  }

  const routes = {
    '': () => (state.user ? go('earn') : renderLanding()),
    earn: pageEarn,
    wall: pageWall,
    cashout: pageCashout,
    leaderboard: pageLeaderboard,
    games: pageGames,
    reset: pageReset,
    referrals: () => (requireAuth('login') ? pageReferrals() : go('earn')),
    profile: () => (requireAuth('login') ? pageProfile() : go('earn')),
    admin: pageAdmin,
  };

  function render() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    state.route = parts;
    const handler = routes[parts[0] || ''];
    if (!handler) return go('');
    if (parts[0] === 'admin' && (!state.user || state.user.role !== 'admin')) {
      toast('Admins only.', 'error');
      return go('');
    }
    $('.dropdown') && $('.dropdown').remove();
    $('.side-backdrop') && $('.side-backdrop').remove();
    $('.sidebar') && $('.sidebar').classList.remove('open');
    window.scrollTo(0, 0);
    handler();
  }

  /* ================================================================= feed */

  let feedKey = '';
  async function loadFeed() {
    try {
      const { feed } = await api('/feed');
      const key = feed.map((f) => f.id).join(',');
      state.feed = feed;
      if (key === feedKey) return; // unchanged: don't restart the scrolling ticker
      feedKey = key;
      const el = $('#ticker');
      if (el) el.innerHTML = tickerHTML();
    } catch { /* ignore */ }
  }

  function tickerHTML() {
    if (!state.feed.length) return '<div class="tick"><span class="muted" style="padding-left:8px">Complete an offer to show up here.</span></div>';
    const items = state.feed.map((f) => `<div class="tick">${avatar(f.username, f.avatar_color)}
      <span><b>${esc(f.username)}</b> <small>${esc(f.offer_title)}</small></span>
      <span class="money green">+${money(f.reward)}</span></div>`).join('');
    return `<div class="ticker-track">${items}</div><div class="ticker-track" aria-hidden="true">${items}</div>`;
  }

  // The drift is tied to the clock, so the clouds are in the same place on every page and after reloads.
  const CLOUD_LOOP_S = 90;
  const clouds = () => `<div class="clouds"><div class="track" style="animation-delay:-${((Date.now() / 1000) % CLOUD_LOOP_S).toFixed(2)}s">${'<div class="cloud"></div>'.repeat(40)}</div></div>`;
  const brand = (cls = '') => `<a href="#/" class="brand ${cls}">${coin('', 34)}<span>${esc(state.config.site_name)}</span></a>`;

  /* =============================================================== landing */

  const GROUPS = [
    ['crypto', 'Crypto', 'Sent straight to your wallet'],
    ['prepaid', 'Prepaid cards', 'Spend anywhere cards are taken'],
    ['giftcard', 'Gift cards', 'Delivered to your inbox'],
  ];

  async function renderLanding() {
    shellKey = null;
    const c = state.config;
    $('#app').innerHTML = `
    <nav class="lnav">${clouds()}
      <div class="lnav-in">
        ${brand()}
        <div class="lnav-links"><a href="#how">How it works</a><a href="#payouts">Payouts</a><a href="#/earn">Offerwalls</a><a href="#/leaderboard">Leaderboard</a><a href="#faq">FAQ</a></div>
        <div class="spacer"></div>
        <button class="btn" data-act="login">Log in</button>
        <button class="btn btn-gold" data-act="register">Sign up</button>
      </div>
    </nav>

    <div class="wrap">
      <header class="hero">
        <div>
          <span class="sticker"><i class="fa-solid fa-bolt"></i> Cash out from ${moneyShort(c.min_withdraw)}</span>
          <h1>Get paid for the games you <span class="u">already play<svg viewBox="0 0 300 20" preserveAspectRatio="none"><path d="M3 14 C 60 4, 120 4, 170 10 S 260 16, 297 6"/></svg></span>.</h1>
          <p class="lead">Play games, answer surveys and try apps. We pay you in real dollars, and you cash out in crypto, prepaid cards or gift cards.</p>
          <div class="hero-cta">
            <button class="btn btn-gold btn-lg" data-act="register">Create free account</button>
            <a href="#/earn" class="btn btn-lg">Browse offerwalls <i class="fa-solid fa-arrow-right"></i></a>
          </div>
          <div class="proof">
            <div><b id="st-users">0</b><span>Members</span></div>
            <div><b id="st-offers">0</b><span>Offers completed</span></div>
            <div><b id="st-third">$0.00</b><span id="st-third-l">Earned today</span></div>
          </div>
        </div>
        <div class="stage">
          <div class="big-coin bob">${coin('spin')}</div>
          <div class="coin-shadow"></div>
          <span class="mini" style="left:6%;top:12%;animation-delay:-1s">${coin('spin', 36)}</span>
          <span class="mini" style="left:22%;top:40%;animation-delay:-2.4s">${coin('spin', 24)}</span>
          <div class="receipt press quiet">
            <div class="receipt-in">
              <div class="label"><i class="fa-solid fa-receipt"></i> Live earnings <span class="spacer"></span><span class="badge b-green" style="text-transform:none"><i class="fa-solid fa-circle" style="font-size:7px;color:var(--green)"></i> live</span></div>
              <div class="receipt-list" id="receipt"></div>
            </div>
          </div>
        </div>
      </header>
    </div>

    <div class="wrap"><div class="ticker" id="ticker">${tickerHTML()}</div></div>

    <div class="wrap">
      <section class="sec" id="how">
        <div class="sec-head" data-reveal><span class="label"><i class="fa-solid fa-route"></i> How it works</span><h2>Three steps. No catch.</h2>
          <p>Advertisers pay us when you try their stuff. We pass most of it on to you.</p></div>
        <div class="steps">
          <div class="press quiet step" data-reveal><div class="num">1</div><h3>Make an account</h3><p>Takes ten seconds. You get ${money(c.signup_bonus)} just for signing up.</p></div>
          <div class="press quiet step" data-reveal><div class="num">2</div><h3>Pick an offer</h3><p>Reach a level in a game, finish a survey, or try an app. Each offer shows exactly what it pays.</p></div>
          <div class="press quiet step" data-reveal><div class="num">3</div><h3>Cash out</h3><p>Crypto or gift cards from ${moneyShort(500)}, prepaid cards from ${moneyShort(2000)}. We review every cashout by hand.</p></div>
        </div>
      </section>

      <section class="sec" id="payouts" style="padding-top:20px">
        <div class="sec-head" data-reveal><span class="label"><i class="fa-solid fa-money-bill-transfer"></i> Payouts</span><h2>Your money, your way.</h2></div>
        <div class="payout-groups" id="landing-methods"></div>
      </section>

      <section class="sec" id="faq" style="padding-top:20px">
        <div class="sec-head" data-reveal><span class="label"><i class="fa-solid fa-circle-question"></i> FAQ</span><h2>Good questions.</h2></div>
        <div class="faq">
          ${[
    [`Is ${esc(c.site_name)} free?`, 'Yes. Signing up and completing offers is free. A few shopping offers involve a purchase, and they say so up front.'],
    ['How do I get paid?', 'Your balance is in US dollars. Cash out to Bitcoin, Ethereum, Litecoin, Solana, BNB, Tron or Dogecoin, to a Visa or Mastercard prepaid card, or to gift cards for Amazon, Walmart, Target and more.'],
    ["What's the minimum?", `${moneyShort(500)} for crypto and gift cards, ${moneyShort(2000)} for prepaid cards.`],
    ['How long do cashouts take?', 'Most are reviewed and sent within 24 hours. Bigger ones can take a bit longer for security checks.'],
    ["An offer didn't credit. What now?", 'Offers are tracked by our partners. Make sure you are a new user for that offer, turn off ad blockers, and follow every step. Some take up to a day to show up.'],
    ['Can I invite friends?', `Yes. You get ${fmt(c.referral_percent)}% of what your referrals earn from offers, for as long as they use the site.`],
  ].map(([q, a]) => `<details data-reveal><summary>${q}<i class="fa-solid fa-plus"></i></summary><p>${a}</p></details>`).join('')}
        </div>
      </section>

      <div class="cta-band" data-reveal>
        <div><h2>Your first ${money(c.signup_bonus)} is waiting.</h2><p>Free to join. Cash out from ${moneyShort(c.min_withdraw)}.</p></div>
        <button class="btn btn-lg" data-act="register">Sign up free <i class="fa-solid fa-arrow-right"></i></button>
      </div>
    </div>

    <footer class="footer"><div class="wrap">
      ${brand()}
      <div class="row wrap" style="gap:22px"><a href="#/earn">Offerwalls</a><a href="#/leaderboard">Leaderboard</a><a href="#" data-act="terms">Terms</a><a href="#" data-act="privacy">Privacy</a></div>
      <div>© ${new Date().getFullYear()} ${esc(c.site_name)}</div>
    </div></footer>`;

    afterRender();

    api('/stats').then((s) => {
      countTo($('#st-users'), s.users, fmt, 1400);
      countTo($('#st-offers'), s.offers_completed, fmt, 1400);
      if (s.paid_usd > 0) { $('#st-third-l').textContent = 'Paid out'; countTo($('#st-third'), Math.round(s.paid_usd * 100), (v) => `$${fmt(Math.round(v / 100))}`, 1400); }
      else countTo($('#st-third'), s.earned_today, money, 1400);
    }).catch(() => {});

    api('/reward-methods').then(({ methods }) => {
      const el = $('#landing-methods');
      if (!el) return;
      el.innerHTML = GROUPS.map(([k, label, sub]) => {
        const list = methods.filter((m) => m.category === k);
        if (!list.length) return '';
        const min = Math.min(...list.map((m) => m.min_coins));
        return `<div class="press quiet payout-group" data-reveal style="${k === 'crypto' ? 'grid-row:span 2' : ''}">
          <div class="row"><h3 style="font-size:22px">${label}</h3><span class="spacer"></span><span class="badge b-gold">from ${moneyShort(min)}</span></div>
          <p class="muted" style="font-size:14px">${sub}</p>
          <div class="logo-grid">${list.map((m) => `<span class="logo-chip">${logo(m.icon, m.color, 'sm')}${esc(m.name)}</span>`).join('')}</div></div>`;
      }).join('');
      reveal(el);
    }).catch(() => {});

    await loadFeed();
    startReceipt();
  }

  let receiptTimer = null;
  function startReceipt() {
    clearInterval(receiptTimer);
    const el = $('#receipt');
    if (!el) return;
    if (!state.feed.length) {
      el.innerHTML = '<div class="empty" style="padding:40px 10px"><i class="fa-solid fa-receipt"></i>Earnings show up here the moment they happen.</div>';
      return;
    }
    const row = (f) => `<div class="receipt-row">${avatar(f.username, f.avatar_color)}
      <div style="flex:1;min-width:0"><b style="font-size:14px">${esc(f.username)}</b><div class="faint" style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.offer_title)}</div></div>
      <span class="money green">+${money(f.reward)}</span></div>`;
    el.innerHTML = state.feed.slice(0, 4).map(row).join('');
    let i = 4;
    receiptTimer = setInterval(() => {
      if (!el.isConnected) return clearInterval(receiptTimer);
      el.insertAdjacentHTML('afterbegin', row(state.feed[i % state.feed.length]));
      i++;
      while (el.children.length > 4) el.lastElementChild.remove();
    }, 2600);
  }

  actions.terms = (e) => {
    e.preventDefault();
    openModal(`<div class="modal-body"><div class="modal-head"><h2>Terms of Service</h2></div><div class="muted" style="display:grid;gap:10px;font-size:14px">
      <p>1. You must be 18 or older to use ${esc(state.config.site_name)}.</p>
      <p>2. One account per person, household and device. VPNs, proxies, emulators and bots are not allowed.</p>
      <p>3. Rewards are credited by our partners. We may reverse rewards that are charged back or obtained by fraud.</p>
      <p>4. Cashouts are reviewed by hand and may be declined for breaking these terms.</p>
      <p>5. Games are played with your real balance and results are final. Only bet what you can afford to lose. If gambling stops being fun, take a break or contact support to close your account.</p>
      <p>6. We may update these terms. Using the site means you accept the latest version.</p></div></div>`);
  };
  actions.privacy = (e) => {
    e.preventDefault();
    openModal(`<div class="modal-body"><div class="modal-head"><h2>Privacy Policy</h2></div><div class="muted" style="display:grid;gap:10px;font-size:14px">
      <p>We store your username, email, a salted hash of your password, and your earning and cashout history.</p>
      <p>We share your user ID with offer partners so they can credit you. We never sell your personal information.</p>
      <p>You can ask us to delete your account at any time.</p></div></div>`);
  };

  /* ================================================================== auth */

  function pwStrength(pw) {
    let s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^A-Za-z0-9]/.test(pw)) s++;
    return s;
  }

  function openAuth(mode = 'register') {
    const c = state.config;
    let ref = '';
    try { ref = localStorage.getItem('ref') || ''; } catch { /* ignore */ }
    openModal(`<div class="auth-side">
        <div class="brand">${coin('', 34)}<span>${esc(c.site_name)}</span></div>
        <h3>Real money for your free time.</h3>
        <ul>
          <li><i class="fa-solid fa-gamepad"></i> Games, apps and surveys</li>
          <li><i class="fa-brands fa-bitcoin"></i> Crypto payouts from ${moneyShort(500)}</li>
          <li><i class="fa-solid fa-gift"></i> Amazon, Walmart, Target & more</li>
          <li><i class="fa-solid fa-user-group"></i> ${fmt(c.referral_percent)}% of friends' earnings</li>
        </ul>
        <p class="bonus-note">${money(c.signup_bonus)} sign-up bonus, added the moment you join.</p>
        <div class="stack">${'<span></span>'.repeat(6)}</div>
      </div>
      <div class="auth-form">
        <div class="seg"><button data-tab="login">Log in</button><button data-tab="register">Sign up</button></div>
        <div id="auth-panel"></div>
      </div>`, { cls: 'auth' });

    const panel = $('#auth-panel');
    const setTab = (tab) => {
      $$('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      if (tab === 'forgot') {
        panel.innerHTML = `<div class="modal-head"><h2>Forgot your password?</h2><p>Enter your account email and we'll send you a link to choose a new one.</p></div>
          <form id="forgot-f" novalidate>
            <div id="auth-err"></div>
            <div class="field"><label>Email</label><div class="input-icon"><i class="fa-solid fa-envelope"></i><input class="input" type="email" name="email" autocomplete="email" placeholder="you@example.com" required></div></div>
            <button class="btn btn-gold btn-block btn-lg" type="submit">Send reset link</button>
            <p class="center muted mt-16" style="font-size:14px">Remembered it? <a href="#" class="gold" data-switch="login">Back to log in</a></p>
          </form>`;
        $$('[data-switch]', panel).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); setTab(a.dataset.switch); }));
        $('input', panel).focus();
        $('#forgot-f').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = $('button[type=submit]', e.target);
          await withBusy(btn, async () => {
            try {
              const r = await api('/auth/forgot', { body: formData(e.target) });
              panel.innerHTML = `<div class="center page-in"><span class="sent-icon"><i class="fa-solid ${r.mail ? 'fa-envelope-circle-check' : 'fa-headset'}"></i></span>
                <h2 class="mt-16" style="font-size:24px;color:#fff">${r.mail ? 'Check your inbox' : 'Contact support'}</h2>
                <p class="muted mt-8">${esc(r.message)}</p>
                <button class="btn btn-block mt-24" data-switch="login">Back to log in</button></div>`;
              $$('[data-switch]', panel).forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); setTab(a.dataset.switch); }));
            } catch (err) { $('#auth-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
          });
        });
        return;
      }
      if (tab === 'login') {
        panel.innerHTML = `<div class="modal-head"><h2>Welcome back</h2><p>Log in to keep earning.</p></div>
          <form id="auth-f" novalidate>
            <div id="auth-err"></div>
            <div class="field"><label>Username or email</label><div class="input-icon"><i class="fa-solid fa-user"></i><input class="input" name="login" autocomplete="username" required></div></div>
            <div class="field"><div class="row"><label>Password</label><span class="spacer"></span><a href="#" class="gold" style="font-size:13px;font-weight:600" data-switch="forgot">Forgot password?</a></div>
              <div class="input-icon"><i class="fa-solid fa-lock"></i><input class="input" type="password" name="password" autocomplete="current-password" required><button type="button" class="pw-toggle" aria-label="Show password"><i class="fa-regular fa-eye"></i></button></div></div>
            <label class="check" style="margin-bottom:16px"><input type="checkbox" name="remember" checked> <span>Keep me logged in for 30 days</span></label>
            <button class="btn btn-gold btn-block btn-lg" type="submit">Log in</button>
            <p class="center muted mt-16" style="font-size:14px">New here? <a href="#" class="gold" data-switch="register">Create an account</a></p>
          </form>`;
      } else {
        panel.innerHTML = `<div class="modal-head"><h2>Create your account</h2><p>Free, and it only takes a moment.</p></div>
          <form id="auth-f" novalidate>
            <div id="auth-err"></div>
            <div class="field"><label>Username</label><div class="input-icon"><i class="fa-solid fa-user"></i><input class="input" name="username" autocomplete="username" maxlength="20" placeholder="3-20 characters" required></div></div>
            <div class="field"><label>Email</label><div class="input-icon"><i class="fa-solid fa-envelope"></i><input class="input" type="email" name="email" autocomplete="email" placeholder="you@example.com" required></div></div>
            <div class="field"><label>Password</label><div class="input-icon"><i class="fa-solid fa-lock"></i><input class="input" type="password" name="password" autocomplete="new-password" placeholder="At least 8 characters" required><button type="button" class="pw-toggle" aria-label="Show password"><i class="fa-regular fa-eye"></i></button></div>
              <div class="pw-meter"><div id="pw-bar" style="width:0"></div></div></div>
            <div class="field"><label>Referral code <span class="faint">(optional)</span></label><div class="input-icon"><i class="fa-solid fa-ticket"></i><input class="input" name="referral" value="${esc(ref)}" placeholder="e.g. A1B2C3D4"></div></div>
            <label class="check" style="margin-bottom:18px"><input type="checkbox" name="terms"> <span>I'm 18 or older and agree to the <a href="#" class="gold" data-act="terms">Terms</a> and <a href="#" class="gold" data-act="privacy">Privacy Policy</a>.</span></label>
            <button class="btn btn-gold btn-block btn-lg" type="submit">Sign up & get ${money(c.signup_bonus)}</button>
            <p class="center muted mt-16" style="font-size:14px">Already have an account? <a href="#" class="gold" data-switch="login">Log in</a></p>
          </form>`;
        const pw = $('input[name=password]', panel);
        pw.addEventListener('input', () => {
          const s = pwStrength(pw.value);
          const bar = $('#pw-bar');
          bar.style.width = `${(s / 5) * 100}%`;
          bar.style.background = ['#ff5c7a', '#ff5c7a', '#eac837', '#eac837', '#14f195', '#14f195'][s];
        });
      }
      $$('[data-switch]', panel).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); setTab(a.dataset.switch); }));
      bindPwToggles(panel);
      $('input', panel).focus();
      $('#auth-f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button[type=submit]', e.target);
        const body = formData(e.target);
        $('#auth-err').innerHTML = '';
        try {
          await withBusy(btn, async () => {
            const { user } = await api(`/auth/${tab}`, { body });
            state.user = user;
            closeModal();
            try { localStorage.removeItem('ref'); } catch { /* ignore */ }
            if (tab === 'register') {
              go('earn');
              setTimeout(() => openWelcome(), 300);
            } else {
              toast(`Welcome back, ${user.username}.`, 'success');
              if (state.route[0]) render(); else go('earn');
              if (!user.onboarded) setTimeout(() => openWelcome(), 300);
            }
          });
        } catch (err) {
          const box = $('#auth-err');
          if (box) box.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
        }
      });
    };
    $$('.seg button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    if (c.ephemeral) $('.auth-form').insertAdjacentHTML('afterbegin', `<div class="form-error" style="font-size:13px"><b>Heads up:</b> this site isn't connected to its database yet, so accounts can disappear and you may not be able to log back in. The owner needs to connect Postgres.</div>`);
    setTab(mode);
  }

  function bindPwToggles(root) {
    $$('.pw-toggle', root).forEach((b) => b.addEventListener('click', () => {
      const input = b.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.innerHTML = `<i class="fa-regular ${show ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    }));
  }

  /** #/reset/<token>: the link from the reset email (or from an admin). */
  async function pageReset() {
    const token = state.route[1] || '';
    if (state.user) pageEarn(); else renderLanding();
    // Keep the token out of browser history once we've read it.
    history.replaceState(null, '', '/#/');
    state.route = [];
    let username = '';
    try {
      username = (await api(`/auth/reset/${encodeURIComponent(token)}`)).username;
    } catch (err) {
      openModal(`<div class="modal-body center"><span class="sent-icon bad"><i class="fa-solid fa-link-slash"></i></span>
        <h2 class="mt-16" style="font-size:24px;color:#fff">Link expired</h2><p class="muted mt-8">${esc(err.message)}</p>
        <button class="btn btn-gold btn-block mt-24" id="rs-new">Get a new link</button></div>`);
      $('#rs-new').addEventListener('click', () => { openAuth('login'); $('[data-switch="forgot"]') && $('[data-switch="forgot"]').click(); });
      return;
    }
    openModal(`<div class="modal-body"><div class="modal-head"><h2>Choose a new password</h2><p>For <b class="gold">${esc(username)}</b>. You'll be logged in right after, and signed out everywhere else.</p></div>
      <form id="rs-f" novalidate><div id="rs-err"></div>
        <div class="field"><label>New password</label><div class="input-icon"><i class="fa-solid fa-lock"></i><input class="input" type="password" name="password" autocomplete="new-password" placeholder="At least 8 characters" required><button type="button" class="pw-toggle" aria-label="Show password"><i class="fa-regular fa-eye"></i></button></div>
          <div class="pw-meter"><div id="rs-bar" style="width:0"></div></div></div>
        <div class="field"><label>Type it again</label><div class="input-icon"><i class="fa-solid fa-lock"></i><input class="input" type="password" name="confirm" autocomplete="new-password" required></div></div>
        <button class="btn btn-gold btn-block btn-lg mt-8" type="submit">Save password & log in</button>
      </form></div>`);
    const f = $('#rs-f');
    bindPwToggles(f);
    f.password.addEventListener('input', () => {
      const sc = pwStrength(f.password.value);
      $('#rs-bar').style.width = `${(sc / 5) * 100}%`;
      $('#rs-bar').style.background = ['#ff5c7a', '#ff5c7a', '#eac837', '#eac837', '#14f195', '#14f195'][sc];
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (f.password.value !== f.confirm.value) { $('#rs-err').innerHTML = '<div class="form-error">The two passwords don\'t match.</div>'; return; }
      await withBusy($('button[type=submit]', f), async () => {
        try {
          const { user } = await api('/auth/reset', { body: { token, password: f.password.value } });
          state.user = user;
          closeModal();
          toast('Password changed. You\'re logged in.', 'success');
          go('earn');
        } catch (err) { $('#rs-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
      });
    });
  }
  actions.login = () => openAuth('login');
  actions.register = () => openAuth('register');

  actions.logout = async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    state.user = null;
    toast('Logged out.');
    if (location.hash === '#/' || location.hash === '') render(); else location.hash = '#/';
  };

  /* ============================================================ onboarding */

  function openWelcome() {
    const c = state.config;
    const u = state.user;
    const slides = [
      () => `${coin('spin')}
       <h2>Welcome, ${esc(u.username)}.</h2>
       <p class="muted mt-8">Your account is ready, and your sign-up bonus is already in.</p>
       <div class="amt" id="ob-amt">$0.00</div>
       <p class="faint" style="font-size:13px;font-weight:600">added to your balance</p>`,
      () => `<h2 style="margin-top:0">How you earn</h2>
       <div class="ob-steps">
         <div><i class="fa-solid fa-layer-group"></i><span><b>Offerwalls</b><br><small class="muted">Games, apps and surveys from our partner networks. Pick one and go.</small></span></div>
         <div><i class="fa-solid fa-bolt"></i><span><b>Paid automatically</b><br><small class="muted">When the network confirms an offer, the money lands in your balance.</small></span></div>
         <div><i class="fa-solid fa-calendar-check"></i><span><b>Daily bonus</b><br><small class="muted">${money(c.daily_reward)} free, every 24 hours.</small></span></div>
         <div><i class="fa-solid fa-user-group"></i><span><b>Invite friends</b><br><small class="muted">Get ${fmt(c.referral_percent)}% of everything they earn.</small></span></div>
       </div>`,
      () => `<h2 style="margin-top:0">Cashing out</h2>
       <p class="muted mt-8">Crypto and gift cards from ${moneyShort(500)}. Prepaid Visa and Mastercard from ${moneyShort(2000)}.</p>
       <div class="logo-grid" style="justify-content:center;margin:18px 0">
         ${logo('img:/img/crypto/btc.svg', '#f7931a')}${logo('img:/img/crypto/eth.svg', '#627eea')}${logo('img:/img/crypto/ltc.svg', '#bfbbbb')}${logo('img:/img/crypto/sol.svg', '#9945ff')}
         ${logo('fa-brands fa-amazon', '#ff9900')}${logo('img:/img/brands/walmart.svg', '#0071ce')}${logo('fa-brands fa-cc-visa', '#ffffff')}
       </div>
       <div class="panel" style="text-align:left;padding:16px 18px">
         <div class="row" style="font-weight:700;font-size:14px"><span>Progress to your first cashout</span><span class="spacer"></span><span class="gold">${money(u.balance)} / ${money(c.min_withdraw)}</span></div>
         <div class="bar mt-8"><div data-w="${pct(u.balance, c.min_withdraw)}"></div></div>
       </div>
       <p class="muted mt-16" style="font-size:14px">Tip: code <span class="code inline">WELCOME</span> gets you a little extra.</p>`,
    ];
    let i = 0;
    openModal('<div class="modal-body onboard" id="onboard"></div>', { onClose: () => api('/me/onboarded', { body: {} }).catch(() => {}) });
    const draw = () => {
      const el = $('#onboard');
      el.innerHTML = `<div class="dots">${slides.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
        <div class="page-in">${slides[i]()}</div>
        <div class="row mt-24">
          ${i > 0 ? '<button class="btn" id="ob-back">Back</button>' : ''}
          <button class="btn btn-gold btn-block btn-lg" id="ob-next">${i === slides.length - 1 ? 'Start earning' : 'Next'}</button>
        </div>`;
      if (i === 0) countTo($('#ob-amt'), c.signup_bonus, money, 1300);
      setBars(el);
      $('#ob-next').addEventListener('click', () => { if (i < slides.length - 1) { i++; draw(); } else closeModal(); });
      $('#ob-back') && $('#ob-back').addEventListener('click', () => { i--; draw(); });
    };
    draw();
    coinRain();
  }

  /* ============================================================== app shell */

  function isActive(path) {
    const [p0, p1 = ''] = path.split('/');
    return (state.route[0] || '') === p0 && (p0 !== 'admin' || (state.route[1] || '') === p1);
  }

  function navItem(path, ic, label, extra = '') {
    return `<a href="#/${path}" data-path="${path}" class="nav-item ${isActive(path) ? 'active' : ''}"><i class="fa-solid ${ic}"></i>${label}${extra}</a>`;
  }

  const EPHEMERAL_NOTICE = '<div class="notice warn"><i class="fa-solid fa-triangle-exclamation"></i><span><b>Heads up:</b> this site isn\'t connected to its database yet, so accounts and balances can disappear. The owner needs to connect Postgres (see README).</span></div>';

  /*
   * The shell (sidebar, top bar, clouds, ticker) is built once and kept while you move between pages,
   * so its animations don't restart. It's only rebuilt when something it shows changes
   * (logging in or out, entering or leaving the admin panel, settings).
   */
  let shellKey = null;

  function shell(content) {
    const c = state.config;
    const u = state.user;
    const isAdmin = u && u.role === 'admin';
    const inAdmin = state.route[0] === 'admin';
    const key = JSON.stringify([inAdmin, u && u.id, u && u.role, c.site_name, c.announcement, c.maintenance, c.ephemeral, c.referral_percent]);
    if (key !== shellKey || !$('#content')) {
      shellKey = key;
      $('#app').innerHTML = `<div class="shell">
      <aside class="sidebar">
        ${brand()}
        ${inAdmin ? `
          <div class="nav-label">Admin</div>
          ${navItem('admin', 'fa-chart-column', 'Overview')}
          ${navItem('admin/users', 'fa-users', 'Users')}
          ${navItem('admin/walls', 'fa-layer-group', 'Offerwalls')}
          ${navItem('admin/logs', 'fa-tower-broadcast', 'Postback log')}
          ${navItem('admin/completions', 'fa-circle-check', 'Conversions')}
          ${navItem('admin/withdrawals', 'fa-money-bill-transfer', 'Cashouts')}
          ${navItem('admin/games', 'fa-dice', 'Games')}
          ${navItem('admin/methods', 'fa-wallet', 'Payout methods')}
          ${navItem('admin/promos', 'fa-ticket', 'Promo codes')}
          ${navItem('admin/transactions', 'fa-receipt', 'Transactions')}
          ${navItem('admin/audit', 'fa-clipboard-list', 'Audit log')}
          ${navItem('admin/settings', 'fa-gear', 'Settings')}
          <div class="nav-label">Site</div>
          ${navItem('earn', 'fa-arrow-left', 'Back to site')}
        ` : `
          <div class="nav-label">Earn</div>
          ${navItem('earn', 'fa-house', 'Home')}
          ${navItem('games', 'fa-gamepad', 'Games', ' <span class="tag soon-tag">NEW</span>')}
          ${navItem('leaderboard', 'fa-trophy', 'Leaderboard')}
          <div class="nav-label">Account</div>
          ${navItem('cashout', 'fa-money-bill-wave', 'Cash out')}
          ${navItem('referrals', 'fa-user-group', 'Referrals')}
          ${navItem('profile', 'fa-user', 'Profile')}
          ${isAdmin ? `<div class="nav-label">Manage</div>${navItem('admin', 'fa-shield-halved', 'Admin', ' <span class="tag admin-tag">ADMIN</span>')}` : ''}
          <div class="press quiet side-card">
            <b>Invite friends</b>
            <p>Get ${fmt(c.referral_percent)}% of what they earn, for good.</p>
            <a href="#/referrals" class="btn btn-gold btn-sm btn-block">Get your link</a>
          </div>
        `}
      </aside>
      <div class="main">
        <div class="topbar">${clouds()}
          <div class="topbar-in">
            <button class="icon-btn menu-btn" data-act="menu" aria-label="Menu"><i class="fa-solid fa-bars"></i></button>
            <div class="spacer"></div>
            ${u ? `
              <div class="balance">
                <span id="bal-coin">${coin('', 30)}</span>
                <span class="amt"><span id="bal-amt" data-v="${u.balance}">${money(u.balance)}</span><small>USD</small></span>
                <a href="#/cashout" class="btn btn-gold btn-sm">Cash out</a>
              </div>
              <div class="user-chip" data-act="user-menu">${avatar(u.username, u.avatar_color)}<b class="hide-sm">${esc(u.username)}</b><i class="fa-solid fa-chevron-down faint hide-sm" style="font-size:11px"></i></div>
            ` : `
              <button class="btn" data-act="login">Log in</button>
              <button class="btn btn-gold" data-act="register">Sign up</button>
            `}
          </div>
        </div>
        ${c.ephemeral ? EPHEMERAL_NOTICE : ''}
        ${c.maintenance ? '<div class="notice bad"><i class="fa-solid fa-screwdriver-wrench"></i><span>Maintenance mode is on. Only admins can use the site.</span></div>' : ''}
        ${c.announcement && !inAdmin ? `<div class="notice"><i class="fa-solid fa-bullhorn"></i><span>${esc(c.announcement)}</span></div>` : ''}
        ${inAdmin ? '' : `<div class="ticker-bar"><div class="ticker" id="ticker">${tickerHTML()}</div></div>`}
        <main class="content" id="content"></main>
      </div>
    </div>`;
    } else {
      $$('.nav-item[data-path]').forEach((a) => a.classList.toggle('active', isActive(a.dataset.path)));
      if (u) showBalance(u.balance);
    }
    setContent(content || '');
  }

  const page = shell;
  const setContent = (html) => {
    const el = $('#content');
    if (!el) return;
    el.innerHTML = html;
    el.classList.remove('page-in'); void el.offsetWidth; el.classList.add('page-in');
    afterRender(el);
  };

  actions.menu = () => {
    const sb = $('.sidebar');
    sb.classList.add('open');
    const bd = document.createElement('div');
    bd.className = 'side-backdrop';
    bd.addEventListener('click', () => { sb.classList.remove('open'); bd.remove(); });
    document.body.appendChild(bd);
  };

  actions['user-menu'] = (e) => {
    e.stopPropagation();
    const existing = $('.dropdown');
    if (existing) return existing.remove();
    const u = state.user;
    const dd = document.createElement('div');
    dd.className = 'dropdown';
    dd.innerHTML = `<div style="padding:10px 12px"><b>${esc(u.username)}</b><div class="faint" style="font-size:12px">${esc(u.email)}</div></div>
      <a href="#/profile"><i class="fa-solid fa-user"></i>Profile</a><a href="#/cashout"><i class="fa-solid fa-money-bill-wave"></i>Cash out</a><a href="#/referrals"><i class="fa-solid fa-user-group"></i>Referrals</a>
      ${u.role === 'admin' ? '<a href="#/admin"><i class="fa-solid fa-shield-halved"></i>Admin panel</a>' : ''}
      <button data-act="logout" class="red"><i class="fa-solid fa-arrow-right-from-bracket"></i>Log out</button>`;
    document.body.appendChild(dd);
  };

  /* ============================================================== earning */

  function canDaily() {
    return state.user && Date.now() - (Number(state.user.last_daily_at) || 0) >= 86400000;
  }
  function dailyText() {
    if (canDaily()) return 'Ready to claim';
    const ms = 86400000 - (Date.now() - Number(state.user.last_daily_at));
    return `Next in ${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }

  const skels = (n, h = 150) => `<div class="skel" style="min-height:${h}px"></div>`.repeat(n);
  const emptyHTML = (msg, ic = 'fa-magnifying-glass') => `<div class="empty"><i class="fa-solid ${ic}"></i>${esc(msg)}</div>`;

  function noWallsHTML() {
    const admin = state.user && state.user.role === 'admin';
    return `<div class="empty"><i class="fa-solid fa-layer-group"></i>${admin
      ? 'No offerwalls are live yet. <a href="#/admin/walls" class="gold">Add one in the admin panel</a>.'
      : 'Offerwalls are on their way. Check back soon.'}</div>`;
  }

  async function pageEarn() {
    const u = state.user;
    const c = state.config;
    page(`
      ${u ? `<div class="hello">
        <div class="press quiet hello-main" data-reveal>
          <span class="coin-deco">${coin()}</span>
          <span class="label"><i class="fa-solid fa-hand"></i> Hey ${esc(u.username)}</span>
          <h2 class="mt-8">${u.balance >= c.min_withdraw ? `You have ${money(u.balance)} ready to cash out.` : `${money(c.min_withdraw - u.balance)} to go until your first cashout.`}</h2>
          <p>Open any offerwall below and complete an offer. Rewards land in your balance as soon as the network confirms them.</p>
          <div class="bar mt-24" style="max-width:440px"><div data-w="${pct(u.balance, c.min_withdraw)}"></div></div>
          <div class="bar-meta" style="max-width:440px"><span>${money(u.balance)}</span><span>${money(c.min_withdraw)} minimum</span></div>
        </div>
        <div class="quick-list">
          <div class="press quiet quick" data-reveal><span class="qi"><i class="fa-solid fa-calendar-check"></i></span><div class="qb"><b>Daily bonus</b><small id="daily-sub">${dailyText()}</small></div>
            <button class="btn btn-sm ${canDaily() ? 'btn-gold' : ''}" data-act="daily" ${canDaily() ? '' : 'disabled'}>${canDaily() ? `Claim ${money(c.daily_reward)}` : 'Claimed'}</button></div>
          <div class="press quiet quick" data-reveal><span class="qi"><i class="fa-solid fa-ticket"></i></span><div class="qb"><b>Promo code</b>
            <form id="promo-f"><input class="input" name="code" placeholder="Enter code" maxlength="32"><button class="btn btn-sm">Redeem</button></form></div></div>
          <div class="press quiet quick" data-reveal><span class="qi"><i class="fa-solid fa-user-group"></i></span><div class="qb"><b>Invite friends</b><small>${fmt(c.referral_percent)}% of their earnings</small></div><a href="#/referrals" class="btn btn-sm">Invite</a></div>
        </div>
      </div>` : `<div class="press quiet hello-main" data-reveal>
        <span class="coin-deco">${coin()}</span>
        <span class="label"><i class="fa-solid fa-bolt"></i> Start earning</span>
        <h2 class="mt-8">Sign up and get ${money(c.signup_bonus)} on us.</h2>
        <p>Then cash out in crypto or gift cards from ${moneyShort(c.min_withdraw)}.</p>
        <button class="btn btn-gold btn-lg mt-24" data-act="register">Create free account</button></div>`}

      <div class="sec-title"><i class="fa-solid fa-layer-group"></i> Offerwalls</div>
      <div class="wall-grid" id="walls">${skels(4, 180)}</div>
    `);

    const pf = $('#promo-f');
    if (pf) pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = e.target.code.value.trim();
      if (!code) return;
      const btn = $('button', e.target);
      await withBusy(btn, async () => {
        try {
          const r = await api('/promo', { body: { code } });
          e.target.reset();
          toast(`Code redeemed: ${money(r.amount)} added.`, 'success');
          creditFx(btn, r.user, 8);
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    try {
      const { offerwalls } = await api('/offerwalls');
      const el = $('#walls');
      if (!el) return;
      el.innerHTML = offerwalls.map(wallCard).join('') || noWallsHTML();
      reveal(el);
    } catch (err) { toast(err.message, 'error'); }
  }

  actions.daily = async (e) => {
    if (!requireAuth()) return;
    const btn = e.target.closest('button');
    await withBusy(btn, async () => {
      try {
        const r = await api('/daily', { body: {} });
        toast(`Daily bonus: ${money(r.amount)} added.`, 'success');
        creditFx(btn, r.user, 8);
      } catch (err) { toast(err.message, 'error'); }
    });
    if (btn.isConnected && !canDaily()) {
      btn.disabled = true; btn.className = 'btn btn-sm'; btn.textContent = 'Claimed';
      $('#daily-sub').textContent = dailyText();
    }
  };

  function wallCard(w) {
    return `<a href="#/wall/${encodeURIComponent(w.slug)}" class="wall press" style="--c:${safeColor(w.color)}" data-reveal>
      ${w.bonus_percent ? `<span class="bonus">+${w.bonus_percent}%</span>` : ''}
      ${logo(w.icon, w.color, 'lg')}<h4>${esc(w.name)}</h4><p>${esc(w.tagline)}</p>
      <div class="meta">Open wall <i class="fa-solid fa-arrow-right"></i></div></a>`;
  }

  async function pageWall() {
    const slug = state.route[1];
    if (!state.user) { go('earn'); setTimeout(() => openAuth('register'), 50); return; }
    page(skels(1, 520));
    try {
      const [{ offerwalls }, launch] = await Promise.all([api('/offerwalls'), api(`/offerwalls/${encodeURIComponent(slug)}/launch`)]);
      const w = offerwalls.find((x) => x.slug === slug);
      if (!w) { setContent(emptyHTML('That offerwall could not be found.')); return; }
      const safeUrl = /^https:\/\//i.test(launch.url) ? launch.url : '';
      setContent(`<a href="#/earn" class="muted" style="font-weight:600"><i class="fa-solid fa-arrow-left"></i> All offerwalls</a>
        <div class="press quiet wall-head mt-16">
          ${logo(w.icon, w.color, 'lg')}
          <div style="flex:1;min-width:180px"><h2>${esc(w.name)}</h2><p class="muted">${esc(w.tagline)}</p></div>
          ${w.bonus_percent ? `<span class="sticker"><i class="fa-solid fa-arrow-trend-up"></i> +${w.bonus_percent}% bonus</span>` : ''}
          <a class="btn btn-sm" href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-up-right-from-square"></i> New tab</a>
        </div>
        <p class="faint mt-16" style="font-size:13px;font-weight:600"><i class="fa-solid fa-circle-info gold"></i>
          Rewards are added automatically once ${esc(w.name)} confirms the offer${w.hold_hours ? `, then held for ${w.hold_hours} hour${w.hold_hours === 1 ? '' : 's'} before they're spendable` : ''}. Turn off ad blockers and VPNs so offers track.</p>
        ${launch.open_mode === 'tab' ? `<div class="press quiet wall-launch mt-16">${logo(w.icon, w.color, 'xl')}
            <h3>${esc(w.name)} opens in a new tab</h3><p class="muted">Complete offers there, then come back here to see your balance go up.</p>
            <a class="btn btn-gold btn-lg mt-16" href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">Open ${esc(w.name)} <i class="fa-solid fa-up-right-from-square"></i></a></div>`
    : `<div class="wall-frame mt-16"><iframe src="${esc(safeUrl)}" title="${esc(w.name)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" allow="clipboard-write"></iframe></div>`}`);
    } catch (err) {
      setContent(emptyHTML(err.message, 'fa-triangle-exclamation'));
    }
  }

  /* ================================================================= games */

  /** Games live in /js/games.js (loaded after this file); it fills in window.GR.games. */
  function pageGames() {
    const g = window.GR && window.GR.games;
    if (!g) { page(emptyHTML('Games failed to load. Refresh the page.', 'fa-triangle-exclamation')); return; }
    if (state.route[1]) g.play(state.route[1]); else g.lobby();
  }

  /* =============================================================== cashout */

  async function pageCashout() {
    const u = state.user;
    page(`<div class="page-head"><div><h1>Cash out</h1><p>Crypto and gift cards from ${moneyShort(500)}. Prepaid cards from ${moneyShort(2000)}.</p></div></div>
      ${u ? `<div class="cash-head">
        <div class="press quiet big-bal" data-reveal>${coin()}<div><div class="label">Balance</div><div class="v mt-8" data-count="${u.balance}">$0.00</div>
          <div class="faint mt-8" style="font-weight:600;font-size:13px">${money(u.total_earned)} earned all time</div></div></div>
        <div class="press quiet" data-reveal style="padding:22px 24px">
          <div class="label"><i class="fa-solid fa-shield-halved"></i> How cashouts work</div>
          <p class="muted mt-8" style="font-size:14px">Pick a method and amount. The money comes out of your balance right away, and we review and send it, usually within 24 hours. If we can't send it, it goes back to your balance.</p>
        </div>
      </div>` : ''}
      <div id="methods">${skels(1, 200)}</div>
      ${u ? '<div class="sec-title"><i class="fa-solid fa-clock-rotate-left"></i> Your cashouts</div><div id="my-wd"></div>' : ''}`);
    try {
      const { methods } = await api('/reward-methods');
      const el = $('#methods');
      if (!el) return;
      el.innerHTML = GROUPS.map(([k, label, sub]) => {
        const list = methods.filter((m) => m.category === k);
        if (!list.length) return '';
        const min = Math.min(...list.map((m) => m.min_coins));
        return `<div class="group-head"><h3>${label}</h3><span>${sub} · from ${moneyShort(min)}</span></div>
          <div class="method-grid">${list.map((m) => {
          const locked = u && u.balance < m.min_coins;
          return `<div class="method press click ${locked ? 'locked' : ''}" data-method="${m.id}" data-reveal>
            ${logo(m.icon, m.color, 'lg')}<b>${esc(m.name)}</b><small>Min ${moneyShort(m.min_coins)}</small>
            ${u ? `<div class="bar"><div data-w="${pct(u.balance, m.min_coins)}"></div></div>` : ''}</div>`;
        }).join('')}</div>`;
      }).join('') || emptyHTML('No payout methods yet.');
      afterRender(el);
      $$('[data-method]').forEach((m) => m.addEventListener('click', () => openWithdraw(methods.find((x) => String(x.id) === m.dataset.method))));
      if (u) loadMyWithdrawals();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function loadMyWithdrawals() {
    const { withdrawals } = await api('/me/history');
    const el = $('#my-wd');
    if (!el) return;
    el.innerHTML = withdrawals.length ? `<div class="table-wrap"><table><thead><tr><th>Method</th><th>Amount</th><th>Sent to</th><th>Status</th><th>Date</th></tr></thead><tbody>
      ${withdrawals.map((w) => `<tr><td><b>${esc(w.method_name)}</b></td><td class="money">${money(w.coins)}</td><td class="mono faint" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(w.destination)}</td>
        <td><span class="badge st-${esc(w.status)}">${esc(w.status)}</span>${w.admin_note ? `<div class="faint" style="font-size:12px">${esc(w.admin_note)}</div>` : ''}</td><td class="faint">${dateTime(w.created_at)}</td></tr>`).join('')}
      </tbody></table></div>` : emptyHTML("You haven't cashed out yet.", 'fa-money-bill-wave');
  }

  function openWithdraw(m) {
    if (!m || !requireAuth()) return;
    const u = state.user;
    const min = m.min_coins;
    const amounts = [500, 1000, 2000, 2500, 5000, 10000].filter((a) => a >= min);
    if (!amounts.includes(min)) amounts.unshift(min);
    let chosen = amounts.find((a) => a <= u.balance) || null;
    openModal(`<div class="modal-body">
      <div class="modal-head c">${logo(m.icon, m.color, 'xl')}<h2 class="mt-16">${esc(m.name)}</h2><p>Balance: <span class="gold">${money(u.balance)}</span></p></div>
      <form id="wd-f">
        <div id="wd-err"></div>
        <div class="label">Amount</div>
        <div class="amount-grid">${amounts.map((a) => `<div class="amount ${a > u.balance ? 'disabled' : ''} ${a === chosen ? 'active' : ''}" data-amt="${a}">${moneyShort(a)}</div>`).join('')}</div>
        <div class="field"><label>${esc(m.field_label)}</label><input class="input ${m.category === 'crypto' ? 'mono' : ''}" name="destination" maxlength="200" required autocomplete="off"></div>
        ${m.category === 'crypto' ? '<p class="faint" style="font-size:13px;margin:-6px 0 14px"><i class="fa-solid fa-triangle-exclamation gold"></i> Double-check the address and network. Crypto sent to the wrong address can\'t be recovered.</p>' : ''}
        <button class="btn btn-gold btn-block btn-lg" type="submit" ${chosen ? '' : 'disabled'}>${chosen ? `Cash out ${money(chosen)}` : `${money(min - u.balance)} more needed`}</button>
      </form></div>`);
    $$('.amount').forEach((el) => el.addEventListener('click', () => {
      if (el.classList.contains('disabled')) return;
      chosen = Number(el.dataset.amt);
      $$('.amount').forEach((x) => x.classList.toggle('active', x === el));
      const b = $('#wd-f button[type=submit]');
      b.disabled = false;
      b.textContent = `Cash out ${money(chosen)}`;
    }));
    $('#wd-f').addEventListener('submit', async (e) => {
      e.preventDefault();
      await withBusy($('button[type=submit]', e.target), async () => {
        try {
          const r = await api('/withdraw', { body: { method_id: m.id, coins: chosen, destination: e.target.destination.value } });
          state.user = r.user;
          closeModal();
          coinRain(18);
          toast(`Cashout requested: ${money(chosen)} via ${m.name}.`, 'success');
          pageCashout();
        } catch (err) { $('#wd-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
      });
    });
  }

  /* =========================================================== leaderboard */

  async function pageLeaderboard() {
    const period = state.route[1] || 'weekly';
    page(`<div class="page-head"><div><h1>Leaderboard</h1><p>Top earners from offers and referrals.</p></div>
      <div class="tabs">${[['weekly', 'This week'], ['monthly', 'This month'], ['all', 'All time']].map(([k, l]) => `<a href="#/leaderboard/${k}" class="tab ${period === k ? 'active' : ''}">${l}</a>`).join('')}</div></div>
      <div id="lb">${skels(1, 220)}</div>`);
    try {
      const { leaderboard } = await api(`/leaderboard?period=${period}`);
      const el = $('#lb');
      if (!el) return;
      if (!leaderboard.length) { el.innerHTML = emptyHTML('Nobody on the board yet. Could be you.', 'fa-trophy'); return; }
      const [a, b, c] = leaderboard;
      const pod = (p, cls, n) => (p ? `<div class="pod press quiet ${cls}" data-reveal><div class="place">${n}</div>${avatar(p.username, p.avatar_color, 'lg')}<b>${esc(p.username)}</b><div class="money green mt-8" style="font-size:22px">${money(p.earned)}</div></div>` : '<div></div>');
      el.innerHTML = `<div class="podium">${pod(b, 'p2', 2)}${pod(a, 'p1', 1)}${pod(c, 'p3', 3)}</div>
        ${leaderboard.length > 3 ? `<div class="table-wrap" data-reveal><table><thead><tr><th>#</th><th>User</th><th style="text-align:right">Earned</th></tr></thead><tbody>
        ${leaderboard.slice(3).map((p, i) => `<tr><td><span class="rank">${i + 4}</span></td><td><div class="row">${avatar(p.username, p.avatar_color)}<b>${esc(p.username)}</b></div></td><td style="text-align:right" class="money green">${money(p.earned)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
      afterRender(el);
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ============================================================= referrals */

  async function pageReferrals() {
    const c = state.config;
    page(skels(1, 200));
    try {
      const r = await api('/me/referrals');
      const link = `${location.origin}/?ref=${r.code}`;
      setContent(`<div class="page-head"><div><h1>Referrals</h1><p>Get ${fmt(c.referral_percent)}% of every offer your friends complete. For good.</p></div></div>
        <div class="stat-grid">
          <div class="press quiet stat" data-reveal><span class="si"><i class="fa-solid fa-user-group"></i></span><div><div class="sl">People you referred</div><div class="sv" data-count="${r.referrals.length}" data-fmt="n">0</div></div></div>
          <div class="press quiet stat" data-reveal><span class="si"><i class="fa-solid fa-sack-dollar"></i></span><div><div class="sl">You've earned</div><div class="sv" data-count="${r.commission}">$0.00</div></div></div>
          <div class="press quiet stat" data-reveal><span class="si"><i class="fa-solid fa-percent"></i></span><div><div class="sl">Your cut</div><div class="sv">${fmt(c.referral_percent)}%</div></div></div>
        </div>
        <div class="press quiet mt-32" data-reveal style="padding:24px">
          <div class="label"><i class="fa-solid fa-link"></i> Your link</div>
          <p class="muted mt-8" style="font-size:14px;margin-bottom:14px">Share it anywhere. Anyone who signs up with it, or with code <span class="code inline">${esc(r.code)}</span>, counts as your referral.</p>
          <div class="copy-box"><input class="input" readonly value="${esc(link)}" id="ref-link"><button class="btn btn-gold" data-act="copy-ref"><i class="fa-solid fa-copy"></i> Copy</button></div>
        </div>
        <div class="sec-title"><i class="fa-solid fa-users"></i> Your referrals</div>
        ${r.referrals.length ? `<div class="table-wrap"><table><thead><tr><th>User</th><th>Joined</th><th style="text-align:right">They earned</th><th style="text-align:right">Your cut</th></tr></thead><tbody>
          ${r.referrals.map((x) => `<tr><td><b>${esc(x.username)}</b></td><td class="faint">${date(x.created_at)}</td><td style="text-align:right" class="money">${money(x.earned)}</td><td style="text-align:right" class="money green">${money(Math.floor((x.earned * c.referral_percent) / 100))}</td></tr>`).join('')}
          </tbody></table></div>` : emptyHTML('No referrals yet. Send your link to a friend.', 'fa-user-plus')}`);
    } catch (err) { toast(err.message, 'error'); }
  }

  actions['copy-ref'] = async (e) => {
    const input = $('#ref-link');
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    const btn = e.target.closest('button');
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
    setTimeout(() => { if (btn.isConnected) btn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy'; }, 1600);
  };

  /* =============================================================== profile */

  async function pageProfile() {
    const u = state.user;
    const tab = state.route[1] || 'activity';
    page(`<div class="press quiet row wrap" style="gap:20px;padding:24px" data-reveal>
        ${avatar(u.username, u.avatar_color, 'lg')}
        <div style="flex:1;min-width:200px"><h1 style="font-size:28px;color:#fff">${esc(u.username)} ${u.role === 'admin' ? '<span class="admin-tag">ADMIN</span>' : ''}</h1><p class="muted">${esc(u.email)} · joined ${date(u.created_at)}</p></div>
        <div class="row" style="gap:34px"><div><div class="label">Balance</div><div class="money" style="font-size:24px">${money(u.balance)}</div></div>
        <div><div class="label">Earned</div><div class="money green" style="font-size:24px">${money(u.total_earned)}</div></div></div>
      </div>
      <div class="tabs mt-32">${[['activity', 'Activity'], ['offers', 'Earnings'], ['cashouts', 'Cashouts'], ['settings', 'Settings']].map(([k, l]) => `<a href="#/profile/${k}" class="tab ${tab === k ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div class="mt-24" id="profile-tab">${skels(1, 200)}</div>`);

    const out = $('#profile-tab');
    if (tab === 'settings') {
      out.innerHTML = `<div class="settings-grid">
        <div class="panel"><h3><i class="fa-solid fa-key gold"></i> Change password</h3>
          <p class="faint" style="font-size:13px;margin:4px 0 14px">Other devices are signed out when you change it.</p>
          <form id="pw-f"><div id="pw-err"></div>
            <div class="field"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password"></div>
            <div class="field"><label>New password</label><input class="input" type="password" name="next" autocomplete="new-password" placeholder="At least 8 characters"></div>
            <button class="btn btn-gold">Update password</button></form></div>
        <div class="panel"><h3><i class="fa-solid fa-envelope gold"></i> Email</h3>
          <p class="faint" style="font-size:13px;margin:4px 0 14px">Password reset links go here.</p>
          <form id="em-f"><div id="em-err"></div>
            <div class="field"><label>Email</label><input class="input" type="email" name="email" value="${esc(u.email)}" autocomplete="email"></div>
            <div class="field"><label>Your password</label><input class="input" type="password" name="password" autocomplete="current-password"></div>
            <button class="btn btn-gold">Update email</button></form></div>
        <div class="panel" style="grid-column:1/-1"><div class="row wrap"><h3><i class="fa-solid fa-laptop gold"></i> Where you're logged in</h3><span class="spacer"></span>
          <button class="btn btn-sm btn-danger" id="ss-others">Sign out everywhere else</button></div>
          <div id="ss-list" class="mt-16">${skels(1, 80)}</div></div>
      </div>`;
      $('#pw-f').addEventListener('submit', async (e) => {
        e.preventDefault();
        await withBusy($('button', e.target), async () => {
          try {
            const r = await api('/me/password', { body: formData(e.target) });
            e.target.reset(); $('#pw-err').innerHTML = ''; toast(r.message, 'success'); loadSessions();
          } catch (err) { $('#pw-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
        });
      });
      $('#em-f').addEventListener('submit', async (e) => {
        e.preventDefault();
        await withBusy($('button', e.target), async () => {
          try {
            const r = await api('/me/email', { body: formData(e.target) });
            state.user = r.user; e.target.password.value = ''; $('#em-err').innerHTML = ''; toast('Email updated.', 'success');
          } catch (err) { $('#em-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
        });
      });
      $('#ss-others').addEventListener('click', async () => {
        if (!(await confirmModal('Sign out everywhere else?', 'Every other browser and device will need to log in again.', 'Sign them out', true))) return;
        await api('/me/sessions/revoke-others', { body: {} });
        toast('Signed out everywhere else.', 'success'); loadSessions();
      });
      const device = (ua) => {
        const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
        const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown device';
        const ic = /iPhone|Android/.test(ua) ? 'fa-mobile-screen-button' : 'fa-desktop';
        return [ic, `${b} on ${os}`];
      };
      const loadSessions = async () => {
        const { sessions } = await api('/me/sessions');
        const el = $('#ss-list');
        if (!el) return;
        el.innerHTML = sessions.map((x) => {
          const [ic, name] = device(x.user_agent || '');
          return `<div class="session-row"><span class="si"><i class="fa-solid ${ic}"></i></span>
            <div style="flex:1;min-width:0"><b>${esc(name)}</b> ${x.current ? '<span class="badge b-green">This device</span>' : ''}
              <div class="faint" style="font-size:12px">${esc(x.ip || 'unknown IP')} · active ${esc(dateTime(x.last_seen_at))} · signed in ${esc(date(x.created_at))}</div></div>
            ${x.current ? '' : `<button class="btn btn-sm" data-revoke="${esc(x.id)}">Sign out</button>`}</div>`;
        }).join('') || emptyHTML('No active sessions.');
        $$('[data-revoke]', el).forEach((btn) => btn.addEventListener('click', async () => {
          await api(`/me/sessions/${btn.dataset.revoke}`, { method: 'DELETE' });
          toast('Signed out that device.', 'success'); loadSessions();
        }));
      };
      loadSessions().catch((err) => toast(err.message, 'error'));
      return;
    }
    try {
      const h = await api('/me/history');
      if (!out.isConnected) return;
      if (tab === 'activity') {
        out.innerHTML = h.transactions.length ? `<div class="table-wrap"><table><thead><tr><th>What</th><th>Type</th><th style="text-align:right">Amount</th><th>When</th></tr></thead><tbody>
          ${h.transactions.map((t) => `<tr><td>${esc(t.description)}</td><td><span class="badge b-gray">${esc(t.type)}</span></td><td style="text-align:right" class="money ${t.amount >= 0 ? 'green' : 'red'}">${t.amount >= 0 ? '+' : '−'}${money(Math.abs(t.amount))}</td><td class="faint">${dateTime(t.created_at)}</td></tr>`).join('')}
          </tbody></table></div>` : emptyHTML('Nothing here yet.');
      } else if (tab === 'offers') {
        out.innerHTML = h.completions.length ? `<div class="table-wrap"><table><thead><tr><th>Offer</th><th>From</th><th>Pays</th><th>Status</th><th>When</th></tr></thead><tbody>
          ${h.completions.map((c) => `<tr><td><b>${esc(c.offer_title)}</b></td><td class="faint">${esc(c.provider)}</td><td class="money">${money(c.reward)}</td><td><span class="badge st-${esc(c.status)}">${c.status === 'pending' ? 'on hold' : esc(c.status)}</span>${c.status === 'pending' && c.release_at ? `<div class="faint" style="font-size:12px">until ${esc(dateTime(c.release_at))}</div>` : ''}</td><td class="faint">${dateTime(c.created_at)}</td></tr>`).join('')}
          </tbody></table></div>` : emptyHTML("You haven't earned from any offerwalls yet.", 'fa-layer-group');
      } else {
        out.innerHTML = h.withdrawals.length ? `<div class="table-wrap"><table><thead><tr><th>Method</th><th>Amount</th><th>Sent to</th><th>Status</th><th>When</th></tr></thead><tbody>
          ${h.withdrawals.map((w) => `<tr><td><b>${esc(w.method_name)}</b></td><td class="money">${money(w.coins)}</td><td class="mono faint">${esc(w.destination)}</td><td><span class="badge st-${esc(w.status)}">${esc(w.status)}</span></td><td class="faint">${dateTime(w.created_at)}</td></tr>`).join('')}
          </tbody></table></div>` : emptyHTML('No cashouts yet.', 'fa-money-bill-wave');
      }
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ================================================================= admin */

  const adminPages = {
    '': adminOverview,
    users: adminUsers,
    walls: adminWalls,
    logs: adminLogs,
    audit: adminAudit,
    games: adminGames,
    completions: adminCompletions,
    withdrawals: adminWithdrawals,
    methods: adminMethods,
    promos: adminPromos,
    transactions: adminTransactions,
    settings: adminSettings,
  };

  function pageAdmin() {
    const fn = adminPages[state.route[1] || ''];
    if (!fn) return go('admin');
    page(skels(1, 200));
    fn().catch((err) => toast(err.message, 'error'));
  }

  const adminHead = (title, sub, right = '') => `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div>${right}</div>`;
  const ICON_HELP = 'Font Awesome name like <span class="code inline">fa-dragon</span> or <span class="code inline">fa-brands fa-steam</span>, or an image like <span class="code inline">img:/img/crypto/btc.svg</span>';

  function chart(data, cls, format) {
    const max = Math.max(1, ...data.map((d) => d.n));
    return `<div class="chart ${cls}">${data.map((d) => `<div class="col"><div data-h="${(d.n / max) * 100}" data-v="${esc(format(d.n))}"></div><small>${new Date(d.day).getDate()}</small></div>`).join('')}</div>`;
  }

  async function adminOverview() {
    const o = await api('/admin/overview');
    const stat = (ic, label, val, href, sub = '') => `<a href="#/admin/${href}" class="press stat" data-reveal><span class="si"><i class="fa-solid ${ic}"></i></span><div><div class="sl">${label}</div><div class="sv">${val}</div>${sub ? `<div class="faint" style="font-size:12px;font-weight:600">${sub}</div>` : ''}</div></a>`;
    setContent(`${adminHead('Overview', 'How the site is doing.')}
      <div class="stat-grid">
        ${stat('fa-users', 'Users', `<span data-count="${o.users}" data-fmt="n">0</span>`, 'users', `+${fmt(o.users_today)} today`)}
        ${stat('fa-circle-check', 'Offers completed', `<span data-count="${o.offers_completed}" data-fmt="n">0</span>`, 'completions')}
        ${stat('fa-hourglass-half', 'On hold', money(o.held_cents), 'completions', `${fmt(o.pending_completions)} conversions`)}
        ${stat('fa-money-bill-transfer', 'Pending cashouts', fmt(o.pending_withdrawals), 'withdrawals', `$${o.pending_withdrawals_usd.toFixed(2)}`)}
        ${stat('fa-sack-dollar', 'Paid out', `$${o.paid_usd.toFixed(2)}`, 'withdrawals/paid')}
        ${stat('fa-scale-balanced', 'Owed to users', money(o.total_balance), 'users')}
        ${stat('fa-chart-line', 'Revenue reported', money(o.revenue_cents), 'walls', `${money(o.paid_to_users_cents)} paid to users`)}
        ${stat('fa-layer-group', 'Live offerwalls', fmt(o.active_walls), 'walls')}
        ${stat('fa-tower-broadcast', 'Postbacks today', fmt(o.postbacks_today), 'logs', o.rejected_today ? `<span class="red">${fmt(o.rejected_today)} rejected</span>` : 'none rejected')}
      </div>
      <div class="two mt-32">
        <div class="panel" data-reveal><h3>Signups, last 14 days</h3>${chart(o.signups, '', fmt)}</div>
        <div class="panel" data-reveal><h3>Offer earnings, last 14 days</h3>${chart(o.earnings, 'green', money)}</div>
      </div>
      <div class="sec-title"><i class="fa-solid fa-user-plus"></i> Newest users</div>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Email</th><th>Balance</th><th>Joined</th></tr></thead><tbody>
        ${o.recent_users.map((u) => `<tr><td class="faint">#${u.id}</td><td><b>${esc(u.username)}</b></td><td class="faint">${esc(u.email)}</td><td class="money">${money(u.balance)}</td><td class="faint">${dateTime(u.created_at)}</td></tr>`).join('')}
      </tbody></table></div>`);
  }

  async function adminUsers() {
    setContent(`${adminHead('Users', 'Search, adjust balances, ban and promote.')}
      <div class="toolbar"><div class="input-icon" style="width:min(100%,340px)"><i class="fa-solid fa-magnifying-glass"></i><input class="input" id="u-search" placeholder="Username, email or ID"></div></div><div id="u-table"></div>`);
    const load = async () => {
      if (!$('#u-search')) return; // left the page
      const { users } = await api(`/admin/users?q=${encodeURIComponent($('#u-search').value)}`);
      if (!$('#u-table')) return;
      $('#u-table').innerHTML = `<div class="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Balance</th><th>Earned</th><th>Refs</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td class="faint">#${u.id}</td>
          <td><b>${esc(u.username)}</b> ${u.role === 'admin' ? '<span class="admin-tag">ADMIN</span>' : ''} ${u.is_demo ? '<span class="badge b-gray">demo</span>' : ''}<div class="faint" style="font-size:12px">${esc(u.email)}</div></td>
          <td class="money">${money(u.balance)}</td><td class="faint">${money(u.total_earned)}</td><td>${fmt(u.referrals)}</td>
          <td>${u.banned ? '<span class="badge b-red">Banned</span>' : '<span class="badge b-green">Active</span>'}</td>
          <td class="faint">${date(u.created_at)}</td>
          <td><button class="btn btn-sm" data-user="${u.id}">Manage</button></td></tr>`).join('') || `<tr><td colspan="8">${emptyHTML('No users found.')}</td></tr>`}
        </tbody></table></div>`;
      $$('[data-user]').forEach((b) => b.addEventListener('click', () => manageUser(Number(b.dataset.user), load)));
    };
    let t;
    $('#u-search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    await load();
  }

  async function manageUser(id, reload) {
    const { user: u, transactions, withdrawals, same_ip: sameIp, sessions } = await api(`/admin/users/${id}`);
    openModal(`<div class="modal-body">
      <div class="row" style="margin-bottom:20px;padding-right:40px">${avatar(u.username, '#eac837', 'lg')}<div><h2 style="font-size:24px;color:#fff">${esc(u.username)}</h2><div class="faint">${esc(u.email)} · #${u.id}</div>
        <div class="mt-8"><span class="money">${money(u.balance)}</span> <span class="faint">balance</span> · <span class="money green">${money(u.total_earned)}</span> <span class="faint">earned</span></div></div></div>
      <div class="grid-2">
        <form id="bal-f" class="panel" style="background:var(--bg)"><h3>Adjust balance</h3><p class="faint" style="font-size:13px;margin:4px 0 12px">In dollars. Use a minus sign to take money away.</p>
          <div class="field"><div class="input-icon"><i class="fa-solid fa-dollar-sign"></i><input class="input" name="amount" type="number" step="0.01" placeholder="5.00 or -5.00" required></div></div>
          <div class="field"><input class="input" name="reason" placeholder="Reason (optional)"></div>
          <button class="btn btn-gold btn-sm btn-block">Apply</button></form>
        <div class="panel" style="background:var(--bg)"><h3>Account</h3>
          <div class="row mt-16"><span style="flex:1">Banned</span><label class="switch"><input type="checkbox" id="u-ban" ${u.banned ? 'checked' : ''}><span></span></label></div>
          <div class="row mt-16"><span style="flex:1">Admin</span><label class="switch"><input type="checkbox" id="u-admin" ${u.role === 'admin' ? 'checked' : ''}><span></span></label></div>
          <form id="upw-f" class="row mt-16"><input class="input" name="password" type="password" placeholder="New password" style="padding:7px 10px"><button class="btn btn-sm">Set</button></form>
          <button class="btn btn-danger btn-sm btn-block mt-16" id="u-del">Delete user</button>
        </div>
      </div>
      <div class="panel mt-16" style="background:var(--bg)"><h3>Login & security</h3>
        <div class="faint mt-8" style="font-size:13px;line-height:1.8">
          Signed up from <span class="code inline">${esc(u.signup_ip || 'unknown')}</span> · last seen from <span class="code inline">${esc(u.last_ip || 'unknown')}</span><br>
          Last login ${u.last_login_at ? esc(dateTime(u.last_login_at)) : 'never'} · ${fmt(sessions)} active session${sessions === 1 ? '' : 's'}
          ${u.locked_until && u.locked_until > Date.now() ? `<br><span class="red">Locked after failed logins until ${esc(dateTime(u.locked_until))}</span>` : ''}
          ${sameIp.length ? `<br><span class="gold"><i class="fa-solid fa-triangle-exclamation"></i> Same IP as:</span> ${sameIp.map((x) => `<b>${esc(x.username)}</b>${x.banned ? ' (banned)' : ''}`).join(', ')}` : ''}
        </div>
        <div class="row wrap mt-16" style="gap:8px">
          <button class="btn btn-sm" id="u-reset"><i class="fa-solid fa-link"></i> Create password reset link</button>
          <button class="btn btn-sm" id="u-logout"><i class="fa-solid fa-arrow-right-from-bracket"></i> Sign out everywhere</button>
        </div>
        <div id="u-reset-out"></div>
      </div>
      <h3 class="mt-24">Recent activity</h3>
      <div class="table-wrap mt-8" style="max-height:220px;overflow:auto"><table><tbody>
        ${transactions.map((t) => `<tr><td>${esc(t.description)}</td><td class="money ${t.amount >= 0 ? 'green' : 'red'}" style="text-align:right">${t.amount >= 0 ? '+' : '−'}${money(Math.abs(t.amount))}</td><td class="faint nowrap">${dateTime(t.created_at)}</td></tr>`).join('') || '<tr><td class="faint">None</td></tr>'}
      </tbody></table></div>
      ${withdrawals.length ? `<h3 class="mt-16">Cashouts</h3><div class="table-wrap mt-8"><table><tbody>${withdrawals.map((w) => `<tr><td>${esc(w.method_name)}</td><td class="money">${money(w.coins)}</td><td><span class="badge st-${esc(w.status)}">${esc(w.status)}</span></td><td class="faint">${dateTime(w.created_at)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>`, { cls: 'wide', onClose: reload });

    const patch = async (body, msg) => {
      try { await api(`/admin/users/${id}`, { method: 'PATCH', body }); toast(msg, 'success'); } catch (err) { toast(err.message, 'error'); }
    };
    $('#bal-f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      body.amount = toCents(body.amount);
      try {
        await api(`/admin/users/${id}/balance`, { body });
        toast('Balance updated.', 'success');
        manageUser(id, reload);
        if (state.user.id === id) refreshMe();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#u-reset').addEventListener('click', async () => {
      try {
        const r = await api(`/admin/users/${id}/reset-link`, { body: {} });
        $('#u-reset-out').innerHTML = `<p class="faint mt-16" style="font-size:13px">Send this to ${esc(u.username)}. It works once, for ${r.expires_in_minutes} minutes.</p>
          <div class="copy-box mt-8"><input class="input mono" readonly value="${esc(r.url)}" id="u-reset-url"><button class="btn btn-gold" id="u-reset-copy"><i class="fa-solid fa-copy"></i></button></div>`;
        $('#u-reset-copy').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText($('#u-reset-url').value); } catch { $('#u-reset-url').select(); document.execCommand('copy'); }
          toast('Link copied.', 'success');
        });
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#u-logout').addEventListener('click', async () => {
      try { await api(`/admin/users/${id}/logout`, { body: {} }); toast('Signed out everywhere.', 'success'); } catch (err) { toast(err.message, 'error'); }
    });
    $('#u-ban').addEventListener('change', (e) => patch({ banned: e.target.checked }, e.target.checked ? 'User banned.' : 'User unbanned.'));
    $('#u-admin').addEventListener('change', (e) => patch({ role: e.target.checked ? 'admin' : 'user' }, 'Role updated.'));
    $('#upw-f').addEventListener('submit', (e) => { e.preventDefault(); patch({ password: e.target.password.value }, 'Password updated.'); e.target.reset(); });
    $('#u-del').addEventListener('click', async () => {
      if (!(await confirmModal('Delete user?', `This permanently deletes ${u.username} and all their history.`, 'Delete', true))) return;
      try { await api(`/admin/users/${id}`, { method: 'DELETE' }); toast('User deleted.', 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
    });
  }

  function postbackUrl(w, presets) {
    const macros = (presets && presets[w.preset] && presets[w.preset].macros) || {};
    const q = [
      [w.p_user, macros.user || '{USER_ID}'],
      [w.p_txid, macros.txid || '{TRANSACTION_ID}'],
      w.amount_source === 'payout' ? [w.p_payout, macros.payout || '{PAYOUT_USD}'] : [w.p_reward, macros.reward || (w.amount_unit === 'dollars' ? '{REWARD_DOLLARS}' : '{REWARD_CENTS}')],
      w.amount_source === 'payout' ? null : [w.p_payout, macros.payout || '{PAYOUT_USD}'],
      [w.p_status, macros.status || '{STATUS}'],
      [w.p_offer, macros.offer || '{OFFER_NAME}'],
      [w.p_ip, macros.ip || '{USER_IP}'],
      w.sig_method !== 'none' && w.sig_mode === 'template' ? [w.sig_param, macros.sig || '{SIGNATURE}'] : null,
    ].filter(Boolean).map(([k, v]) => `${k}=${v}`).join('&');
    return `${location.origin}/api/postback/${w.slug}/${w.postback_token}?${q}`;
  }

  async function adminWalls() {
    const [{ offerwalls }, { presets, sig_methods: sigMethods }] = await Promise.all([api('/admin/offerwalls'), api('/admin/offerwall-presets')]);
    setContent(`${adminHead('Offerwalls', 'Connect offerwall networks. Each one gets its own postback URL, and users are paid automatically when the network confirms an offer.',
      '<button class="btn btn-gold" id="new-wall"><i class="fa-solid fa-plus"></i> Add offerwall</button>')}
      ${offerwalls.length ? '' : `<div class="panel"><h3>How to connect a network</h3><ol class="muted steps-list">
        <li>Sign up as a publisher with an offerwall network (CPX Research, BitLabs, AdGem, Torox, Lootably, AyeT Studios…) and add your site there.</li>
        <li>Click <b>Add offerwall</b>, pick the network, and paste the wall link from their dashboard with <span class="code inline">{user_id}</span> where the user ID goes.</li>
        <li>Copy the postback URL we give you into the network's dashboard, replacing the <span class="code inline">{CAPS}</span> parts with the network's own macros.</li>
        <li>Set the network's currency to US cents (100 = $1), or tell us they send dollars, or pay users a % of the payout.</li>
        <li>Hit <b>Send test</b>, then send a test conversion from the network's dashboard and check the <a href="#/admin/logs" class="gold">postback log</a>.</li></ol></div>`}
      <div class="wall-admin-list">${offerwalls.map((w) => `<div class="panel wall-admin" data-reveal>
        <div class="row wrap">
          ${logo(w.icon, w.color, 'lg')}
          <div style="flex:1;min-width:180px"><h3 style="font-size:20px">${esc(w.name)} ${w.active ? '<span class="badge b-green">Live</span>' : '<span class="badge b-red">Off</span>'}
            ${!w.iframe_url ? '<span class="badge b-gold">No wall link</span>' : ''} ${w.sig_method !== 'none' ? `<span class="badge b-gray"><i class="fa-solid fa-signature"></i> ${esc(w.sig_method)}</span>` : ''}
            ${w.ip_whitelist ? '<span class="badge b-gray"><i class="fa-solid fa-network-wired"></i> IP allowlist</span>' : ''} ${w.hold_hours ? `<span class="badge b-gray"><i class="fa-regular fa-clock"></i> ${w.hold_hours}h hold</span>` : ''}</h3>
            <div class="faint" style="font-size:13px;font-weight:600">${fmt(w.completed)} completed · ${money(w.paid_cents)} paid to users · ${money(w.revenue_cents)} revenue reported · last postback ${w.last_postback ? dateTime(w.last_postback) : 'never'}</div></div>
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <button class="btn btn-sm" data-test="${w.id}"><i class="fa-solid fa-vial"></i> Send test</button>
            <a class="btn btn-sm" href="#/admin/logs/${w.id}"><i class="fa-solid fa-tower-broadcast"></i> Log</a>
            <button class="btn btn-sm" data-edit="${w.id}">Edit</button>
            <button class="btn btn-sm btn-danger" data-del="${w.id}" aria-label="Delete"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
        <div class="label mt-16"><i class="fa-solid fa-link"></i> Postback URL</div>
        <div class="copy-box mt-8"><input class="input mono" readonly value="${esc(postbackUrl(w, presets))}"><button class="btn btn-gold" data-copyurl><i class="fa-solid fa-copy"></i></button>
          <button class="btn" data-token="${w.id}" title="Make a new secret URL. The old one stops working."><i class="fa-solid fa-arrows-rotate"></i></button></div>
      </div>`).join('')}</div>`);

    $$('[data-copyurl]').forEach((b) => b.addEventListener('click', async () => {
      const input = b.parentElement.querySelector('input');
      try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
      toast('Postback URL copied.', 'success');
    }));
    $$('[data-token]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('New postback URL?', 'The current URL stops working right away. You will need to update it in the network dashboard.', 'Make new URL', true))) return;
      await api(`/admin/offerwalls/${b.dataset.token}/token`, { body: {} });
      toast('New postback URL created.', 'success'); adminWalls();
    }));
    $$('[data-test]').forEach((b) => b.addEventListener('click', () => withBusy(b, async () => {
      try {
        const r = await api(`/admin/offerwalls/${b.dataset.test}/test`, { body: {} });
        const row = (label, x) => `<div class="row" style="padding:10px 0;border-bottom:1px solid var(--line)"><b style="width:90px">${label}</b>
          <span class="badge ${['credited', 'held', 'reversed'].includes(x.result) ? 'b-green' : x.result === 'rejected' ? 'b-red' : 'b-gold'}">${esc(x.result)}</span><span class="muted" style="font-size:14px">${esc(x.message)}</span></div>`;
        openModal(`<div class="modal-body"><div class="modal-head"><h2>Test postback</h2>
          <p>We sent a signed $1.00 test conversion for your own account, then reversed it, exactly as the network would.</p></div>
          ${row('Credit', r.credit)}${row('Reversal', r.reversal)}
          <div class="label mt-16">URL that was used</div><div class="code mt-8">${esc(r.url)}</div>
          <p class="faint mt-16" style="font-size:13px">This checks your settings here. To check the network side, send a test conversion from their dashboard and watch the postback log.</p></div>`, { cls: 'wide' });
        adminWalls();
      } catch (err) { toast(err.message, 'error'); }
    })));
    $('#new-wall').addEventListener('click', () => wallForm(null, presets, sigMethods));
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => wallForm(offerwalls.find((w) => String(w.id) === b.dataset.edit), presets, sigMethods)));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete offerwall?', 'Its postback URL stops working. Past earnings are kept.', 'Delete', true))) return;
      await api(`/admin/offerwalls/${b.dataset.del}`, { method: 'DELETE' });
      toast('Offerwall deleted.', 'success'); adminWalls();
    }));
  }

  const WALL_DEFAULTS = {
    name: '', slug: '', tagline: '', color: '#eac837', icon: 'fa-layer-group', bonus_percent: 0, active: 1, sort: 0, preset: 'custom',
    iframe_url: '', open_mode: 'iframe', ip_whitelist: '', sig_method: 'none', sig_mode: 'template', sig_template: '', sig_param: 'hash', sig_secret: '',
    p_user: 'user_id', p_txid: 'txid', p_reward: 'reward', p_payout: 'payout', p_status: 'status', p_offer: 'offer', p_ip: 'ip',
    amount_source: 'reward', amount_unit: 'cents', revenue_share: 70, reversal_values: '2,reversed,chargeback,rejected', success_response: '1', hold_hours: 0,
  };

  function wallForm(w, presets, sigMethods) {
    const isNew = !w;
    w = { ...WALL_DEFAULTS, ...(w || {}) };
    const opt = (list, val) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const input = (name, label, help = '', attrs = '') => `<div class="field"><label>${label}</label><input class="input" name="${name}" value="${esc(w[name])}" ${attrs}>${help ? `<small class="faint">${help}</small>` : ''}</div>`;
    openModal(`<div class="modal-body"><div class="modal-head"><h2>${isNew ? 'Add offerwall' : `Edit ${esc(w.name)}`}</h2>
        <p>Settings come from your network's publisher dashboard.</p></div>
      <form id="w-f"><div id="w-err"></div>
        <div class="form-sec"><div class="label"><i class="fa-solid fa-plug"></i> Network</div>
          <div class="grid-2 mt-8">
            <div class="field"><label>Network</label><select class="input" name="preset">${opt(Object.entries(presets).map(([k, v]) => [k, v.name]), w.preset)}</select>
              <small class="faint">Fills in typical settings. Always double-check against the network's postback docs.</small></div>
            ${input('name', 'Name shown to users', '', 'required maxlength="60"')}
            ${input('tagline', 'Tagline', '', 'maxlength="120"')}
            ${input('slug', 'Slug', 'Used in URLs. Leave blank to generate it from the name.', 'maxlength="60"')}
            ${input('icon', 'Icon', 'e.g. <span class="code inline">fa-gem</span> or <span class="code inline">img:/img/your-logo.svg</span>')}
            <div class="field"><label>Color</label><div class="color-input"><input type="color" name="color" value="${safeColor(w.color)}"></div></div>
            ${input('bonus_percent', 'Bonus %', 'Extra on top of every reward from this wall.', 'type="number" min="0" max="1000"')}
            ${input('sort', 'Order', '', 'type="number"')}
          </div>
          <label class="check"><input type="checkbox" name="active" ${w.active ? 'checked' : ''}> Live (shown to users and accepting postbacks)</label>
        </div>

        <div class="form-sec"><div class="label"><i class="fa-solid fa-window-maximize"></i> Wall link</div>
          ${input('iframe_url', 'Wall URL', 'From the network dashboard. Put <span class="code inline">{user_id}</span> where the user ID goes, e.g. <span class="code inline">https://wall.example.com/?app=123&amp;uid={user_id}</span>', 'placeholder="https://"')}
          <div class="field"><label>Show it</label><select class="input" name="open_mode">${opt([['iframe', 'Embedded on our site'], ['tab', 'In a new tab (if the network blocks embedding)']], w.open_mode)}</select></div>
        </div>

        <div class="form-sec"><div class="label"><i class="fa-solid fa-sack-dollar"></i> Rewards</div>
          <div class="grid-2 mt-8">
            <div class="field"><label>User's reward comes from</label><select class="input" name="amount_source">${opt([['reward', 'The reward param (currency set in network dashboard)'], ['payout', 'A % of the payout to you']], w.amount_source)}</select></div>
            <div class="field" data-show="reward"><label>Reward param is in</label><select class="input" name="amount_unit">${opt([['cents', 'Cents (set network currency to 100 per $1)'], ['dollars', 'Dollars']], w.amount_unit)}</select></div>
            <div class="field" data-show="payout"><label>User gets % of payout</label><input class="input" type="number" min="0" max="100" name="revenue_share" value="${esc(w.revenue_share)}"></div>
            ${input('hold_hours', 'Hold rewards for (hours)', '0 = credit right away. Holding gives networks time to send chargebacks before users can cash out.', 'type="number" min="0" max="1440"')}
            ${input('reversal_values', 'Status values that mean "reversed"', 'Comma separated. A negative reward also counts as a reversal.')}
          </div>
        </div>

        <div class="form-sec"><div class="label"><i class="fa-solid fa-shield-halved"></i> Security</div>
          <p class="faint mt-8" style="font-size:13px">The postback URL already contains a secret token. Add an IP allowlist and signature check when the network supports them.</p>
          ${input('ip_whitelist', 'Allowed IPs', 'Comma separated, from the network docs. A trailing * matches a prefix, like <span class="code inline">203.0.113.*</span>. Leave blank to allow any IP.')}
          <div class="grid-2">
            <div class="field"><label>Signature</label><select class="input" name="sig_method">${opt(sigMethods.map((m) => [m, m === 'none' ? 'None' : m.toUpperCase()]), w.sig_method)}</select></div>
            <div class="field" data-sig><label>Signed data</label><select class="input" name="sig_mode">${opt([['template', 'A template of params (below)'], ['url', 'The full postback URL']], w.sig_mode)}</select></div>
            <div data-sig data-sigtpl style="grid-column:1/-1">${input('sig_template', 'Template', 'Placeholders: <span class="code inline">{txid}</span> <span class="code inline">{user_id}</span> <span class="code inline">{reward}</span> <span class="code inline">{payout}</span> <span class="code inline">{status}</span> <span class="code inline">{secret}</span>, or any raw param name.')}</div>
            <div data-sig>${input('sig_param', 'Signature param name')}</div>
            <div data-sig>${input('sig_secret', 'Secret key', 'From the network dashboard.', 'autocomplete="off"')}</div>
          </div>
        </div>

        <details class="form-sec"><summary class="label" style="cursor:pointer"><i class="fa-solid fa-sliders"></i> Advanced: param names & response</summary>
          <p class="faint mt-8" style="font-size:13px">The names we read from the postback. You only need to change these if the network can't use the names in our URL.</p>
          <div class="grid-2 mt-8">${input('p_user', 'User ID')}${input('p_txid', 'Transaction ID')}${input('p_reward', 'Reward')}${input('p_payout', 'Payout (USD)')}${input('p_status', 'Status')}${input('p_offer', 'Offer name')}${input('p_ip', 'User IP')}
            ${input('success_response', 'Reply on success', 'What the network expects back, often 1 or OK.')}</div>
        </details>

        <button class="btn btn-gold btn-block btn-lg mt-16">${isNew ? 'Add offerwall' : 'Save changes'}</button>
      </form></div>`, { cls: 'wide' });

    const f = $('#w-f');
    const sync = () => {
      const src = f.amount_source.value;
      $$('[data-show]', f).forEach((el) => { el.style.display = el.dataset.show === src ? '' : 'none'; });
      const sig = f.sig_method.value !== 'none';
      $$('[data-sig]', f).forEach((el) => { el.style.display = sig ? '' : 'none'; });
      $$('[data-sigtpl]', f).forEach((el) => { el.style.display = sig && f.sig_mode.value === 'template' ? '' : 'none'; });
    };
    f.preset.addEventListener('change', () => {
      const p = presets[f.preset.value] || {};
      const fill = { ...WALL_DEFAULTS, ...p };
      for (const k of ['name', 'tagline', 'icon', 'sig_method', 'sig_mode', 'sig_template', 'sig_param', 'reversal_values']) {
        if (f[k] && (k !== 'name' || !f.name.value || Object.values(presets).some((x) => x.name === f.name.value))) f[k].value = fill[k] ?? '';
      }
      if (p.color) f.color.value = p.color;
      sync();
    });
    ['amount_source', 'sig_method', 'sig_mode'].forEach((n) => f[n].addEventListener('change', sync));
    sync();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(isNew ? '/admin/offerwalls' : `/admin/offerwalls/${w.id}`, { method: isNew ? 'POST' : 'PUT', body: formData(f) });
        closeModal(); toast(isNew ? 'Offerwall added. Copy its postback URL into the network dashboard.' : 'Offerwall saved.', 'success'); adminWalls();
      } catch (err) { $('#w-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; $('#w-err').scrollIntoView({ block: 'center' }); }
    });
  }

  async function adminLogs() {
    const wallId = state.route[2] || '';
    const result = state.route[3] || '';
    const [{ offerwalls }, { logs }] = await Promise.all([api('/admin/offerwalls'),
      api(`/admin/postback-logs?wall=${encodeURIComponent(wallId)}&result=${encodeURIComponent(result)}`)]);
    const RESULTS = ['credited', 'held', 'reversed', 'duplicate', 'ignored', 'rejected'];
    const badge = (r) => `<span class="badge ${['credited', 'held', 'reversed'].includes(r) ? 'b-green' : r === 'rejected' ? 'b-red' : 'b-gold'}">${esc(r)}</span>`;
    setContent(`${adminHead('Postback log', 'Every postback the networks send, and what happened to it. Kept for 30 days.')}
      <div class="toolbar">
        <select class="input" id="lg-wall" style="width:auto"><option value="">All offerwalls</option>${offerwalls.map((w) => `<option value="${w.id}" ${String(w.id) === wallId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
        <select class="input" id="lg-res" style="width:auto"><option value="">All results</option>${RESULTS.map((r) => `<option ${r === result ? 'selected' : ''}>${r}</option>`).join('')}</select>
        <button class="btn btn-sm" id="lg-refresh"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Wall</th><th>Result</th><th>User</th><th>Amount</th><th>Details</th></tr></thead><tbody>
      ${logs.map((l) => `<tr><td class="faint nowrap">${dateTime(l.created_at)}</td><td><b>${esc(l.wall_name || '—')}</b></td><td>${badge(l.result)}</td>
        <td>${l.username ? esc(l.username) : '<span class="faint">—</span>'}</td><td class="money ${l.amount < 0 ? 'red' : ''}">${l.amount === null || l.amount === undefined ? '' : money(l.amount)}</td>
        <td><div>${esc(l.message)}</div><details><summary class="faint" style="cursor:pointer;font-size:12px">${esc(l.method)} from ${esc(l.ip)}</summary><div class="code mt-8">${esc(l.params)}</div></details></td></tr>`).join('')
        || `<tr><td colspan="6">${emptyHTML('No postbacks yet. Use "Send test" on an offerwall, or send a test conversion from the network.', 'fa-tower-broadcast')}</td></tr>`}
      </tbody></table></div>`);
    const nav = () => go(`admin/logs/${$('#lg-wall').value || '0'}/${$('#lg-res').value}`.replace(/\/$/, ''));
    $('#lg-wall').addEventListener('change', nav);
    $('#lg-res').addEventListener('change', nav);
    $('#lg-refresh').addEventListener('click', () => adminLogs().catch((err) => toast(err.message, 'error')));
  }

  function statusTabs(base, current, list) {
    return `<div class="tabs" style="margin-bottom:18px">${list.map(([k, l]) => `<a href="#/admin/${base}${k ? `/${k}` : ''}" class="tab ${current === k ? 'active' : ''}">${l}</a>`).join('')}</div>`;
  }

  async function adminCompletions() {
    const status = state.route[2] || 'pending';
    const { completions } = await api(`/admin/completions?status=${status === 'all' ? '' : status}`);
    setContent(`${adminHead('Conversions', 'Every reward the networks have reported. Pending ones are on hold: release them early or reject them. Reversing a paid one takes the money back.')}
      ${statusTabs('completions', status, [['pending', 'Pending'], ['completed', 'Completed'], ['rejected', 'Rejected'], ['all', 'All']])}
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Offer</th><th>Pays</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>
      ${completions.map((c) => `<tr><td class="faint">#${c.id}</td><td><b>${esc(c.username)}</b></td><td>${esc(c.offer_title)}<div class="faint" style="font-size:12px">${esc(c.provider)}${c.txid ? ` · tx ${esc(c.txid)}` : ''}</div></td>
        <td class="money">${money(c.reward)}</td><td><span class="badge st-${esc(c.status)}">${esc(c.status)}</span></td><td class="faint">${dateTime(c.created_at)}</td>
        <td><div class="row" style="gap:6px">${c.status === 'pending' ? `<button class="btn btn-sm btn-green" data-ok="${c.id}" title="${c.release_at ? `Releases on its own ${esc(dateTime(c.release_at))}` : ''}">Release now</button>` : ''}${c.status !== 'rejected' ? `<button class="btn btn-sm btn-danger" data-no="${c.id}">${c.status === 'completed' ? 'Reverse' : 'Reject'}</button>` : ''}</div></td></tr>`).join('') || `<tr><td colspan="7">${emptyHTML('Nothing here.', 'fa-circle-check')}</td></tr>`}
      </tbody></table></div>`);
    $$('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/admin/completions/${b.dataset.ok}/approve`, { body: {} }); toast('Approved and paid.', 'success'); adminCompletions(); } catch (err) { toast(err.message, 'error'); }
    }));
    $$('[data-no]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('Reject this?', 'If it was already paid, the money is taken back from the user.', 'Reject', true))) return;
      try { await api(`/admin/completions/${b.dataset.no}/reject`, { body: {} }); toast('Rejected.', 'success'); adminCompletions(); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  async function adminWithdrawals() {
    const status = state.route[2] || 'pending';
    const { withdrawals } = await api(`/admin/withdrawals?status=${status === 'all' ? '' : status}`);
    setContent(`${adminHead('Cashouts', 'Send the payment yourself, then mark it paid. Rejecting refunds the user.')}
      ${statusTabs('withdrawals', status, [['pending', 'Pending'], ['paid', 'Paid'], ['rejected', 'Rejected'], ['all', 'All']])}
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Method</th><th>Amount</th><th>Send to</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>
      ${withdrawals.map((w) => `<tr><td class="faint">#${w.id}</td><td><b>${esc(w.username)}</b><div class="faint" style="font-size:12px">${esc(w.email)}</div></td><td>${esc(w.method_name)}</td>
        <td class="money">${money(w.coins)}</td><td><span class="code inline" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle">${esc(w.destination)}</span> <button class="icon-btn" style="width:30px;height:30px;display:inline-grid;vertical-align:middle" data-copy="${esc(w.destination)}" aria-label="Copy"><i class="fa-solid fa-copy" style="font-size:12px"></i></button></td>
        <td><span class="badge st-${esc(w.status)}">${esc(w.status)}</span>${w.admin_note ? `<div class="faint" style="font-size:12px">${esc(w.admin_note)}</div>` : ''}</td><td class="faint">${dateTime(w.created_at)}</td>
        <td>${w.status === 'pending' ? `<div class="row" style="gap:6px"><button class="btn btn-sm btn-green" data-pay="${w.id}">Mark paid</button><button class="btn btn-sm btn-danger" data-rej="${w.id}">Reject</button></div>` : ''}</td></tr>`).join('') || `<tr><td colspan="8">${emptyHTML('Nothing here.', 'fa-money-bill-transfer')}</td></tr>`}
      </tbody></table></div>`);
    $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied.', 'success'); } catch { toast("Couldn't copy.", 'error'); }
    }));
    const act = (id, action) => {
      openModal(`<div class="modal-body"><div class="modal-head"><h2>${action === 'pay' ? 'Mark as paid' : 'Reject cashout'}</h2><p>${action === 'pay' ? 'Only do this once you have actually sent the payment.' : 'The money goes back to the user\'s balance.'}</p></div>
        <form id="wa-f"><div class="field"><label>Note to user (optional)</label><input class="input" name="note" maxlength="300" placeholder="${action === 'pay' ? 'e.g. transaction hash or gift card code' : 'e.g. reason'}"></div>
        <button class="btn ${action === 'pay' ? 'btn-gold' : 'btn-danger'} btn-block">${action === 'pay' ? 'Mark paid' : 'Reject and refund'}</button></form></div>`);
      $('#wa-f').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api(`/admin/withdrawals/${id}/${action}`, { body: formData(e.target) }); closeModal(); toast('Cashout updated.', 'success'); adminWithdrawals(); } catch (err) { toast(err.message, 'error'); }
      });
    };
    $$('[data-pay]').forEach((b) => b.addEventListener('click', () => act(b.dataset.pay, 'pay')));
    $$('[data-rej]').forEach((b) => b.addEventListener('click', () => act(b.dataset.rej, 'reject')));
  }

  async function adminMethods() {
    const { methods } = await api('/admin/reward-methods');
    const cats = [['crypto', 'Crypto'], ['prepaid', 'Prepaid card'], ['giftcard', 'Gift card']];
    setContent(`${adminHead('Payout methods', 'What users can cash out to, and the minimum for each.', '<button class="btn btn-gold" id="new-m"><i class="fa-solid fa-plus"></i> New method</button>')}
      <div class="table-wrap"><table><thead><tr><th></th><th>Name</th><th>Type</th><th>Minimum</th><th>Asks for</th><th>Status</th><th></th></tr></thead><tbody>
      ${methods.map((m) => `<tr><td>${logo(m.icon, m.color)}</td><td><b>${esc(m.name)}</b></td><td><span class="badge b-gray">${esc(m.category)}</span></td><td class="money">${money(m.min_coins)}</td><td class="faint">${esc(m.field_label)}</td>
        <td>${m.active ? '<span class="badge b-green">Live</span>' : '<span class="badge b-red">Hidden</span>'}</td>
        <td><div class="row" style="gap:6px"><button class="btn btn-sm" data-edit="${m.id}">Edit</button><button class="btn btn-sm btn-danger" data-del="${m.id}" aria-label="Delete"><i class="fa-solid fa-trash"></i></button></div></td></tr>`).join('') || `<tr><td colspan="7">${emptyHTML('No methods yet.')}</td></tr>`}
      </tbody></table></div>`);
    const form = (m) => {
      m = m || { name: '', category: 'giftcard', icon: 'fa-gift', color: '#eac837', field_label: 'Email for delivery', min_coins: 500, active: 1, sort: methods.length + 30 };
      openModal(`<div class="modal-body"><div class="modal-head"><h2>${m.id ? 'Edit method' : 'New method'}</h2></div>
        <form id="m-f"><div id="m-err"></div><div class="grid-2">
          <div class="field"><label>Name</label><input class="input" name="name" value="${esc(m.name)}" required></div>
          <div class="field"><label>Type</label><select class="input" name="category">${cats.map(([k, l]) => `<option value="${k}" ${m.category === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Minimum (USD)</label><div class="input-icon"><i class="fa-solid fa-dollar-sign"></i><input class="input" type="number" min="0.01" step="0.01" name="min_coins" value="${dollars(m.min_coins)}"></div></div>
          <div class="field"><label>Order</label><input class="input" type="number" name="sort" value="${esc(m.sort)}"></div></div>
          <div class="field"><label>Asks the user for</label><input class="input" name="field_label" value="${esc(m.field_label)}"></div>
          <div class="field"><label>Icon</label><input class="input" name="icon" value="${esc(m.icon)}"><small class="faint">${ICON_HELP}</small></div>
          <div class="field"><label>Color</label><div class="color-input"><input type="color" name="color" value="${safeColor(m.color)}"></div></div>
          <label class="check" style="margin-bottom:16px"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> Live</label>
          <button class="btn btn-gold btn-block">Save</button></form></div>`);
      $('#m-f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = formData(e.target);
        body.min_coins = toCents(body.min_coins);
        try {
          await api(m.id ? `/admin/reward-methods/${m.id}` : '/admin/reward-methods', { method: m.id ? 'PUT' : 'POST', body });
          closeModal(); toast('Method saved.', 'success'); adminMethods();
        } catch (err) { $('#m-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
      });
    };
    $('#new-m').addEventListener('click', () => form());
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => form(methods.find((m) => String(m.id) === b.dataset.edit))));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete method?', 'Past cashouts are kept.', 'Delete', true))) return;
      await api(`/admin/reward-methods/${b.dataset.del}`, { method: 'DELETE' });
      toast('Method deleted.', 'success'); adminMethods();
    }));
  }

  async function adminPromos() {
    const { promos } = await api('/admin/promos');
    setContent(`${adminHead('Promo codes', 'Codes users can redeem for a bonus.')}
      <form id="p-f" class="panel row wrap" style="align-items:flex-end;margin-bottom:22px">
        <div class="field" style="margin:0;flex:1;min-width:140px"><label>Code</label><input class="input" name="code" placeholder="SUMMER25" required></div>
        <div class="field" style="margin:0;width:140px"><label>Bonus (USD)</label><input class="input" type="number" name="reward" min="0.01" step="0.01" value="0.10"></div>
        <div class="field" style="margin:0;width:150px"><label>Max uses (0 = no limit)</label><input class="input" type="number" name="max_uses" min="0" value="0"></div>
        <div class="field" style="margin:0;width:140px"><label>Expires in days</label><input class="input" type="number" name="expires_days" min="0" value="0"></div>
        <button class="btn btn-gold">Create code</button></form>
      <div class="table-wrap"><table><thead><tr><th>Code</th><th>Bonus</th><th>Used</th><th>Expires</th><th>Live</th><th></th></tr></thead><tbody>
      ${promos.map((p) => `<tr><td><span class="code inline">${esc(p.code)}</span></td><td class="money">${money(p.reward)}</td><td>${fmt(p.uses)}${p.max_uses ? ` / ${fmt(p.max_uses)}` : ''}</td>
        <td class="faint">${p.expires_at ? dateTime(p.expires_at) : 'Never'}</td>
        <td><label class="switch"><input type="checkbox" data-toggle="${esc(p.code)}" ${p.active ? 'checked' : ''}><span></span></label></td>
        <td><button class="btn btn-sm btn-danger" data-del="${esc(p.code)}" aria-label="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`).join('') || `<tr><td colspan="6">${emptyHTML('No promo codes yet.')}</td></tr>`}
      </tbody></table></div>`);
    $('#p-f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      body.reward = toCents(body.reward);
      try { await api('/admin/promos', { body }); toast('Promo code created.', 'success'); adminPromos(); } catch (err) { toast(err.message, 'error'); }
    });
    $$('[data-toggle]').forEach((el) => el.addEventListener('change', () => api(`/admin/promos/${encodeURIComponent(el.dataset.toggle)}`, { method: 'PATCH', body: { active: el.checked } }).then(() => toast('Updated.', 'success'))));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete code?', b.dataset.del, 'Delete', true))) return;
      await api(`/admin/promos/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
      toast('Deleted.', 'success'); adminPromos();
    }));
  }

  async function adminGames() {
    const d = await api('/admin/games');
    const box = (label, x) => `<div class="press quiet stat" data-reveal><span class="si"><i class="fa-solid fa-dice"></i></span><div><div class="sl">${label}</div>
      <div class="sv ${x.wagered - x.paid >= 0 ? '' : 'red'}">${money(x.wagered - x.paid)}</div><div class="faint" style="font-size:12px;font-weight:600">${fmt(x.bets)} bets · ${money(x.wagered)} wagered</div></div></div>`;
    setContent(`${adminHead('Games', 'House profit is what players wagered minus what was paid back. Limits and the on/off switch are in Settings.')}
      <div class="stat-grid">${box('House profit today', d.today)}${box('Last 7 days', d.week)}${box('All time', d.all)}
        <div class="press quiet stat" data-reveal><span class="si"><i class="fa-solid fa-hourglass-half"></i></span><div><div class="sl">Open rounds</div><div class="sv">${fmt(d.open.n)}</div><div class="faint" style="font-size:12px;font-weight:600">${money(d.open.amount)} at stake</div></div></div></div>
      <div class="sec-title"><i class="fa-solid fa-chart-column"></i> By game</div>
      <div class="table-wrap"><table><thead><tr><th>Game</th><th>Bets</th><th>Wagered</th><th>Paid</th><th style="text-align:right">House profit</th><th>Actual RTP</th></tr></thead><tbody>
        ${d.byGame.map((g) => `<tr><td><b>${esc(g.name)}</b></td><td>${fmt(g.bets)}</td><td class="money">${money(g.wagered)}</td><td class="money">${money(g.paid)}</td>
          <td style="text-align:right" class="money ${g.wagered - g.paid >= 0 ? 'green' : 'red'}">${money(g.wagered - g.paid)}</td><td class="faint">${g.wagered ? ((g.paid / g.wagered) * 100).toFixed(1) : '0'}%</td></tr>`).join('')
        || `<tr><td colspan="6">${emptyHTML('No bets yet.', 'fa-dice')}</td></tr>`}</tbody></table></div>
      <div class="sec-title"><i class="fa-solid fa-list"></i> Latest bets</div>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Player</th><th>Game</th><th>Bet</th><th>Multiplier</th><th style="text-align:right">Payout</th></tr></thead><tbody>
        ${d.bets.map((b) => `<tr><td class="faint nowrap">${dateTime(b.created_at)}</td><td><b>${esc(b.username)}</b></td><td>${esc(b.name)} ${b.status === 'active' ? '<span class="badge b-gold">open</span>' : ''}</td>
          <td class="money">${money(b.amount)}</td><td>${Number(b.multiplier).toFixed(2)}×</td><td style="text-align:right" class="money ${b.payout > b.amount ? 'green' : ''}">${money(b.payout)}</td></tr>`).join('')
        || `<tr><td colspan="6">${emptyHTML('No bets yet.', 'fa-dice')}</td></tr>`}</tbody></table></div>`);
  }

  async function adminAudit() {
    const { entries } = await api('/admin/audit');
    setContent(`${adminHead('Audit log', 'Every change made in the admin panel, and who made it.')}
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Details</th><th>IP</th></tr></thead><tbody>
      ${entries.map((e) => `<tr><td class="faint nowrap">${dateTime(e.created_at)}</td><td><b>${esc(e.admin_name || 'deleted')}</b></td><td>${esc(e.action)}<div class="faint mono" style="font-size:11px">${esc(e.target)}</div></td>
        <td><details><summary class="faint" style="cursor:pointer;font-size:12px">View</summary><div class="code mt-8">${esc(e.details)}</div></details></td><td class="faint mono" style="font-size:12px">${esc(e.ip)}</td></tr>`).join('')
        || `<tr><td colspan="5">${emptyHTML('No admin actions yet.', 'fa-clipboard-list')}</td></tr>`}
      </tbody></table></div>`);
  }

  async function adminTransactions() {
    const { transactions } = await api('/admin/transactions');
    setContent(`${adminHead('Transactions', 'The latest 300 balance changes.')}
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Type</th><th>What</th><th style="text-align:right">Amount</th><th>When</th></tr></thead><tbody>
      ${transactions.map((t) => `<tr><td class="faint">#${t.id}</td><td><b>${esc(t.username)}</b></td><td><span class="badge b-gray">${esc(t.type)}</span></td><td>${esc(t.description)}</td>
        <td style="text-align:right" class="money ${t.amount >= 0 ? 'green' : 'red'}">${t.amount >= 0 ? '+' : '−'}${money(Math.abs(t.amount))}</td><td class="faint">${dateTime(t.created_at)}</td></tr>`).join('') || `<tr><td colspan="6">${emptyHTML('No transactions yet.')}</td></tr>`}
      </tbody></table></div>`);
  }

  async function adminSettings() {
    const { settings: s } = await api('/admin/settings');
    const row = (key, label, help, type = 'text', val = s[key], extra = '') => `<div class="set-row"><div class="si"><b>${label}</b><small>${help}</small></div>
      <input class="input" name="${key}" type="${type}" value="${esc(val)}" ${extra}></div>`;
    const toggle = (key, label, help) => `<div class="set-row"><div class="si"><b>${label}</b><small>${help}</small></div>
      <label class="switch"><input type="checkbox" name="${key}" ${s[key] === '1' ? 'checked' : ''}><span></span></label></div>`;
    setContent(`${adminHead('Settings', 'Site-wide options.')}
      <form id="s-f">
        <div class="panel"><h3>General</h3>
          ${row('site_name', 'Site name', 'Shown in the header and page title.')}
          ${row('announcement', 'Announcement bar', 'Shown at the top of every page. Leave empty to hide it.')}
          ${toggle('maintenance', 'Maintenance mode', 'Blocks everyone except admins.')}
          ${row('max_accounts_per_ip', 'Max accounts per IP', 'Stops people making lots of accounts from one network. 0 = no limit. Shared networks (schools, offices) may hit this.', 'number', s.max_accounts_per_ip || 0, 'min="0" max="100"')}
        </div>
        <div class="panel mt-24"><h3>Money</h3>
          ${row('signup_bonus', 'Sign-up bonus (USD)', 'Added when someone creates an account.', 'number', dollars(s.signup_bonus), 'min="0" step="0.01"')}
          ${row('daily_reward', 'Daily bonus (USD)', 'Users can claim this once every 24 hours.', 'number', dollars(s.daily_reward), 'min="0" step="0.01"')}
          ${row('referral_percent', 'Referral cut (%)', "Share of a referral's offer earnings paid to whoever invited them.", 'number', s.referral_percent, 'min="0" max="100"')}
          <p class="faint" style="font-size:13px;margin-top:10px">Cashout minimums are set per method under <a href="#/admin/methods" class="gold">Payout methods</a>.</p>
        </div>
        <div class="panel mt-24"><h3>Games</h3>
          ${toggle('games_enabled', 'Games on', 'Turn off to stop all new bets (open rounds can still finish).')}
          ${row('games_min_bet', 'Minimum bet (USD)', 'Smallest bet allowed in any game.', 'number', dollars(s.games_min_bet || 10), 'min="0.01" step="0.01"')}
          ${row('games_max_bet', 'Maximum bet (USD)', 'Largest bet allowed in any game.', 'number', dollars(s.games_max_bet || 10000), 'min="0.01" step="0.01"')}
          ${row('games_max_win', 'Maximum win per bet (USD)', 'Payouts above this are capped. Protects you from huge multipliers (mines, limbo, crash).', 'number', dollars(s.games_max_win || 100000), 'min="0.01" step="0.01"')}
        </div>
        <p class="faint mt-16" style="font-size:13px">Postback URLs, signatures and hold periods are set per network under <a href="#/admin/walls" class="gold">Offerwalls</a>.</p>
        <button class="btn btn-gold btn-lg mt-24">Save settings</button>
      </form>`);
    $('#s-f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      body.maintenance = body.maintenance ? 1 : 0;
      body.games_enabled = body.games_enabled ? 1 : 0;
      body.games_min_bet = toCents(body.games_min_bet);
      body.games_max_bet = toCents(body.games_max_bet);
      body.games_max_win = toCents(body.games_max_win);
      body.signup_bonus = toCents(body.signup_bonus);
      body.daily_reward = toCents(body.daily_reward);
      try {
        await api('/admin/settings', { method: 'PUT', body });
        toast('Settings saved.', 'success');
        await loadConfig();
        render();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  /* ===================================================== shared with games */

  window.GR = {
    $, $$, esc, fmt, money, moneyShort, toCents, api, toast, coin, avatar, dateTime, emptyHTML, skels,
    page, setContent, openModal, closeModal, confirmModal, openAuth, reveal, afterRender, countTo,
    setUser, showBalance, creditFx, coinRain, go, state, reduced,
  };

  /* ================================================================== boot */

  async function loadConfig() {
    state.config = await api('/config');
    state.user = state.config.user;
    document.title = `${state.config.site_name} · Get paid for games, apps and surveys`;
  }

  async function refreshMe() {
    try { setUser((await api('/me')).user); } catch { /* ignore */ }
  }

  document.addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-act]');
    if (actEl && actions[actEl.dataset.act]) actions[actEl.dataset.act](e);
    if (e.target.matches('[data-overlay]')) closeModal();
    const dd = $('.dropdown');
    if (dd && (!e.target.closest('.dropdown') || e.target.closest('.dropdown a')) && !e.target.closest('[data-act="user-menu"]')) dd.remove();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  window.addEventListener('hashchange', () => {
    // In-page anchors on the landing page (#how, #faq) aren't routes.
    if (/^#[a-z]/.test(location.hash)) return;
    closeModal();
    render();
  });

  (async () => {
    const ref = new URLSearchParams(location.search).get('ref');
    if (ref) {
      try { localStorage.setItem('ref', ref.toUpperCase()); } catch { /* ignore */ }
      history.replaceState(null, '', `/${location.hash}`);
    }
    try {
      await loadConfig();
    } catch {
      $('#app').innerHTML = '<div class="boot"><div class="center"><i class="fa-solid fa-plug-circle-xmark gold" style="font-size:42px"></i><h2 class="mt-16">Can\'t reach the server</h2><p class="muted">Please refresh in a moment.</p></div></div>';
      return;
    }
    render();
    if (ref && !state.user) openAuth('register');
    if (state.user && !state.user.onboarded) setTimeout(openWelcome, 400);
    if (!state.feed.length) loadFeed();
    setInterval(loadFeed, 20000);
    setInterval(() => { if (state.user && !document.hidden) refreshMe(); }, 30000);
  })();
})();
