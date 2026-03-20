import { startSimulation, stopSimulation, getSimulationStatus } from '../simulation/tickEngine.js';

export default async function simulationRoutes(fastify) {
    const startHandler = async () => ({ domain: 'sandbox', ...startSimulation() });
    const stopHandler = async () => ({ domain: 'sandbox', ...stopSimulation() });
    const statusHandler = async () => ({ domain: 'sandbox', ...getSimulationStatus() });

    fastify.post('/simulation/start', startHandler);
    fastify.post('/simulation/stop', stopHandler);
    fastify.get('/simulation/status', statusHandler);

    fastify.post('/sandbox/simulation/start', startHandler);
    fastify.post('/sandbox/simulation/stop', stopHandler);
    fastify.get('/sandbox/simulation/status', statusHandler);
}
