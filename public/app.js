// === State ===
let prevFoodPrice = null;
let prevEnergyPrice = null;
let creditsChart = null;
let priceChart = null;
let actionChart = null;
let connectedWallet = null;
/** @type {object | null} EIP-1193 provider from EIP-6963 or window.ethereum */
let activeEip1193Provider = null;
let walletLabel = '';
let accountsChangedHandler = null;
let marketOutcomes = [];
let cachedMarkets = [];
let cachedPositions = [];
let marketConfig = null;
let tradeLocked = false;
let quoteLocked = false;
/** @type {'buy'|'sell'} */
let betMode = 'buy';
let quoteDebounce = null;
function getEthers() {
  if (typeof ethers !== 'undefined') return ethers;
  if (typeof window !== 'undefined' && window.ethers) return window.ethers;
  throw new Error('ethers failed to load');
}
const priceHistory = { labels: [], food: [], energy: [] };
const MAX_PRICE_POINTS = 30;

/** EIP-1193 provider selected by user (EIP-6963 or window.ethereum). */
function getEip1193Provider() {
  return activeEip1193Provider || window.ethereum || null;
}

function providerDisplayName(p) {
  if (!p) return 'Wallet';
  if (p.isMetaMask && !p.isBraveWallet) return 'MetaMask';
  if (p.isRabby) return 'Rabby';
  if (p.isCoinbaseWallet) return 'Coinbase Wallet';
  if (p.isBraveWallet) return 'Brave Wallet';
  if (p.isTrust) return 'Trust Wallet';
  return 'Browser wallet';
}

function collectEip6963Providers() {
  return new Promise((resolve) => {
    const announced = new Map();
    function onAnnounce(event) {
      try {
        const { info, provider } = event.detail;
        if (info?.uuid && provider?.request) announced.set(info.uuid, { info, provider });
      } catch (_) {}
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      resolve([...announced.values()]);
    }, 180);
  });
}

async function collectWalletOptions() {
  const eip6963 = await collectEip6963Providers();
  if (eip6963.length > 0) {
    return eip6963.map(({ info, provider }) => ({
      id: info.uuid,
      name: info.name || 'Wallet',
      icon: info.icon || null,
      provider,
    }));
  }
  const eth = window.ethereum;
  if (!eth) return [];
  if (eth.providers && eth.providers.length > 1) {
    return eth.providers.map((p, i) => ({
      id: `legacy-${i}`,
      name: providerDisplayName(p),
      icon: null,
      provider: p,
    }));
  }
  return [{ id: 'default', name: providerDisplayName(eth), icon: null, provider: eth }];
}

function closeWalletModal() {
  const modal = document.getElementById('wallet-modal');
  if (modal) modal.hidden = true;
}

function openWalletModal(options) {
  const modal = document.getElementById('wallet-modal');
  const list = document.getElementById('wallet-list');
  if (!modal || !list) return;
  list.innerHTML = '';
  options.forEach((opt) => {
    const li = document.createElement('li');
    li.className = 'wallet-list-item';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wallet-list-btn';
    const label = document.createElement('span');
    label.className = 'wallet-list-label';
    label.textContent = opt.name;
    if (opt.icon) {
      const img = document.createElement('img');
      img.className = 'wallet-list-icon';
      img.src = opt.icon;
      img.alt = '';
      img.width = 28;
      img.height = 28;
      btn.appendChild(img);
    }
    btn.appendChild(label);
    btn.addEventListener('click', async () => {
      closeWalletModal();
      try {
        await connectWithProvider(opt.provider, opt.name);
      } catch (e) {
        console.error(e);
        alert(e?.message || String(e));
      }
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
  modal.hidden = false;
}

function teardownAccountsListener() {
  if (activeEip1193Provider && accountsChangedHandler) {
    try {
      activeEip1193Provider.removeListener('accountsChanged', accountsChangedHandler);
    } catch (_) {}
  }
  accountsChangedHandler = null;
}

function onAccountsChanged(accounts) {
  if (!accounts || accounts.length === 0) {
    disconnectWallet();
    return;
  }
  const next = String(accounts[0]).toLowerCase();
  if (next !== connectedWallet) {
    connectedWallet = next;
    updateWalletChrome();
    loadPositions();
  }
}

function setupAccountsListener(provider) {
  teardownAccountsListener();
  if (!provider?.on) return;
  accountsChangedHandler = onAccountsChanged;
  provider.on('accountsChanged', accountsChangedHandler);
}

function updateWalletChrome() {
  const badge = document.getElementById('wallet-badge');
  const btnConnect = document.getElementById('btn-connect-wallet');
  const connectedRow = document.getElementById('wallet-connected');
  const addrEl = document.getElementById('wallet-connected-addr');
  if (connectedWallet) {
    const short = `${connectedWallet.slice(0, 6)}…${connectedWallet.slice(-4)}`;
    if (badge) {
      badge.textContent = walletLabel ? `${walletLabel} · ${short}` : short;
    }
    if (addrEl) {
      addrEl.textContent = short;
      addrEl.title = connectedWallet;
    }
    if (btnConnect) btnConnect.hidden = true;
    if (connectedRow) connectedRow.hidden = false;
  } else {
    if (badge) badge.textContent = 'Wallet disconnected';
    if (btnConnect) btnConnect.hidden = false;
    if (connectedRow) connectedRow.hidden = true;
  }
}

async function connectWithProvider(provider, name) {
  if (!provider?.request) throw new Error('Invalid wallet provider');
  await loadMarketConfig();
  teardownAccountsListener();
  activeEip1193Provider = provider;
  walletLabel = name || providerDisplayName(provider);

  const [addr] = await provider.request({ method: 'eth_requestAccounts' });
  const challengeRes = await api('/wallet/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: addr }),
  });
  const signature = await provider.request({
    method: 'personal_sign',
    params: [challengeRes.challenge.message, addr],
  });
  await api('/wallet/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: addr, signature }),
  });
  connectedWallet = addr.toLowerCase();
  setupAccountsListener(provider);
  updateWalletChrome();
  await loadPositions();
}

async function openWalletChooser() {
  const options = await collectWalletOptions();
  if (options.length === 0) {
    alert('No EVM wallet detected. Install MetaMask, Rabby, Coinbase Wallet, or another browser extension.');
    return;
  }
  if (options.length === 1) {
    await connectWithProvider(options[0].provider, options[0].name);
    return;
  }
  openWalletModal(options);
}

function disconnectWallet() {
  teardownAccountsListener();
  connectedWallet = null;
  activeEip1193Provider = null;
  walletLabel = '';
  updateWalletChrome();
  const tbody = document.getElementById('positions-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="positions-empty">Connect wallet to view positions</td></tr>';
  cachedPositions = [];
}

// Chart.js - dark dashboard defaults
Chart.defaults.color = '#9aa4b2';
Chart.defaults.borderColor = '#252b34';
Chart.defaults.font.family = "'DM Sans', sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.font.weight = '500';

// === API ===
const api = (path, opts) =>
  fetch(path, opts).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: j.error || r.statusText || 'Request failed' };
    return j;
  });

