import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config/index.js';
import agentRoutes from './routes/agents.js';
import marketRoutes from './routes/market.js';
import eventRoutes from './routes/events.js';
import simulationRoutes from './routes/simulation.js';
import predictionMarketRoutes from './routes/predictionMarkets.js';
import walletRoutes from './routes/wallet.js';
import positionsRoutes from './routes/positions.js';
import { resolveMarketsByDeadline } from './services/predictionMarketService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });

// CORS
app.register(fastifyCors, { origin: true });

// Serve static dashboard
app.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/',
});

// Register API routes
app.register(agentRoutes);
app.register(marketRoutes);
app.register(eventRoutes);
app.register(simulationRoutes);
app.register(predictionMarketRoutes);
app.register(walletRoutes);
app.register(positionsRoutes);

// Start server
app.listen({ port: config.port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
        app.log.error(err);
        process.exit(1);
    }
    console.log(`\n🏦 Agents of Chaos running at ${address}`);
    console.log('   Dashboard → http://localhost:' + config.port);
    console.log('   Agents: economy (earn / trade / scam / starve) · humans bet on richest');
    console.log('   POST /simulation/start  → begin simulation');
    console.log('   POST /simulation/stop   → pause simulation\n');

    setInterval(() => {
        resolveMarketsByDeadline()
            .then((ids) => {
                if (ids.length) app.log.info({ resolvedMarketIds: ids }, 'Markets resolved by betting deadline');
            })
            .catch((e) => app.log.error(e));
    }, 5000);
});
