// Domain-specific caching facade for pearpop-api
import {
  CloudflareKVAdapter,
  hashQueryParams as hashQueryParamsGeneric,
  VersionManager,
  withCacheGeneric,
} from './cache/index.js'

/**
 * Re-export parameter hashing utility.
 */
export const hashQueryParams = hashQueryParamsGeneric

/**
 * Helper to get a CloudflareKVAdapter instance for context `c`.
 */
function getAdapter(c) {
  if (!c?.data?.kv) return null
  return new CloudflareKVAdapter(c.data.kv)
}

/**
 * Rotate a version key.
 */
async function rotateVersion(c, key) {
  const adapter = getAdapter(c)
  if (!adapter) return
  await VersionManager.rotateVersion(adapter, key, { expirationTtl: 86400 })
}

/**
 * Get the current cache version for a user's inbox threads.
 */
export async function getInboxVersion(c, userId) {
  const adapter = getAdapter(c)
  return VersionManager.getVersion(adapter, `inbox:version:${userId}`, { defaultTtl: 86400 })
}

/**
 * Increment/rotate the inbox cache version for a user.
 */
export async function incrementInboxVersion(c, userId) {
  if (!userId) return
  const adapter = getAdapter(c)
  if (!adapter) return
  await rotateVersion(c, `inbox:version:${userId}`)
  await adapter.delete(`dashboard:home:${userId}`)
}

/**
 * Get the current cache version for a manager's opportunities list.
 */
export async function getOpportunitiesVersion(c, managerId) {
  const adapter = getAdapter(c)
  return VersionManager.getVersion(adapter, `opportunities:version:${managerId}`, { defaultTtl: 86400 })
}

/**
 * Increment/rotate the opportunities cache version for a manager.
 */
export async function incrementOpportunitiesVersion(c, managerId) {
  if (!managerId) return
  const adapter = getAdapter(c)
  if (!adapter) return
  await rotateVersion(c, `opportunities:version:${managerId}`)
  await adapter.delete(`dashboard:home:${managerId}`)
}

/**
 * Get the current cache version for a manager's creators list.
 */
export async function getCreatorsVersion(c, managerId) {
  const adapter = getAdapter(c)
  return VersionManager.getVersion(adapter, `creators:version:${managerId}`, { defaultTtl: 86400 })
}

/**
 * Increment/rotate the creators cache version for a manager.
 */
export async function incrementCreatorsVersion(c, managerId) {
  if (!managerId) return
  const adapter = getAdapter(c)
  if (!adapter) return
  await rotateVersion(c, `creators:version:${managerId}`)
  await adapter.delete(`dashboard:home:${managerId}`)
  await adapter.delete(`dashboard:stats:${managerId}`)
}

/**
 * Get the current cache version for a user's clients CRM summary.
 */
export async function getClientsVersion(c, userId) {
  const adapter = getAdapter(c)
  return VersionManager.getVersion(adapter, `clients:version:${userId}`, { defaultTtl: 86400 })
}

/**
 * Increment/rotate the clients CRM summary cache version for a user.
 */
export async function incrementClientsVersion(c, userId) {
  if (!userId) return
  const adapter = getAdapter(c)
  if (!adapter) return
  await rotateVersion(c, `clients:version:${userId}`)
}

/**
 * Bust one manager's derived caches.
 */
export async function bustManagerCaches(c, mId, { versions = ['creators', 'inbox', 'clients', 'opportunities'] } = {}) {
  const adapter = getAdapter(c)
  if (!mId || !adapter) return

  const versionKeys = {
    creators: `creators:version:${mId}`,
    inbox: `inbox:version:${mId}`,
    clients: `clients:version:${mId}`,
    opportunities: `opportunities:version:${mId}`,
  }
  for (const v of versions) {
    if (versionKeys[v]) await rotateVersion(c, versionKeys[v])
  }

  const homeTouchingVersions = new Set(['creators', 'inbox', 'opportunities'])
  const touchesHome = versions.some((v) => homeTouchingVersions.has(v))
  if (touchesHome) {
    await adapter.delete(`dashboard:home:${mId}`)
  }
  await adapter.delete(`financials:v1:${mId}:manager`)
  await adapter.delete(`financials:v1:${mId}:all`)
  await adapter.delete(`dashboard:stats:${mId}`)
}

/**
 * Invalidate cache for thread.
 */
