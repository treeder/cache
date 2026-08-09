/**
 * Generic Caching Library Core
 * Framework-agnostic caching kernel with storage adapters, version management, and SWR.
 */

/**
 * Memory Adapter for local/in-memory caching and node testing environment.
 */
export class MemoryAdapter {
  constructor() {
    this.store = new Map()
    this.ttlMap = new Map()
  }

  _isExpired(key) {
    const exp = this.ttlMap.get(key)
    if (exp && Date.now() > exp) {
      this.store.delete(key)
      this.ttlMap.delete(key)
      return true
    }
    return false
  }

  async get(key) {
    if (this._isExpired(key)) return null
    return this.store.get(key) ?? null
  }

  async put(key, val, { expirationTtl } = {}) {
    this.store.set(key, String(val))
    if (expirationTtl) {
      this.ttlMap.set(key, Date.now() + expirationTtl * 1000)
    } else {
      this.ttlMap.delete(key)
    }
  }

  async delete(key) {
    this.store.delete(key)
    this.ttlMap.delete(key)
  }

  async getJSON(key) {
    const raw = await this.get(key)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async putJSON(key, val, opts = {}) {
    await this.put(key, JSON.stringify(val), opts)
  }
}

/**
 * Cloudflare KV Adapter wrapping Workers KV binding instance.
 */
export class CloudflareKVAdapter {
  constructor(kvBinding) {
    this.kv = kvBinding
  }

  async get(key) {
    if (!this.kv) return null
    return await this.kv.get(key)
  }

  async put(key, val, opts = {}) {
    if (!this.kv) return
    await this.kv.put(key, val, opts)
  }

  async delete(key) {
    if (!this.kv) return
    await this.kv.delete(key)
  }

  async getJSON(key) {
    if (!this.kv) return null
    if (typeof this.kv.getJSON === 'function') {
      return await this.kv.getJSON(key)
    }
    const raw = await this.kv.get(key)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async putJSON(key, val, opts = {}) {
    if (!this.kv) return
    if (typeof this.kv.putJSON === 'function') {
      await this.kv.putJSON(key, val, opts)
    } else {
      await this.kv.put(key, JSON.stringify(val), opts)
    }
  }
}

/**
 * Deterministically hash query parameters into a short string fingerprint.
 * @param {Object} params - The query parameters
 * @returns {string} The parameter fingerprint
 */
export function hashQueryParams(params) {
  if (!params) return 'default'
  const keys = Object.keys(params).sort()
  const parts = keys.map((k) => {
    let val = params[k]
    if (typeof val === 'object' && val !== null) {
      val = JSON.stringify(val)
    }
    return `${k}=${val}`
  })
  const queryStr = parts.join('&')

  let hash = 0
  for (let i = 0; i < queryStr.length; i++) {
    const char = queryStr.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36)
}

let defaultAdapter = null

/**
 * Set global default cache adapter.
 * @param {Object|null} adapter
 */
export function setDefaultAdapter(adapter) {
  defaultAdapter = adapter
}

/**
 * Get global default cache adapter.
 * @returns {Object|null}
 */
export function getDefaultAdapter() {
  return defaultAdapter
}

/**
 * Generic Versioning Manager for cache invalidations.
 */
export const VersionManager = {
  async getVersion(adapter, key, { defaultTtl = 86400 } = {}) {
    const targetAdapter = adapter || defaultAdapter
    if (!targetAdapter) return String(Date.now())
    let version = await targetAdapter.get(key)
    if (!version) {
      version = String(Date.now())
      await targetAdapter.put(key, version, { expirationTtl: defaultTtl })
    }
    return version
  },

  async rotateVersion(adapter, key, { expirationTtl = 86400 } = {}) {
    const targetAdapter = adapter || defaultAdapter
    if (!targetAdapter) return
    await targetAdapter.put(key, String(Date.now()), { expirationTtl })
  },

  async deleteKeys(adapter, keys = []) {
    const targetAdapter = adapter || defaultAdapter
    if (!targetAdapter) return
    for (const key of keys) {
      if (key) await targetAdapter.delete(key)
    }
  },
}

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
  loggerLabel = '[cache]',
  logger = console,
  enableSWR = false,
  staleTtl = 3600,
  staleKey = `${cacheKey}:stale`,
  useJSON = true,
  serialize = String,
  deserialize = Number,
  shouldCache = (val) => val !== undefined && val !== null && !(val instanceof Response),
  waitUntil = (promise) => promise.catch(() => {}),
}) {
  const targetAdapter = adapter || defaultAdapter
  if (bypassCache || !targetAdapter) {
    return fetchFn()
  }

  try {
    // 1. Try primary cache read
    let cached
    if (useJSON) {
      cached = await targetAdapter.getJSON(cacheKey)
    } else {
      const raw = await targetAdapter.get(cacheKey)
      cached = raw !== null && raw !== undefined ? deserialize(raw) : null
    }

    if (cached !== null && cached !== undefined) {
      if (logger?.log) {
        logger.log(`${loggerLabel} cache hit for key ${cacheKey}`)
      }
      return cached
    }

    // 2. If SWR enabled, check stale cache
    if (enableSWR) {
      let stale
      if (useJSON) {
        stale = await targetAdapter.getJSON(staleKey)
      } else {
        const raw = await targetAdapter.get(staleKey)
        stale = raw !== null && raw !== undefined ? deserialize(raw) : null
      }

      if (stale !== null && stale !== undefined) {
        if (logger?.log) {
          logger.log(`${loggerLabel} stale cache hit for key ${cacheKey}, triggering async revalidation`)
        }
        waitUntil(
          (async () => {
            try {
              const freshData = await fetchFn()
              if (shouldCache(freshData)) {
                if (useJSON) {
                  await targetAdapter.putJSON(cacheKey, freshData, {
                    expirationTtl: ttl,
                  })
                  await targetAdapter.putJSON(staleKey, freshData, {
                    expirationTtl: staleTtl,
                  })
                } else {
                  const payload = serialize(freshData)
                  await targetAdapter.put(cacheKey, payload, { expirationTtl: ttl })
                  await targetAdapter.put(staleKey, payload, {
                    expirationTtl: staleTtl,
                  })
                }
                if (logger?.log) {
                  logger.log(`${loggerLabel} revalidation completed for key ${cacheKey}`)
                }
              }
            } catch (err) {
              if (logger?.error) {
                logger.error(`[SWR Revalidate Failed] ${loggerLabel}`, err)
              }
            }
          })(),
        )
        return stale
      }
    }

    if (logger?.log) {
      logger.log(`${loggerLabel} cache miss for key ${cacheKey}`)
    }
  } catch (err) {
    if (logger?.error) {
      logger.error(`${loggerLabel} cache read error`, err)
    }
  }

  const freshData = await fetchFn()

  try {
    if (shouldCache(freshData)) {
      waitUntil(
        (async () => {
          if (useJSON) {
            await targetAdapter.putJSON(cacheKey, freshData, { expirationTtl: ttl })
            if (enableSWR) {
              await targetAdapter.putJSON(staleKey, freshData, {
                expirationTtl: staleTtl,
              })
            }
          } else {
            const payload = serialize(freshData)
            await targetAdapter.put(cacheKey, payload, { expirationTtl: ttl })
            if (enableSWR) {
              await targetAdapter.put(staleKey, payload, { expirationTtl: staleTtl })
            }
          }
        })().catch((err) => {
          if (logger?.error) {
            logger.error(`${loggerLabel} cache put failed for key ${cacheKey}`, err)
          }
        }),
      )
    }
  } catch (err) {
    if (logger?.error) {
      logger.error(`${loggerLabel} cache schedule put error`, err)
    }
  }

  return freshData
}

