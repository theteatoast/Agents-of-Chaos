const cache = new Map();

export async function withTtlCache(key, ttlMs, fn) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = await fn();
    cache.set(key, { value, expiresAt: now + ttlMs });
    return value;
}

export function bustCache(prefix) {
    for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
    }
}
