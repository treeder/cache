import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryAdapter, Cache, setDefaultAdapter, getDefaultAdapter, withCache, VersionManager } from '../index.js'

describe('Cache Class & Global Adapter Support', () => {
  beforeEach(() => {
    setDefaultAdapter(null)
  })

  describe('Global Default Adapter Management', () => {
    it('sets and gets default adapter via helper functions and Cache static methods', () => {
      const adapter = new MemoryAdapter()
      expect(getDefaultAdapter()).toBeNull()
      expect(Cache.getDefaultAdapter()).toBeNull()

      setDefaultAdapter(adapter)
      expect(getDefaultAdapter()).toBe(adapter)
      expect(Cache.getDefaultAdapter()).toBe(adapter)

      const adapter2 = new MemoryAdapter()
      Cache.setDefaultAdapter(adapter2)
      expect(getDefaultAdapter()).toBe(adapter2)
    })

    it('withCache falls back to global default adapter if adapter is omitted', async () => {
      const adapter = new MemoryAdapter()
      setDefaultAdapter(adapter)

      const fetchFn = vi.fn().mockResolvedValue('global-cached-val')

      const res1 = await withCache({
        cacheKey: 'global:key',
        fetchFn,
      })
      expect(res1).toBe('global-cached-val')
      expect(fetchFn).toHaveBeenCalledTimes(1)

      const res2 = await withCache({
        cacheKey: 'global:key',
        fetchFn,
      })
      expect(res2).toBe('global-cached-val')
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('VersionManager falls back to global default adapter if adapter is omitted', async () => {
      const adapter = new MemoryAdapter()
      setDefaultAdapter(adapter)

      const v1 = await VersionManager.getVersion(null, 'ver:global')
      expect(v1).toBeDefined()

      await new Promise((r) => setTimeout(r, 10))
      await VersionManager.rotateVersion(null, 'ver:global')

      const v2 = await VersionManager.getVersion(null, 'ver:global')
      expect(v2).not.toBe(v1)

      await VersionManager.deleteKeys(null, ['ver:global'])
      expect(await adapter.get('ver:global')).toBeNull()
    })
  })

  describe('Cache Instance', () => {
    it('delegates basic CRUD methods to underlying adapter', async () => {
      const adapter = new MemoryAdapter()
      const cache = new Cache({ adapter })

      await cache.put('k1', 'val1')
      expect(await cache.get('k1')).toBe('val1')

      await cache.putJSON('k2', { hello: 'world' })
      expect(await cache.getJSON('k2')).toEqual({ hello: 'world' })

      await cache.delete('k1')
      expect(await cache.get('k1')).toBeNull()
    })

    it('wraps fetchFn using cache.wrap({ cacheKey, fetchFn, ... }) signature', async () => {
      const adapter = new MemoryAdapter()
      const cache = new Cache({ adapter })
      const fetchFn = vi.fn().mockResolvedValue({ id: 123, title: 'Item 123' })

      const res1 = await cache.wrap({
        cacheKey: 'item:123',
        fetchFn,
      })
      expect(res1).toEqual({ id: 123, title: 'Item 123' })
      expect(fetchFn).toHaveBeenCalledTimes(1)

      const res2 = await cache.wrap({
        cacheKey: 'item:123',
        fetchFn,
      })
      expect(res2).toEqual({ id: 123, title: 'Item 123' })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('wraps fetchFn using positional cache.wrap(cacheKey, fetchFn, options) signature', async () => {
      const adapter = new MemoryAdapter()
      const cache = new Cache({ adapter })
      const fetchFn = vi.fn().mockResolvedValue('positional-val')

      const res1 = await cache.wrap('item:positional', fetchFn)
      expect(res1).toBe('positional-val')
      expect(fetchFn).toHaveBeenCalledTimes(1)

      const res2 = await cache.wrap('item:positional', fetchFn)
      expect(res2).toBe('positional-val')
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('merges constructor defaultOptions into wrap calls', async () => {
      const adapter = new MemoryAdapter()
      const logger = { log: vi.fn(), error: vi.fn() }
      const cache = new Cache({ adapter, logger, loggerLabel: '[custom-cache]' })
      const fetchFn = vi.fn().mockResolvedValue({ data: 'ok' })

      await cache.wrap({ cacheKey: 'log:key', fetchFn })
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('[custom-cache] cache miss'))

      await cache.wrap({ cacheKey: 'log:key', fetchFn })
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('[custom-cache] cache hit'))
    })

    it('supports VersionManager methods on cache instance', async () => {
      const adapter = new MemoryAdapter()
      const cache = new Cache({ adapter })

      const v1 = await cache.getVersion('vkey')
      expect(v1).toBeDefined()

      await new Promise((r) => setTimeout(r, 10))
      await cache.rotateVersion('vkey')

      const v2 = await cache.getVersion('vkey')
      expect(v2).not.toBe(v1)

      await cache.deleteKeys(['vkey'])
      expect(await cache.get('vkey')).toBeNull()
    })

    it('supports versionKey in constructor defaultOptions', async () => {
      const adapter = new MemoryAdapter()
      const userCache = new Cache({ adapter, versionKey: 'users' })
      let fetchCount = 0
      const fetchFn = vi.fn().mockImplementation(async () => {
        fetchCount++
        return `user-${fetchCount}`
      })

      const u1 = await userCache.wrap({ cacheKey: '123', fetchFn })
      expect(u1).toBe('user-1')
      expect(fetchFn).toHaveBeenCalledTimes(1)

      const u2 = await userCache.wrap({ cacheKey: '123', fetchFn })
      expect(u2).toBe('user-1')
      expect(fetchFn).toHaveBeenCalledTimes(1)

      await userCache.rotateVersion('users')

      const u3 = await userCache.wrap({ cacheKey: '123', fetchFn })
      expect(u3).toBe('user-2')
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('falls back to global default adapter if instance is created without an adapter', async () => {
      const globalAdapter = new MemoryAdapter()
      setDefaultAdapter(globalAdapter)

      const cache = new Cache()
      await cache.put('fallback:key', 'fallback-val')
      expect(await cache.get('fallback:key')).toBe('fallback-val')

      const fetchFn = vi.fn().mockResolvedValue('wrapped-fallback')
      const res = await cache.wrap({ cacheKey: 'wrap:fallback', fetchFn })
      expect(res).toBe('wrapped-fallback')
    })
  })
})
