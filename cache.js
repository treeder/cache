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

const DEFAULT_INFLIGHT_TTL_MS = 30_000
const RETRY_SENTINEL = Symbol('cache.retry')
const ABORTED_SENTINEL = Symbol('cache.aborted')

const now =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

function getSignalInfo(signalOpt, context) {
  if (signalOpt && typeof signalOpt === 'object' && 'aborted' in signalOpt) {
    return { signal: signalOpt, explicit: true }
  }
  if (context && typeof context === 'object') {
    for (const read of [() => context.request?.signal, () => context.req?.raw?.signal, () => context.signal]) {
      try {
        const signal = read()
        if (signal && typeof signal === 'object' && 'aborted' in signal) {
          return { signal, explicit: false }
        }
      } catch {}
    }
  }
  return { signal: null, explicit: false }
}

function getWaitUntilInfo(waitUntilOpt, context) {
  if (typeof waitUntilOpt === 'function') {
    return { fn: waitUntilOpt, hasLifecycle: true }
  }
  if (context && typeof context === 'object') {
    for (const getTarget of [() => context, () => context.executionCtx, () => context.ctx]) {
      try {
        const target = getTarget()
        if (typeof target?.waitUntil === 'function') {
          return { fn: target.waitUntil.bind(target), hasLifecycle: true }
        }
      } catch {}
    }
  }
  return { fn: null, hasLifecycle: false }
}

function safeWaitUntil(waitUntilFn, promise) {
  const guarded = Promise.resolve(promise).catch(() => {})
  if (typeof waitUntilFn === 'function') {
    try {
      waitUntilFn(guarded)
    } catch {}
  }
}

function toAbortError(signal) {
  return signal?.reason !== undefined ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
}

function isCrossRequestError(err) {
  if (!err) return false
  const msg = String(err?.message || err)
  return (
    msg.includes('created by a request that has since ended') ||
    msg.includes('handle_cross_request_promise_resolution') ||
    msg.includes('Cannot perform I/O on behalf of a different request')
  )
}

function isStaleEntry(entry, ttlMs) {
  if (!entry) return false
  if (entry.aborted || entry.signal?.aborted) return true
  if (Number.isFinite(ttlMs) && now() - entry.startedAt >= ttlMs) return true
  return false
}

function waitForEntry(entry, callerSignal, explicitCallerSignal, ttlMs) {
  if (explicitCallerSignal && callerSignal?.aborted) {
    return Promise.resolve(ABORTED_SENTINEL)
  }
  if (entry.aborted || entry.signal?.aborted) {
    return Promise.resolve(RETRY_SENTINEL)
  }
  const remainingMs = Number.isFinite(ttlMs)
    ? Math.min(0x7fffffff, Math.max(0, ttlMs - (now() - entry.startedAt)))
    : null
  if (remainingMs === 0) {
    return Promise.resolve(RETRY_SENTINEL)
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let ttlTimer = null

    const cleanup = () => {
      if (ttlTimer !== null) {
        clearTimeout(ttlTimer)
        ttlTimer = null
      }
      entry.abortListeners?.delete(onOriginAbort)
      if (explicitCallerSignal && callerSignal && typeof callerSignal.removeEventListener === 'function') {
        try {
          callerSignal.removeEventListener('abort', onCallerAbort)
        } catch {}
      }
    }

    const finish = (outcome) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }

    const finishError = (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const onOriginAbort = () => finish(RETRY_SENTINEL)
    const onCallerAbort = () => finish(ABORTED_SENTINEL)

    entry.abortListeners?.add(onOriginAbort)
    if (explicitCallerSignal && callerSignal && typeof callerSignal.addEventListener === 'function') {
      if (callerSignal.aborted) {
        onCallerAbort()
        return
      }
      callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }

    if (remainingMs !== null) {
      ttlTimer = setTimeout(() => {
        ttlTimer = null
        finish(RETRY_SENTINEL)
      }, remainingMs)
    }

    ;(async () => await entry.promise)().then(
      (val) => finish(val),
      (err) => finishError(err),
    )
  })
}

/**
 * Global maps tracking active in-flight foreground fetches and background SWR revalidations by cache key.
 */
const inFlightFetches = new Map()
const inFlightRevalidations = new Map()

/**
 * Returns the current number of in-flight requests.
 */
export function getInFlightCount() {
  return inFlightFetches.size + inFlightRevalidations.size
}

/**
 * Clears all active in-flight request trackers.
 */
export function clearInFlight() {
  inFlightFetches.clear()
  inFlightRevalidations.clear()
}

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
    const current = await targetAdapter.get(key)
    let nextVersion = String(Date.now())
    if (nextVersion === current) {
      nextVersion = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    }
    await targetAdapter.put(key, nextVersion, { expirationTtl })
    return nextVersion
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
 * Handles cache hits, misses, optional SWR revalidation, single-key metadata wrapping, automatic versioning, and cross-request safe in-flight request coalescing.
 */
