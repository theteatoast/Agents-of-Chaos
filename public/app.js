// === State ===
let prevFoodPrice = null;
let prevEnergyPrice = null;
let creditsChart = null;
let priceChart = null;
let actionChart = null;
let connectedWallet = null;
let marketOutcomes = [];
let cachedMarkets = [];
let marketConfig = null;
let tradeLocked = false;
let quoteLocked = false;
function getEthers() {
  if (typeof ethers !== 'undefined') return ethers;
  if (typeof window !== 'undefined' && window.ethers) return window.ethers;
  throw new Error('ethers failed to load');
}
const priceHistory = { labels: [], food: [], energy: [] };
const MAX_PRICE_POINTS = 30;

// Chart.js — dark dashboard defaults
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

// === Controls ===
async function startSim() {
  await api('/simulation/start', { method: 'POST' });
  refresh();
}
async function stopSim() {
  await api('/simulation/stop', { method: 'POST' });
  refresh();
}

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
      <p class="transparency-pitch">Agents are dropped into an economy — they earn, trade, scam, or starve. <strong>You</strong> bet on <strong>which agent ends richest</strong> (USDC on Base).</p>
      <ul class="transparency-list">
        <li><strong>Chain:</strong> Base (chain ID ${t.chain_id}) · <strong>USDC:</strong> <a href="${t.explorer_base}/address/${t.usdc_contract}" target="_blank" rel="noopener noreferrer">${t.usdc_contract}</a></li>
        <li><strong>Protocol fee:</strong> ${t.protocol_fee_percent}% (${t.protocol_fee_bps} bps) per trade — revenue to treasury: ${treasury}</li>
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

function updateMarketMetaAndCountdown() {
  const select = document.getElementById('market-select');
  const meta = document.getElementById('market-meta');
  const row = document.getElementById('countdown-row');
  const val = document.getElementById('countdown-value');
  if (!select || !meta || !row || !val) return;
  const id = Number(select.value);
  const m = cachedMarkets.find((x) => x.id === id);
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
    val.textContent = left > 0 ? formatDuration(left) : 'Closed — resolving';
  } else {
    row.hidden = true;
  }
}

async function loadMarketConfig() {
  try {
    const c = await api('/markets/config');
    if (!c.error) marketConfig = c;
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
    const id = Number(select.value || cachedMarkets[0].id);
    await loadOutcomes(id);
  }
  updateMarketMetaAndCountdown();
  const feeRes = await api('/markets/fees/daily');
  document.getElementById('fees-output').textContent = JSON.stringify(feeRes.fees || [], null, 2);
}

async function loadOutcomes(marketId) {
  const res = await api(`/markets/${marketId}/outcomes`);
  marketOutcomes = res.outcomes || [];
  const select = document.getElementById('outcome-select');
  select.innerHTML = marketOutcomes.map((o) => `<option value="${o.id}">${o.agent_name}</option>`).join('');
}

async function connectWallet() {
  if (!window.ethereum) {
    alert('No EVM wallet detected');
    return;
  }
  const [addr] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const challengeRes = await api('/wallet/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: addr }),
  });
  const signature = await window.ethereum.request({
    method: 'personal_sign',
    params: [challengeRes.challenge.message, addr],
  });
  await api('/wallet/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: addr, signature }),
  });
  connectedWallet = addr.toLowerCase();
  document.getElementById('wallet-badge').textContent = `${connectedWallet.slice(0, 6)}…${connectedWallet.slice(-4)}`;
  await loadPositions();
}

async function previewTrade() {
  if (quoteLocked) return;
  quoteLocked = true;
  const btn = document.getElementById('btn-quote');
  if (btn) btn.disabled = true;
  try {
    const marketId = Number(document.getElementById('market-select').value);
    const outcomeId = Number(document.getElementById('outcome-select').value);
    const side = document.getElementById('side-select').value;
    const usdcAmount = Number(document.getElementById('usdc-amount').value);
    const quoteRes = await api('/markets/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketId, outcomeId, side, usdcAmount }),
    });
    if (quoteRes.error) {
      document.getElementById('quote-output').textContent = quoteRes.error;
      return;
    }
    document.getElementById('quote-output').textContent = JSON.stringify(quoteRes.quote || quoteRes, null, 2);
  } catch (e) {
    document.getElementById('quote-output').textContent = String(e.message || e);
  } finally {
    quoteLocked = false;
    if (btn) btn.disabled = false;
  }
}

const ERC20_MIN_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const SIDE_MAP = { BUY_YES: 0, BUY_NO: 1, SELL_YES: 2, SELL_NO: 3 };

