import { describe, it, expect, vi } from 'vitest'
import { MemoryAdapter, CloudflareKVAdapter, hashQueryParams, VersionManager, withCache } from '../index.js'

describe('CloudflareKVAdapter', () => {
  it('handles get, put, delete and getJSON/putJSON with KV binding', async () => {
    const mockStore = new Map()
    const kvBinding = {
      async get(k) {
        return mockStore.get(k) ?? null
      },
      async put(k, v) {
        mockStore.set(k, v)
      },
      async delete(k) {
        mockStore.delete(k)
      },
    }

    const adapter = new CloudflareKVAdapter(kvBinding)
    await adapter.put('test-key', 'hello')
    expect(await adapter.get('test-key')).toBe('hello')

    await adapter.putJSON('json-key', { a: 100 })
    expect(await adapter.getJSON('json-key')).toEqual({ a: 100 })

    await adapter.delete('test-key')
    expect(await adapter.get('test-key')).toBeNull()
  })

  it('handles custom getJSON / putJSON if supported by KV binding', async () => {
    const jsonStore = new Map()
    const kvBinding = {
      async get(k) {
        return null
      },
      async put(k, v) {},
      async getJSON(k) {
        return jsonStore.get(k) ?? null
      },
      async putJSON(k, v) {
        jsonStore.set(k, v)
      },
    }

    const adapter = new CloudflareKVAdapter(kvBinding)
    await adapter.putJSON('native-json', { native: true })
    expect(await adapter.getJSON('native-json')).toEqual({ native: true })
  })

  it('safely handles null/undefined kv binding', async () => {
    const adapter = new CloudflareKVAdapter(null)
    expect(await adapter.get('foo')).toBeNull()
    expect(await adapter.getJSON('foo')).toBeNull()
    await adapter.put('foo', 'bar')
    await adapter.putJSON('foo', { a: 1 })
    await adapter.delete('foo')
  })
})