const SIM_ADMIN_KEY = 'sim_admin_key';

function getSimAdminKey() {
  try {
    return sessionStorage.getItem(SIM_ADMIN_KEY) || '';
  } catch {
    return '';
  }
}

function setSimAdminKey(k) {
  try {
    if (k) sessionStorage.setItem(SIM_ADMIN_KEY, k.trim());
    else sessionStorage.removeItem(SIM_ADMIN_KEY);
  } catch (_) {}
}

/** Prompt once per session; used for Authorization: Bearer on simulation routes. */
async function ensureSimAdminKey() {
  let k = getSimAdminKey();
  if (k) return k;
  const entered = prompt(
    'Admin key required to start/stop the simulation.\n\nUse the same value as ADMIN_API_KEY on the server (not shared publicly).'
  );
  if (entered == null || String(entered).trim() === '') return null;
  k = String(entered).trim();
  setSimAdminKey(k);
  return k;
}

// === Controls ===
async function startSim() {
  const key = await ensureSimAdminKey();
  if (!key) return;
  const res = await api('/simulation/start', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.error) {
    if (String(res.error).includes('Forbidden') || String(res.error).includes('403')) {
      setSimAdminKey('');
      alert('Invalid admin key. Check ADMIN_API_KEY on the server matches what you entered.');
      return;
    }
    if (String(res.error).includes('misconfiguration') || String(res.error).includes('ADMIN_API_KEY')) {
      alert(res.error);
      return;
    }
    alert(res.error);
    return;
  }
  refresh();
}

async function stopSim() {
  const key = await ensureSimAdminKey();
  if (!key) return;
  const res = await api('/simulation/stop', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.error) {
    if (String(res.error).includes('Forbidden') || String(res.error).includes('403')) {
      setSimAdminKey('');
      alert('Invalid admin key.');
      return;
    }
    if (String(res.error).includes('misconfiguration') || String(res.error).includes('ADMIN_API_KEY')) {
      alert(res.error);
      return;
    }
    alert(res.error);
    return;
  }
  refresh();
}

/** Clear stored admin key (e.g. after deploy). Call from console: clearSimAdminKey() */
function clearSimAdminKey() {
  setSimAdminKey('');
}
window.clearSimAdminKey = clearSimAdminKey;

// === Init Charts ===
function initCharts() {
  const accent = '#3d9eff';
  const amber = '#fbbf24';
  const positive = '#3ecf8e';
  const negative = '#f87171';
  const neutral = ['#5b8cff', '#3ecf8e', '#22d3ee', '#fbbf24', '#a78bfa', '#6b7684'];

  // Credits bar chart
  const ctxCredits = document.getElementById('credits-chart').getContext('2d');
  creditsChart = new Chart(ctxCredits, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: 'Credits',
        data: [],
        backgroundColor: accent,
        borderRadius: 6,
        barPercentage: 0.65,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: 'rgba(255,255,255,0.06)' },
          ticks: { color: '#6b7684', font: { family: "'JetBrains Mono', monospace", size: 10 } },
        },
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: '#9aa4b2', maxRotation: 45, minRotation: 0 },
        },
      },
    },
  });

  // Price history line chart
  const ctxPrice = document.getElementById('price-chart').getContext('2d');
  priceChart = new Chart(ctxPrice, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Food',
          data: [],
          borderColor: amber,
          backgroundColor: 'rgba(251, 191, 36, 0.08)',
          borderWidth: 2, tension: 0.35, fill: true,
          pointBackgroundColor: '#141920', pointBorderColor: amber, pointRadius: 3, pointHoverRadius: 5,
        },
        {
          label: 'Energy',
          data: [],
          borderColor: accent,
          backgroundColor: 'rgba(61, 158, 255, 0.08)',
          borderWidth: 2, tension: 0.35, fill: true,
          pointBackgroundColor: '#141920', pointBorderColor: accent, pointRadius: 3, pointHoverRadius: 5,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { usePointStyle: true, boxWidth: 6, padding: 16, color: '#9aa4b2' },
        },
      },
      scales: {
        y: {
          border: { display: false },
          grid: { color: 'rgba(255,255,255,0.06)' },
          ticks: { color: '#6b7684', font: { family: "'JetBrains Mono', monospace", size: 10 } },
        },
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: '#9aa4b2', maxRotation: 0 },
        },
      },
    },
  });

  // Action distribution doughnut
  const ctxAction = document.getElementById('action-chart').getContext('2d');
  actionChart = new Chart(ctxAction, {
    type: 'doughnut',
    data: {
      labels: ['WORK', 'BUY_FOOD', 'BUY_ENERGY', 'SELL_FOOD', 'SELL_ENERGY', 'HOLD'],
      datasets: [{
        data: [0, 0, 0, 0, 0, 0],
        backgroundColor: neutral,
        borderWidth: 2, borderColor: '#141920', hoverOffset: 6
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            usePointStyle: true, boxWidth: 6, padding: 10, color: '#9aa4b2', font: { size: 10 },
          },
        },
      },
    },
  });
}

// === Update Charts ===
function updateCreditsChart(agents) {
  if (!creditsChart || !agents.length) return;
  creditsChart.data.labels = agents.map((a) => a.name);
  creditsChart.data.datasets[0].data = agents.map((a) => Number(a.credits));

  const ok = '#3d9eff';
  const bad = '#f87171';
  creditsChart.data.datasets[0].backgroundColor = agents.map((a) =>
    a.status === 'STARVING' ? bad : ok
  );
  creditsChart.update('none');
}

function updatePriceChart(market) {
  if (!priceChart || !market) return;
  const label = `T${market.tick}`;
  if (priceHistory.labels[priceHistory.labels.length - 1] === label) return;

  priceHistory.labels.push(label);
  priceHistory.food.push(Number(market.food_price));
  priceHistory.energy.push(Number(market.energy_price));

  if (priceHistory.labels.length > MAX_PRICE_POINTS) {
    priceHistory.labels.shift();
    priceHistory.food.shift();
    priceHistory.energy.shift();
  }

  priceChart.data.labels = [...priceHistory.labels];
  priceChart.data.datasets[0].data = [...priceHistory.food];
  priceChart.data.datasets[1].data = [...priceHistory.energy];
  priceChart.update('none');
}

