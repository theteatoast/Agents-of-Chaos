import pool from '../db/index.js';

export async function getAllAgents() {
    const { rows } = await pool.query('SELECT * FROM agents ORDER BY id');
    return rows;
}

export async function updateAgent(id, fields) {
    const { credits, food, energy, status, last_action } = fields;
    await pool.query(
        `UPDATE agents SET credits = $1, food = $2, energy = $3, status = $4, last_action = $5 WHERE id = $6`,
        [credits, food, energy, status, last_action, id]
    );
}

export async function updateAgentsBatch(agents) {
    if (!agents.length) return;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const agent of agents) {
            await client.query(
                `UPDATE agents
                 SET credits = $1, food = $2, energy = $3, status = $4, last_action = $5
                 WHERE id = $6`,
                [agent.credits, agent.food, agent.energy, agent.status, agent.last_action, agent.id]
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