export async function withCache({
  adapter,
  cacheKey,
  versionKey = null,
  fetchFn,
  bypassCache = false,
  ttl = 300,
  loggerLabel = '[cache]',
  logger = console,
  enableSWR = false,
  staleTtl = 3600,
  useJSON = true,
  serialize = String,
  deserialize = Number,
  shouldCache = (val) => val !== undefined && val !== null && !(val instanceof Response),
  waitUntil,
  signal,
  context = null,
  inFlightTtlMs = DEFAULT_INFLIGHT_TTL_MS,
}) {
  const { signal: callerSignal, explicit: explicitSignal } = getSignalInfo(signal, context)
  if (explicitSignal && callerSignal?.aborted) {
    throw toAbortError(callerSignal)
  }

  const targetAdapter = adapter || defaultAdapter
  if (bypassCache || !targetAdapter) {
    return fetchFn()
  }

  const { fn: waitUntilFn, hasLifecycle: hasLifecycleWaitUntil } = getWaitUntilInfo(waitUntil, context)
  const effectiveInFlightTtlMs =
    typeof inFlightTtlMs === 'number' && inFlightTtlMs > 0 ? inFlightTtlMs : DEFAULT_INFLIGHT_TTL_MS

  let effectiveKey = cacheKey
  if (versionKey) {
    const version = await VersionManager.getVersion(targetAdapter, versionKey)
    if (version) {
      effectiveKey = `${versionKey}:${version}:${cacheKey}`
    }
  }

  const storageTtl = enableSWR ? staleTtl : ttl

  async function writeEnvelope(data) {
    const writeTime = Date.now()
    const payload = useJSON ? data : serialize(data)
    const envelope = {
      _swr: true,
      v: payload,
      e: writeTime + ttl * 1000,
      s: enableSWR ? writeTime + staleTtl * 1000 : writeTime + ttl * 1000,
    }
    const opts = { expirationTtl: storageTtl }
    if (typeof targetAdapter.putJSON === 'function') {
      await targetAdapter.putJSON(effectiveKey, envelope, opts)
    } else {
      await targetAdapter.put(effectiveKey, JSON.stringify(envelope), opts)
    }
  }

  try {
    // 1. Try single-key metadata read
    let envelope = null
    if (typeof targetAdapter.getJSON === 'function') {
      envelope = await targetAdapter.getJSON(effectiveKey)
    } else {
      const raw = await targetAdapter.get(effectiveKey)
      if (raw !== null && raw !== undefined) {
        try {
          envelope = JSON.parse(raw)
        } catch {
          envelope = raw
        }
      }
    }

    if (envelope !== null && envelope !== undefined) {
      const isEnvelope = typeof envelope === 'object' && envelope !== null && envelope._swr === true

      if (isEnvelope) {
        const readTime = Date.now()
        const value = useJSON ? envelope.v : deserialize(envelope.v)

        if (readTime <= envelope.e) {
          // Fresh Cache Hit
          if (logger?.log) {
            logger.log(`${loggerLabel} cache hit for key ${effectiveKey}`)
          }
          return value
        }

        if (enableSWR && readTime <= envelope.s) {
          // Stale Cache Hit -> Return stale value & trigger background revalidation (if not actively in-flight)
          if (logger?.log) {
            logger.log(`${loggerLabel} stale cache hit for key ${effectiveKey}, triggering async revalidation`)
          }

          const existingReval = inFlightRevalidations.get(effectiveKey)
          if (existingReval && isStaleEntry(existingReval, effectiveInFlightTtlMs)) {
            inFlightRevalidations.delete(effectiveKey)
          }
          const existingFetch = inFlightFetches.get(effectiveKey)
          if (existingFetch && isStaleEntry(existingFetch, effectiveInFlightTtlMs)) {
            inFlightFetches.delete(effectiveKey)
          }

          if (!inFlightRevalidations.has(effectiveKey) && !inFlightFetches.has(effectiveKey)) {
            const revalEntry = {
              promise: null,
              startedAt: now(),
              signal: hasLifecycleWaitUntil ? null : callerSignal,
              aborted: false,
            }

            const revalidatePromise = (async () => {
              try {
                const freshData = await fetchFn()
                if (shouldCache(freshData)) {
                  await writeEnvelope(freshData)
                  if (logger?.log) {
                    logger.log(`${loggerLabel} revalidation completed for key ${effectiveKey}`)
                  }
                }
              } catch (err) {
                if (logger?.error) {
                  logger.error(`[SWR Revalidate Failed] ${loggerLabel}`, err)
                }
              }
            })().finally(() => {
              if (inFlightRevalidations.get(effectiveKey) === revalEntry) {
                inFlightRevalidations.delete(effectiveKey)
              }
            })

            revalEntry.promise = revalidatePromise
            inFlightRevalidations.set(effectiveKey, revalEntry)
            safeWaitUntil(waitUntilFn, revalidatePromise)
          }

          return value
        }

        // Expired Cache Entry
        if (logger?.log) {
          logger.log(`${loggerLabel} expired cache entry for key ${effectiveKey}`)
        }
      }
    }

    if (logger?.log) {
      logger.log(`${loggerLabel} cache miss for key ${effectiveKey}`)
    }
  } catch (err) {
    if (logger?.error) {
      logger.error(`${loggerLabel} cache read error`, err)
    }
  }

  // 2. Request Coalescing / In-flight deduplication for Cache Misses
  let joinAttempts = 0
  const MAX_JOIN_ATTEMPTS = 3

  while (joinAttempts < MAX_JOIN_ATTEMPTS) {
    const existing = inFlightFetches.get(effectiveKey)
    if (!existing) break

    if (isStaleEntry(existing, effectiveInFlightTtlMs)) {
      inFlightFetches.delete(effectiveKey)
      break
    }

    joinAttempts++
    if (logger?.log) {
      logger.log(`${loggerLabel} joining in-flight request for key ${effectiveKey}`)
    }

    try {
      const outcome = await waitForEntry(existing, callerSignal, explicitSignal, effectiveInFlightTtlMs)
      if (outcome === ABORTED_SENTINEL) {
        throw toAbortError(callerSignal)
      }
      if (outcome === RETRY_SENTINEL) {
        if (inFlightFetches.get(effectiveKey) === existing) {
          inFlightFetches.delete(effectiveKey)
        }
        continue
      }
      return outcome
    } catch (err) {
      if (explicitSignal && callerSignal?.aborted) {
        throw err
      }
      const originAborted = err?.name === 'AbortError' && Boolean(existing.aborted || existing.signal?.aborted)
      if (isCrossRequestError(err) || originAborted) {
        if (inFlightFetches.get(effectiveKey) === existing) {
          inFlightFetches.delete(effectiveKey)
        }
        continue
      }
      throw err
    }
  }

  if (explicitSignal && callerSignal?.aborted) {
    throw toAbortError(callerSignal)
  }

  const entry = {
    promise: null,
    startedAt: now(),
    signal: callerSignal,
    aborted: false,
    abortListeners: new Set(),
  }

  const onInitiatorAbort = () => {
    entry.aborted = true
    if (inFlightFetches.get(effectiveKey) === entry) {
      inFlightFetches.delete(effectiveKey)
    }
    if (explicitSignal || !hasLifecycleWaitUntil) {
      const listeners = Array.from(entry.abortListeners)
      entry.abortListeners.clear()
      for (const notify of listeners) {
        notify()
      }
    }
  }

  if (callerSignal && typeof callerSignal.addEventListener === 'function') {
    if (callerSignal.aborted) {
      entry.aborted = true
    } else {
      callerSignal.addEventListener('abort', onInitiatorAbort, { once: true })
    }
  }

  const cleanupEntry = () => {
    entry.abortListeners.clear()
    if (callerSignal && typeof callerSignal.removeEventListener === 'function') {
      try {
        callerSignal.removeEventListener('abort', onInitiatorAbort)
      } catch {}
    }
  }

  const fetchPromise = (async () => {
    const freshData = await fetchFn()

    try {
      if (!entry.aborted || hasLifecycleWaitUntil) {
        if (shouldCache(freshData)) {
          const writePromise = (async () => {
            await writeEnvelope(freshData)
          })().catch((err) => {
            if (logger?.error) {
              logger.error(`${loggerLabel} cache put failed for key ${effectiveKey}`, err)
            }
          })
          safeWaitUntil(waitUntilFn, writePromise)
        }
      }
    } catch (err) {
      if (logger?.error) {
        logger.error(`${loggerLabel} cache schedule put error`, err)
      }
    }

    return freshData
  })().finally(() => {
    if (inFlightFetches.get(effectiveKey) === entry) {
      inFlightFetches.delete(effectiveKey)
    }
    cleanupEntry()
  })

  entry.promise = fetchPromise
  if (!entry.aborted) {
    inFlightFetches.set(effectiveKey, entry)
  }
  safeWaitUntil(waitUntilFn, fetchPromise)

  if (explicitSignal && callerSignal) {
    fetchPromise.catch(() => {})
    const outcome = await waitForEntry(entry, callerSignal, true, Infinity)
    if (outcome === ABORTED_SENTINEL || outcome === RETRY_SENTINEL) {
      throw toAbortError(callerSignal)
    }
    return outcome
  }

  return await fetchPromise
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