function updateActionChart(agents) {
  if (!actionChart || !agents.length) return;
  const actions = ['WORK', 'BUY_FOOD', 'BUY_ENERGY', 'SELL_FOOD', 'SELL_ENERGY', 'HOLD'];
  const counts = actions.map((a) => agents.filter((ag) => ag.last_action === a).length);
  actionChart.data.datasets[0].data = counts;
  actionChart.update('none');
}

// === Render Agents ===
function renderAgents(agents) {
  const grid = document.getElementById('agents-grid');
  if (!agents || agents.length === 0) {
    grid.innerHTML = '<div class="loading">No agents in the economy yet. Run <code>npm run seed</code> to drop some in.</div>';
    return;
  }

  document.getElementById('agent-count-badge').textContent = String(agents.length);

  grid.innerHTML = agents.map((a) => {
    const isStarving = a.status === 'STARVING';
    return `
      <div class="agent-card ${isStarving ? 'starving' : ''}">
        <div class="agent-header">
          <span class="agent-name">${a.name}</span>
          <span class="agent-status ${isStarving ? 'starving' : 'active'}">${a.status}</span>
        </div>
        <div class="agent-personality">${a.personality}</div>
        <div class="agent-stats">
          <div class="agent-stat">
            <div class="agent-stat-label">Credits</div>
            <div class="agent-stat-value credits-color">${Number(a.credits).toFixed(1)}</div>
          </div>
          <div class="agent-stat">
            <div class="agent-stat-label">Food</div>
            <div class="agent-stat-value food-color">${a.food}</div>
          </div>
          <div class="agent-stat">
            <div class="agent-stat-label">Energy</div>
            <div class="agent-stat-value energy-color">${a.energy}</div>
          </div>
        </div>
        <div class="agent-action">
          Last action: <span class="action-tag">${a.last_action || 'NONE'}</span>
        </div>
      </div>
    `;
  }).join('');

  const active = agents.filter((a) => a.status === 'ACTIVE').length;
  const starving = agents.filter((a) => a.status === 'STARVING').length;
  const totalCredits = agents.reduce((sum, a) => sum + Number(a.credits), 0);
  document.getElementById('active-count').textContent = active;
  document.getElementById('starving-count').textContent = starving;
  document.getElementById('total-economy').textContent = `$${totalCredits.toFixed(0)}`;

  updateCreditsChart(agents);
  updateActionChart(agents);
}

// === Render Market ===
function renderMarket(market) {
  if (!market) return;

  document.getElementById('food-price').textContent = `$${Number(market.food_price).toFixed(2)}`;
  document.getElementById('energy-price').textContent = `$${Number(market.energy_price).toFixed(2)}`;

  if (prevFoodPrice !== null) {
    const diff = market.food_price - prevFoodPrice;
    const el = document.getElementById('food-change');
    if (Math.abs(diff) > 0.01) {
      el.textContent = `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff).toFixed(2)}`;
      el.className = `stat-change ${diff > 0 ? 'up' : 'down'}`;
    } else { el.textContent = ''; el.className = 'stat-change'; }
  }

  if (prevEnergyPrice !== null) {
    const diff = market.energy_price - prevEnergyPrice;
    const el = document.getElementById('energy-change');
    if (Math.abs(diff) > 0.01) {
      el.textContent = `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff).toFixed(2)}`;
      el.className = `stat-change ${diff > 0 ? 'up' : 'down'}`;
    } else { el.textContent = ''; el.className = 'stat-change'; }
  }

  prevFoodPrice = market.food_price;
  prevEnergyPrice = market.energy_price;
  document.querySelector('.tick-num').textContent = market.tick;

  updatePriceChart(market);
}

// === Render Events ===
function renderEvents(events) {
  const list = document.getElementById('events-list');
  if (!events || events.length === 0) {
    list.innerHTML = '<div class="loading">No events yet. Start the simulation.</div>';
    document.getElementById('event-count-badge').textContent = '0';
    return;
  }

  document.getElementById('event-count-badge').textContent = String(events.length);
  const recent = events.slice(0, 50);

  list.innerHTML = recent.map((e) => {
    const isWarning = e.description.includes('STARVING') || e.description.includes("couldn't afford");
    const isWork = e.description.includes('worked') || e.description.includes('bought') || e.description.includes('sold');
    return `
      <div class="event-item ${isWarning ? 'warning' : isWork ? 'success' : ''}">
        <div class="event-tick">Tick ${e.tick}</div>
        <div class="event-text">${e.description}</div>
      </div>
    `;
  }).join('');
}

