import config from '../config/index.js';

const MIN_KEY_LEN = 12;

/**
 * Requires Authorization: Bearer <ADMIN_API_KEY> or X-Admin-Key header.
 * Set ADMIN_API_KEY in the server environment (min 12 characters).
 */
export async function requireAdmin(request, reply) {
    const key = config.adminApiKey;
    if (!key || String(key).length < MIN_KEY_LEN) {
        return reply.code(503).send({
            error: `Server misconfiguration: set ADMIN_API_KEY in the environment (min ${MIN_KEY_LEN} characters).`,
        });
    }
    const auth = request.headers.authorization;
    const bearer =
        auth && typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    const xAdmin = request.headers['x-admin-key'];
    const provided = bearer || xAdmin;
    if (!provided || provided !== key) {
        return reply.code(403).send({ error: 'Forbidden: admin credentials required.' });
    }
}