export async function invalidateCacheForThread(c, threadId, opportunityId = null) {
  if (!threadId) return
  try {
    const busted = new Set()
    const threadRow = (await c.data.d1.prepare('SELECT opportunityId FROM threads WHERE id = ?').bind(threadId).all())
      ?.results?.[0]
    const oppId = opportunityId || threadRow?.opportunityId
    if (oppId) {
      const oppRow = (
        await c.data.d1.prepare('SELECT creatorId, managerId FROM opportunities WHERE id = ?').bind(oppId).all()
      )?.results?.[0]
      if (oppRow) {
        if (oppRow.creatorId) {
          for (const id of await invalidateCacheForCreator(c, oppRow.creatorId)) busted.add(id)
        }
        if (oppRow.managerId && !busted.has(oppRow.managerId)) {
          await bustManagerCaches(c, oppRow.managerId, { versions: ['inbox', 'creators', 'clients'] })
          busted.add(oppRow.managerId)
        }
      }
    }
    if (c.data?.userId && !busted.has(c.data.userId)) {
      await bustManagerCaches(c, c.data.userId, { versions: ['inbox', 'creators', 'clients'] })
    }
  } catch (err) {
    console.error('Failed to invalidate cache for thread:', err)
  }
}

/**
 * Invalidate cache for creator.
 */
export async function invalidateCacheForCreator(c, creatorId, extraUserIds = []) {
  if (!creatorId) return []
  try {
    const { results } = await c.data.d1
      .prepare('SELECT userId FROM creatorUsers WHERE creatorId = ?')
      .bind(creatorId)
      .all()
    const managerIds = [
      ...new Set([...(results || []).map((row) => row.userId), ...(extraUserIds || [])].filter(Boolean)),
    ]

    for (const mId of managerIds) {
      await bustManagerCaches(c, mId)
    }
    return managerIds
  } catch (err) {
    console.error('Failed to invalidate cache for creator:', err)
    return []
  }
}

/**
 * Invalidate cache for opportunity.
 */
export async function invalidateCacheForOpportunity(c, opportunityId, managerId = null) {
  if (!opportunityId) return
  try {
    const busted = new Set()
    const oppRow = (
      await c.data.d1.prepare('SELECT creatorId, managerId FROM opportunities WHERE id = ?').bind(opportunityId).all()
    )?.results?.[0]
    if (oppRow) {
      if (oppRow.creatorId) {
        for (const id of await invalidateCacheForCreator(c, oppRow.creatorId)) busted.add(id)
      }
      const mId = managerId || oppRow.managerId
      if (mId && !busted.has(mId)) {
        await bustManagerCaches(c, mId)
        busted.add(mId)
      }
    }
    if (c.data?.userId && !busted.has(c.data.userId)) {
      await bustManagerCaches(c, c.data.userId)
    }
  } catch (err) {
    console.error('Failed to invalidate cache for opportunity:', err)
  }
}

/**
 * Rotate the assembled-report cache version.
 */
export async function bumpReportVersion(c, shareToken) {
  if (!shareToken) return
  const adapter = getAdapter(c)
  if (!adapter) return
  await VersionManager.rotateVersion(adapter, `report:version:${shareToken}`, { expirationTtl: 86400 })
}

/**
 * Get report version.
 */
export async function getReportVersion(c, shareToken) {
  const adapter = getAdapter(c)
  return VersionManager.getVersion(adapter, `report:version:${shareToken}`, { defaultTtl: 86400 })
}

/**
 * Invalidate cache for invoice.
 */
export async function invalidateCacheForInvoice(c, invoiceId, creatorId = null) {
  if (!invoiceId) return
  try {
    const invRow = (await c.data.d1.prepare('SELECT creatorId FROM invoices WHERE id = ?').bind(invoiceId).all())
      ?.results?.[0]
    const cId = creatorId || invRow?.creatorId
    if (cId) {
      await invalidateCacheForCreator(c, cId)
    }
    if (c.data?.userId) {
      await bustManagerCaches(c, c.data.userId, { versions: [] })
    }
  } catch (err) {
    console.error('Failed to invalidate cache for invoice:', err)
  }
}

/**
 * Adapter wrapper for withCache in Pearpop API endpoints.
 */
export async function withCache(c, options) {
  const adapter = getAdapter(c)
  const logger = c?.data?.logger || console
  const waitUntil = c?.waitUntil?.bind(c) || ((promise) => promise.catch(() => {}))

  return withCacheGeneric({
    adapter,
    logger,
    waitUntil,
    ...options,
  })
}