// === Render Status ===
function renderStatus(status) {
  const dot = document.querySelector('.status-dot');
  const label = document.querySelector('.status-label');
  const startBtn = document.getElementById('btn-start');
  const stopBtn = document.getElementById('btn-stop');
  if (!startBtn || !stopBtn) return;

  const adminOk = marketConfig?.admin_configured !== false;
  if (marketConfig && adminOk === false) {
    dot.className = 'status-dot offline';
    label.textContent = 'Stopped';
    startBtn.disabled = true;
    stopBtn.disabled = true;
    startBtn.title = 'Server must set ADMIN_API_KEY (min 12 chars) to allow simulation control.';
    stopBtn.title = startBtn.title;
    return;
  }
  startBtn.title = '';
  stopBtn.title = '';

  if (status.running) {
    dot.className = 'status-dot online';
    label.textContent = 'Running';
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    dot.className = 'status-dot offline';
    label.textContent = 'Stopped';
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

// === Polling ===
async function refresh() {
  try {
    const [agentsRes, marketRes, eventsRes, statusRes] = await Promise.all([
      api('/agents'), api('/market'), api('/events'), api('/simulation/status'),
    ]);
    if (agentsRes.error || marketRes.error || eventsRes.error || statusRes.error) return;
    renderAgents(agentsRes.agents);
    renderMarket(marketRes.market);
    renderEvents(eventsRes.events);
    renderStatus(statusRes);
  } catch (err) { console.error('Polling error:', err); }
}

async function loadTransparency() {
  try {
    const res = await api('/markets/transparency');
    const t = res.transparency;
    const el = document.getElementById('transparency-body');
    if (!t || !el) return;
    const treasury = t.protocol_treasury
      ? `<a href="${t.explorer_base}/address/${t.protocol_treasury}" target="_blank" rel="noopener noreferrer">${t.protocol_treasury}</a>`
      : 'Not configured (set PROTOCOL_TREASURY_ADDRESS)';
    el.innerHTML = `
      <p class="transparency-pitch">Agents are dropped into an economy - they earn, trade, scam, or starve. <strong>You</strong> bet on <strong>which agent ends richest</strong> (USDC on Base).</p>
      <ul class="transparency-list">
        <li><strong>Chain:</strong> Base (chain ID ${t.chain_id}) · <strong>USDC:</strong> <a href="${t.explorer_base}/address/${t.usdc_contract}" target="_blank" rel="noopener noreferrer">${t.usdc_contract}</a></li>
        <li><strong>Protocol fee:</strong> ${t.protocol_fee_percent}% (${t.protocol_fee_bps} bps) per trade - revenue to treasury: ${treasury}</li>
        <li><strong>Economy vs bets:</strong> Agent credits are the in-game score (not cash). USDC is only for betting on who wins that race.</li>
      </ul>
      <ul class="transparency-rules">
        ${t.rules.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
      </ul>
    `;
  } catch (e) {
    console.error(e);
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDuration(ms) {
  if (ms <= 0) return '0s';
  let sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  sec -= d * 86400;
  const h = Math.floor(sec / 3600);
  sec -= h * 3600;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function updatePmMarketHeader() {
  const line = document.getElementById('pm-market-line');
  const closeLine = document.getElementById('pm-close-line');
  if (!line || !closeLine) return;
  const select = document.getElementById('market-select');
  const id = Number(select?.value);
  const m = cachedMarkets.find((x) => x.id === id);
  if (!m) {
    line.textContent = 'Select a market';
    closeLine.textContent = '-';
    return;
  }
  line.textContent = (m.title || `Market #${m.id}`).slice(0, 72);
  const closes = m.betting_closes_at ? new Date(m.betting_closes_at) : null;
  closeLine.textContent = closes
    ? `Closes ${closes.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · ${closes.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'No deadline set';
}

function getSelectedOutcome() {
  const outcomeId = Number(document.getElementById('outcome-select')?.value);
  return marketOutcomes.find((o) => o.id === outcomeId);
}

/** Parimutuel: show share of pool for selected agent (not misleading Yes/No “prices”). */
function updatePoolShareHint() {
  const line = document.getElementById('pool-share-line');
  const sub = document.getElementById('pool-share-sub');
  if (!line) return;
  const o = getSelectedOutcome();
  const nAgents = marketOutcomes.length || 1;
  if (!o) {
    line.textContent = '-';
    if (sub) sub.textContent = '';
    return;
  }
  const share = Number(o.implied_pool_share ?? o.implied_yes ?? 0);
  const poolTotal = marketOutcomes.reduce((s, x) => s + Number(x.pool_stake_usdc || 0), 0);
  const pct = (share * 100).toFixed(1);
  line.textContent = `~${pct}% of pool if this agent wins`;
  if (sub) {
    if (poolTotal <= 0.000001) {
      sub.textContent = `No bets yet · equal baseline 1/${nAgents} each (${nAgents} agents) - not USDC odds`;
    } else {
      sub.textContent = `Pool ≈ $${poolTotal.toFixed(2)} USDC on-chain (indexed)`;
    }
  }
}

function setBetMode(mode) {
  betMode = mode;
  document.getElementById('tab-buy')?.classList.toggle('pm-tab-active', mode === 'buy');
  document.getElementById('tab-buy')?.setAttribute('aria-selected', String(mode === 'buy'));
}

/** Parimutuel: single bet type - stake on selected agent (outcome). */
function getSideKey() {
  return 'BET';
}

function getPositionForOutcome() {
  const marketId = Number(document.getElementById('market-select')?.value);
  const outcomeId = Number(document.getElementById('outcome-select')?.value);
  return cachedPositions.find((p) => Number(p.market_id) === marketId && Number(p.outcome_id) === outcomeId);
}

function scheduleQuotePreview() {
  if (quoteDebounce) clearTimeout(quoteDebounce);
  quoteDebounce = setTimeout(() => previewTrade(), 450);
}

function formatQuotePreview(q) {
  if (!q) return '';
  const fee = Number(q.feeUsdc ?? q.fee_on_gross_usdc ?? 0);
  const net = Number(q.netUsdc ?? q.net_to_pool_usdc ?? 0);
  const poolAfter = Number(q.pool_total_after_usdc ?? 0);
  const share = Number(q.implied_share_of_pool_if_this_outcome_wins ?? 0);
  return `fee ${fee.toFixed(4)} USDC · ${net.toFixed(4)} USDC to pool · pool ~${poolAfter.toFixed(2)} after · ~${(share * 100).toFixed(1)}% of pool if this outcome wins`;
}

function updateMarketMetaAndCountdown() {
  const select = document.getElementById('market-select');
  const meta = document.getElementById('market-meta');
  const row = document.getElementById('countdown-row');
  const val = document.getElementById('countdown-value');
  if (!select || !meta || !row || !val) return;
  const id = Number(select.value);
  const m = cachedMarkets.find((x) => x.id === id);
  updatePmMarketHeader();
  if (!m) {
    meta.textContent = '';
    row.hidden = true;
    return;
  }
  const trading = m.trading_open !== false && m.status === 'OPEN';
  const closes = m.betting_closes_at ? new Date(m.betting_closes_at) : null;
  meta.innerHTML = `
    <span class="meta-pill ${trading ? 'meta-open' : 'meta-closed'}">${trading ? 'Trading open' : 'Trading closed'}</span>
    <span class="meta-text">Market status: <strong>${escapeHtml(m.status)}</strong>
    ${closes ? ` · Closes (server): ${closes.toLocaleString()}` : ''}
    </span>
  `;
  if (closes && m.status === 'OPEN') {
    row.hidden = false;
    const left = closes.getTime() - Date.now();
    val.textContent = left > 0 ? formatDuration(left) : 'Closed - resolving';
  } else {
    row.hidden = true;
  }
}

async function loadMarketConfig() {
  try {
    const c = await api('/markets/config');
    if (!c.error) marketConfig = c;
    const warn = document.getElementById('pm-contract-warning');
    if (warn) {
      const hasContract = !c.error && Boolean(c.prediction_market_contract);
      warn.hidden = hasContract;
    }
  } catch (e) {
    console.error(e);
  }
}

async function loadMarkets() {
  const res = await api('/markets');
  if (res.error) return;
  cachedMarkets = res.markets || [];
  const select = document.getElementById('market-select');
  const prev = select.value;
  select.innerHTML = cachedMarkets.map((m) => {
    const tag = m.trading_open && m.status === 'OPEN' ? '' : ' [closed]';
    return `<option value="${m.id}">${m.title}${tag}</option>`;
  }).join('');
  if (prev && cachedMarkets.some((x) => String(x.id) === prev)) select.value = prev;
  if (cachedMarkets.length) {
    if (!select.value || select.value === '') {
      select.value = String(cachedMarkets[0].id);
    }
    const id = Number(select.value || cachedMarkets[0].id);
    await loadOutcomes(id);
  }
  updateMarketMetaAndCountdown();
  updatePmMarketHeader();
  const feeRes = await api('/markets/fees/daily');
  document.getElementById('fees-output').textContent = JSON.stringify(feeRes.fees || [], null, 2);
}

async function loadOutcomes(marketId) {
  const res = await api(`/markets/${marketId}/outcomes`);
  marketOutcomes = res.outcomes || [];
  const select = document.getElementById('outcome-select');
  // Preserve user selection when markets/outcomes refresh on an interval (otherwise first option wins).
  const prevOutcomeId = select?.value;
  select.innerHTML = marketOutcomes.map((o) => `<option value="${o.id}">${o.agent_name}</option>`).join('');
  if (prevOutcomeId && marketOutcomes.some((o) => String(o.id) === String(prevOutcomeId))) {
    select.value = prevOutcomeId;
  }
  updatePoolShareHint();
  scheduleQuotePreview();
}

async function connectWallet() {
  try {
    await openWalletChooser();
  } catch (e) {
    console.error(e);
    alert(e?.message || String(e));
  }
}

async function previewTrade() {
  if (quoteLocked) return;
  const previewEl = document.getElementById('quote-preview');
  const usdcAmount = Number(document.getElementById('usdc-amount')?.value);
  if (!Number.isFinite(usdcAmount) || usdcAmount <= 0) {
    if (previewEl) previewEl.textContent = 'Enter a USDC amount for an estimate.';
    return;
  }
  quoteLocked = true;
  try {
    const marketId = Number(document.getElementById('market-select').value);
    const outcomeId = Number(document.getElementById('outcome-select').value);
    const side = getSideKey();
    const quoteRes = await api('/markets/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketId, outcomeId, side, usdcAmount }),
    });
    if (quoteRes.error) {
      if (previewEl) previewEl.textContent = quoteRes.error;
      return;
    }
    const q = quoteRes.quote || quoteRes;
    if (previewEl) previewEl.textContent = formatQuotePreview(q);
  } catch (e) {
    if (previewEl) previewEl.textContent = String(e.message || e);
  } finally {
    quoteLocked = false;
  }
}

const ERC20_MIN_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
];

async function getUsdcBalance() {
  const eip = getEip1193Provider();
  if (!connectedWallet || !eip) return 0;
  if (!marketConfig?.usdc_contract) await loadMarketConfig();
  if (!marketConfig?.usdc_contract) return 0;
  try {
    const eth = getEthers();
    const provider = new eth.BrowserProvider(eip);
    const usdc = new eth.Contract(marketConfig.usdc_contract, ERC20_MIN_ABI, provider);
    const raw = await usdc.balanceOf(connectedWallet);
    return Number(eth.formatUnits(raw, 6));
  } catch {
    return 0;
  }
}

function applyQuickAdd(delta) {
  const input = document.getElementById('usdc-amount');
  if (!input) return;
  const cur = parseFloat(input.value) || 0;
  input.value = (cur + delta).toFixed(2);
  scheduleQuotePreview();
}

async function applyAmount50() {
  const input = document.getElementById('usdc-amount');
  const previewEl = document.getElementById('quote-preview');
  if (!input) return;
  if (betMode === 'buy') {
    const bal = await getUsdcBalance();
    if (bal <= 0) {
      if (previewEl) previewEl.textContent = 'Connect wallet and fund USDC on Base.';
      return;
    }
    input.value = (bal * 0.5).toFixed(2);
  } else {
    const pos = getPositionForOutcome();
    const shares = pos ? Number(pos.shares) : 0;
    if (shares <= 0) {
      if (previewEl) previewEl.textContent = 'No position to sell for this agent outcome.';
      return;
    }
    input.value = (shares * 0.5).toFixed(6);
  }
  scheduleQuotePreview();
}

async function applyAmountMax() {
  const input = document.getElementById('usdc-amount');
  const previewEl = document.getElementById('quote-preview');
  if (!input) return;
  if (betMode === 'buy') {
    const bal = await getUsdcBalance();
    if (bal <= 0) {
      if (previewEl) previewEl.textContent = 'Connect wallet and fund USDC on Base.';
      return;
    }
    input.value = Math.max(0.01, bal - 0.000001).toFixed(6);
  } else {
    const pos = getPositionForOutcome();
    const shares = pos ? Number(pos.shares) : 0;
    if (shares <= 0) {
      if (previewEl) previewEl.textContent = 'No position to sell for this agent outcome.';
      return;
    }
    input.value = Math.max(0.01, shares).toFixed(6);
  }
  scheduleQuotePreview();
}

/**
 * Switch to configured chain (Base) and return a fresh BrowserProvider so MetaMask prompts work.
 */
async function ensureWalletOnChain(eth, cfg) {
  if (!cfg?.chain_id) throw new Error('Server config missing chain_id');
  const eip = getEip1193Provider();
  if (!eip) throw new Error('No wallet - connect a wallet first');
  const want = BigInt(cfg.chain_id);
  let provider = new eth.BrowserProvider(eip);
  let net = await provider.getNetwork();
  if (net.chainId === want) return provider;

  const hex = '0x' + want.toString(16);
  try {
    await eip.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    const code = e?.code;
    if (code === 4902 && Number(cfg.chain_id) === 8453) {
      await eip.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hex,
            chainName: 'Base',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [cfg.rpc_url || 'https://mainnet.base.org'],
            blockExplorerUrls: ['https://basescan.org'],
          },
        ],
      });
      await eip.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } else {
      throw new Error('Please switch your wallet to Base (chain ' + cfg.chain_id + ').');
    }
  }
  provider = new eth.BrowserProvider(eip);
  net = await provider.getNetwork();
  if (net.chainId !== want) {
    throw new Error(
      `Wallet is still not on chain ${cfg.chain_id} (Base). Current chain: ${net.chainId}. Switch to Base in your wallet and try again.`
    );
  }
  return provider;
}

/** Full withdrawal of net stake on this outcome before betting closes (requires contract with exitStake). */
async function exitStakePosition(marketId, outcomeIndex) {
  if (tradeLocked) return;
  if (!connectedWallet) {
    alert('Connect wallet first');
    return;
  }
  const mid = Number(marketId);
  const oid = Number(outcomeIndex);
  if (!Number.isFinite(mid) || !Number.isFinite(oid) || oid < 0) return;

  const m = cachedMarkets.find((x) => x.id === mid);
  if (!m || m.status !== 'OPEN' || !m.trading_open) {
    alert(
      'Betting is closed for this market. You cannot exit on-chain anymore - if the market resolved and you won, claim USDC with claim(marketId) on the contract.'
    );
    return;
  }

  tradeLocked = true;
  try {
    const eth = getEthers();
    if (!getEip1193Provider()) throw new Error('No wallet - connect a wallet first');

    let cfg = marketConfig && !marketConfig.error ? marketConfig : null;
    if (!cfg) {
      const c = await api('/markets/config');
      if (c.error) throw new Error(c.error);
      cfg = c;
      marketConfig = c;
    }
    if (!cfg.prediction_market_contract) {
      throw new Error('Server has no PREDICTION_MARKET_CONTRACT_ADDRESS.');
    }

    const provider = await ensureWalletOnChain(eth, cfg);
    const signer = await provider.getSigner();
    const user = (await signer.getAddress()).toLowerCase();
    if (user !== connectedWallet) throw new Error('Connected wallet mismatch - reconnect.');

    const abiRes = await api('/markets/abi');
    if (abiRes.error || !abiRes.abi) throw new Error(abiRes.error || 'Contract ABI not available');
    const marketContract = new eth.Contract(cfg.prediction_market_contract, abiRes.abi, signer);

    const sim = await api(`/markets/${mid}/simulate-exit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcomeIndex: oid, wallet: user }),
    });
    if (sim.error) throw new Error(sim.error);

    let exitOverrides = undefined;
    if (sim.gas_limit) {
      const raw = BigInt(sim.gas_limit);
      const withHeadroom = (raw * 125n) / 100n;
      const cap = 5000000n;
      exitOverrides = { gasLimit: withHeadroom > cap ? cap : withHeadroom };
    }

    let tx;
    try {
      tx = exitOverrides
        ? await marketContract.exitStake(mid, oid, exitOverrides)
        : await marketContract.exitStake(mid, oid);
    } catch (betErr) {
      const msg = String(betErr?.message || betErr?.shortMessage || betErr || '');
      if (/missing revert data|CALL_EXCEPTION/i.test(msg)) {
        throw new Error(
          'exitStake failed. Deploy the latest contract (with exitStake), confirm you have a stake on this outcome, and betting is still open on-chain.\n\n' +
            msg
        );
      }
      throw betErr;
    }
    const receipt = await tx.wait();
    const st = receipt?.status;
    const ok =
      st === 1 ||
      st === 1n ||
      (typeof st === 'string' && st === '0x1') ||
      Number(st) === 1;
    if (!ok) throw new Error('Transaction reverted on-chain (see BaseScan).');

    const confirm = await api('/markets/trade/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: receipt.hash }),
    });
    if (confirm.error) throw new Error(confirm.error);

    alert('Stake exited - USDC returned to your wallet (check wallet balance; you still pay gas in ETH).');
    await loadPositions();
    await loadMarkets();
  } catch (e) {
    console.error(e);
    alert(e?.reason || e?.message || e?.shortMessage || String(e));
  } finally {
    tradeLocked = false;
  }
}

