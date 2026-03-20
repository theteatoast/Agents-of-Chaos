import config from '../config/index.js';
import { getContractAbi } from '../services/chainSync.js';
import {
    listMarkets,
    createMarket,
    getMarketOutcomes,
    quoteTrade,
    executeTrade,
    getProtocolFeesDaily,
    getTransparencyPayload,
    syncTradeFromTxHash,
} from '../services/predictionMarketService.js';

const confirmBuckets = new Map();

function rateLimitConfirm(ip) {
    const now = Date.now();
    const windowMs = 60_000;
    const max = 30;
    const key = ip || 'unknown';
    const b = confirmBuckets.get(key) || { c: 0, t: now };
    if (now - b.t > windowMs) {
        b.c = 0;
        b.t = now;
    }
    b.c += 1;
    confirmBuckets.set(key, b);
    return b.c <= max;
}

export default async function predictionMarketRoutes(fastify) {
    fastify.get('/markets', async () => {
        const markets = await listMarkets();
        return { domain: 'usdc', chain: 'base', markets };
    });

    fastify.get('/markets/transparency', async () => ({
        transparency: getTransparencyPayload(),
    }));

    fastify.get('/markets/config', async () => ({
        chain_id: config.baseChainId,
        rpc_url: config.baseRpcUrl,
        usdc_contract: config.usdcContractAddress,
        prediction_market_contract: config.predictionMarketContractAddress || null,
        treasury: config.protocolTreasuryAddress || null,
        fee_bps: config.protocolFeeBps,
        allow_unverified_trades: config.allowUnverifiedTrades,
    }));

    fastify.get('/markets/abi', async () => ({
        abi: getContractAbi(),
    }));

    fastify.post('/markets', async (request, reply) => {
        const { slug, title, settlementTick, feeBps, bettingOpensAt, bettingClosesAt } = request.body || {};
        if (!slug || !title || !settlementTick) {
            return reply.code(400).send({ error: 'slug, title, settlementTick are required' });
        }
        const market = await createMarket({
            slug,
            title,
            settlementTick,
            feeBps,
            bettingOpensAt,
            bettingClosesAt,
        });
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

    fastify.post('/markets/trade/confirm', async (request, reply) => {
        const ip = request.ip;
        if (!rateLimitConfirm(ip)) {
            return reply.code(429).send({ error: 'Too many confirm requests — try again shortly.' });
        }
        try {
            const { txHash } = request.body || {};
            const result = await syncTradeFromTxHash(txHash);
            return { ok: true, ...result };
        } catch (error) {
            return reply.code(400).send({ error: error.message });
        }
    });

    fastify.get('/markets/fees/daily', async () => {
        const fees = await getProtocolFeesDaily();
        return { fees };
    });
}
