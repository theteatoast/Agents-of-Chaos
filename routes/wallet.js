import { createAuthChallenge, verifyAuthChallenge } from '../services/walletService.js';

export default async function walletRoutes(fastify) {
    fastify.post('/wallet/challenge', async (request, reply) => {
        try {
            const { walletAddress } = request.body || {};
            const challenge = await createAuthChallenge(walletAddress);
            return { challenge };
        } catch (error) {
            return reply.code(400).send({ error: error.message });
        }
    });

    fastify.post('/wallet/verify', async (request, reply) => {
        try {
            const { walletAddress, signature } = request.body || {};
            const result = await verifyAuthChallenge(walletAddress, signature);
            return { result };
        } catch (error) {
            return reply.code(400).send({ error: error.message });
        }
    });
}
