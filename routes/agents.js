import { getAllAgents } from '../services/agentService.js';
import { withTtlCache } from '../services/cacheService.js';

export default async function agentRoutes(fastify) {
    const handler = async () => {
        const agents = await withTtlCache('sandbox:agents', 1500, () => getAllAgents());
        return { domain: 'sandbox', agents };
    };

    fastify.get('/agents', handler);
    fastify.get('/sandbox/agents', handler);
}
