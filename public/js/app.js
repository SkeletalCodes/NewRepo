/* GemRush front-end: a small hash-routed single-page app with no build step. */
(() => {
  'use strict';

  /* =============================================================== helpers */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const gem = (n) => `<span class="gem">${fmt(n)}</span>`;
  const usd = (gems) => `$${(Number(gems || 0) / (state.config.coins_per_usd || 1000)).toFixed(2)}`;
  const initial = (name) => esc(String(name || '?').charAt(0));
  const avatar = (name, color, cls = '') => `<div class="avatar ${cls}" style="background:${esc(color || '#7c5cff')}">${initial(name)}</div>`;
  const date = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const dateTime = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : '#7c5cff');

  function timeAgo(ts) {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function duration(mins) {
    if (mins < 60) return `${mins} min`;
    if (mins < 1440) return `${Math.round(mins / 60)} hr`;
    return `${Math.round(mins / 1440)} days`;
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
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
    const icon = { success: '✅', error: '⚠️', info: '💎' }[type];
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${icon}</span><div>${esc(msg)}</div>`;
    $('#toast-root').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, 3600);
    setTimeout(() => el.remove(), 4000);
  }

  function confetti(n = 80) {
    const colors = ['#7c5cff', '#22d3ee', '#22d37a', '#fbbf24', '#f43f5e', '#ffffff'];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = `${Math.random() * 100}vw`;
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = `${Math.random() * 0.6}s`;
      c.style.animationDuration = `${2 + Math.random() * 1.5}s`;
      c.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 4500);
    }
  }

  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value;
    }
    return out;
  }

  async function withBusy(btn, fn) {
    const label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="gem-spin" style="font-size:16px">💎</span>'; }
    try { return await fn(); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
  }

  /* ================================================================= state */

  const state = { config: {}, user: null, feed: [], route: [], walls: null, dropdown: false };
  const actions = {};

  function setUser(user) {
    const prev = state.user ? state.user.balance : null;
    state.user = user;
    const el = $('#balance-amt');
    if (el && user) {
      el.innerHTML = gem(user.balance);
      $('#balance-usd').textContent = usd(user.balance);
      if (prev !== null && prev !== user.balance) {
        el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
      }
    }
  }

  /* ================================================================ modals */

  function openModal(html, { cls = '', onClose } = {}) {
    closeModal();
    const root = $('#modal-root');
    root.innerHTML = `<div class="overlay" data-overlay><div class="modal ${cls}" role="dialog" aria-modal="true">
      <button class="icon-btn modal-close" data-act="close-modal" aria-label="Close">✕</button>${html}</div></div>`;
    root._onClose = onClose;
    document.body.style.overflow = 'hidden';
    const first = $('input, select, textarea', root);
    if (first) setTimeout(() => first.focus(), 50);
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
        <div class="row"><button class="btn btn-ghost btn-block" data-act="close-modal">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block" id="confirm-ok">${esc(okLabel)}</button></div></div>`,
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
    offers: pageOffers,
    wall: pageWall,
    cashout: pageCashout,
    leaderboard: pageLeaderboard,
    referrals: () => (requireAuth('login') ? pageReferrals() : go('earn')),
    profile: () => (requireAuth('login') ? pageProfile() : go('earn')),
    admin: pageAdmin,
  };

  function render() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    state.route = parts;
    state.dropdown = false;
    const handler = routes[parts[0] || ''];
    if (!handler) return go('');
    if (parts[0] === 'admin' && (!state.user || state.user.role !== 'admin')) {
      toast('Admins only.', 'error');
      return go('');
    }
    $('.sidebar') && $('.sidebar').classList.remove('open');
    $('.sidebar-backdrop') && $('.sidebar-backdrop').remove();
    window.scrollTo(0, 0);
    handler();
  }

  /* ================================================================= feed */

  async function loadFeed() {
    try {
      state.feed = (await api('/feed')).feed;
      renderTicker();
    } catch { /* ignore */ }
  }

  function tickerHTML() {
    if (!state.feed.length) return '<div class="tick"><span class="muted">Complete an offer to appear in the live feed!</span></div>';
    const items = state.feed.map((f) => `<div class="tick">${avatar(f.username, f.avatar_color)}
      <div class="t-meta"><b>${esc(f.username)}</b><small>${esc(f.offer_title)}</small></div>
      <span class="green">${gem(f.reward)}</span></div>`).join('');
    return `<div class="ticker-track">${items}</div><div class="ticker-track" aria-hidden="true">${items}</div>`;
  }

  function renderTicker() {
    const el = $('#ticker');
    if (el) el.innerHTML = tickerHTML();
  }

  /* =============================================================== landing */

  async function renderLanding() {
    const c = state.config;
    $('#app').innerHTML = `
    <nav class="landing-nav">
      <a href="#/" class="logo"><span class="logo-mark">💎</span><b>${esc(c.site_name)}</b></a>
      <div class="landing-links"><a href="#how">How it works</a><a href="#rewards">Rewards</a><a href="#/offers">Offers</a><a href="#/leaderboard">Leaderboard</a><a href="#faq">FAQ</a></div>
      <div class="spacer"></div>
      <button class="btn btn-ghost" data-act="login">Log in</button>
      <button class="btn btn-primary" data-act="register">Sign up</button>
    </nav>

    <header class="hero">
      <div>
        <span class="pill"><span class="dot"></span> <span id="hero-online">Earn up to $50 per offer</span></span>
        <h1>Play games. Take surveys.<br><span class="grad">Get paid real rewards.</span></h1>
        <p class="lead">Earn ${esc(c.currency_name)} for completing offers you actually enjoy, then cash out to PayPal, crypto, gift cards and in-game currency — starting from just ${usd(c.min_withdraw)}.</p>
        <div class="hero-cta">
          <button class="btn btn-green btn-lg" data-act="register">🎁 Claim ${fmt(c.signup_bonus)} free ${esc(c.currency_name)}</button>
          <a href="#/offers" class="btn btn-ghost btn-lg">Browse offers →</a>
        </div>
        <div class="hero-proof">
          <div><b id="st-users">—</b><span>Members</span></div>
          <div><b id="st-offers">—</b><span>Offers completed</span></div>
          <div><b id="st-paid">—</b><span>Paid out</span></div>
        </div>
      </div>
      <div class="hero-card">
        <span class="float-gem" style="top:-26px;right:24px">💎</span>
        <span class="float-gem" style="bottom:-20px;left:-14px;font-size:34px;animation-delay:1s">🪙</span>
        <div class="balance-demo">
          <div><small class="muted">Your balance</small><div class="big">${gem(12450)}</div></div>
          <span class="badge badge-green">≈ ${usd(12450)}</span>
        </div>
        <div id="hero-offers" style="display:grid;gap:10px"></div>
        <button class="btn btn-primary btn-block mt-16" data-act="register">Start earning now</button>
      </div>
    </header>

    <div class="section" style="padding-top:0;padding-bottom:0"><div class="ticker" id="ticker">${tickerHTML()}</div></div>

    <section class="section" id="how">
      <div class="section-head"><span class="kicker">How it works</span><h2>Three steps to your first cashout</h2><p>No hidden fees, no catch. Advertisers pay us for new users — we share that revenue with you.</p></div>
      <div class="steps">
        <div class="step"><span class="num">1</span><div class="ico" style="background:rgba(124,92,255,.2)">👤</div><h3>Create a free account</h3><p>Sign up in 10 seconds and get ${fmt(c.signup_bonus)} ${esc(c.currency_name)} instantly as a welcome bonus.</p></div>
        <div class="step"><span class="num">2</span><div class="ico" style="background:rgba(34,211,238,.18)">🎮</div><h3>Complete offers</h3><p>Play games, try apps, answer surveys and watch videos from our partner offerwalls.</p></div>
        <div class="step"><span class="num">3</span><div class="ico" style="background:rgba(34,211,122,.18)">💸</div><h3>Cash out fast</h3><p>Withdraw to PayPal, Bitcoin, Amazon, Robux, Steam and more. ${fmt(c.coins_per_usd)} ${esc(c.currency_name)} = $1.00.</p></div>
      </div>
    </section>

    <section class="section" id="rewards" style="padding-top:20px">
      <div class="section-head"><span class="kicker">Rewards</span><h2>Cash out your way</h2><p>Pick from cash, crypto, gift cards and gaming currencies.</p></div>
      <div class="methods-strip" id="landing-methods"></div>
    </section>

    <section class="section" id="faq" style="padding-top:20px">
      <div class="section-head"><span class="kicker">FAQ</span><h2>Questions? Answers.</h2></div>
      <div class="faq">
        <details><summary>Is ${esc(c.site_name)} free?</summary><p>Yes. Signing up and completing offers is completely free. Some shopping offers involve purchases, and they're always clearly marked.</p></details>
        <details><summary>How much are ${esc(c.currency_name)} worth?</summary><p>${fmt(c.coins_per_usd)} ${esc(c.currency_name)} are worth $1.00 USD. The minimum cashout is ${fmt(c.min_withdraw)} ${esc(c.currency_name)} (${usd(c.min_withdraw)}).</p></details>
        <details><summary>How long do cashouts take?</summary><p>Most cashouts are reviewed and sent within 24 hours. Larger cashouts may take a little longer for security checks.</p></details>
        <details><summary>Why didn't my offer credit?</summary><p>Offers are tracked by our partners. Make sure you're a new user for that offer, disable ad blockers and follow every requirement. Some offers take up to 24 hours to credit.</p></details>
        <details><summary>Can I invite friends?</summary><p>Yes! You earn ${fmt(c.referral_percent)}% of everything your referrals earn from offers — forever.</p></details>
      </div>
    </section>

    <div class="cta-band">
      <h2>Your next reward is one click away</h2>
      <p>Join now and get ${fmt(c.signup_bonus)} ${esc(c.currency_name)} on the house.</p>
      <button class="btn btn-lg" data-act="register">Create free account</button>
    </div>

    <footer class="footer">
      <div class="logo" style="font-size:18px"><span class="logo-mark" style="width:30px;height:30px;font-size:16px">💎</span><b>${esc(c.site_name)}</b></div>
      <div class="row wrap" style="gap:22px"><a href="#/offers">Offers</a><a href="#/leaderboard">Leaderboard</a><a href="#" data-act="terms">Terms</a><a href="#" data-act="privacy">Privacy</a></div>
      <div>© ${new Date().getFullYear()} ${esc(c.site_name)}. All rights reserved.</div>
    </footer>`;

    api('/stats').then((s) => {
      $('#st-users') && ($('#st-users').textContent = fmt(s.users));
      $('#st-offers') && ($('#st-offers').textContent = fmt(s.offers_completed));
      if ($('#st-paid')) {
        if (s.paid_usd > 0) $('#st-paid').textContent = `$${fmt(Math.round(s.paid_usd))}`;
        else $('#st-paid').parentElement.innerHTML = `<b>${fmt(s.earned_today)}</b><span>${esc(c.currency_name)} earned today</span>`;
      }
    }).catch(() => {});
    api('/offers?featured=1').then(({ offers }) => {
      const el = $('#hero-offers');
      if (!el) return;
      el.innerHTML = offers.slice(0, 3).map((o) => `<div class="quick" style="padding:12px;cursor:pointer" data-act="register">
        <div class="q-ico" style="background:${safeColor(o.color)}33">${esc(o.icon)}</div>
        <div class="q-body"><b style="font-size:14px">${esc(o.title)}</b><small>${esc(o.provider || '')}</small></div>
        <span class="green">${gem(o.payout)}</span></div>`).join('');
    }).catch(() => {});
    api('/reward-methods').then(({ methods }) => {
      const el = $('#landing-methods');
      if (el) el.innerHTML = methods.map((m) => `<div class="method-chip"><div class="m-ico" style="background:${safeColor(m.color)}33">${esc(m.icon)}</div>${esc(m.name)}</div>`).join('');
    }).catch(() => {});
    loadFeed();
  }

  actions.terms = (e) => {
    e.preventDefault();
    openModal(`<div class="modal-body"><div class="modal-head"><h2>Terms of Service</h2></div><div class="muted" style="display:grid;gap:10px;font-size:14px">
      <p>1. You must be 13 or older (18+ for some offers) to use ${esc(state.config.site_name)}.</p>
      <p>2. One account per person, household and device. Using VPNs, proxies, emulators or bots to complete offers is prohibited.</p>
      <p>3. Rewards are credited by our partners. We may reverse rewards that are charged back or obtained fraudulently.</p>
      <p>4. Cashouts are reviewed manually and may be declined for violations of these terms.</p>
      <p>5. We may update these terms at any time. Continued use of the site means you accept the latest version.</p></div></div>`);
  };
  actions.privacy = (e) => {
    e.preventDefault();
    openModal(`<div class="modal-body"><div class="modal-head"><h2>Privacy Policy</h2></div><div class="muted" style="display:grid;gap:10px;font-size:14px">
      <p>We store your username, email, a salted hash of your password, and your earning and cashout history.</p>
      <p>We share your user ID with offer partners so they can credit your rewards. We never sell your personal information.</p>
      <p>You can request deletion of your account at any time by contacting support.</p></div></div>`);
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
        <div>
          <div class="logo"><span class="logo-mark">💎</span><b style="color:#fff;-webkit-text-fill-color:#fff">${esc(c.site_name)}</b></div>
          <h3 class="mt-24">Turn your free time into real rewards.</h3>
          <ul>
            <li><span>🎮</span> Hundreds of games, apps & surveys</li>
            <li><span>⚡</span> Fast cashouts from ${usd(c.min_withdraw)}</li>
            <li><span>💸</span> PayPal, crypto, gift cards & more</li>
            <li><span>👥</span> ${fmt(c.referral_percent)}% lifetime referral earnings</li>
          </ul>
        </div>
        <div class="bonus-callout"><b>🎁 Sign-up bonus</b><div style="opacity:.85;font-size:14px">Get ${fmt(c.signup_bonus)} ${esc(c.currency_name)} free when you create your account today.</div></div>
        <div class="deco">💎</div>
      </div>
      <div class="auth-form">
        <div class="auth-tabs"><button data-tab="login">Log in</button><button data-tab="register">Sign up</button></div>
        <div id="auth-panel"></div>
      </div>`, { cls: 'auth-modal' });

    const panel = $('#auth-panel');
    const setTab = (tab) => {
      $$('.auth-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      if (tab === 'login') {
        panel.innerHTML = `<div class="modal-head" style="text-align:left;margin-bottom:18px"><h2>Welcome back 👋</h2><p>Log in to keep earning.</p></div>
          <form id="auth-f" novalidate>
            <div id="auth-err"></div>
            <div class="field"><label>Username or email</label><div class="input-icon"><span>👤</span><input class="input" name="login" autocomplete="username" required></div></div>
            <div class="field"><label>Password</label><div class="input-icon"><span>🔒</span><input class="input" type="password" name="password" autocomplete="current-password" required></div></div>
            <button class="btn btn-primary btn-block btn-lg" type="submit">Log in</button>
            <p class="center muted mt-16" style="font-size:14px">New here? <a href="#" class="gold" data-switch="register">Create an account</a></p>
          </form>`;
      } else {
        panel.innerHTML = `<div class="modal-head" style="text-align:left;margin-bottom:18px"><h2>Create your account</h2><p>Free forever. Takes 10 seconds.</p></div>
          <form id="auth-f" novalidate>
            <div id="auth-err"></div>
            <div class="field"><label>Username</label><div class="input-icon"><span>👤</span><input class="input" name="username" autocomplete="username" maxlength="20" placeholder="3-20 characters" required></div></div>
            <div class="field"><label>Email</label><div class="input-icon"><span>✉️</span><input class="input" type="email" name="email" autocomplete="email" placeholder="you@example.com" required></div></div>
            <div class="field"><label>Password</label><div class="input-icon"><span>🔒</span><input class="input" type="password" name="password" autocomplete="new-password" placeholder="At least 8 characters" required></div>
              <div class="pw-meter"><div id="pw-bar" style="width:0"></div></div></div>
            <div class="field"><label>Referral code <span class="faint">(optional)</span></label><div class="input-icon"><span>🎟️</span><input class="input" name="referral" value="${esc(ref)}" placeholder="e.g. A1B2C3D4"></div></div>
            <label class="check" style="margin-bottom:16px"><input type="checkbox" name="terms"> <span>I am 13+ and agree to the <a href="#" class="gold" data-act="terms">Terms</a> and <a href="#" class="gold" data-act="privacy">Privacy Policy</a>.</span></label>
            <button class="btn btn-green btn-block btn-lg" type="submit">🎁 Sign up & claim ${fmt(c.signup_bonus)}</button>
            <p class="center muted mt-16" style="font-size:14px">Already have an account? <a href="#" class="gold" data-switch="login">Log in</a></p>
          </form>`;
        const pw = $('input[name=password]', panel);
        pw.addEventListener('input', () => {
          const s = pwStrength(pw.value);
          const bar = $('#pw-bar');
          bar.style.width = `${(s / 5) * 100}%`;
          bar.style.background = ['#f43f5e', '#f43f5e', '#fbbf24', '#fbbf24', '#22d37a', '#22d37a'][s];
        });
      }
      $$('[data-switch]', panel).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); setTab(a.dataset.switch); }));
      $('input', panel).focus();
      $('#auth-f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button[type=submit]', e.target);
        const body = formData(e.target);
        $('#auth-err').innerHTML = '';
        try {
          await withBusy(btn, async () => {
            const { user } = await api(`/auth/${tab}`, { body });
            setUser(user);
            closeModal();
            try { localStorage.removeItem('ref'); } catch { /* ignore */ }
            if (tab === 'register') {
              startApp('earn');
              setTimeout(() => openWelcome(), 250);
            } else {
              toast(`Welcome back, ${user.username}!`, 'success');
              startApp(state.route[0] ? null : 'earn');
              if (!user.onboarded) setTimeout(() => openWelcome(), 250);
            }
          });
        } catch (err) {
          const box = $('#auth-err');
          if (box) box.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
        }
      });
    };
    $$('.auth-tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    setTab(mode);
  }
  actions.login = () => openAuth('login');
  actions.register = () => openAuth('register');

  actions.logout = async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    state.user = null;
    toast('You have been logged out.');
    location.hash = '#/';
    startApp();
  };

  /* ============================================================ onboarding */

  function openWelcome() {
    const c = state.config;
    const u = state.user;
    const slides = [
      `<div class="big-gem">💎</div>
       <h2>Welcome to ${esc(c.site_name)}, ${esc(u.username)}!</h2>
       <p class="muted">Your account is ready. Here's a little something to get you started:</p>
       <div class="bonus-amt">+${gem(c.signup_bonus)}</div>
       <p class="muted" style="font-size:14px">That's already ${usd(c.signup_bonus)} toward your first cashout.</p>`,
      `<h2>How to earn ${esc(c.currency_name)}</h2>
       <div class="onboard-steps">
         <div><span style="background:rgba(124,92,255,.2)">🎮</span><span style="all:unset"><b>Featured offers</b><br><small class="muted">Hand-picked games & apps with the highest payouts.</small></span></div>
         <div><span style="background:rgba(34,211,238,.18)">🧱</span><span style="all:unset"><b>Offerwalls</b><br><small class="muted">Thousands of tasks from our partner networks.</small></span></div>
         <div><span style="background:rgba(251,191,36,.18)">📅</span><span style="all:unset"><b>Daily reward</b><br><small class="muted">Claim ${fmt(c.daily_reward)} free ${esc(c.currency_name)} every 24 hours.</small></span></div>
         <div><span style="background:rgba(236,72,153,.18)">👥</span><span style="all:unset"><b>Invite friends</b><br><small class="muted">Earn ${fmt(c.referral_percent)}% of everything they earn.</small></span></div>
       </div>`,
      `<div class="big-gem">💸</div>
       <h2>Cash out your way</h2>
       <p class="muted mt-8">${fmt(c.coins_per_usd)} ${esc(c.currency_name)} = $1.00. Withdraw from just ${usd(c.min_withdraw)} to PayPal, crypto, gift cards, Robux and more.</p>
       <div class="mt-24" style="background:var(--bg-2);border:1px solid var(--border);border-radius:14px;padding:16px;text-align:left">
         <div class="row"><b>Progress to first cashout</b><span class="spacer"></span><span class="muted">${fmt(u.balance)} / ${fmt(c.min_withdraw)}</span></div>
         <div class="progress mt-8"><div style="width:${Math.min(100, (u.balance / c.min_withdraw) * 100)}%"></div></div>
       </div>
       <p class="muted mt-16" style="font-size:14px">Tip: try promo code <b class="gold">WELCOME</b> for a few extra ${esc(c.currency_name)}!</p>`,
    ];
    let i = 0;
    const finish = () => api('/me/onboarded', { body: {} }).catch(() => {});
    openModal('<div class="modal-body onboard" id="onboard"></div>', { onClose: finish });
    const draw = () => {
      $('#onboard').innerHTML = `<div class="dots">${slides.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
        ${slides[i]}
        <div class="row mt-24">
          ${i > 0 ? '<button class="btn btn-ghost" id="ob-back">Back</button>' : ''}
          <button class="btn ${i === slides.length - 1 ? 'btn-green' : 'btn-primary'} btn-block btn-lg" id="ob-next">${i === slides.length - 1 ? "Let's start earning 🚀" : 'Continue'}</button>
        </div>`;
      $('#ob-next').addEventListener('click', () => { if (i < slides.length - 1) { i++; draw(); } else closeModal(); });
      $('#ob-back') && $('#ob-back').addEventListener('click', () => { i--; draw(); });
    };
    draw();
    confetti();
  }

  /* ============================================================== app shell */

  function navItem(path, icon, label, extra = '') {
    const active = (state.route[0] || '') === path.split('/')[0] && (path.split('/')[0] !== 'admin' || (state.route[1] || '') === (path.split('/')[1] || ''));
    return `<a href="#/${path}" class="nav-item ${active ? 'active' : ''}"><span class="ni">${icon}</span>${label}${extra}</a>`;
  }

  function shell(content) {
    const c = state.config;
    const u = state.user;
    const isAdmin = u && u.role === 'admin';
    const inAdmin = state.route[0] === 'admin';
    $('#app').innerHTML = `<div class="shell">
      <aside class="sidebar">
        <a href="#/" class="logo"><span class="logo-mark">💎</span><b>${esc(c.site_name)}</b></a>
        ${inAdmin ? `
          <div class="nav-label">Admin <span class="admin-badge">ADMIN</span></div>
          ${navItem('admin', '📊', 'Overview')}
          ${navItem('admin/users', '👥', 'Users')}
          ${navItem('admin/offers', '🎯', 'Offers')}
          ${navItem('admin/walls', '🧱', 'Offerwalls')}
          ${navItem('admin/completions', '✅', 'Completions')}
          ${navItem('admin/withdrawals', '💸', 'Withdrawals')}
          ${navItem('admin/methods', '🎁', 'Reward methods')}
          ${navItem('admin/promos', '🎟️', 'Promo codes')}
          ${navItem('admin/transactions', '📜', 'Transactions')}
          ${navItem('admin/settings', '⚙️', 'Settings')}
          <div class="nav-label">Site</div>
          ${navItem('earn', '←', 'Back to site')}
        ` : `
          <div class="nav-label">Earn</div>
          ${navItem('earn', '🏠', 'Earn')}
          ${navItem('offers', '🎯', 'All offers')}
          ${navItem('leaderboard', '🏆', 'Leaderboard')}
          <div class="nav-label">Account</div>
          ${navItem('cashout', '💸', 'Cash out')}
          ${navItem('referrals', '👥', 'Referrals')}
          ${navItem('profile', '👤', 'Profile')}
          ${isAdmin ? `<div class="nav-label">Manage</div>${navItem('admin', '🛡️', 'Admin panel', ' <span class="admin-badge badge">ADMIN</span>')}` : ''}
          <div class="sidebar-promo">
            <b>👥 Invite & earn</b>
            <p>Get ${fmt(c.referral_percent)}% of your friends' earnings for life.</p>
            <a href="#/referrals" class="btn btn-primary btn-sm btn-block">Invite friends</a>
          </div>
        `}
      </aside>
      <div class="main">
        <div class="topbar">
          <button class="icon-btn menu-btn" data-act="menu" aria-label="Menu">☰</button>
          <div class="spacer"></div>
          ${u ? `
            <div class="balance-pill">
              <div><div id="balance-amt">${gem(u.balance)}</div><div class="usd" id="balance-usd">${usd(u.balance)}</div></div>
              <a href="#/cashout" class="btn btn-green btn-sm">Cash out</a>
            </div>
            <div class="user-chip" data-act="user-menu">${avatar(u.username, u.avatar_color)}<span class="hide-sm"><b>${esc(u.username)}</b></span><span class="faint hide-sm">▾</span></div>
          ` : `
            <button class="btn btn-ghost" data-act="login">Log in</button>
            <button class="btn btn-primary" data-act="register">Sign up</button>
          `}
        </div>
        ${c.announcement && !inAdmin ? `<div class="announcement">📣 <span>${esc(c.announcement)}</span></div>` : ''}
        ${c.maintenance ? '<div class="announcement" style="background:rgba(244,63,94,.15)">🛠️ Maintenance mode is ON — only admins can use the site.</div>' : ''}
        ${inAdmin ? '' : `<div class="ticker-bar"><div class="ticker" id="ticker">${tickerHTML()}</div></div>`}
        <main class="content" id="content">${content || ''}</main>
      </div>
    </div>`;
  }

  actions.menu = () => {
    const sb = $('.sidebar');
    sb.classList.add('open');
    const bd = document.createElement('div');
    bd.className = 'sidebar-backdrop';
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
      <a href="#/profile">👤 Profile</a><a href="#/cashout">💸 Cash out</a><a href="#/referrals">👥 Referrals</a>
      ${u.role === 'admin' ? '<a href="#/admin">🛡️ Admin panel</a>' : ''}
      <button data-act="logout" class="red">🚪 Log out</button>`;
    $('.topbar').appendChild(dd);
  };

  function page(html) {
    // Re-render the full shell so the active nav and topbar stay in sync.
    shell(html);
  }

  /* ================================================================ offers */

  function offerCard(o) {
    const deviceIcon = { android: '🤖 Android', ios: '🍎 iOS', desktop: '🖥️ Desktop', all: '🌐 All devices' }[o.device] || '';
    const status = o.user_status === 'completed' ? '<span class="badge badge-green">✓ Done</span>'
      : o.user_status === 'pending' ? '<span class="badge badge-yellow">Pending</span>' : '';
    return `<div class="offer ${o.user_status === 'completed' && !o.repeatable ? 'done' : ''}" style="--c:${safeColor(o.color)}" data-offer="${o.id}">
      <div class="o-top"><span class="device">${deviceIcon}</span>${o.featured ? '<span class="hot">🔥 HOT</span>' : ''}${esc(o.icon)}</div>
      <div class="o-body">
        <div class="o-title">${esc(o.title)}</div>
        <div class="o-prov">${esc(o.provider || 'Featured')} · ${duration(o.est_minutes)}</div>
        <div class="o-foot"><span class="o-reward">${gem(o.payout)}</span>${status || `<span class="faint" style="font-size:12px">${usd(o.payout)}</span>`}</div>
      </div></div>`;
  }

  function bindOffers(offers) {
    const map = new Map(offers.map((o) => [String(o.id), o]));
    $$('[data-offer]').forEach((el) => el.addEventListener('click', () => openOffer(map.get(el.dataset.offer))));
  }

  function openOffer(o) {
    if (!o) return;
    const color = safeColor(o.color);
    const done = o.user_status === 'completed' && !o.repeatable;
    const pending = o.user_status === 'pending';
    openModal(`<div class="offer-hero" style="--c:${color}">${esc(o.icon)}</div>
      <div class="modal-body">
        <div class="row" style="align-items:flex-start">
          <div style="flex:1"><h2 style="font-size:22px">${esc(o.title)}</h2><div class="faint mt-8" style="font-size:13px">via ${esc(o.provider || 'Featured')} ${o.bonus_percent ? `<span class="badge badge-green">+${o.bonus_percent}% bonus</span>` : ''}</div></div>
        </div>
        <p class="muted mt-16">${esc(o.description)}</p>
        <div class="offer-facts">
          <div><small>Reward</small><b class="green">${gem(o.payout)}</b></div>
          <div><small>Value</small><b>${usd(o.payout)}</b></div>
          <div><small>Est. time</small><b>${duration(o.est_minutes)}</b></div>
        </div>
        ${o.requirements ? `<div class="req"><b style="color:var(--text)">Requirements</b><br>${esc(o.requirements)}</div>` : ''}
        <div class="mt-24" id="offer-action">
          ${done ? '<button class="btn btn-block btn-lg" disabled>✓ Already completed</button>'
            : pending ? '<button class="btn btn-block btn-lg" disabled>⏳ Pending review</button>'
            : `<button class="btn btn-green btn-block btn-lg" id="start-offer">Start offer · earn ${fmt(o.payout)}</button>`}
        </div>
        <p class="demo-note">Demo offer — completion is simulated. Connect a real offerwall via the postback URL in Admin → Settings.</p>
      </div>`, { cls: 'wide' });

    const btn = $('#start-offer');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!requireAuth('register')) return;
      const box = $('#offer-action');
      box.innerHTML = `<div class="card" style="text-align:center;background:var(--bg-2)">
        <div class="gem-spin" style="font-size:32px">💎</div><b>Tracking your progress…</b>
        <div class="progress mt-16"><div id="track-bar" style="width:0"></div></div>
        <small class="muted" style="display:block;margin-top:8px">Verifying completion with ${esc(o.provider || 'the advertiser')}</small></div>`;
      requestAnimationFrame(() => { const b = $('#track-bar'); if (b) { b.style.transition = 'width 2s ease'; b.style.width = '100%'; } });
      await new Promise((r) => setTimeout(r, 2100));
      try {
        const r = await api(`/offers/${o.id}/complete`, { body: {} });
        setUser(r.user);
        o.user_status = r.status;
        if (r.status === 'completed') {
          box.innerHTML = `<div class="card center" style="background:rgba(34,211,122,.1);border-color:rgba(34,211,122,.35)">
            <div style="font-size:40px">🎉</div><h3>Offer completed!</h3><div class="green mt-8" style="font-size:24px">+${gem(r.reward)}</div></div>`;
          confetti(60);
          toast(`+${fmt(r.reward)} ${state.config.currency_name} credited!`, 'success');
        } else {
          box.innerHTML = `<div class="card center" style="background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.3)">
            <div style="font-size:40px">⏳</div><h3>Submitted for review</h3><p class="muted mt-8">${fmt(r.reward)} ${esc(state.config.currency_name)} will be credited once approved.</p></div>`;
          toast('Offer submitted — pending review.', 'info');
        }
        loadFeed();
        const card = $(`[data-offer="${o.id}"]`);
        if (card) card.outerHTML = offerCard(o);
        bindOffers([o]);
      } catch (err) {
        box.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
      }
    });
  }

  async function pageEarn() {
    const u = state.user;
    const c = state.config;
    page(`
      ${u ? `<div class="welcome-banner">
        <div><h2>Hey ${esc(u.username)} 👋</h2><p>Complete offers below to earn ${esc(c.currency_name)}. ${u.balance >= c.min_withdraw ? `You have <b>${usd(u.balance)}</b> ready to cash out!` : `You're <b>${fmt(c.min_withdraw - u.balance)}</b> ${esc(c.currency_name)} away from your next cashout.`}</p>
          <div class="progress mt-16" style="max-width:420px;background:rgba(0,0,0,.25)"><div style="width:${Math.min(100, (u.balance / c.min_withdraw) * 100)}%"></div></div></div>
        <a href="#/cashout" class="btn btn-lg" style="background:#fff;color:#2b1a8f">💸 Cash out</a>
        <div class="deco">💎</div></div>
      <div class="quick-grid">
        <div class="quick"><div class="q-ico" style="background:rgba(251,191,36,.18)">📅</div><div class="q-body"><b>Daily reward</b><small id="daily-sub">${dailyText()}</small></div>
          <button class="btn btn-sm ${canDaily() ? 'btn-green' : ''}" data-act="daily" ${canDaily() ? '' : 'disabled'}>${canDaily() ? `Claim ${fmt(c.daily_reward)}` : 'Claimed'}</button></div>
        <div class="quick"><div class="q-ico" style="background:rgba(124,92,255,.2)">🎟️</div><div class="q-body"><b>Promo code</b>
          <form id="promo-f" class="mt-8"><input class="input" name="code" placeholder="Enter code" maxlength="32"><button class="btn btn-primary btn-sm">Redeem</button></form></div></div>
        <div class="quick"><div class="q-ico" style="background:rgba(236,72,153,.18)">👥</div><div class="q-body"><b>Refer friends</b><small>Earn ${fmt(c.referral_percent)}% of their earnings</small></div><a href="#/referrals" class="btn btn-sm">Invite</a></div>
      </div>` : `<div class="welcome-banner">
        <div><h2>Earn rewards for playing games & taking surveys</h2><p>Sign up now and get ${fmt(c.signup_bonus)} ${esc(c.currency_name)} free. Cash out from ${usd(c.min_withdraw)}.</p></div>
        <button class="btn btn-lg" style="background:#fff;color:#2b1a8f" data-act="register">🎁 Sign up free</button><div class="deco">💎</div></div>`}

      <div class="section-title">🔥 Featured offers <span class="spacer"></span><a href="#/offers" class="muted" style="font-size:14px">View all →</a></div>
      <div class="offer-grid" id="featured">${'<div class="skel"></div>'.repeat(5)}</div>

      <div class="section-title">🧱 Offerwalls</div>
      <div class="wall-grid" id="walls">${'<div class="skel" style="min-height:180px"></div>'.repeat(6)}</div>

      <div class="section-title">📋 Quick tasks</div>
      <div class="offer-grid" id="quick-tasks">${'<div class="skel"></div>'.repeat(4)}</div>
    `);

    const pf = $('#promo-f');
    if (pf) pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = e.target.code.value.trim();
      if (!code) return;
      await withBusy($('button', e.target), async () => {
        try {
          const r = await api('/promo', { body: { code } });
          setUser(r.user);
          e.target.reset();
          toast(`Code redeemed! +${fmt(r.amount)} ${state.config.currency_name}`, 'success');
          confetti(40);
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    try {
      const [{ offers }, { offerwalls }] = await Promise.all([api('/offers'), api('/offerwalls')]);
      const featured = offers.filter((o) => o.featured);
      const quick = offers.filter((o) => o.est_minutes <= 15).sort((a, b) => a.est_minutes - b.est_minutes);
      $('#featured') && ($('#featured').innerHTML = featured.map(offerCard).join('') || emptyHTML('No featured offers right now.'));
      $('#quick-tasks') && ($('#quick-tasks').innerHTML = quick.slice(0, 10).map(offerCard).join('') || emptyHTML('No quick tasks right now.'));
      $('#walls') && ($('#walls').innerHTML = offerwalls.map(wallCard).join('') || emptyHTML('No offerwalls yet.'));
      bindOffers(offers);
    } catch (err) { toast(err.message, 'error'); }
  }

  function canDaily() {
    return state.user && Date.now() - (state.user.last_daily_at || 0) >= 86400000;
  }
  function dailyText() {
    if (canDaily()) return 'Ready to claim!';
    const ms = 86400000 - (Date.now() - state.user.last_daily_at);
    return `Next in ${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }

  actions.daily = async (e) => {
    if (!requireAuth()) return;
    const btn = e.target.closest('button');
    await withBusy(btn, async () => {
      try {
        const r = await api('/daily', { body: {} });
        setUser(r.user);
        toast(`Daily reward claimed! +${fmt(r.amount)} ${state.config.currency_name}`, 'success');
        confetti(40);
      } catch (err) { toast(err.message, 'error'); }
    });
    if (btn.isConnected && !canDaily()) {
      btn.disabled = true; btn.className = 'btn btn-sm'; btn.textContent = 'Claimed';
      $('#daily-sub').textContent = dailyText();
    }
  };

  function wallCard(w) {
    return `<a href="#/wall/${encodeURIComponent(w.slug)}" class="wall" style="--c:${safeColor(w.color)}">
      ${w.bonus_percent ? `<span class="bonus-tag">+${w.bonus_percent}%</span>` : ''}
      <div class="w-ico">${esc(w.icon)}</div><h4>${esc(w.name)}</h4><p>${esc(w.tagline)}</p>
      <div class="w-meta">${fmt(w.offer_count)} offers</div></a>`;
  }

  const emptyHTML = (msg, icon = '🔍') => `<div class="empty" style="grid-column:1/-1"><div class="e-ico">${icon}</div>${esc(msg)}</div>`;

  const CATEGORIES = [['all', '✨ All'], ['game', '🎮 Games'], ['app', '📱 Apps'], ['survey', '📋 Surveys'], ['signup', '✍️ Sign-ups'], ['shopping', '🛍️ Shopping'], ['video', '🎬 Videos']];

  async function pageOffers() {
    const cat = state.route[1] || 'all';
    page(`<div class="page-head"><div><h1>All offers</h1><p>Pick an offer, follow the steps, get paid.</p></div>
        <input class="input" id="offer-search" placeholder="🔎 Search offers…" style="max-width:280px"></div>
      <div class="chips">${CATEGORIES.map(([k, l]) => `<a href="#/offers/${k}" class="chip ${cat === k ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div class="row mt-16"><span class="muted" id="offer-count"></span><span class="spacer"></span>
        <select class="input" id="offer-sort" style="width:auto"><option value="reward">Highest reward</option><option value="time">Fastest</option><option value="popular">Most popular</option></select></div>
      <div class="offer-grid mt-16" id="offers">${'<div class="skel"></div>'.repeat(8)}</div>`);
    try {
      const { offers } = await api(`/offers?category=${encodeURIComponent(cat)}`);
      const draw = () => {
        const q = $('#offer-search').value.toLowerCase();
        const sort = $('#offer-sort').value;
        const list = offers.filter((o) => !q || o.title.toLowerCase().includes(q) || (o.provider || '').toLowerCase().includes(q));
        list.sort((a, b) => (sort === 'time' ? a.est_minutes - b.est_minutes : sort === 'popular' ? b.completions - a.completions : b.payout - a.payout));
        $('#offer-count').textContent = `${list.length} offer${list.length === 1 ? '' : 's'}`;
        $('#offers').innerHTML = list.map(offerCard).join('') || emptyHTML('No offers match your filters.');
        bindOffers(list);
      };
      $('#offer-search').addEventListener('input', draw);
      $('#offer-sort').addEventListener('change', draw);
      draw();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function pageWall() {
    const slug = state.route[1];
    page('<div class="skel" style="min-height:160px"></div>');
    try {
      const [{ offerwalls }, { offers }] = await Promise.all([api('/offerwalls'), api(`/offers?wall=${encodeURIComponent(slug)}`)]);
      const w = offerwalls.find((x) => x.slug === slug);
      if (!w) { $('#content').innerHTML = emptyHTML('That offerwall could not be found.'); return; }
      $('#content').innerHTML = `<a href="#/earn" class="muted">← Back to earn</a>
        <div class="welcome-banner mt-16" style="background:linear-gradient(120deg, ${safeColor(w.color)}, var(--surface-2))">
          <div class="row" style="gap:18px"><div class="w-ico" style="width:72px;height:72px;border-radius:20px;display:grid;place-items:center;font-size:38px;background:rgba(0,0,0,.2)">${esc(w.icon)}</div>
          <div><h2>${esc(w.name)}</h2><p>${esc(w.tagline)}</p></div></div>
          ${w.bonus_percent ? `<span class="badge" style="background:#fff;color:#14532d;font-size:14px;padding:8px 14px">🔥 +${w.bonus_percent}% bonus on all offers</span>` : ''}
          <div class="deco">${esc(w.icon)}</div></div>
        <div class="section-title">${fmt(offers.length)} available offers</div>
        <div class="offer-grid">${offers.map(offerCard).join('') || emptyHTML('No offers on this wall yet. Check back soon!')}</div>`;
      bindOffers(offers);
    } catch (err) { toast(err.message, 'error'); }
  }

  /* =============================================================== cashout */

  async function pageCashout() {
    const c = state.config;
    const u = state.user;
    page(`<div class="page-head"><div><h1>Cash out</h1><p>${fmt(c.coins_per_usd)} ${esc(c.currency_name)} = $1.00 · Minimum ${fmt(c.min_withdraw)} ${esc(c.currency_name)}</p></div></div>
      ${u ? `<div class="stat-grid">
        <div class="stat"><div class="s-ico" style="background:rgba(34,211,238,.15)">💎</div><div><div class="s-label">Balance</div><div class="s-val">${gem(u.balance)}</div></div></div>
        <div class="stat"><div class="s-ico" style="background:rgba(34,211,122,.15)">💵</div><div><div class="s-label">Worth</div><div class="s-val">${usd(u.balance)}</div></div></div>
        <div class="stat"><div class="s-ico" style="background:rgba(124,92,255,.2)">📈</div><div><div class="s-label">Total earned</div><div class="s-val">${gem(u.total_earned)}</div></div></div>
      </div>` : ''}
      <div id="methods"><div class="skel mt-24"></div></div>
      ${u ? '<div class="section-title">🧾 Your cashouts</div><div id="my-wd"></div>' : ''}`);
    try {
      const { methods } = await api('/reward-methods');
      const groups = [['cash', '💵 Cash'], ['crypto', '🪙 Crypto'], ['giftcard', '🎁 Gift cards'], ['gaming', '🎮 Gaming']];
      $('#methods').innerHTML = groups.map(([k, label]) => {
        const list = methods.filter((m) => m.category === k);
        if (!list.length) return '';
        return `<div class="section-title">${label}</div><div class="method-grid">${list.map((m) => {
          const min = Math.max(m.min_coins, c.min_withdraw);
          const locked = u && u.balance < min;
          return `<div class="method ${locked ? 'locked' : ''}" style="--c:${safeColor(m.color)}" data-method="${m.id}">
            <div class="m-ico">${esc(m.icon)}</div><b>${esc(m.name)}</b><small>Min ${usd(min)}</small>
            ${u ? `<div class="progress mt-8" style="height:6px"><div style="width:${Math.min(100, (u.balance / min) * 100)}%"></div></div>` : ''}</div>`;
        }).join('')}</div>`;
      }).join('') || emptyHTML('No reward methods available yet.');
      $$('[data-method]').forEach((el) => el.addEventListener('click', () => openWithdraw(methods.find((m) => String(m.id) === el.dataset.method))));
      if (u) loadMyWithdrawals();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function loadMyWithdrawals() {
    const { withdrawals } = await api('/me/history');
    const el = $('#my-wd');
    if (!el) return;
    el.innerHTML = withdrawals.length ? `<div class="table-wrap"><table><thead><tr><th>Method</th><th>Amount</th><th>Value</th><th>Status</th><th>Date</th></tr></thead><tbody>
      ${withdrawals.map((w) => `<tr><td><b>${esc(w.method_name)}</b></td><td>${gem(w.coins)}</td><td>$${w.usd.toFixed(2)}</td>
        <td><span class="status-badge status-${esc(w.status)}">${esc(w.status)}</span>${w.admin_note ? `<div class="faint" style="font-size:12px">${esc(w.admin_note)}</div>` : ''}</td><td class="muted">${dateTime(w.created_at)}</td></tr>`).join('')}
      </tbody></table></div>` : emptyHTML('No cashouts yet — your first one is closer than you think!', '💸');
  }

  function openWithdraw(m) {
    if (!m || !requireAuth()) return;
    const c = state.config;
    const u = state.user;
    const min = Math.max(m.min_coins, c.min_withdraw);
    const amounts = [...new Set([min, min * 2, min * 5, min * 10, min * 20, min * 50])];
    let chosen = amounts.find((a) => a <= u.balance) || null;
    openModal(`<div class="modal-body">
      <div class="modal-head"><div class="m-ico" style="width:64px;height:64px;border-radius:18px;margin:0 auto 12px;display:grid;place-items:center;font-size:32px;font-weight:800;background:${safeColor(m.color)}40">${esc(m.icon)}</div>
        <h2>${esc(m.name)}</h2><p>Balance: ${gem(u.balance)} (${usd(u.balance)})</p></div>
      <form id="wd-f">
        <div id="wd-err"></div>
        <label class="muted" style="font-size:13px">Choose an amount</label>
        <div class="amount-grid mt-8">${amounts.map((a) => `<div class="amount ${a > u.balance ? 'disabled' : ''} ${a === chosen ? 'active' : ''}" data-amt="${a}">${usd(a)}<small>${fmt(a)}</small></div>`).join('')}</div>
        <div class="field"><label>${esc(m.field_label)}</label><input class="input" name="destination" maxlength="200" required></div>
        <button class="btn btn-green btn-block btn-lg" type="submit" ${chosen ? '' : 'disabled'}>${chosen ? `Withdraw ${usd(chosen)}` : `Need ${fmt(min - u.balance)} more`}</button>
        <p class="demo-note">Cashouts are reviewed manually, usually within 24 hours.</p>
      </form></div>`);
    $$('.amount').forEach((el) => el.addEventListener('click', () => {
      if (el.classList.contains('disabled')) return;
      chosen = Number(el.dataset.amt);
      $$('.amount').forEach((x) => x.classList.toggle('active', x === el));
      const b = $('#wd-f button[type=submit]');
      b.disabled = false;
      b.textContent = `Withdraw ${usd(chosen)}`;
    }));
    $('#wd-f').addEventListener('submit', async (e) => {
      e.preventDefault();
      await withBusy($('button[type=submit]', e.target), async () => {
        try {
          const r = await api('/withdraw', { body: { method_id: m.id, coins: chosen, destination: e.target.destination.value } });
          setUser(r.user);
          closeModal();
          confetti();
          toast(`Cashout requested: ${usd(chosen)} via ${m.name}`, 'success');
          pageCashout();
        } catch (err) { $('#wd-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
      });
    });
  }

  /* =========================================================== leaderboard */

  async function pageLeaderboard() {
    const period = state.route[1] || 'weekly';
    page(`<div class="page-head"><div><h1>🏆 Leaderboard</h1><p>Top earners from offers and referrals.</p></div>
      <div class="tabs">${[['weekly', 'This week'], ['monthly', 'This month'], ['all', 'All time']].map(([k, l]) => `<a href="#/leaderboard/${k}" class="tab ${period === k ? 'active' : ''}">${l}</a>`).join('')}</div></div>
      <div id="lb"><div class="skel"></div></div>`);
    try {
      const { leaderboard } = await api(`/leaderboard?period=${period}`);
      if (!leaderboard.length) { $('#lb').innerHTML = emptyHTML('No earners yet for this period. Be the first!', '🏆'); return; }
      const [a, b, cc] = leaderboard;
      const pod = (p, cls, medal) => (p ? `<div class="pod ${cls}"><div class="medal">${medal}</div>${avatar(p.username, p.avatar_color, 'lg')}<b>${esc(p.username)}</b><div class="green mt-8">${gem(p.earned)}</div></div>` : '<div></div>');
      $('#lb').innerHTML = `<div class="podium">${pod(b, 'p2', '🥈')}${pod(a, 'p1', '🥇')}${pod(cc, 'p3', '🥉')}</div>
        ${leaderboard.length > 3 ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>User</th><th style="text-align:right">Earned</th></tr></thead><tbody>
        ${leaderboard.slice(3).map((p, i) => `<tr><td><span class="rank">${i + 4}</span></td><td><div class="row">${avatar(p.username, p.avatar_color)}<b>${esc(p.username)}</b></div></td><td style="text-align:right" class="green">${gem(p.earned)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ============================================================= referrals */

  async function pageReferrals() {
    const c = state.config;
    page('<div class="skel"></div>');
    try {
      const r = await api('/me/referrals');
      const link = `${location.origin}/?ref=${r.code}`;
      $('#content').innerHTML = `<div class="page-head"><div><h1>👥 Referrals</h1><p>Earn ${fmt(c.referral_percent)}% of every offer your friends complete — for life.</p></div></div>
        <div class="stat-grid">
          <div class="stat"><div class="s-ico" style="background:rgba(124,92,255,.2)">👥</div><div><div class="s-label">Referred users</div><div class="s-val">${fmt(r.referrals.length)}</div></div></div>
          <div class="stat"><div class="s-ico" style="background:rgba(34,211,122,.15)">💎</div><div><div class="s-label">Commission earned</div><div class="s-val">${gem(r.commission)}</div></div></div>
          <div class="stat"><div class="s-ico" style="background:rgba(251,191,36,.15)">📈</div><div><div class="s-label">Commission rate</div><div class="s-val">${fmt(c.referral_percent)}%</div></div></div>
        </div>
        <div class="card mt-24">
          <h3>Your referral link</h3><p class="muted" style="font-size:14px;margin-bottom:12px">Share it anywhere. Friends who sign up with your link or code <b>${esc(r.code)}</b> become your referrals.</p>
          <div class="copy-box"><input class="input" readonly value="${esc(link)}" id="ref-link"><button class="btn btn-primary" data-act="copy-ref">Copy</button></div>
        </div>
        <div class="section-title">Your referrals</div>
        ${r.referrals.length ? `<div class="table-wrap"><table><thead><tr><th>User</th><th>Joined</th><th style="text-align:right">They earned</th><th style="text-align:right">You earned</th></tr></thead><tbody>
          ${r.referrals.map((x) => `<tr><td><b>${esc(x.username)}</b></td><td class="muted">${date(x.created_at)}</td><td style="text-align:right">${gem(x.earned)}</td><td style="text-align:right" class="green">${gem(Math.floor((x.earned * c.referral_percent) / 100))}</td></tr>`).join('')}
          </tbody></table></div>` : emptyHTML('No referrals yet. Share your link to start earning!', '👥')}`;
    } catch (err) { toast(err.message, 'error'); }
  }

  actions['copy-ref'] = async () => {
    const input = $('#ref-link');
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    toast('Referral link copied!', 'success');
  };

  /* =============================================================== profile */

  async function pageProfile() {
    const u = state.user;
    const tab = state.route[1] || 'activity';
    page(`<div class="card row wrap" style="gap:18px">
        ${avatar(u.username, u.avatar_color, 'lg')}
        <div style="flex:1;min-width:200px"><h1 style="font-size:24px">${esc(u.username)} ${u.role === 'admin' ? '<span class="admin-badge">ADMIN</span>' : ''}</h1><p class="muted">${esc(u.email)} · Member since ${date(u.created_at)}</p></div>
        <div class="row" style="gap:28px"><div><div class="muted" style="font-size:13px">Balance</div><b style="font-size:20px">${gem(u.balance)}</b></div>
        <div><div class="muted" style="font-size:13px">Total earned</div><b style="font-size:20px">${gem(u.total_earned)}</b></div></div>
      </div>
      <div class="tabs mt-24">${[['activity', 'Activity'], ['offers', 'Offers'], ['cashouts', 'Cashouts'], ['settings', 'Settings']].map(([k, l]) => `<a href="#/profile/${k}" class="tab ${tab === k ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div class="mt-16" id="profile-tab"><div class="skel"></div></div>`);

    if (tab === 'settings') {
      $('#profile-tab').innerHTML = `<div class="card" style="max-width:520px"><h3>Change password</h3>
        <form id="pw-f" class="mt-16"><div id="pw-err"></div>
          <div class="field"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password"></div>
          <div class="field"><label>New password</label><input class="input" type="password" name="next" autocomplete="new-password"></div>
          <button class="btn btn-primary">Update password</button></form></div>`;
      $('#pw-f').addEventListener('submit', async (e) => {
        e.preventDefault();
        await withBusy($('button', e.target), async () => {
          try { await api('/me/password', { body: formData(e.target) }); e.target.reset(); $('#pw-err').innerHTML = ''; toast('Password updated.', 'success'); } catch (err) { $('#pw-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
        });
      });
      return;
    }
    try {
      const h = await api('/me/history');
      let html = '';
      if (tab === 'activity') {
        html = h.transactions.length ? `<div class="table-wrap"><table><thead><tr><th>Description</th><th>Type</th><th style="text-align:right">Amount</th><th>Date</th></tr></thead><tbody>
          ${h.transactions.map((t) => `<tr><td>${esc(t.description)}</td><td><span class="badge badge-gray">${esc(t.type)}</span></td><td style="text-align:right" class="${t.amount >= 0 ? 'green' : 'red'}">${t.amount >= 0 ? '+' : ''}${fmt(t.amount)}</td><td class="muted">${dateTime(t.created_at)}</td></tr>`).join('')}
          </tbody></table></div>` : emptyHTML('No activity yet.');
      } else if (tab === 'offers') {
        html = h.completions.length ? `<div class="table-wrap"><table><thead><tr><th>Offer</th><th>Provider</th><th>Reward</th><th>Status</th><th>Date</th></tr></thead><tbody>
          ${h.completions.map((c) => `<tr><td><b>${esc(c.offer_title)}</b></td><td class="muted">${esc(c.provider)}</td><td>${gem(c.reward)}</td><td><span class="status-badge status-${esc(c.status)}">${esc(c.status)}</span></td><td class="muted">${dateTime(c.created_at)}</td></tr>`).join('')}
          </tbody></table></div>` : emptyHTML('You haven\'t completed any offers yet.', '🎯');
      } else {
        html = h.withdrawals.length ? `<div class="table-wrap"><table><thead><tr><th>Method</th><th>Amount</th><th>Destination</th><th>Status</th><th>Date</th></tr></thead><tbody>
          ${h.withdrawals.map((w) => `<tr><td><b>${esc(w.method_name)}</b></td><td>${gem(w.coins)} <span class="faint">($${w.usd.toFixed(2)})</span></td><td class="muted">${esc(w.destination)}</td><td><span class="status-badge status-${esc(w.status)}">${esc(w.status)}</span></td><td class="muted">${dateTime(w.created_at)}</td></tr>`).join('')}
          </tbody></table></div>` : emptyHTML('No cashouts yet.', '💸');
      }
      $('#profile-tab').innerHTML = html;
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ================================================================= admin */

  const adminPages = {
    '': adminOverview,
    users: adminUsers,
    offers: adminOffers,
    walls: adminWalls,
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
    page('<div class="skel"></div>');
    fn().catch((err) => { toast(err.message, 'error'); });
  }

  const setContent = (html) => { const el = $('#content'); if (el) el.innerHTML = html; };
  const adminHead = (title, sub, right = '') => `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div>${right}</div>`;

  function barChart(data, green) {
    const max = Math.max(1, ...data.map((d) => d.n));
    return `<div class="bar-chart ${green ? 'green' : ''}">${data.map((d) => `<div class="bar"><div style="height:${(d.n / max) * 100}%" data-v="${fmt(d.n)}"></div><small>${new Date(d.day).getDate()}</small></div>`).join('')}</div>`;
  }

  async function adminOverview() {
    const o = await api('/admin/overview');
    const stat = (ico, bg, label, val, href) => `<a href="#/admin/${href}" class="stat"><div class="s-ico" style="background:${bg}">${ico}</div><div><div class="s-label">${label}</div><div class="s-val">${val}</div></div></a>`;
    setContent(`${adminHead('📊 Overview', 'Your site at a glance.')}
      <div class="stat-grid">
        ${stat('👥', 'rgba(124,92,255,.2)', 'Total users', `${fmt(o.users)} <small class="green" style="font-size:13px">+${fmt(o.users_today)} today</small>`, 'users')}
        ${stat('✅', 'rgba(34,211,122,.15)', 'Offers completed', fmt(o.offers_completed), 'completions')}
        ${stat('⏳', 'rgba(251,191,36,.15)', 'Pending completions', fmt(o.pending_completions), 'completions')}
        ${stat('💸', 'rgba(244,63,94,.15)', 'Pending cashouts', `${fmt(o.pending_withdrawals)} <small class="muted" style="font-size:13px">$${o.pending_withdrawals_usd.toFixed(2)}</small>`, 'withdrawals')}
        ${stat('💵', 'rgba(34,211,122,.15)', 'Total paid out', `$${o.paid_usd.toFixed(2)}`, 'withdrawals')}
        ${stat('💎', 'rgba(34,211,238,.15)', 'Outstanding balance', `${gem(o.total_balance)} <small class="muted" style="font-size:13px">${usd(o.total_balance)}</small>`, 'users')}
        ${stat('🎯', 'rgba(124,92,255,.2)', 'Active offers', fmt(o.active_offers), 'offers')}
      </div>
      <div class="admin-grid-2 mt-24">
        <div class="card"><h3>Signups — last 14 days</h3>${barChart(o.signups)}</div>
        <div class="card"><h3>Offer earnings (gems) — last 14 days</h3>${barChart(o.earnings, true)}</div>
      </div>
      <div class="section-title">Newest users</div>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Email</th><th>Balance</th><th>Joined</th></tr></thead><tbody>
        ${o.recent_users.map((u) => `<tr><td class="faint">#${u.id}</td><td><b>${esc(u.username)}</b></td><td class="muted">${esc(u.email)}</td><td>${gem(u.balance)}</td><td class="muted">${dateTime(u.created_at)}</td></tr>`).join('')}
      </tbody></table></div>`);
  }

  async function adminUsers() {
    setContent(`${adminHead('👥 Users', 'Search, adjust balances, ban and promote.')}
      <div class="toolbar"><input class="input" id="u-search" placeholder="🔎 Search by username, email or ID"></div><div id="u-table"></div>`);
    const load = async () => {
      const { users } = await api(`/admin/users?q=${encodeURIComponent($('#u-search').value)}`);
      $('#u-table').innerHTML = `<div class="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Balance</th><th>Earned</th><th>Refs</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td class="faint">#${u.id}</td>
          <td><b>${esc(u.username)}</b> ${u.role === 'admin' ? '<span class="admin-badge">ADMIN</span>' : ''} ${u.is_demo ? '<span class="badge badge-gray">demo</span>' : ''}<div class="faint" style="font-size:12px">${esc(u.email)}</div></td>
          <td>${gem(u.balance)}</td><td class="muted">${fmt(u.total_earned)}</td><td>${fmt(u.referrals)}</td>
          <td>${u.banned ? '<span class="badge badge-red">Banned</span>' : '<span class="badge badge-green">Active</span>'}</td>
          <td class="muted">${date(u.created_at)}</td>
          <td><button class="btn btn-sm" data-user="${u.id}">Manage</button></td></tr>`).join('') || `<tr><td colspan="8">${emptyHTML('No users found.')}</td></tr>`}
        </tbody></table></div>`;
      $$('[data-user]').forEach((b) => b.addEventListener('click', () => manageUser(Number(b.dataset.user), load)));
    };
    let t;
    $('#u-search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    await load();
  }

  async function manageUser(id, reload) {
    const { user: u, transactions, withdrawals } = await api(`/admin/users/${id}`);
    openModal(`<div class="modal-body">
      <div class="row" style="margin-bottom:18px">${avatar(u.username, '#7c5cff', 'lg')}<div><h2 style="font-size:22px">${esc(u.username)}</h2><div class="muted">${esc(u.email)} · #${u.id}</div>
        <div class="mt-8">${gem(u.balance)} <span class="faint">balance</span> · ${fmt(u.total_earned)} <span class="faint">earned</span></div></div></div>
      <div class="grid-2">
        <form id="bal-f" class="card" style="background:var(--bg-2)"><h3>Adjust balance</h3><p class="faint" style="font-size:13px;margin-bottom:10px">Use a negative number to deduct.</p>
          <div class="field"><input class="input" name="amount" type="number" placeholder="e.g. 500 or -500" required></div>
          <div class="field"><input class="input" name="reason" placeholder="Reason (optional)"></div>
          <button class="btn btn-primary btn-sm btn-block">Apply</button></form>
        <div class="card" style="background:var(--bg-2)"><h3>Account</h3>
          <div class="row mt-16"><span style="flex:1">Banned</span><label class="switch"><input type="checkbox" id="u-ban" ${u.banned ? 'checked' : ''}><span></span></label></div>
          <div class="row mt-16"><span style="flex:1">Admin</span><label class="switch"><input type="checkbox" id="u-admin" ${u.role === 'admin' ? 'checked' : ''}><span></span></label></div>
          <form id="upw-f" class="row mt-16"><input class="input" name="password" type="password" placeholder="Set new password" style="padding:8px 10px"><button class="btn btn-sm">Set</button></form>
          <button class="btn btn-danger btn-sm btn-block mt-16" id="u-del">Delete user</button>
        </div>
      </div>
      <h3 class="mt-24">Recent transactions</h3>
      <div class="table-wrap mt-8" style="max-height:220px;overflow:auto"><table><tbody>
        ${transactions.map((t) => `<tr><td>${esc(t.description)}</td><td class="${t.amount >= 0 ? 'green' : 'red'}" style="text-align:right">${t.amount >= 0 ? '+' : ''}${fmt(t.amount)}</td><td class="muted nowrap">${dateTime(t.created_at)}</td></tr>`).join('') || '<tr><td class="muted">None</td></tr>'}
      </tbody></table></div>
      ${withdrawals.length ? `<h3 class="mt-16">Cashouts</h3><div class="table-wrap mt-8"><table><tbody>${withdrawals.map((w) => `<tr><td>${esc(w.method_name)}</td><td>$${w.usd.toFixed(2)}</td><td><span class="status-badge status-${esc(w.status)}">${esc(w.status)}</span></td><td class="muted">${dateTime(w.created_at)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>`, { cls: 'wide', onClose: reload });

    const patch = async (body, msg) => {
      try { await api(`/admin/users/${id}`, { method: 'PATCH', body }); toast(msg, 'success'); } catch (err) { toast(err.message, 'error'); }
    };
    $('#bal-f').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/admin/users/${id}/balance`, { body: formData(e.target) });
        toast('Balance updated.', 'success');
        manageUser(id, reload);
        if (state.user.id === id) refreshMe();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#u-ban').addEventListener('change', (e) => patch({ banned: e.target.checked }, e.target.checked ? 'User banned.' : 'User unbanned.'));
    $('#u-admin').addEventListener('change', (e) => patch({ role: e.target.checked ? 'admin' : 'user' }, 'Role updated.'));
    $('#upw-f').addEventListener('submit', (e) => { e.preventDefault(); patch({ password: e.target.password.value }, 'Password updated.'); e.target.reset(); });
    $('#u-del').addEventListener('click', async () => {
      if (!(await confirmModal('Delete user?', `This permanently deletes ${u.username} and all their history.`, 'Delete', true))) return;
      try { await api(`/admin/users/${id}`, { method: 'DELETE' }); toast('User deleted.', 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
    });
  }

  async function adminOffers() {
    const [{ offers }, { offerwalls }] = await Promise.all([api('/admin/offers'), api('/admin/offerwalls')]);
    setContent(`${adminHead('🎯 Offers', 'Create and manage the (demo) offers shown to users.', '<button class="btn btn-primary" id="new-offer">+ New offer</button>')}
      <div class="table-wrap"><table><thead><tr><th></th><th>Offer</th><th>Wall</th><th>Category</th><th>Reward</th><th>Completions</th><th>Flags</th><th></th></tr></thead><tbody>
      ${offers.map((o) => `<tr><td style="font-size:26px">${esc(o.icon)}</td><td><b>${esc(o.title)}</b><div class="faint" style="font-size:12px">${esc(o.device)} · ${duration(o.est_minutes)}</div></td>
        <td class="muted">${esc(o.provider || '—')}</td><td><span class="badge badge-gray">${esc(o.category)}</span></td><td>${gem(o.reward)}</td><td>${fmt(o.completions)}</td>
        <td>${o.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Hidden</span>'} ${o.featured ? '<span class="badge badge-yellow">Featured</span>' : ''} ${o.repeatable ? '<span class="badge badge-purple">Repeatable</span>' : ''}</td>
        <td><div class="row"><button class="btn btn-sm" data-edit="${o.id}">Edit</button><button class="btn btn-sm btn-danger" data-del="${o.id}">✕</button></div></td></tr>`).join('') || `<tr><td colspan="8">${emptyHTML('No offers yet.')}</td></tr>`}
      </tbody></table></div>`);
    $('#new-offer').addEventListener('click', () => offerForm(null, offerwalls));
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => offerForm(offers.find((o) => String(o.id) === b.dataset.edit), offerwalls)));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete offer?', 'Past completions are kept.', 'Delete', true))) return;
      await api(`/admin/offers/${b.dataset.del}`, { method: 'DELETE' });
      toast('Offer deleted.', 'success');
      adminOffers();
    }));
  }

  function offerForm(o, walls) {
    o = o || { title: '', description: '', requirements: '', offerwall_id: walls[0] ? walls[0].id : '', category: 'game', reward: 1000, icon: '🎮', color: '#7c5cff', device: 'all', est_minutes: 10, url: '', featured: 0, repeatable: 0, active: 1 };
    const opt = (list, val) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('');
    openModal(`<div class="modal-body"><div class="modal-head"><h2>${o.id ? 'Edit offer' : 'New offer'}</h2></div>
      <form id="of-f"><div id="of-err"></div>
        <div class="field"><label>Title</label><input class="input" name="title" value="${esc(o.title)}" required></div>
        <div class="field"><label>Description</label><textarea class="input" name="description">${esc(o.description)}</textarea></div>
        <div class="field"><label>Requirements</label><textarea class="input" name="requirements">${esc(o.requirements)}</textarea></div>
        <div class="grid-2">
          <div class="field"><label>Offerwall</label><select class="input" name="offerwall_id"><option value="">— None —</option>${opt(walls.map((w) => [w.id, w.name]), o.offerwall_id)}</select></div>
          <div class="field"><label>Category</label><select class="input" name="category">${opt(CATEGORIES.slice(1).map(([k, l]) => [k, l]), o.category)}</select></div>
          <div class="field"><label>Reward (gems)</label><input class="input" type="number" min="1" name="reward" value="${esc(o.reward)}"></div>
          <div class="field"><label>Est. minutes</label><input class="input" type="number" min="1" name="est_minutes" value="${esc(o.est_minutes)}"></div>
          <div class="field"><label>Device</label><select class="input" name="device">${opt([['all', 'All'], ['android', 'Android'], ['ios', 'iOS'], ['desktop', 'Desktop']], o.device)}</select></div>
          <div class="field"><label>Icon (emoji)</label><input class="input" name="icon" value="${esc(o.icon)}" maxlength="8"></div>
          <div class="field"><label>Color</label><div class="color-input"><input type="color" name="color" value="${safeColor(o.color)}"></div></div>
          <div class="field"><label>Tracking URL (optional)</label><input class="input" name="url" value="${esc(o.url)}" placeholder="https://"></div>
        </div>
        <div class="row wrap" style="gap:22px;margin:6px 0 18px">
          <label class="check"><input type="checkbox" name="active" ${o.active ? 'checked' : ''}> Active</label>
          <label class="check"><input type="checkbox" name="featured" ${o.featured ? 'checked' : ''}> Featured</label>
          <label class="check"><input type="checkbox" name="repeatable" ${o.repeatable ? 'checked' : ''}> Repeatable</label>
        </div>
        <button class="btn btn-primary btn-block">${o.id ? 'Save changes' : 'Create offer'}</button></form></div>`, { cls: 'wide' });
    $('#of-f').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(o.id ? `/admin/offers/${o.id}` : '/admin/offers', { method: o.id ? 'PUT' : 'POST', body: formData(e.target) });
        closeModal();
        toast('Offer saved.', 'success');
        adminOffers();
      } catch (err) { $('#of-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
    });
  }

  async function adminWalls() {
    const { offerwalls } = await api('/admin/offerwalls');
    setContent(`${adminHead('🧱 Offerwalls', 'Group offers into branded offerwalls with optional bonuses.', '<button class="btn btn-primary" id="new-wall">+ New offerwall</button>')}
      <div class="table-wrap"><table><thead><tr><th></th><th>Name</th><th>Slug</th><th>Bonus</th><th>Sort</th><th>Status</th><th></th></tr></thead><tbody>
      ${offerwalls.map((w) => `<tr><td style="font-size:24px">${esc(w.icon)}</td><td><b>${esc(w.name)}</b><div class="faint" style="font-size:12px">${esc(w.tagline)}</div></td><td class="muted">${esc(w.slug)}</td>
        <td>${w.bonus_percent ? `<span class="badge badge-green">+${w.bonus_percent}%</span>` : '—'}</td><td>${w.sort}</td>
        <td>${w.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Hidden</span>'}</td>
        <td><div class="row"><button class="btn btn-sm" data-edit="${w.id}">Edit</button><button class="btn btn-sm btn-danger" data-del="${w.id}">✕</button></div></td></tr>`).join('') || `<tr><td colspan="7">${emptyHTML('No offerwalls yet.')}</td></tr>`}
      </tbody></table></div>`);
    const form = (w) => {
      w = w || { name: '', slug: '', tagline: '', color: '#7c5cff', icon: '💎', bonus_percent: 0, active: 1, sort: offerwalls.length };
      openModal(`<div class="modal-body"><div class="modal-head"><h2>${w.id ? 'Edit offerwall' : 'New offerwall'}</h2></div>
        <form id="w-f"><div id="w-err"></div><div class="grid-2">
          <div class="field"><label>Name</label><input class="input" name="name" value="${esc(w.name)}" required></div>
          <div class="field"><label>Slug</label><input class="input" name="slug" value="${esc(w.slug)}" placeholder="auto"></div>
          <div class="field"><label>Icon</label><input class="input" name="icon" value="${esc(w.icon)}" maxlength="8"></div>
          <div class="field"><label>Color</label><div class="color-input"><input type="color" name="color" value="${safeColor(w.color)}"></div></div>
          <div class="field"><label>Bonus %</label><input class="input" type="number" min="0" name="bonus_percent" value="${esc(w.bonus_percent)}"></div>
          <div class="field"><label>Sort order</label><input class="input" type="number" name="sort" value="${esc(w.sort)}"></div></div>
          <div class="field"><label>Tagline</label><input class="input" name="tagline" value="${esc(w.tagline)}"></div>
          <label class="check" style="margin-bottom:16px"><input type="checkbox" name="active" ${w.active ? 'checked' : ''}> Active</label>
          <button class="btn btn-primary btn-block">Save</button></form></div>`);
      $('#w-f').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(w.id ? `/admin/offerwalls/${w.id}` : '/admin/offerwalls', { method: w.id ? 'PUT' : 'POST', body: formData(e.target) });
          closeModal(); toast('Offerwall saved.', 'success'); adminWalls();
        } catch (err) { $('#w-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
      });
    };
    $('#new-wall').addEventListener('click', () => form());
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => form(offerwalls.find((w) => String(w.id) === b.dataset.edit))));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete offerwall?', 'Its offers will be kept but unassigned.', 'Delete', true))) return;
      await api(`/admin/offerwalls/${b.dataset.del}`, { method: 'DELETE' });
      toast('Offerwall deleted.', 'success'); adminWalls();
    }));
  }

  function statusTabs(base, current, list) {
    return `<div class="tabs" style="margin-bottom:16px">${list.map(([k, l]) => `<a href="#/admin/${base}${k ? `/${k}` : ''}" class="tab ${current === k ? 'active' : ''}">${l}</a>`).join('')}</div>`;
  }

  async function adminCompletions() {
    const status = state.route[2] || 'pending';
    const { completions } = await api(`/admin/completions?status=${status === 'all' ? '' : status}`);
    setContent(`${adminHead('✅ Offer completions', 'Approve or reject offer completions. Rejecting a completed one reverses the payout.')}
      ${statusTabs('completions', status, [['pending', 'Pending'], ['completed', 'Completed'], ['rejected', 'Rejected'], ['all', 'All']])}
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Offer</th><th>Reward</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>
      ${completions.map((c) => `<tr><td class="faint">#${c.id}</td><td><b>${esc(c.username)}</b></td><td>${esc(c.offer_title)}<div class="faint" style="font-size:12px">${esc(c.provider)}${c.txid ? ` · tx ${esc(c.txid)}` : ''}</div></td>
        <td>${gem(c.reward)}</td><td><span class="status-badge status-${esc(c.status)}">${esc(c.status)}</span></td><td class="muted">${dateTime(c.created_at)}</td>
        <td><div class="row">${c.status === 'pending' ? `<button class="btn btn-sm btn-green" data-ok="${c.id}">Approve</button>` : ''}${c.status !== 'rejected' ? `<button class="btn btn-sm btn-danger" data-no="${c.id}">${c.status === 'completed' ? 'Reverse' : 'Reject'}</button>` : ''}</div></td></tr>`).join('') || `<tr><td colspan="7">${emptyHTML('Nothing here.', '✅')}</td></tr>`}
      </tbody></table></div>`);
    $$('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/admin/completions/${b.dataset.ok}/approve`, { body: {} }); toast('Approved & credited.', 'success'); adminCompletions(); } catch (err) { toast(err.message, 'error'); }
    }));
    $$('[data-no]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('Reject completion?', 'If it was already credited, the reward is deducted from the user.', 'Reject', true))) return;
      try { await api(`/admin/completions/${b.dataset.no}/reject`, { body: {} }); toast('Rejected.', 'success'); adminCompletions(); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  async function adminWithdrawals() {
    const status = state.route[2] || 'pending';
    const { withdrawals } = await api(`/admin/withdrawals?status=${status === 'all' ? '' : status}`);
    setContent(`${adminHead('💸 Withdrawals', 'Send the reward yourself, then mark it paid. Rejecting refunds the user.')}
      ${statusTabs('withdrawals', status, [['pending', 'Pending'], ['paid', 'Paid'], ['rejected', 'Rejected'], ['all', 'All']])}
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Method</th><th>Amount</th><th>Destination</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>
      ${withdrawals.map((w) => `<tr><td class="faint">#${w.id}</td><td><b>${esc(w.username)}</b><div class="faint" style="font-size:12px">${esc(w.email)}</div></td><td>${esc(w.method_name)}</td>
        <td><b>$${w.usd.toFixed(2)}</b><div class="faint" style="font-size:12px">${fmt(w.coins)} gems</div></td><td><span class="code" style="padding:4px 8px">${esc(w.destination)}</span></td>
        <td><span class="status-badge status-${esc(w.status)}">${esc(w.status)}</span>${w.admin_note ? `<div class="faint" style="font-size:12px">${esc(w.admin_note)}</div>` : ''}</td><td class="muted">${dateTime(w.created_at)}</td>
        <td>${w.status === 'pending' ? `<div class="row"><button class="btn btn-sm btn-green" data-pay="${w.id}">Mark paid</button><button class="btn btn-sm btn-danger" data-rej="${w.id}">Reject</button></div>` : ''}</td></tr>`).join('') || `<tr><td colspan="8">${emptyHTML('Nothing here.', '💸')}</td></tr>`}
      </tbody></table></div>`);
    const act = (id, action) => {
      openModal(`<div class="modal-body"><div class="modal-head"><h2>${action === 'pay' ? 'Mark as paid' : 'Reject cashout'}</h2><p>${action === 'pay' ? 'Confirm you have sent the reward.' : 'The gems will be refunded to the user.'}</p></div>
        <form id="wa-f"><div class="field"><label>Note to user (optional)</label><input class="input" name="note" maxlength="300" placeholder="${action === 'pay' ? 'e.g. Transaction ID' : 'e.g. Reason for rejection'}"></div>
        <button class="btn ${action === 'pay' ? 'btn-green' : 'btn-danger'} btn-block">${action === 'pay' ? 'Mark paid' : 'Reject & refund'}</button></form></div>`);
      $('#wa-f').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api(`/admin/withdrawals/${id}/${action}`, { body: formData(e.target) }); closeModal(); toast('Withdrawal updated.', 'success'); adminWithdrawals(); } catch (err) { toast(err.message, 'error'); }
      });
    };
    $$('[data-pay]').forEach((b) => b.addEventListener('click', () => act(b.dataset.pay, 'pay')));
    $$('[data-rej]').forEach((b) => b.addEventListener('click', () => act(b.dataset.rej, 'reject')));
  }

  async function adminMethods() {
    const { methods } = await api('/admin/reward-methods');
    setContent(`${adminHead('🎁 Reward methods', 'Cashout options users can choose from.', '<button class="btn btn-primary" id="new-m">+ New method</button>')}
      <div class="table-wrap"><table><thead><tr><th></th><th>Name</th><th>Category</th><th>Minimum</th><th>Field</th><th>Status</th><th></th></tr></thead><tbody>
      ${methods.map((m) => `<tr><td style="font-size:22px">${esc(m.icon)}</td><td><b>${esc(m.name)}</b></td><td><span class="badge badge-gray">${esc(m.category)}</span></td><td>${gem(m.min_coins)} <span class="faint">${usd(m.min_coins)}</span></td><td class="muted">${esc(m.field_label)}</td>
        <td>${m.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Hidden</span>'}</td>
        <td><div class="row"><button class="btn btn-sm" data-edit="${m.id}">Edit</button><button class="btn btn-sm btn-danger" data-del="${m.id}">✕</button></div></td></tr>`).join('') || `<tr><td colspan="7">${emptyHTML('No methods yet.')}</td></tr>`}
      </tbody></table></div>`);
    const form = (m) => {
      m = m || { name: '', category: 'cash', icon: '💵', color: '#22c55e', field_label: 'Email', min_coins: 1000, active: 1, sort: methods.length };
      const cats = [['cash', 'Cash'], ['crypto', 'Crypto'], ['giftcard', 'Gift card'], ['gaming', 'Gaming']];
      openModal(`<div class="modal-body"><div class="modal-head"><h2>${m.id ? 'Edit method' : 'New method'}</h2></div>
        <form id="m-f"><div id="m-err"></div><div class="grid-2">
          <div class="field"><label>Name</label><input class="input" name="name" value="${esc(m.name)}" required></div>
          <div class="field"><label>Category</label><select class="input" name="category">${cats.map(([k, l]) => `<option value="${k}" ${m.category === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Icon</label><input class="input" name="icon" value="${esc(m.icon)}" maxlength="8"></div>
          <div class="field"><label>Color</label><div class="color-input"><input type="color" name="color" value="${safeColor(m.color)}"></div></div>
          <div class="field"><label>Minimum (gems)</label><input class="input" type="number" min="1" name="min_coins" value="${esc(m.min_coins)}"></div>
          <div class="field"><label>Destination label</label><input class="input" name="field_label" value="${esc(m.field_label)}"></div>
          <div class="field"><label>Sort order</label><input class="input" type="number" name="sort" value="${esc(m.sort)}"></div></div>
          <label class="check" style="margin-bottom:16px"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> Active</label>
          <button class="btn btn-primary btn-block">Save</button></form></div>`);
      $('#m-f').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(m.id ? `/admin/reward-methods/${m.id}` : '/admin/reward-methods', { method: m.id ? 'PUT' : 'POST', body: formData(e.target) });
          closeModal(); toast('Method saved.', 'success'); adminMethods();
        } catch (err) { $('#m-err').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
      });
    };
    $('#new-m').addEventListener('click', () => form());
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => form(methods.find((m) => String(m.id) === b.dataset.edit))));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete method?', 'Existing cashout records are kept.', 'Delete', true))) return;
      await api(`/admin/reward-methods/${b.dataset.del}`, { method: 'DELETE' });
      toast('Method deleted.', 'success'); adminMethods();
    }));
  }

  async function adminPromos() {
    const { promos } = await api('/admin/promos');
    setContent(`${adminHead('🎟️ Promo codes', 'Give out bonus gems with redeemable codes.')}
      <form id="p-f" class="card row wrap" style="align-items:flex-end;margin-bottom:18px">
        <div class="field" style="margin:0;flex:1;min-width:140px"><label>Code</label><input class="input" name="code" placeholder="SUMMER25" required></div>
        <div class="field" style="margin:0;width:130px"><label>Reward (gems)</label><input class="input" type="number" name="reward" min="1" value="100"></div>
        <div class="field" style="margin:0;width:130px"><label>Max uses (0=∞)</label><input class="input" type="number" name="max_uses" min="0" value="0"></div>
        <div class="field" style="margin:0;width:140px"><label>Expires in days</label><input class="input" type="number" name="expires_days" min="0" value="0"></div>
        <button class="btn btn-primary">Create code</button></form>
      <div class="table-wrap"><table><thead><tr><th>Code</th><th>Reward</th><th>Uses</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>
      ${promos.map((p) => `<tr><td><span class="code" style="padding:4px 8px">${esc(p.code)}</span></td><td>${gem(p.reward)}</td><td>${fmt(p.uses)}${p.max_uses ? ` / ${fmt(p.max_uses)}` : ''}</td>
        <td class="muted">${p.expires_at ? dateTime(p.expires_at) : 'Never'}</td>
        <td><label class="switch"><input type="checkbox" data-toggle="${esc(p.code)}" ${p.active ? 'checked' : ''}><span></span></label></td>
        <td><button class="btn btn-sm btn-danger" data-del="${esc(p.code)}">✕</button></td></tr>`).join('') || `<tr><td colspan="6">${emptyHTML('No promo codes yet.')}</td></tr>`}
      </tbody></table></div>`);
    $('#p-f').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/admin/promos', { body: formData(e.target) }); toast('Promo code created.', 'success'); adminPromos(); } catch (err) { toast(err.message, 'error'); }
    });
    $$('[data-toggle]').forEach((el) => el.addEventListener('change', () => api(`/admin/promos/${encodeURIComponent(el.dataset.toggle)}`, { method: 'PATCH', body: { active: el.checked } }).then(() => toast('Updated.', 'success'))));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete code?', b.dataset.del, 'Delete', true))) return;
      await api(`/admin/promos/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
      toast('Deleted.', 'success'); adminPromos();
    }));
  }

  async function adminTransactions() {
    const { transactions } = await api('/admin/transactions');
    setContent(`${adminHead('📜 Transactions', 'The latest 300 balance changes across all users.')}
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Type</th><th>Description</th><th style="text-align:right">Amount</th><th>Date</th></tr></thead><tbody>
      ${transactions.map((t) => `<tr><td class="faint">#${t.id}</td><td><b>${esc(t.username)}</b></td><td><span class="badge badge-gray">${esc(t.type)}</span></td><td>${esc(t.description)}</td>
        <td style="text-align:right" class="${t.amount >= 0 ? 'green' : 'red'}">${t.amount >= 0 ? '+' : ''}${fmt(t.amount)}</td><td class="muted">${dateTime(t.created_at)}</td></tr>`).join('') || `<tr><td colspan="6">${emptyHTML('No transactions yet.')}</td></tr>`}
      </tbody></table></div>`);
  }

  async function adminSettings() {
    const { settings: s } = await api('/admin/settings');
    const row = (key, label, help, type = 'number') => `<div class="setting-row"><div class="s-info"><b>${label}</b><small>${help}</small></div>
      <input class="input" name="${key}" type="${type}" value="${esc(s[key])}" ${type === 'number' ? 'min="0"' : ''}></div>`;
    const toggle = (key, label, help) => `<div class="setting-row"><div class="s-info"><b>${label}</b><small>${help}</small></div>
      <label class="switch"><input type="checkbox" name="${key}" ${s[key] === '1' ? 'checked' : ''}><span></span></label></div>`;
    const postback = `${location.origin}/api/postback?secret=${encodeURIComponent(s.postback_secret)}&user_id={USER_ID}&offer_id={OFFER_ID}&title={OFFER_NAME}&reward={REWARD}&txid={TRANSACTION_ID}&provider=NetworkName&status={STATUS}`;
    setContent(`${adminHead('⚙️ Settings', 'Configure your site.')}
      <form id="s-f">
        <div class="card"><h3>General</h3>
          ${row('site_name', 'Site name', 'Shown in the header and emails.', 'text')}
          ${row('currency_name', 'Currency name', 'What you call your points (e.g. Gems, Coins).', 'text')}
          ${row('announcement', 'Announcement bar', 'Shown at the top of every page. Leave empty to hide.', 'text')}
          ${toggle('maintenance', 'Maintenance mode', 'Blocks everyone except admins from using the site.')}
        </div>
        <div class="card mt-16"><h3>Economy</h3>
          ${row('coins_per_usd', 'Gems per $1.00', 'Exchange rate used for cashouts.')}
          ${row('signup_bonus', 'Sign-up bonus', 'Gems credited when a new account is created.')}
          ${row('daily_reward', 'Daily reward', 'Gems users can claim every 24 hours.')}
          ${row('referral_percent', 'Referral commission %', 'Share of a referral\'s offer earnings paid to the referrer.')}
          ${row('min_withdraw', 'Minimum cashout', 'Global minimum, in gems.')}
          ${toggle('auto_approve_offers', 'Auto-approve demo offers', 'If off, demo offer completions wait for admin approval.')}
        </div>
        <div class="card mt-16"><h3>Offerwall postback</h3>
          <p class="muted" style="font-size:14px;margin:6px 0 12px">Point real offerwall networks at this URL to credit users automatically. Replace the {PLACEHOLDERS} with your network's macros. <b>status=2</b> reverses a payout (chargeback).</p>
          <div class="code">${esc(postback)}</div>
          ${row('postback_secret', 'Postback secret', 'Keep this private. At least 12 characters.', 'text')}
        </div>
        <button class="btn btn-primary btn-lg mt-16">Save settings</button>
      </form>`);
    $('#s-f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      body.maintenance = body.maintenance ? 1 : 0;
      body.auto_approve_offers = body.auto_approve_offers ? 1 : 0;
      try {
        await api('/admin/settings', { method: 'PUT', body });
        toast('Settings saved.', 'success');
        await loadConfig();
        render();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  /* ================================================================== boot */

  async function loadConfig() {
    state.config = await api('/config');
    state.user = state.config.user;
    document.title = `${state.config.site_name} — Get paid to play games, take surveys and try apps`;
  }

  async function refreshMe() {
    try { setUser((await api('/me')).user); } catch { /* ignore */ }
  }

  function startApp(path) {
    if (path) go(path); else render();
  }

  document.addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-act]');
    if (actEl && actions[actEl.dataset.act]) {
      actions[actEl.dataset.act](e);
    }
    if (e.target.matches('[data-overlay]')) closeModal();
    const dd = $('.dropdown');
    if (dd && !e.target.closest('.dropdown') && !e.target.closest('[data-act="user-menu"]')) dd.remove();
    if (dd && e.target.closest('.dropdown a')) dd.remove();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  window.addEventListener('hashchange', () => { closeModal(); render(); });

  (async () => {
    const ref = new URLSearchParams(location.search).get('ref');
    if (ref) {
      try { localStorage.setItem('ref', ref.toUpperCase()); } catch { /* ignore */ }
      history.replaceState(null, '', `/${location.hash}`);
    }
    try {
      await loadConfig();
    } catch {
      $('#app').innerHTML = '<div class="boot"><div class="center"><div style="font-size:48px">🛠️</div><h2>Can\'t reach the server</h2><p class="muted">Please refresh in a moment.</p></div></div>';
      return;
    }
    render();
    if (ref && !state.user) openAuth('register');
    if (state.user && !state.user.onboarded) setTimeout(openWelcome, 400);
    loadFeed();
    setInterval(loadFeed, 20000);
    setInterval(() => { if (state.user && !document.hidden) refreshMe(); }, 30000);
  })();
})();
