// === State ===
let prevFoodPrice = null;
let prevEnergyPrice = null;
let creditsChart = null;
let priceChart = null;
let actionChart = null;
let connectedWallet = null;
let marketOutcomes = [];
let cachedMarkets = [];
const priceHistory = { labels: [], food: [], energy: [] };
const MAX_PRICE_POINTS = 30;

// === Chart.js Cute Defaults ===
Chart.defaults.color = '#8c7b73';
Chart.defaults.borderColor = '#f2e2d5'; // dashed cute border
Chart.defaults.font.family = "'Nunito', sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.font.weight = '700';

// === API ===
const api = (path, opts) => fetch(path, opts).then((r) => r.json());

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
  // Pastel Palette
  const mint = '#8fd1b4';
  const pink = '#ff9fa8';
  const lavender = '#bcaefa';
  const yellow = '#ffcf70';
  const peach = '#ffb88a';

  // Credits bar chart
  const ctxCredits = document.getElementById('credits-chart').getContext('2d');
  creditsChart = new Chart(ctxCredits, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: 'Credits',
        data: [],
        backgroundColor: lavender,
        borderRadius: 8,
        barPercentage: 0.6,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, border: { display: false } },
        x: { grid: { display: false }, border: { display: false } },
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
          label: '🥐 Food',
          data: [],
          borderColor: peach,
          backgroundColor: '#ffebd9',
          borderWidth: 4, tension: 0.4, fill: true,
          pointBackgroundColor: '#fff', pointBorderColor: peach, pointRadius: 4, pointHoverRadius: 6,
        },
        {
          label: '🧃 Energy',
          data: [],
          borderColor: mint,
          backgroundColor: '#d8f2e7',
          borderWidth: 4, tension: 0.4, fill: true,
          pointBackgroundColor: '#fff', pointBorderColor: mint, pointRadius: 4, pointHoverRadius: 6,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } } },
      scales: {
        y: { border: { display: false } },
        x: { grid: { display: false }, border: { display: false } },
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
        backgroundColor: [lavender, mint, '#aae3f5', yellow, peach, '#e0d8d5'],
        borderWidth: 4, borderColor: '#ffffff', hoverOffset: 8
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '55%',
      plugins: { legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8 } } },
    },
  });
}

// === Update Charts ===
function updateCreditsChart(agents) {
  if (!creditsChart || !agents.length) return;
  creditsChart.data.labels = agents.map((a) => a.name);
  creditsChart.data.datasets[0].data = agents.map((a) => Number(a.credits));

  const pink = '#ff9fa8';
  const lavender = '#bcaefa';
  creditsChart.data.datasets[0].backgroundColor = agents.map((a) =>
    a.status === 'STARVING' ? pink : lavender
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
    grid.innerHTML = '<div class="loading">No agents found. Plz run seed!</div>';
    return;
  }

  document.getElementById('agent-count-badge').textContent = `${agents.length} agents`;

  grid.innerHTML = agents.map((a) => {
    const isStarving = a.status === 'STARVING';
    return `
      <div class="agent-card ${isStarving ? 'starving' : ''}">
        <div class="agent-header">
          <span class="agent-name">${a.name} ✨</span>
          <span class="agent-status ${isStarving ? 'starving' : 'active'}">${a.status}</span>
        </div>
        <div class="agent-personality">"${a.personality}"</div>
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
    list.innerHTML = '<div class="loading">No events yet! Start the magic ✨</div>';
    document.getElementById('event-count-badge').textContent = '0 events';
    return;
  }

  document.getElementById('event-count-badge').textContent = `${events.length} events`;
  const recent = events.slice(0, 50);

  list.innerHTML = recent.map((e) => {
    const isWarning = e.description.includes('STARVING') || e.description.includes("couldn't afford");
    const isWork = e.description.includes('worked') || e.description.includes('bought') || e.description.includes('sold');
    return `
      <div class="event-item ${isWarning ? 'warning' : isWork ? 'success' : ''}">
        <div class="event-tick">🎀 Time: ${e.tick}</div>
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
    label.textContent = 'Awake ✨';
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    dot.className = 'status-dot offline';
    label.textContent = 'Sleeping 💤';
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
    renderAgents(agentsRes.agents);
    renderMarket(marketRes.market);
    renderEvents(eventsRes.events);
    renderStatus(statusRes);
  } catch (err) { console.error('Polling error:', err); }
}

async function loadMarkets() {
  const res = await api('/markets');
  cachedMarkets = res.markets || [];
  const select = document.getElementById('market-select');
  select.innerHTML = cachedMarkets.map((m) => `<option value="${m.id}">${m.title} (status: ${m.status})</option>`).join('');
  if (cachedMarkets.length) {
    await loadOutcomes(Number(cachedMarkets[0].id));
  }
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
  document.getElementById('wallet-badge').textContent = connectedWallet;
  await loadPositions();
}

async function previewTrade() {
  const marketId = Number(document.getElementById('market-select').value);
  const outcomeId = Number(document.getElementById('outcome-select').value);
  const side = document.getElementById('side-select').value;
  const usdcAmount = Number(document.getElementById('usdc-amount').value);
  const quoteRes = await api('/markets/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marketId, outcomeId, side, usdcAmount }),
  });
  document.getElementById('quote-output').textContent = JSON.stringify(quoteRes.quote || quoteRes, null, 2);
}

async function placeTrade() {
  if (!connectedWallet) {
    alert('Connect wallet first');
    return;
  }
  const marketId = Number(document.getElementById('market-select').value);
  const outcomeId = Number(document.getElementById('outcome-select').value);
  const side = document.getElementById('side-select').value;
  const usdcAmount = Number(document.getElementById('usdc-amount').value);
  const fakeTxHash = `0xsimulated${Date.now().toString(16)}`;
  const tradeRes = await api('/markets/trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: connectedWallet, marketId, outcomeId, side, usdcAmount, txHash: fakeTxHash }),
  });
  document.getElementById('quote-output').textContent = JSON.stringify(tradeRes.trade || tradeRes, null, 2);
  await loadPositions();
  await loadMarkets();
}

async function loadPositions() {
  if (!connectedWallet) return;
  const positionsRes = await api(`/positions/${connectedWallet}`);
  document.getElementById('positions-output').textContent = JSON.stringify(positionsRes.positions || [], null, 2);
}

// === Boot ===
initCharts();
refresh();
loadMarkets();
setInterval(refresh, 3000);
document.getElementById('market-select')?.addEventListener('change', (e) => {
  loadOutcomes(Number(e.target.value));
});

window.connectWallet = connectWallet;
window.previewTrade = previewTrade;
window.placeTrade = placeTrade;
window.loadPositions = loadPositions;
