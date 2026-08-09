/**
 * Reusable Caching Library Entrypoint
 * Can be packaged independently for npm or reused across multiple services.
 */

export { MemoryAdapter, CloudflareKVAdapter, hashQueryParams, VersionManager, withCacheGeneric } from './cacheCore.js'