/** After owner resolves on-chain: claim USDC for this market (winning outcome only). */
async function claimWinnings(marketId) {
  if (tradeLocked) return;
  if (!connectedWallet) {
    alert('Connect wallet first');
    return;
  }
  const mid = Number(marketId);
  if (!Number.isFinite(mid) || mid < 1) return;

  tradeLocked = true;
  try {
    const eth = getEthers();
    if (!getEip1193Provider()) throw new Error('No wallet - connect a wallet first');

    let cfg = marketConfig && !marketConfig.error ? marketConfig : null;
    if (!cfg) {
      const c = await api('/markets/config');
      if (c.error) throw new Error(c.error);
      cfg = c;
      marketConfig = c;
    }
    if (!cfg.prediction_market_contract) throw new Error('No prediction market contract on server.');

    const provider = await ensureWalletOnChain(eth, cfg);
    const signer = await provider.getSigner();
    const user = (await signer.getAddress()).toLowerCase();
    if (user !== connectedWallet) throw new Error('Wallet mismatch - reconnect.');

    const pre = await api(`/markets/${mid}/claim-precheck?wallet=${encodeURIComponent(user)}`);
    if (pre.error) throw new Error(pre.error);
    const pc = pre.precheck;
    if (!pc?.can_claim) {
      throw new Error(
        pc?.reason === 'not_resolved'
          ? 'Market is not resolved on-chain yet - the contract owner must call resolveMarket first.'
          : 'Nothing to claim for this wallet on this market (wrong outcome, already claimed, or no stake).'
      );
    }

    const sim = await api(`/markets/${mid}/simulate-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: user }),
    });
    if (sim.error) throw new Error(sim.error);

    let claimOverrides = undefined;
    if (sim.gas_limit) {
      const raw = BigInt(sim.gas_limit);
      const withHeadroom = (raw * 125n) / 100n;
      const cap = 5000000n;
      claimOverrides = { gasLimit: withHeadroom > cap ? cap : withHeadroom };
    }

    const abiRes = await api('/markets/abi');
    if (abiRes.error || !abiRes.abi) throw new Error(abiRes.error || 'ABI');
    const marketContract = new eth.Contract(cfg.prediction_market_contract, abiRes.abi, signer);

    let tx;
    try {
      tx = claimOverrides
        ? await marketContract.claim(mid, claimOverrides)
        : await marketContract.claim(mid);
    } catch (err) {
      const msg = String(err?.message || err?.shortMessage || err || '');
      if (/missing revert data|CALL_EXCEPTION/i.test(msg)) {
        throw new Error(
          'claim() failed. Confirm the market is resolved on-chain and you have stake on the winning outcome.\n\n' +
            msg
        );
      }
      throw err;
    }
    const receipt = await tx.wait();
    const st = receipt?.status;
    const ok =
      st === 1 ||
      st === 1n ||
      (typeof st === 'string' && st === '0x1') ||
      Number(st) === 1;
    if (!ok) throw new Error('Transaction reverted on-chain.');

    const confirm = await api('/markets/trade/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: receipt.hash }),
    });
    if (confirm.error) throw new Error(confirm.error);

    const est = pc.estimated_payout_usdc ? ` ~${Number(pc.estimated_payout_usdc).toFixed(4)} USDC` : '';
    alert(`Claim confirmed - USDC sent to your wallet${est} (minus gas).`);
    await loadPositions();
    await loadMarkets();
  } catch (e) {
    console.error(e);
    alert(e?.reason || e?.message || e?.shortMessage || String(e));
  } finally {
    tradeLocked = false;
  }
}

async function placeTrade() {
  if (tradeLocked) return;
  if (betMode !== 'buy') {
    alert('Parimutuel markets only support betting on an outcome (Buy).');
    return;
  }
  if (!connectedWallet) {
    alert('Connect wallet first');
    return;
  }
  if (!marketConfig?.prediction_market_contract) {
    alert(
      'Server has no PREDICTION_MARKET_CONTRACT_ADDRESS.\n\n' +
        '1) Deploy: npm run deploy:contract\n' +
        '2) Add address to .env and restart\n' +
        '3) Owner: registerMarket(...) - no USDC seed required (parimutuel)'
    );
    return;
  }

  const marketId = Number(document.getElementById('market-select').value);
  const outcomeId = Number(document.getElementById('outcome-select').value);
  const sideKey = getSideKey();
  const usdcAmount = Number(document.getElementById('usdc-amount').value);
  if (!Number.isFinite(marketId) || marketId < 1) {
    alert('Select a market (refresh the page if the list is empty).');
    return;
  }
  if (!Number.isFinite(usdcAmount) || usdcAmount <= 0) {
    alert('Enter a valid USDC amount.');
    return;
  }

  const m = cachedMarkets.find((x) => x.id === marketId);
  if (!m || m.status !== 'OPEN' || !m.trading_open) {
    alert('Trading is closed for this market.');
    return;
  }

  const outcome = marketOutcomes.find((o) => o.id === outcomeId);
  if (!outcome || outcome.outcome_index == null) {
    alert('Outcome not loaded - refresh and try again.');
    return;
  }

  const outcomeIndex = Number(outcome.outcome_index);
  if (!Number.isFinite(outcomeIndex) || outcomeIndex < 0) {
    alert('Invalid outcome - refresh and pick an agent.');
    return;
  }

  tradeLocked = true;
  const btnTrade = document.getElementById('btn-trade');
  if (btnTrade) btnTrade.disabled = true;

  try {
    const eth = getEthers();
    if (!getEip1193Provider()) throw new Error('No wallet - connect a wallet first');

    let cfg = marketConfig && !marketConfig.error ? marketConfig : null;
    if (!cfg) {
      const c = await api('/markets/config');
      if (c.error) throw new Error(c.error);
      cfg = c;
      marketConfig = c;
    }
    if (!cfg.prediction_market_contract) {
      throw new Error('Set PREDICTION_MARKET_CONTRACT_ADDRESS on the server and deploy/register on-chain.');
    }

    const provider = await ensureWalletOnChain(eth, cfg);
    const signer = await provider.getSigner();
    const user = (await signer.getAddress()).toLowerCase();
    if (user !== connectedWallet) {
      throw new Error('Connected wallet mismatch - reconnect.');
    }

    const gross = eth.parseUnits(String(usdcAmount), 6);

    const q = await api('/markets/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketId, outcomeId, side: sideKey, usdcAmount }),
    });
    if (q.error) throw new Error(q.error);

    const abiRes = await api('/markets/abi');
    if (abiRes.error || !abiRes.abi) throw new Error(abiRes.error || 'Contract ABI not available');
    const marketAbi = abiRes.abi;

    const preRes = await api(`/markets/${marketId}/precheck?wallet=${encodeURIComponent(user)}`);
    if (preRes.error) {
      throw new Error(
        preRes.error +
          '\n\n(Check server BASE_RPC_URL, deploy ChaosParimutuelMarket to Base, set PREDICTION_MARKET_CONTRACT_ADDRESS, run npm run register:market -- ' +
          marketId +
          ')'
      );
    }
    const pre = preRes.precheck;
    if (!pre?.active) {
      throw new Error(
        `Market #${marketId} is not active on-chain. Owner: npm run register:market -- ${marketId}`
      );
    }
    if (pre.resolved) {
      throw new Error(`Market #${marketId} is already resolved on-chain.`);
    }
    if (outcomeIndex >= pre.outcomeCount) {
      throw new Error(
        `This agent’s index (${outcomeIndex}) is not valid on-chain (outcomeCount=${pre.outcomeCount}). ` +
          `The contract may have been registered with fewer outcomes than your database - re-run: npm run register:market -- ${marketId}`
      );
    }

    const balanceWei = eth.parseUnits(String(pre.balance_usdc || '0'), 6);
    if (balanceWei < gross) {
      throw new Error(
        `Not enough USDC on Base in this wallet.\nNeed at least ${usdcAmount} USDC; balance ~${pre.balance_usdc} USDC.\nBridge or send USDC on Base (not Ethereum mainnet).`
      );
    }

    const usdc = new eth.Contract(cfg.usdc_contract, ERC20_MIN_ABI, signer);
    const market = new eth.Contract(cfg.prediction_market_contract, marketAbi, signer);

    const quoteEl = document.getElementById('quote-preview');
    let cur = eth.parseUnits(String(pre.allowance_usdc || '0'), 6);
    if (cur < gross) {
      if (quoteEl) quoteEl.textContent = 'Approve USDC in your wallet…';
      const ap = await usdc.approve(cfg.prediction_market_contract, gross);
      await ap.wait();
      const pre2 = await api(`/markets/${marketId}/precheck?wallet=${encodeURIComponent(user)}`);
      if (pre2.error) throw new Error(pre2.error);
      cur = eth.parseUnits(String(pre2.precheck?.allowance_usdc || '0'), 6);
      if (cur < gross) {
        throw new Error(
          'USDC allowance is still too low after approve. Approve again for at least this bet amount (or unlimited) for the market contract.'
        );
      }
    }

    const sim = await api(`/markets/${marketId}/simulate-bet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcomeIndex,
        gross_smallest: gross.toString(),
        wallet: user,
      }),
    });
    if (sim.error) {
      throw new Error(
        sim.error +
          '\n\n(This dry-run uses the same rules as the chain - fix the issue above before trying the wallet again.)'
      );
    }

    /** Server-estimated gas avoids wallet RPC eth_estimateGas (often shows misleading CALL_EXCEPTION / wrong calldata in MetaMask). */
    let betOverrides = undefined;
    if (sim.gas_limit) {
      const raw = BigInt(sim.gas_limit);
      const withHeadroom = (raw * 125n) / 100n;
      const cap = 5000000n;
      betOverrides = { gasLimit: withHeadroom > cap ? cap : withHeadroom };
    }

    if (quoteEl) quoteEl.textContent = 'Confirm bet in your wallet…';
    let tx;
    try {
      tx = betOverrides
        ? await market.bet(marketId, outcomeIndex, gross, betOverrides)
        : await market.bet(marketId, outcomeIndex, gross);
    } catch (betErr) {
      const betMsg = String(betErr?.message || betErr?.shortMessage || betErr || '');
      if (/missing revert data|CALL_EXCEPTION/i.test(betMsg)) {
        throw new Error(
          'Could not submit the transaction (gas estimate / RPC returned no revert data).\n' +
            '• Confirm the wallet is on Base and you have enough ETH for gas.\n' +
            '• Cancel any stuck pending tx, refresh, try again.\n' +
            '• Open BaseScan → paste your wallet / contract - compare with server simulate-bet (already passed).\n\n' +
            betMsg
        );
      }
      throw betErr;
    }
    if (quoteEl) quoteEl.textContent = 'Waiting for confirmation… ' + tx.hash;
    const receipt = await tx.wait();
    const st = receipt?.status;
    const ok =
      st === 1 ||
      st === 1n ||
      (typeof st === 'string' && st === '0x1') ||
      Number(st) === 1;
    if (!ok) throw new Error('Transaction reverted on-chain (see BaseScan).');

    const confirm = await api('/markets/trade/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: receipt.hash }),
    });
    if (confirm.error) throw new Error(confirm.error);

    if (quoteEl) quoteEl.textContent = `Confirmed · indexed · ${receipt.hash.slice(0, 10)}…`;
    await loadPositions();
    await loadMarkets();
  } catch (e) {
    console.error(e);
    const quoteEl = document.getElementById('quote-preview');
    const msg = e?.reason || e?.message || e?.shortMessage || String(e);
    if (quoteEl) quoteEl.textContent = 'Error: ' + msg;
    alert(msg);
  } finally {
    tradeLocked = false;
    if (btnTrade) btnTrade.disabled = false;
  }
}

function renderPositionsTable(positions) {
  const tbody = document.getElementById('positions-tbody');
  if (!tbody) return;
  if (!positions || !positions.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="positions-empty">No open positions</td></tr>';
    return;
  }
  tbody.innerHTML = positions.map((p) => {
    const title = escapeHtml((p.title || '').slice(0, 32));
    const agent = escapeHtml(p.agent_name || '');
    const unreal = Number(p.unrealized_pnl_usdc ?? 0);
    const unrealClass = unreal >= 0 ? 'pnl-pos' : 'pnl-neg';
    const canExit =
      p.status === 'OPEN' &&
      p.trading_open === true &&
      Number(p.shares) > 0 &&
      Number(p.outcome_index) >= 0;
    const canClaim =
      p.status === 'RESOLVED' &&
      Number(p.shares) > 0 &&
      p.winning_agent_id != null &&
      Number(p.agent_id) === Number(p.winning_agent_id);
    let actionCell = '<span class="positions-action-muted">-</span>';
    if (canExit) {
      actionCell = `<button type="button" class="pm-exit-stake" onclick="exitStakePosition(${Number(p.market_id)}, ${Number(p.outcome_index)})">Exit stake</button>`;
    } else if (canClaim) {
      actionCell = `<button type="button" class="pm-claim-winnings" onclick="claimWinnings(${Number(p.market_id)})">Claim winnings</button>`;
    }
    return `<tr>
      <td>${title}</td>
      <td>${agent}</td>
      <td class="mono">${Number(p.shares).toFixed(4)}</td>
      <td class="mono">${Number(p.total_cost_usdc).toFixed(4)}</td>
      <td class="mono">${Number(p.estimated_mark_value_usdc).toFixed(4)}</td>
      <td class="mono ${unrealClass}">${unreal.toFixed(4)}</td>
      <td>${escapeHtml(p.status || '')}</td>
      <td class="positions-action-cell">${actionCell}</td>
    </tr>`;
  }).join('');
}

async function loadPositions() {
  const tbody = document.getElementById('positions-tbody');
  if (!connectedWallet) {
    cachedPositions = [];
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="positions-empty">Connect wallet to view positions</td></tr>';
    return;
  }
  const positionsRes = await api(`/positions/${connectedWallet}`);
  cachedPositions = positionsRes.positions || [];
  renderPositionsTable(cachedPositions);
}

// === Boot ===
initCharts();
refresh();
loadTransparency();
loadMarketConfig().then(() => refresh());
loadMarkets();
setInterval(refresh, 3000);
setInterval(loadMarkets, 5000);
setInterval(updateMarketMetaAndCountdown, 1000);
document.getElementById('market-select')?.addEventListener('change', (e) => {
  loadOutcomes(Number(e.target.value));
  updateMarketMetaAndCountdown();
});

document.getElementById('outcome-select')?.addEventListener('change', () => {
  updatePoolShareHint();
  scheduleQuotePreview();
});

document.getElementById('tab-buy')?.addEventListener('click', () => {
  setBetMode('buy');
  scheduleQuotePreview();
});
document.querySelectorAll('.pm-chip[data-add]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const d = parseFloat(btn.getAttribute('data-add'));
    if (Number.isFinite(d)) applyQuickAdd(d);
  });
});
document.getElementById('amt-50')?.addEventListener('click', () => applyAmount50());
document.getElementById('amt-max')?.addEventListener('click', () => applyAmountMax());
document.getElementById('usdc-amount')?.addEventListener('input', () => scheduleQuotePreview());
document.getElementById('btn-trade')?.addEventListener('click', (e) => {
  e.preventDefault();
  placeTrade();
});

window.connectWallet = connectWallet;
window.disconnectWallet = disconnectWallet;
window.previewTrade = previewTrade;
window.placeTrade = placeTrade;
window.exitStakePosition = exitStakePosition;
window.claimWinnings = claimWinnings;
window.loadPositions = loadPositions;

document.getElementById('btn-connect-wallet')?.addEventListener('click', () => connectWallet());
document.getElementById('btn-disconnect-wallet')?.addEventListener('click', () => disconnectWallet());
document.getElementById('btn-change-wallet')?.addEventListener('click', () => connectWallet());
document.getElementById('wallet-modal-cancel')?.addEventListener('click', closeWalletModal);
document.getElementById('wallet-modal-backdrop')?.addEventListener('click', closeWalletModal);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const m = document.getElementById('wallet-modal');
  if (m && !m.hidden) closeWalletModal();
});
