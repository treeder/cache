import { describe, it, expect, vi } from 'vitest'
import { MemoryAdapter, hashQueryParams, VersionManager, withCache } from '../index.js'

describe('Generic Cache Library Core', () => {
  describe('hashQueryParams', () => {
    it('returns default for falsy params', () => {
      expect(hashQueryParams(null)).toBe('default')
      expect(hashQueryParams(undefined)).toBe('default')
    })

    it('produces deterministic hashes regardless of key order', () => {
      const hash1 = hashQueryParams({ b: 2, a: 1 })
      const hash2 = hashQueryParams({ a: 1, b: 2 })
      expect(hash1).toBe(hash2)
    })
  })

  describe('MemoryAdapter', () => {
    it('sets, gets, and deletes primitive & json values', async () => {
      const adapter = new MemoryAdapter()
      await adapter.put('k1', 'val1')
      expect(await adapter.get('k1')).toBe('val1')

      await adapter.putJSON('k2', { foo: 'bar' })
      expect(await adapter.getJSON('k2')).toEqual({ foo: 'bar' })

      await adapter.delete('k1')
      expect(await adapter.get('k1')).toBeNull()
    })
  })

  describe('VersionManager', () => {
    it('mints version if missing and rotates on demand', async () => {
      const adapter = new MemoryAdapter()
      const v1 = await VersionManager.getVersion(adapter, 'ver:key')
      expect(v1).toBeDefined()

      await new Promise((r) => setTimeout(r, 10))
      await VersionManager.rotateVersion(adapter, 'ver:key')

      const v2 = await VersionManager.getVersion(adapter, 'ver:key')
      expect(v2).not.toBe(v1)
    })
  })

  describe('withCache', () => {
    it('returns cached result on hit and fetches fresh data on miss', async () => {
      const adapter = new MemoryAdapter()
      const fetchFn = vi.fn().mockResolvedValue({ count: 42 })

      // First call (miss)
      const res1 = await withCache({
        adapter,
        cacheKey: 'test:item',
        fetchFn,
      })
      expect(res1).toEqual({ count: 42 })
      expect(fetchFn).toHaveBeenCalledTimes(1)

      // Second call (hit)
      const res2 = await withCache({
        adapter,
        cacheKey: 'test:item',
        fetchFn,
      })
      expect(res2).toEqual({ count: 42 })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })
  })
})
