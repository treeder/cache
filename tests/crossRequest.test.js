import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryAdapter, Cache, withCache, clearInFlight, getInFlightCount } from '../index.js'

describe('Cross-Request Promise Safety & Lifecycle Handling', () => {
  beforeEach(() => {
    clearInFlight()
  })

  it('recovers and evicts dead entry when awaiting an in-flight promise throws Cloudflare cross-request error', async () => {
    const adapter = new MemoryAdapter()
    let calls = 0

    // Simulate Request A creating a promise whose request IoContext ended,
    // so awaiting/attaching to it rejects with Cloudflare's handle_cross_request_promise_resolution error.
    let onFirstFetchStarted
    const firstFetchStarted = new Promise((r) => {
      onFirstFetchStarted = r
    })
    let rejectDeadRequest
    const fetchFn = vi.fn().mockImplementation(() => {
      calls++
      if (calls === 1) {
        return new Promise((_, reject) => {
          rejectDeadRequest = reject
          onFirstFetchStarted()
        })
      }
      return Promise.resolve({ hash: '0xd05c', logs: ['ok'], attempt: calls })
    })

    const reqAPromise = withCache({
      adapter,
      cacheKey: 'tx:payload:0xd05c',
      fetchFn,
    })
    // Prevent unhandled rejection on abandoned Request A
    reqAPromise.catch(() => {})

    await firstFetchStarted

    // Request B joins while Request A's entry is in inFlightFetches
    const reqBPromise = withCache({
      adapter,
      cacheKey: 'tx:payload:0xd05c',
      fetchFn,
    })
    await new Promise((r) => setTimeout(r, 5))

    // Simulate workerd rejecting cross-request promise settlement
    rejectDeadRequest(
      new Error(
        'This promise was created by a request that has since ended, so it can never settle. With the handle_cross_request_promise_resolution compatibility flag, a promise can only settle in the request that created it, and settling it after that request ends is dropped.',
      ),
    )

    const resB = await reqBPromise
    expect(resB).toEqual({ hash: '0xd05c', logs: ['ok'], attempt: 2 })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(getInFlightCount()).toBe(0)

    // Subsequent call hits fresh cache cleanly (key was not poisoned)
    const resC = await withCache({
      adapter,
      cacheKey: 'tx:payload:0xd05c',
      fetchFn,
    })
    expect(resC).toEqual({ hash: '0xd05c', logs: ['ok'], attempt: 2 })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('registers cold-miss fetchPromise and writeEnvelope with waitUntil and swallows rejections in waitUntil', async () => {
    const adapter = new MemoryAdapter()
    const waited = []
    const waitUntil = vi.fn((p) => waited.push(p))

    const res = await withCache({
      adapter,
      cacheKey: 'wait:ok',
      waitUntil,
      fetchFn: async () => ({ ok: true }),
    })

    expect(res).toEqual({ ok: true })
    expect(waitUntil).toHaveBeenCalled()
    await Promise.all(waited)

    // Also verify waitUntil promise never rejects even when fetchFn throws
    const errorWaited = []
    await expect(
      withCache({
        adapter,
        cacheKey: 'wait:err',
        waitUntil: (p) => errorWaited.push(p),
        fetchFn: async () => {
          throw new Error('upstream 500')
        },
      }),
    ).rejects.toThrow('upstream 500')

    expect(errorWaited.length).toBeGreaterThan(0)
    await expect(Promise.all(errorWaited)).resolves.toBeDefined()
  })

  it('evicts unsettled in-flight promise after inFlightTtlMs for both later and already-waiting callers', async () => {
    const adapter = new MemoryAdapter()
    let calls = 0

    const fetchFn = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) {
        // Simulate hung cross-request promise that never settles
        return await new Promise(() => {})
      }
      return `recovered:${calls}`
    })

    // Start Request 1 (hangs forever)
    void withCache({
      adapter,
      cacheKey: 'hung:key',
      inFlightTtlMs: 25,
      fetchFn,
    })

    await new Promise((r) => setTimeout(r, 5))

    // Request 2 joins before TTL expires, then wakes up at TTL and retries in its own context
    const res2 = await withCache({
      adapter,
      cacheKey: 'hung:key',
      inFlightTtlMs: 25,
      fetchFn,
    })
    expect(res2).toBe('recovered:2')
    expect(calls).toBe(2)
    expect(getInFlightCount()).toBe(0)
  })

  it('detaches concurrent caller and retries cleanly when initiating request signal aborts mid-flight', async () => {
    const adapter = new MemoryAdapter()
    let calls = 0

    const ac1 = new AbortController()
    const ac2 = new AbortController()

    const p1 = withCache({
      adapter,
      cacheKey: 'abort:coalesce',
      signal: ac1.signal,
      fetchFn: async () => {
        calls++
        return await new Promise(() => {})
      },
    })

    const p2 = withCache({
      adapter,
      cacheKey: 'abort:coalesce',
      signal: ac2.signal,
      fetchFn: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 5))
        return 'from-request-2'
      },
    })

    setTimeout(() => ac1.abort(), 5)

    await expect(p1).rejects.toMatchObject({ name: 'AbortError' })
    expect(await p2).toBe('from-request-2')
    expect(calls).toBe(2)
  })

  it('aborts only the joining caller when the joining caller signal aborts', async () => {
    const adapter = new MemoryAdapter()
    const acJoiner = new AbortController()

    const p1 = withCache({
      adapter,
      cacheKey: 'abort:joiner',
      fetchFn: async () => {
        await new Promise((r) => setTimeout(r, 30))
        return 'initiator-ok'
      },
    })

    const p2 = withCache({
      adapter,
      cacheKey: 'abort:joiner',
      signal: acJoiner.signal,
      fetchFn: async () => 'unused',
    })

    setTimeout(() => acJoiner.abort(), 5)

    await expect(p2).rejects.toMatchObject({ name: 'AbortError' })
    expect(await p1).toBe('initiator-ok')
  })

  it('extracts waitUntil and request signal safely from Workers/Flaregun/Hono context objects', async () => {
    const adapter = new MemoryAdapter()
    const waited = []
    const honoLikeCtx = {
      get executionCtx() {
        throw new Error('This context has no ExecutionContext')
      },
      ctx: {
        waitUntil: (p) => waited.push(p),
      },
      request: {
        signal: new AbortController().signal,
      },
    }

    const cache = new Cache({ adapter, context: honoLikeCtx })
    const res = await cache.wrap('ctx:key', async () => 'ctx-val')
    expect(res).toBe('ctx-val')
    expect(waited.length).toBeGreaterThan(0)
    await Promise.all(waited)
  })

  it('keeps SWR background revalidation isolated from foreground cache-miss coalescing', async () => {
    const adapter = new MemoryAdapter()
    const nowMs = Date.now()
    await adapter.putJSON('swr:race', {
      _swr: true,
      v: 'stale-val',
      e: nowMs - 1000,
      s: nowMs + 50, // stale window expires in 50ms
    })

    let calls = 0
    const fetchFn = vi.fn().mockImplementation(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 80))
      return `fresh-${calls}`
    })

    // 1. Trigger SWR background revalidation
    const staleRes = await withCache({
      adapter,
      cacheKey: 'swr:race',
      enableSWR: true,
      fetchFn,
    })
    expect(staleRes).toBe('stale-val')

    // 2. Wait for stale window to expire while SWR revalidation is still in-flight
    await new Promise((r) => setTimeout(r, 60))

    // 3. Foreground miss must return real fresh value, NOT undefined from SWR background promise
    const fgRes = await withCache({
      adapter,
      cacheKey: 'swr:race',
      enableSWR: true,
      fetchFn,
    })
    expect(fgRes).toMatch(/^fresh-/)
  })

  it('fails fast without invoking fetchFn when explicit initiating signal is already aborted', async () => {
    const adapter = new MemoryAdapter()
    const fetchFn = vi.fn().mockResolvedValue('should-not-run')
    const ac = new AbortController()
    ac.abort()

    await expect(
      withCache({
        adapter,
        cacheKey: 'preaborted:key',
        signal: ac.signal,
        fetchFn,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('late settlement of an aborted or TTL-evicted run does not delete a newer active in-flight entry', async () => {
    const adapter = new MemoryAdapter()
    let resolveFirst
    let resolveSecond
    let calls = 0

    const ac1 = new AbortController()
    const p1 = withCache({
      adapter,
      cacheKey: 'late:key',
      signal: ac1.signal,
      fetchFn: () => {
        calls++
        return new Promise((r) => {
          resolveFirst = r
        })
      },
    })

    await new Promise((r) => setTimeout(r, 5))
    ac1.abort()
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' })

    // Start second active run for the same key
    const p2 = withCache({
      adapter,
      cacheKey: 'late:key',
      fetchFn: () => {
        calls++
        return new Promise((r) => {
          resolveSecond = r
        })
      },
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(getInFlightCount()).toBe(1)

    // First (aborted) run settles late — must NOT evict p2 from inFlightFetches or poison cache
    resolveFirst('stale-aborted-run')
    await new Promise((r) => setTimeout(r, 5))
    expect(getInFlightCount()).toBe(1)

    // Third caller should still coalesce onto p2
    const p3 = withCache({
      adapter,
      cacheKey: 'late:key',
      fetchFn: async () => 'unexpected-third-run',
    })
    await new Promise((r) => setTimeout(r, 5))
    resolveSecond('clean-second-run')

    expect(await p2).toBe('clean-second-run')
    expect(await p3).toBe('clean-second-run')
    expect(calls).toBe(2)
  })
})
