/**
 * Standalone Caching Library
 * Re-exports core caching utilities, storage adapters, and version management.
 */

export {
  MemoryAdapter,
  CloudflareKVAdapter,
  hashQueryParams,
  VersionManager,
  withCache,
  Cache,
  setDefaultAdapter,
  getDefaultAdapter,
} from './cache.js'
