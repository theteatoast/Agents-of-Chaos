import config from '../config/index.js';
import { getAllAgents, updateAgentsBatch } from '../services/agentService.js';
import { getMarketState, updateMarketState, saveTickSnapshot } from '../services/marketService.js';
import { logEventsBatch } from '../services/eventService.js';
import { getAgentDecision } from '../ai/groqClient.js';
import { resolveMaturedMarkets } from '../services/predictionMarketService.js';
import { bustCache } from '../services/cacheService.js';

let intervalId = null;
let currentTick = 0;
let running = false;

// Economy constants
const WORK_PAY = 10;
const FOOD_CONSUME_PER_TICK = 1;

/** When FOOD_CONSUME_EVERY_N_TICKS > 1, only some ticks drain food (fairer short runs). */
function shouldConsumeFoodThisTick(tick, everyN) {
    const n = Math.max(1, Math.floor(everyN));
    if (n <= 1) return true;
    return (tick - 1) % n === 0;
}

function applyAction(agent, action, market, { consumeFood }) {
    const events = [];

    switch (action) {
        case 'WORK':
            agent.credits += WORK_PAY;
            events.push(`${agent.name} worked and earned ${WORK_PAY} credits`);
            break;

        case 'BUY_FOOD':
            if (agent.credits >= market.food_price) {
                agent.credits -= market.food_price;
                agent.food += 1;
                events.push(`${agent.name} bought 1 food for ${market.food_price} credits`);
            } else {
                events.push(`${agent.name} tried to buy food but couldn't afford it`);
            }
            break;

        case 'BUY_ENERGY':
            if (agent.credits >= market.energy_price) {
                agent.credits -= market.energy_price;
                agent.energy += 1;
                events.push(`${agent.name} bought 1 energy for ${market.energy_price} credits`);
            } else {
                events.push(`${agent.name} tried to buy energy but couldn't afford it`);
            }
            break;

        case 'SELL_FOOD':
            if (agent.food > 0) {
                agent.food -= 1;
                agent.credits += market.food_price * 0.9; // 10% spread
                events.push(`${agent.name} sold 1 food for ${(market.food_price * 0.9).toFixed(2)} credits`);
            } else {
                events.push(`${agent.name} tried to sell food but has none`);
            }
            break;

        case 'SELL_ENERGY':
            if (agent.energy > 0) {
                agent.energy -= 1;
                agent.credits += market.energy_price * 0.9;
                events.push(`${agent.name} sold 1 energy for ${(market.energy_price * 0.9).toFixed(2)} credits`);
            } else {
                events.push(`${agent.name} tried to sell energy but has none`);
            }
            break;

        case 'HOLD':
        default:
            events.push(`${agent.name} decided to hold`);
            break;
    }

    // Metabolism: drain food on scheduled ticks only (configurable)
    if (consumeFood) {
        agent.food = Math.max(0, agent.food - FOOD_CONSUME_PER_TICK);
    }
    if (agent.food === 0) {
        agent.status = 'STARVING';
        events.push(`⚠️ ${agent.name} is STARVING!`);
    } else {
        agent.status = 'ACTIVE';
    }

    agent.last_action = action;
    return events;
}

function updatePrices(market) {
    // Random volatility: ±15%
    const foodChange = 1 + (Math.random() * 0.3 - 0.15);
    const energyChange = 1 + (Math.random() * 0.3 - 0.15);
    market.food_price = Math.max(1, +(market.food_price * foodChange).toFixed(2));
    market.energy_price = Math.max(1, +(market.energy_price * energyChange).toFixed(2));
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            results[idx] = await mapper(items[idx], idx);
        }
    });
    await Promise.all(workers);
    return results;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Groq calls: default sequential + delay to avoid 429 bursts on free tier.
 * Set GROQ_MAX_CONCURRENT>1 only if your Groq plan allows higher RPM.
 */
