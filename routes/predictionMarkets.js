import config from '../config/index.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { getContractAbi, getBetPrecheck, simulateBet, simulateExitStake } from '../services/chainSync.js';
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
        market_model: 'parimutuel',
        /** True when ADMIN_API_KEY is set (min length) — required for simulation control & creating markets via API. */
        admin_configured: Boolean(config.adminApiKey && String(config.adminApiKey).length >= 12),
    }));

    fastify.get('/markets/abi', async () => ({
        abi: getContractAbi(),
    }));

    fastify.post('/markets', { preHandler: requireAdmin }, async (request, reply) => {
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

    /** Server-side chain reads (RPC) — use for bet UX so wallet RPC quirks (e.g. Rabby) don’t break reads. */
    fastify.get('/markets/:marketId/precheck', async (request, reply) => {
        try {
            const marketId = Number(request.params.marketId);
            const wallet = request.query?.wallet || '';
            const outcomeIndex = request.query?.outcomeIndex;
            const precheck = await getBetPrecheck(marketId, wallet, outcomeIndex);
            return { precheck };
        } catch (error) {
            return reply.code(400).send({ error: error.message });
        }
    });

    /** Dry-run `bet` on server RPC — catches BadOutcome / TradingClosed / allowance before wallet tx (helps Rabby). */
    fastify.post('/markets/:marketId/simulate-bet', async (request, reply) => {
        try {
            const marketId = Number(request.params.marketId);
            const { outcomeIndex, gross_smallest, wallet } = request.body || {};
            const gross = BigInt(String(gross_smallest ?? '0'));
            const result = await simulateBet(marketId, Number(outcomeIndex), gross, String(wallet || ''));
            return { ok: true, gas_limit: result.gas_limit || null };
        } catch (error) {
            let msg = String(error?.shortMessage || error?.reason || error?.message || error);
            if (/BadOutcome|outcome/i.test(msg)) {
                msg +=
                    ' — On-chain outcomeCount may not match your DB (re-run register:market with correct outcome count) or pick another agent.';
            }
            if (/TradingClosed|closed/i.test(msg)) {
                msg += ' — Betting deadline has passed on-chain.';
            }
            if (/allowance|ERC20/i.test(msg)) {
                msg += ' — Approve USDC for the market contract first.';
            }
            return reply.code(400).send({ error: msg });
        }
    });

    /** Dry-run `exitStake` — full stake return before betting closes. */
    fastify.post('/markets/:marketId/simulate-exit', async (request, reply) => {
        try {
            const marketId = Number(request.params.marketId);
            const { outcomeIndex, wallet } = request.body || {};
            const result = await simulateExitStake(marketId, Number(outcomeIndex), String(wallet || ''));
            return { ok: true, gas_limit: result.gas_limit || null };
        } catch (error) {
            let msg = String(error?.shortMessage || error?.reason || error?.message || error);
            if (/TradingClosed|closed/i.test(msg)) {
                msg += ' — Betting closed on-chain; use claim() after resolution if you won.';
            }
            if (/NothingToExit|stake/i.test(msg)) {
                msg += ' — No net stake on this outcome for your wallet.';
            }
            return reply.code(400).send({ error: msg });
        }
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

    /** DB-only unverified trades — admin only (same key as simulation). */
    fastify.post('/markets/trade', { preHandler: requireAdmin }, async (request, reply) => {
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
