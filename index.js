/**
 * Standalone Caching Library
 * Re-exports core caching utilities, storage adapters, and version management.
 */

export {
  MemoryAdapter,
  CloudflareKVAdapter,
  hashQueryParams,
  VersionManager,
  withCacheGeneric,
} from './functions/utils/cache/index.js'

export * as domainFacade from './functions/utils/cache.js'
