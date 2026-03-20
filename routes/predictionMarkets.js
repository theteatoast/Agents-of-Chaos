import {
    listMarkets,
    createMarket,
    getMarketOutcomes,
    quoteTrade,
    executeTrade,
    getProtocolFeesDaily,
} from '../services/predictionMarketService.js';

export default async function predictionMarketRoutes(fastify) {
    fastify.get('/markets', async () => {
        const markets = await listMarkets();
        return { domain: 'usdc', chain: 'base', markets };
    });

    fastify.post('/markets', async (request, reply) => {
        const { slug, title, settlementTick, feeBps } = request.body || {};
        if (!slug || !title || !settlementTick) {
            return reply.code(400).send({ error: 'slug, title, settlementTick are required' });
        }
        const market = await createMarket({ slug, title, settlementTick, feeBps });
        return { market };
    });

    fastify.get('/markets/:marketId/outcomes', async (request) => {
        const marketId = Number(request.params.marketId);
        const outcomes = await getMarketOutcomes(marketId);
        return { marketId, outcomes };
    });

    fastify.post('/markets/quote', async (request, reply) => {
        try {
            const quote = await quoteTrade(request.body || {});
            return { quote };
        } catch (error) {
            return reply.code(400).send({ error: error.message });
        }
    });

    fastify.post('/markets/trade', async (request, reply) => {
        try {
            const trade = await executeTrade(request.body || {});
            return { trade };
        } catch (error) {
            return reply.code(400).send({ error: error.message });
        }
    });

    fastify.get('/markets/fees/daily', async () => {
        const fees = await getProtocolFeesDaily();
        return { fees };
    });
}
