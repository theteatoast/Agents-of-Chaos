import { startSimulation, stopSimulation, getSimulationStatus } from '../simulation/tickEngine.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

export default async function simulationRoutes(fastify) {
    const startHandler = async () => ({ domain: 'sandbox', ...startSimulation() });
    const stopHandler = async () => ({ domain: 'sandbox', ...stopSimulation() });
    const statusHandler = async () => ({ domain: 'sandbox', ...getSimulationStatus() });

    fastify.post('/simulation/start', { preHandler: requireAdmin }, startHandler);
    fastify.post('/simulation/stop', { preHandler: requireAdmin }, stopHandler);
    fastify.get('/simulation/status', statusHandler);

    fastify.post('/sandbox/simulation/start', { preHandler: requireAdmin }, startHandler);
    fastify.post('/sandbox/simulation/stop', { preHandler: requireAdmin }, stopHandler);
    fastify.get('/sandbox/simulation/status', statusHandler);
}