/**
 * Cache wrapper class bound to an adapter instance or global default adapter.
 */
export class Cache {
  constructor({ adapter = null, ...defaultOptions } = {}) {
    this.adapter = adapter
    this.defaultOptions = defaultOptions
  }

  static setDefaultAdapter(adapter) {
    setDefaultAdapter(adapter)
  }

  static getDefaultAdapter() {
    return getDefaultAdapter()
  }

  get targetAdapter() {
    return this.adapter || defaultAdapter
  }

  async get(key) {
    const adp = this.targetAdapter
    if (!adp) return null
    return adp.get(key)
  }

  async put(key, val, opts) {
    const adp = this.targetAdapter
    if (!adp) return
    return adp.put(key, val, opts)
  }

  async delete(key) {
    const adp = this.targetAdapter
    if (!adp) return
    return adp.delete(key)
  }

  async getJSON(key) {
    const adp = this.targetAdapter
    if (!adp) return null
    return adp.getJSON(key)
  }

  async putJSON(key, val, opts) {
    const adp = this.targetAdapter
    if (!adp) return
    return adp.putJSON(key, val, opts)
  }

  /**
   * Wrap function call with caching.
   * Supports `cache.wrap({ cacheKey, fetchFn, ... })` or `cache.wrap(cacheKey, fetchFn, options)`
   */
  async wrap(firstArg, fetchFnArg, optionsArg = {}) {
    let opts = {}
    if (typeof firstArg === 'object' && firstArg !== null) {
      opts = firstArg
    } else if (typeof firstArg === 'string' && typeof fetchFnArg === 'function') {
      opts = { cacheKey: firstArg, fetchFn: fetchFnArg, ...optionsArg }
    } else {
      opts = firstArg || {}
    }

    return withCache({
      adapter: this.targetAdapter,
      ...this.defaultOptions,
      ...opts,
    })
  }

  async getVersion(key, opts) {
    return VersionManager.getVersion(this.targetAdapter, key, opts)
  }

  async rotateVersion(key, opts) {
    return VersionManager.rotateVersion(this.targetAdapter, key, opts)
  }

  async deleteKeys(keys) {
    return VersionManager.deleteKeys(this.targetAdapter, keys)
  }
}
