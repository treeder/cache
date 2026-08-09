/**
 * Generic Caching Library Core
 * Framework-agnostic caching kernel with storage adapters, version management, and SWR.
 */

/**
 * Memory Adapter for local/in-memory caching and node testing environment.
 */
export class MemoryAdapter {
  constructor() {
    this.store = new Map();
    this.ttlMap = new Map();
  }

  _isExpired(key) {
    const exp = this.ttlMap.get(key);
    if (exp && Date.now() > exp) {
      this.store.delete(key);
      this.ttlMap.delete(key);
      return true;
    }
    return false;
  }

  async get(key) {
    if (this._isExpired(key)) return null;
    return this.store.get(key) ?? null;
  }

  async put(key, val, { expirationTtl } = {}) {
    this.store.set(key, String(val));
    if (expirationTtl) {
      this.ttlMap.set(key, Date.now() + expirationTtl * 1000);
    } else {
      this.ttlMap.delete(key);
    }
  }

  async delete(key) {
    this.store.delete(key);
    this.ttlMap.delete(key);
  }

  async getJSON(key) {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async putJSON(key, val, opts = {}) {
    await this.put(key, JSON.stringify(val), opts);
  }
}

/**
 * Cloudflare KV Adapter wrapping Workers KV binding instance.
 */
export class CloudflareKVAdapter {
  constructor(kvBinding) {
    this.kv = kvBinding;
  }

  async get(key) {
    if (!this.kv) return null;
    return await this.kv.get(key);
  }

  async put(key, val, opts = {}) {
    if (!this.kv) return;
    await this.kv.put(key, val, opts);
  }

  async delete(key) {
    if (!this.kv) return;
    await this.kv.delete(key);
  }

  async getJSON(key) {
    if (!this.kv) return null;
    if (typeof this.kv.getJSON === "function") {
      return await this.kv.getJSON(key);
    }
    const raw = await this.kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async putJSON(key, val, opts = {}) {
    if (!this.kv) return;
    if (typeof this.kv.putJSON === "function") {
      await this.kv.putJSON(key, val, opts);
    } else {
      await this.kv.put(key, JSON.stringify(val), opts);
    }
  }
}

/**
 * Deterministically hash query parameters into a short string fingerprint.
 * @param {Object} params - The query parameters
 * @returns {string} The parameter fingerprint
 */
export function hashQueryParams(params) {
  if (!params) return "default";
  const keys = Object.keys(params).sort();
  const parts = keys.map((k) => {
    let val = params[k];
    if (typeof val === "object" && val !== null) {
      val = JSON.stringify(val);
    }
    return `${k}=${val}`;
  });
  const queryStr = parts.join("&");

  let hash = 0;
  for (let i = 0; i < queryStr.length; i++) {
    const char = queryStr.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Generic Versioning Manager for cache invalidations.
 */
export const VersionManager = {
  async getVersion(adapter, key, { defaultTtl = 86400 } = {}) {
    if (!adapter) return String(Date.now());
    let version = await adapter.get(key);
    if (!version) {
      version = String(Date.now());
      await adapter.put(key, version, { expirationTtl: defaultTtl });
    }
    return version;
  },

  async rotateVersion(adapter, key, { expirationTtl = 86400 } = {}) {
    if (!adapter) return;
    await adapter.put(key, String(Date.now()), { expirationTtl });
  },

  async deleteKeys(adapter, keys = []) {
    if (!adapter) return;
    for (const key of keys) {
      if (key) await adapter.delete(key);
    }
  },
};

/**
 * Core generic `withCache` function.
 * Handles cache hits, misses, optional SWR revalidation, and background scheduling.
 */
export async function withCache({
  adapter,
  cacheKey,
  fetchFn,
  bypassCache = false,
  ttl = 300,
  loggerLabel = "[cache]",
  logger = console,
  enableSWR = false,
  staleTtl = 3600,
  staleKey = `${cacheKey}:stale`,
  useJSON = true,
  serialize = String,
  deserialize = Number,
  shouldCache = (val) =>
    val !== undefined && val !== null && !(val instanceof Response),
  waitUntil = (promise) => promise.catch(() => {}),
}) {
  if (bypassCache || !adapter) {
    return fetchFn();
  }

  try {
    // 1. Try primary cache read
    let cached;
    if (useJSON) {
      cached = await adapter.getJSON(cacheKey);
    } else {
      const raw = await adapter.get(cacheKey);
      cached = raw !== null && raw !== undefined ? deserialize(raw) : null;
    }

    if (cached !== null && cached !== undefined) {
      if (logger?.log) {
        logger.log(`${loggerLabel} cache hit for key ${cacheKey}`);
      }
      return cached;
    }

    // 2. If SWR enabled, check stale cache
    if (enableSWR) {
      let stale;
      if (useJSON) {
        stale = await adapter.getJSON(staleKey);
      } else {
        const raw = await adapter.get(staleKey);
        stale = raw !== null && raw !== undefined ? deserialize(raw) : null;
      }

      if (stale !== null && stale !== undefined) {
        if (logger?.log) {
          logger.log(
            `${loggerLabel} stale cache hit for key ${cacheKey}, triggering async revalidation`,
          );
        }
        waitUntil(
          (async () => {
            try {
              const freshData = await fetchFn();
              if (shouldCache(freshData)) {
                if (useJSON) {
                  await adapter.putJSON(cacheKey, freshData, {
                    expirationTtl: ttl,
                  });
                  await adapter.putJSON(staleKey, freshData, {
                    expirationTtl: staleTtl,
                  });
                } else {
                  const payload = serialize(freshData);
                  await adapter.put(cacheKey, payload, { expirationTtl: ttl });
                  await adapter.put(staleKey, payload, {
                    expirationTtl: staleTtl,
                  });
                }
                if (logger?.log) {
                  logger.log(
                    `${loggerLabel} revalidation completed for key ${cacheKey}`,
                  );
                }
              }
            } catch (err) {
              if (logger?.error) {
                logger.error(`[SWR Revalidate Failed] ${loggerLabel}`, err);
              }
            }
          })(),
        );
        return stale;
      }
    }

    if (logger?.log) {
      logger.log(`${loggerLabel} cache miss for key ${cacheKey}`);
    }
  } catch (err) {
    if (logger?.error) {
      logger.error(`${loggerLabel} cache read error`, err);
    }
  }

  const freshData = await fetchFn();

  try {
    if (shouldCache(freshData)) {
      waitUntil(
        (async () => {
          if (useJSON) {
            await adapter.putJSON(cacheKey, freshData, { expirationTtl: ttl });
            if (enableSWR) {
              await adapter.putJSON(staleKey, freshData, {
                expirationTtl: staleTtl,
              });
            }
          } else {
            const payload = serialize(freshData);
            await adapter.put(cacheKey, payload, { expirationTtl: ttl });
            if (enableSWR) {
              await adapter.put(staleKey, payload, { expirationTtl: staleTtl });
            }
          }
        })().catch((err) => {
          if (logger?.error) {
            logger.error(
              `${loggerLabel} cache put failed for key ${cacheKey}`,
              err,
            );
          }
        }),
      );
    }
  } catch (err) {
    if (logger?.error) {
      logger.error(`${loggerLabel} cache schedule put error`, err);
    }
  }

  return freshData;
}

export { withCache as withCacheGeneric };

