import { getMarketState } from '../services/marketService.js';
import { withTtlCache } from '../services/cacheService.js';

export default async function marketRoutes(fastify) {
    const handler = async () => {
        const market = await withTtlCache('sandbox:market', 1200, () => getMarketState());
        return { domain: 'sandbox', market };
    };

    fastify.get('/market', handler);
    fastify.get('/sandbox/market', handler);
}
