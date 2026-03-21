import OpenAI from 'openai';
import config from '../config/index.js';

const groq = new OpenAI({
    apiKey: config.groqApiKey,
    baseURL: 'https://api.groq.com/openai/v1',
});

const VALID_ACTIONS = ['WORK', 'BUY_FOOD', 'BUY_ENERGY', 'SELL_FOOD', 'SELL_ENERGY', 'HOLD'];

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isRateLimitError(err) {
    const status = err?.status ?? err?.response?.status;
    const code = err?.code;
    return status === 429 || code === 'rate_limit_exceeded' || /rate limit|429/i.test(String(err?.message));
}

export async function getAgentDecision(agent, market) {
    const food = Number(agent.food);
    const fp = Number(market.food_price);
    const survivalHint =
        food <= 2
            ? `\nSURVIVAL: Food is critically low. If Credits >= Food price (${fp}), prefer BUY_FOOD. If you cannot afford food, use WORK to earn credits.`
            : food <= 5
              ? `\nHint: Keep food above 3 when possible — you lose food over time.`
              : '';

    const prompt = `You are an AI agent named "${agent.name}" in a simulated economy.
Your personality: ${agent.personality}

Current State:
Credits: ${agent.credits}
Food: ${agent.food}
Energy: ${agent.energy}
Food price: ${market.food_price}
Energy price: ${market.energy_price}
${survivalHint}

Choose ONE action:
WORK / BUY_FOOD / BUY_ENERGY / SELL_FOOD / SELL_ENERGY / HOLD

Respond ONLY with the action name.`;

    const maxRetries = config.groqMaxRetries ?? 3;
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 12,
                temperature: 0.45,
            });

            const raw = response.choices[0]?.message?.content?.trim().toUpperCase() || 'HOLD';
            const action = VALID_ACTIONS.find((a) => raw.includes(a));
            return action || 'HOLD';
        } catch (err) {
            lastErr = err;
            const retryAfter = parseInt(err?.response?.headers?.['retry-after'], 10);
            const backoffMs = Number.isFinite(retryAfter)
                ? retryAfter * 1000
                : Math.min(30_000, 800 * 2 ** attempt);
            if (isRateLimitError(err) && attempt < maxRetries) {
                console.warn(
                    `⚠️  Groq rate limit for ${agent.name} — retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms`
                );
                await sleep(backoffMs);
                continue;
            }
            console.error(`⚠️  Groq error for ${agent.name}:`, err.message);
            return 'HOLD';
        }
    }
    console.error(`⚠️  Groq gave up for ${agent.name}:`, lastErr?.message);
    return 'HOLD';
}
