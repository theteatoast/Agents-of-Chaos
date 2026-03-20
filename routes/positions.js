import { getPositions, claimWinnings } from '../services/predictionMarketService.js';

export default async function positionsRoutes(fastify) {
    fastify.get('/positions/:walletAddress', async (request, reply) => {
        const { walletAddress } = request.params;
        if (!walletAddress) return reply.code(400).send({ error: 'walletAddress required' });
        const positions = await getPositions(walletAddress);
        return { walletAddress: walletAddress.toLowerCase(), positions };
    });

    fastify.post('/positions/:walletAddress/claim', async (request, reply) => {
        try {
            const { walletAddress } = request.params;
            const { marketId } = request.body || {};
            const result = await claimWinnings(walletAddress, Number(marketId));
            return { claim: result };
        } catch (error) {
            return reply.code(400).send({ error: error.message });
        }
    });
}
