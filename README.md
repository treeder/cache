# @pearpop/cache

A lightweight, framework-agnostic, generic JavaScript caching library with storage adapter support, versioned invalidation management, and Stale-While-Revalidate (SWR) support.

Extracted from Pearpop API ([PR #912](https://github.com/pearpop-repo/pearpop-api/pull/912)).

## Features

- **Generic Core**: Framework-agnostic caching logic (`withCacheGeneric`).
- **Storage Adapters**:
  - `MemoryAdapter`: In-memory Map store with TTL support for local development, testing, and Node environments.
  - `CloudflareKVAdapter`: Adapter wrapping Cloudflare Workers KV bindings.
- **Stale-While-Revalidate (SWR)**: Serve stale cached data instantly while trigger background revalidation.
- **VersionManager**: Automatic cache version minting, key rotation, and grouped invalidation.
- **Deterministic Parameter Hashing**: `hashQueryParams` converts query objects to sorted fingerprint hashes.
- **Domain Facade**: Includes backward-compatible Pearpop API domain invalidation functions (`getInboxVersion`, `bustManagerCaches`, `invalidateCacheForThread`, `withCache`).

## Installation

```bash
npm install
```

## Quick Start

### 1. Simple In-Memory Caching

```javascript
import { MemoryAdapter, withCacheGeneric } from '@pearpop/cache'

const adapter = new MemoryAdapter()

const data = await withCacheGeneric({
  adapter,
  cacheKey: 'user:123',
  ttl: 300, // 5 minutes
  fetchFn: async () => {
    return await fetchUserData('123')
  },
})
```

### 2. Cloudflare KV Adapter with SWR

```javascript
import { CloudflareKVAdapter, withCacheGeneric } from '@pearpop/cache'

export default {
  async fetch(request, env, ctx) {
    const adapter = new CloudflareKVAdapter(env.MY_KV)

    const responseData = await withCacheGeneric({
      adapter,
      cacheKey: 'api:trending',
      ttl: 60,         // Cache fresh for 60 seconds
      enableSWR: true, // Enable Stale-While-Revalidate
      staleTtl: 3600,  // Keep stale copy for 1 hour
      waitUntil: (promise) => ctx.waitUntil(promise),
      fetchFn: async () => {
        return await computeTrendingData()
      },
    })

    return new Response(JSON.stringify(responseData))
  }
}
```

### 3. Version Manager & Invalidation

```javascript
import { MemoryAdapter, VersionManager } from '@pearpop/cache'

const adapter = new MemoryAdapter()

// Get current version or mint a new timestamp version
const version = await VersionManager.getVersion(adapter, 'products:version')

// Rotate version to invalidate all caches using this version key
await VersionManager.rotateVersion(adapter, 'products:version')
```

### 4. Query Parameter Hashing

```javascript
import { hashQueryParams } from '@pearpop/cache'

const hash = hashQueryParams({ page: 1, filter: 'active', sort: 'desc' })
// Returns deterministic hash string regardless of property order
```

## Running Tests

```bash
npm test
```

## Repository Structure

```
├── index.js                     # Main package entrypoint
├── functions/
│   └── utils/
│       ├── cache.js             # Domain-specific caching facade & helper functions
│       └── cache/
│           ├── cacheCore.js     # Core adapters, VersionManager, hashQueryParams, withCacheGeneric
│           └── index.js         # Core library entrypoint
├── tests/
│   ├── cacheCore.test.js        # Unit tests for core caching library
│   └── extendedCache.test.js    # Unit tests for Cloudflare KV adapter, SWR, & facade functions
├── package.json
└── README.md
```

## License

MIT
