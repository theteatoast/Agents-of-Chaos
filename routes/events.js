import { getRecentEvents } from '../services/eventService.js';
import { withTtlCache } from '../services/cacheService.js';

export default async function eventRoutes(fastify) {
    const handler = async () => {
        const events = await withTtlCache('sandbox:events', 1200, () => getRecentEvents());
        return { domain: 'sandbox', events };
    };

    fastify.get('/events', handler);
    fastify.get('/sandbox/events', handler);
}