async function placeTrade() {
  if (tradeLocked) return;
  if (!connectedWallet) {
    alert('Connect wallet first');
    return;
  }
  if (!marketConfig?.prediction_market_contract) {
    alert('Set PREDICTION_MARKET_CONTRACT_ADDRESS on the server and deploy/register the market on-chain.');
    return;
  }

  const marketId = Number(document.getElementById('market-select').value);
  const outcomeId = Number(document.getElementById('outcome-select').value);
  const sideKey = document.getElementById('side-select').value;
  const usdcAmount = Number(document.getElementById('usdc-amount').value);

  const m = cachedMarkets.find((x) => x.id === marketId);
  if (!m || m.status !== 'OPEN' || !m.trading_open) {
    alert('Trading is closed for this market.');
    return;
  }

  const outcome = marketOutcomes.find((o) => o.id === outcomeId);
  if (!outcome || outcome.outcome_index === undefined) {
    alert('Outcome not loaded — refresh and try again.');
    return;
  }

  const side = SIDE_MAP[sideKey];
  if (side === undefined) {
    alert('Invalid side');
    return;
  }

  tradeLocked = true;
  const btnTrade = document.getElementById('btn-trade');
  const btnQuote = document.getElementById('btn-quote');
  if (btnTrade) btnTrade.disabled = true;
  if (btnQuote) btnQuote.disabled = true;

  try {
    const eth = getEthers();
    if (!window.ethereum) throw new Error('No wallet');

    const cfg = marketConfig || (await api('/markets/config'));
    marketConfig = cfg;

    const provider = new eth.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== Number(cfg.chain_id)) {
      const hex = '0x' + Number(cfg.chain_id).toString(16);
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
      } catch (e) {
        throw new Error('Please switch your wallet to Base (chain ' + cfg.chain_id + ').');
      }
    }

    const signer = await provider.getSigner();
    const user = (await signer.getAddress()).toLowerCase();
    if (user !== connectedWallet) {
      throw new Error('Connected wallet mismatch — reconnect.');
    }

    const gross = eth.parseUnits(String(usdcAmount), 6);

    const q = await api('/markets/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketId, outcomeId, side: sideKey, usdcAmount }),
    });
    if (q.error) throw new Error(q.error);
    /** min_out_suggested matches on-chain quote (1.5% slippage cushion vs expected shares or USDC to user). */
    const suggested = Math.max(0, Number(q.quote.min_out_suggested ?? 0));
    const minOut = eth.parseUnits(suggested.toFixed(6), 6);

    const marketAbi = (await api('/markets/abi')).abi;
    const usdc = new eth.Contract(cfg.usdc_contract, ERC20_MIN_ABI, signer);
    const market = new eth.Contract(cfg.prediction_market_contract, marketAbi, signer);

    if (side < 2) {
      const cur = await usdc.allowance(user, cfg.prediction_market_contract);
      if (cur < gross) {
        document.getElementById('quote-output').textContent = 'Approving USDC spend…';
        const ap = await usdc.approve(cfg.prediction_market_contract, eth.MaxUint256);
        await ap.wait();
      }
    }

    document.getElementById('quote-output').textContent = 'Confirm the trade in your wallet…';
    const tx = await market.trade(marketId, outcome.outcome_index, side, gross, minOut);
    document.getElementById('quote-output').textContent = 'Waiting for confirmation…\n' + tx.hash;
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error('Transaction reverted');

    const confirm = await api('/markets/trade/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: receipt.hash }),
    });
    if (confirm.error) throw new Error(confirm.error);

    document.getElementById('quote-output').textContent = JSON.stringify({ receipt: receipt.hash, indexed: confirm }, null, 2);
    await loadPositions();
    await loadMarkets();
  } catch (e) {
    console.error(e);
    document.getElementById('quote-output').textContent = 'Error: ' + (e.message || e);
    alert(e.message || e);
  } finally {
    tradeLocked = false;
    if (btnTrade) btnTrade.disabled = false;
    if (btnQuote) btnQuote.disabled = false;
  }
}

function renderPositionsTable(positions) {
  const tbody = document.getElementById('positions-tbody');
  if (!tbody) return;
  if (!positions || !positions.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="positions-empty">No open positions</td></tr>';
    return;
  }
  tbody.innerHTML = positions.map((p) => {
    const title = escapeHtml((p.title || '').slice(0, 32));
    const agent = escapeHtml(p.agent_name || '');
    const unreal = Number(p.unrealized_pnl_usdc);
    const unrealClass = unreal >= 0 ? 'pnl-pos' : 'pnl-neg';
    return `<tr>
      <td>${title}</td>
      <td>${agent}</td>
      <td class="mono">${Number(p.shares).toFixed(4)}</td>
      <td class="mono">${Number(p.total_cost_usdc).toFixed(4)}</td>
      <td class="mono">${Number(p.estimated_mark_value_usdc).toFixed(4)}</td>
      <td class="mono ${unrealClass}">${unreal.toFixed(4)}</td>
      <td>${escapeHtml(p.status || '')}</td>
    </tr>`;
  }).join('');
}

async function loadPositions() {
  const tbody = document.getElementById('positions-tbody');
  if (!connectedWallet) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="positions-empty">Connect wallet to view positions</td></tr>';
    return;
  }
  const positionsRes = await api(`/positions/${connectedWallet}`);
  renderPositionsTable(positionsRes.positions || []);
}

// === Boot ===
initCharts();
refresh();
loadTransparency();
loadMarketConfig();
loadMarkets();
setInterval(refresh, 3000);
setInterval(loadMarkets, 5000);
setInterval(updateMarketMetaAndCountdown, 1000);
document.getElementById('market-select')?.addEventListener('change', (e) => {
  loadOutcomes(Number(e.target.value));
  updateMarketMetaAndCountdown();
});

window.connectWallet = connectWallet;
window.previewTrade = previewTrade;
window.placeTrade = placeTrade;
window.loadPositions = loadPositions;