describe('SWR & Advanced Caching Features', () => {
  it('supports Single-Key Stale-While-Revalidate (SWR) background revalidation', async () => {
    const adapter = new MemoryAdapter()
    const now = Date.now()
    await adapter.putJSON('swr:item', {
      _swr: true,
      v: { data: 'stale-value' },
      e: now - 1000, // expired fresh window 1 sec ago
      s: now + 60000, // valid in stale window for another 60 sec
    })

    const fetchFn = vi.fn().mockResolvedValue({ data: 'fresh-value' })
    const waitUntil = vi.fn((promise) => promise)

    const result = await withCache({
      adapter,
      cacheKey: 'swr:item',
      fetchFn,
      enableSWR: true,
      waitUntil,
    })

    // Returns stale value immediately
    expect(result).toEqual({ data: 'stale-value' })
    expect(waitUntil).toHaveBeenCalled()

    // Wait for async revalidation promise passed to waitUntil
    await waitUntil.mock.calls[0][0]
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // Second call should return fresh value from single-key primary cache
    const secondCall = await withCache({
      adapter,
      cacheKey: 'swr:item',
      fetchFn,
    })
    expect(secondCall).toEqual({ data: 'fresh-value' })

    // Verify only single key exists in memory store (no :stale key created)
    expect(adapter.store.has('swr:item:stale')).toBe(false)
    expect(adapter.store.has('swr:item')).toBe(true)
  })

  it('coalesces multiple concurrent cold cache misses into a single fetchFn call', async () => {
    const adapter = new MemoryAdapter()
    let fetchCount = 0
    const fetchFn = vi.fn().mockImplementation(async () => {
      fetchCount++
      await new Promise((r) => setTimeout(r, 50)) // simulate 50ms async fetch
      return { count: fetchCount }
    })

    // Launch 10 concurrent requests for the exact same cacheKey
    const requests = Array.from({ length: 10 }).map(() =>
      withCache({
        adapter,
        cacheKey: 'stampede:key',
        fetchFn,
      }),
    )

    const results = await Promise.all(requests)

    // All 10 requests should receive the exact same result
    expect(results).toHaveLength(10)
    for (const res of results) {
      expect(res).toEqual({ count: 1 })
    }

    // fetchFn must have been executed EXACTLY ONCE despite 10 concurrent calls
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('deduplicates in-flight SWR background revalidations', async () => {
    const adapter = new MemoryAdapter()
    const now = Date.now()
    await adapter.putJSON('swr:stampede', {
      _swr: true,
      v: 'stale-data',
      e: now - 1000,
      s: now + 60000,
    })

    let fetchCount = 0
    const fetchFn = vi.fn().mockImplementation(async () => {
      fetchCount++
      await new Promise((r) => setTimeout(r, 50))
      return 'fresh-data'
    })

    const waitUntilPromises = []
    const waitUntil = vi.fn((p) => waitUntilPromises.push(p))

    // 5 concurrent requests hit stale cache
    const results = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        withCache({
          adapter,
          cacheKey: 'swr:stampede',
          fetchFn,
          enableSWR: true,
          waitUntil,
        }),
      ),
    )

    // All 5 immediately receive stale value
    expect(results).toEqual(['stale-data', 'stale-data', 'stale-data', 'stale-data', 'stale-data'])

    // Wait for the background revalidation promise
    await Promise.all(waitUntilPromises)

    // Exactly 1 background fetch revalidation occurred
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('respects bypassCache option', async () => {
    const adapter = new MemoryAdapter()
    await adapter.putJSON('key', { data: 'cached' })

    const fetchFn = vi.fn().mockResolvedValue({ data: 'bypass' })

    const result = await withCache({
      adapter,
      cacheKey: 'key',
      fetchFn,
      bypassCache: true,
    })

    expect(result).toEqual({ data: 'bypass' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('supports non-JSON mode with custom serialize and deserialize functions', async () => {
    const adapter = new MemoryAdapter()
    const fetchFn = vi.fn().mockResolvedValue(12345)

    const res1 = await withCache({
      adapter,
      cacheKey: 'numKey',
      fetchFn,
      useJSON: false,
      serialize: (val) => String(val),
      deserialize: (raw) => Number(raw),
    })

    expect(res1).toBe(12345)

    // Primary read should use deserialize
    const res2 = await withCache({
      adapter,
      cacheKey: 'numKey',
      fetchFn,
      useJSON: false,
      serialize: (val) => String(val),
      deserialize: (raw) => Number(raw),
    })

    expect(res2).toBe(12345)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('handles TTL expiration in MemoryAdapter', async () => {
    const adapter = new MemoryAdapter()
    await adapter.put('ttlKey', 'temp', { expirationTtl: 0.05 }) // 50ms
    expect(await adapter.get('ttlKey')).toBe('temp')

    await new Promise((r) => setTimeout(r, 60))
    expect(await adapter.get('ttlKey')).toBeNull()
  })

  it('supports automatic versionKey resolution and group invalidation via rotateVersion', async () => {
    const adapter = new MemoryAdapter()
    let callCount = 0
    const fetchFn = vi.fn().mockImplementation(async () => {
      callCount++
      return { profile: `user-${callCount}` }
    })

    // First call resolves version, caches under users:VERSION:user:123
    const res1 = await withCache({
      adapter,
      cacheKey: 'user:123',
      versionKey: 'users',
      fetchFn,
    })
    expect(res1).toEqual({ profile: 'user-1' })
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // Second call hits cache under same versionKey
    const res2 = await withCache({
      adapter,
      cacheKey: 'user:123',
      versionKey: 'users',
      fetchFn,
    })
    expect(res2).toEqual({ profile: 'user-1' })
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // Rotate version to invalidate group
    await VersionManager.rotateVersion(adapter, 'users')

    // Third call after rotation generates a new version tag -> cache miss -> fetches fresh data
    const res3 = await withCache({
      adapter,
      cacheKey: 'user:123',
      versionKey: 'users',
      fetchFn,
    })
    expect(res3).toEqual({ profile: 'user-2' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('VersionManager deleteKeys removes specified keys', async () => {
    const adapter = new MemoryAdapter()
    await adapter.put('k1', 'v1')
    await adapter.put('k2', 'v2')

    await VersionManager.deleteKeys(adapter, ['k1', 'k2', null])
    expect(await adapter.get('k1')).toBeNull()
    expect(await adapter.get('k2')).toBeNull()
  })
})
