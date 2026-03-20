import crypto from 'crypto';
import { verifyMessage, isAddress, getAddress } from 'ethers';
import pool from '../db/index.js';
import config from '../config/index.js';

function buildChallenge(address, nonce) {
    return [
        'Agents of Chaos wallet authentication',
        `Address: ${address}`,
        `Chain ID: ${config.baseChainId}`,
        `Nonce: ${nonce}`,
    ].join('\n');
}

export async function createAuthChallenge(walletAddress) {
    if (!isAddress(walletAddress)) {
        throw new Error('Invalid wallet address');
    }
    const normalized = getAddress(walletAddress).toLowerCase();
    const nonce = crypto.randomBytes(16).toString('hex');
    await pool.query(
        `INSERT INTO user_wallet_links (wallet_address, auth_nonce, nonce_expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
         ON CONFLICT (wallet_address)
         DO UPDATE SET auth_nonce = EXCLUDED.auth_nonce, nonce_expires_at = EXCLUDED.nonce_expires_at`,
        [normalized, nonce]
    );
    return { message: buildChallenge(normalized, nonce), nonce, walletAddress: normalized };
}

export async function verifyAuthChallenge(walletAddress, signature) {
    if (!isAddress(walletAddress)) throw new Error('Invalid wallet address');
    const normalized = getAddress(walletAddress).toLowerCase();
    const { rows } = await pool.query(
        `SELECT auth_nonce, nonce_expires_at
         FROM user_wallet_links
         WHERE wallet_address = $1`,
        [normalized]
    );
    const rec = rows[0];
    if (!rec?.auth_nonce) throw new Error('No active challenge');
    if (new Date(rec.nonce_expires_at) < new Date()) throw new Error('Challenge expired');

    const message = buildChallenge(normalized, rec.auth_nonce);
    const recovered = verifyMessage(message, signature).toLowerCase();
    if (recovered !== normalized) throw new Error('Signature mismatch');

    await pool.query(
        `UPDATE user_wallet_links
         SET last_authenticated_at = NOW(), auth_nonce = NULL, nonce_expires_at = NULL
         WHERE wallet_address = $1`,
        [normalized]
    );
    return { walletAddress: normalized, authenticated: true };
}