async function collectAgentDecisions(agents, market) {
    const maxC = config.groqMaxConcurrent ?? 1;
    const minDelay = config.groqMinDelayMs ?? 0;

    if (maxC <= 1) {
        const decisions = [];
        for (let i = 0; i < agents.length; i++) {
            try {
                decisions.push(await getAgentDecision(agents[i], market));
            } catch {
                decisions.push('HOLD');
            }
            if (minDelay > 0 && i < agents.length - 1) {
                await delay(minDelay);
            }
        }
        return decisions;
    }

    const decisions = new Array(agents.length);
    for (let i = 0; i < agents.length; i += maxC) {
        const slice = agents.slice(i, i + maxC);
        const batch = await mapWithConcurrency(slice, maxC, async (agent, j) => {
            try {
                return await getAgentDecision(agent, market);
            } catch {
                return 'HOLD';
            }
        });
        for (let k = 0; k < batch.length; k++) {
            decisions[i + k] = batch[k];
        }
        if (minDelay > 0 && i + maxC < agents.length) {
            await delay(minDelay);
        }
    }
    return decisions;
}

async function runTick() {
    try {
        currentTick++;
        console.log(`\n⏱️  Tick ${currentTick}`);

        const agents = await getAllAgents();
        const market = await getMarketState();

        const allEvents = [];
        const decisions = await collectAgentDecisions(agents, market);

        const consumeFood = shouldConsumeFoodThisTick(currentTick, config.foodConsumeEveryNTicks ?? 2);

        for (let i = 0; i < agents.length; i++) {
            const action = decisions[i];
            const events = applyAction(agents[i], action, market, { consumeFood });
            for (const description of events) {
                allEvents.push({ tick: currentTick, description });
                console.log(`  ${description}`);
            }
        }

        await updateAgentsBatch(agents);
        await logEventsBatch(allEvents);

        // Update market prices
        updatePrices(market);
        await updateMarketState(currentTick, market.food_price, market.energy_price);
        const richest = [...agents].sort((a, b) => Number(b.credits) - Number(a.credits))[0];
        if (richest) {
            await saveTickSnapshot(currentTick, richest.id, Number(richest.credits));
        }
        const resolved = await resolveMaturedMarkets(currentTick);
        if (resolved.length) {
            console.log(`  ✅ Resolved markets: ${resolved.join(', ')}`);
        }
        bustCache('sandbox:');
        console.log(`  📊 Market — Food: ${market.food_price} | Energy: ${market.energy_price}`);
    } catch (err) {
        console.error('❌ Tick error:', err.message);
    }
}

export function startSimulation() {
    if (running) return { message: 'Simulation already running' };
    running = true;
    intervalId = setInterval(runTick, config.tickInterval);
    console.log('🚀 Simulation started');
    const n = config.groqMaxConcurrent ?? 1;
    const d = config.groqMinDelayMs ?? 0;
    const foodN = config.foodConsumeEveryNTicks ?? 2;
    console.log(
        `   Economy: food drains 1 unit every ${foodN} tick(s) · Groq: ${n} concurrent · ${d}ms between sequential calls`
    );
    console.log(
        `   Tip: keep TICK_INTERVAL_MS ≥ (agents × GROQ_MIN_DELAY_MS) + buffer to stay under Groq RPM limits.`
    );
    return { message: 'Simulation started', tick: currentTick };
}

export function stopSimulation() {
    if (!running) return { message: 'Simulation is not running' };
    clearInterval(intervalId);
    intervalId = null;
    running = false;
    console.log('⏸️  Simulation stopped');
    return { message: 'Simulation stopped', tick: currentTick };
}

export function getSimulationStatus() {
    return { running, tick: currentTick };
}

/**
 * Stop the tick loop and set **currentTick** from the latest **market_state** row (usually 0 after `npm run db:reset`).
 * Call this after wiping the DB while the server stays up, so the next tick doesn’t continue from an old tick number.
 */
export async function resetSimulationState() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
    running = false;
    try {
        const ms = await getMarketState();
        currentTick = Number(ms.tick) || 0;
    } catch {
        currentTick = 0;
    }
    console.log(`🔁 Simulation state reset (tick=${currentTick}, synced from DB).`);
    return { message: 'Simulation reset', tick: currentTick, running: false };
}
