import OpenAI from 'openai';
import config from '../config/index.js';

const groq = new OpenAI({
    apiKey: config.groqApiKey,
    baseURL: 'https://api.groq.com/openai/v1',
});

const VALID_ACTIONS = ['WORK', 'BUY_FOOD', 'BUY_ENERGY', 'SELL_FOOD', 'SELL_ENERGY', 'HOLD'];

export async function getAgentDecision(agent, market) {
    const prompt = `You are an AI agent named "${agent.name}" in a simulated economy.
Your personality: ${agent.personality}

Current State:
Credits: ${agent.credits}
Food: ${agent.food}
Energy: ${agent.energy}
Food price: ${market.food_price}
Energy price: ${market.energy_price}

Choose ONE action:
WORK / BUY_FOOD / BUY_ENERGY / SELL_FOOD / SELL_ENERGY / HOLD

Respond ONLY with the action name.`;

    try {
        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 10,
            temperature: 0.7,
        });

        const raw = response.choices[0]?.message?.content?.trim().toUpperCase() || 'HOLD';
        // Extract valid action from response
        const action = VALID_ACTIONS.find((a) => raw.includes(a));
        return action || 'HOLD';
    } catch (err) {
        console.error(`⚠️  Groq error for ${agent.name}:`, err.message);
        return 'HOLD';
    }
}
