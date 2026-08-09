import { describe, it, expect, vi } from "vitest";
import {
  MemoryAdapter,
  CloudflareKVAdapter,
  hashQueryParams,
  VersionManager,
  withCache,
  withCacheGeneric,
} from "../index.js";


describe("CloudflareKVAdapter", () => {
  it("handles get, put, delete and getJSON/putJSON with KV binding", async () => {
    const mockStore = new Map();
    const kvBinding = {
      async get(k) {
        return mockStore.get(k) ?? null;
      },
      async put(k, v) {
        mockStore.set(k, v);
      },
      async delete(k) {
        mockStore.delete(k);
      },
    };

    const adapter = new CloudflareKVAdapter(kvBinding);
    await adapter.put("test-key", "hello");
    expect(await adapter.get("test-key")).toBe("hello");

    await adapter.putJSON("json-key", { a: 100 });
    expect(await adapter.getJSON("json-key")).toEqual({ a: 100 });

    await adapter.delete("test-key");
    expect(await adapter.get("test-key")).toBeNull();
  });

  it("handles custom getJSON / putJSON if supported by KV binding", async () => {
    const jsonStore = new Map();
    const kvBinding = {
      async get(k) {
        return null;
      },
      async put(k, v) {},
      async getJSON(k) {
        return jsonStore.get(k) ?? null;
      },
      async putJSON(k, v) {
        jsonStore.set(k, v);
      },
    };

    const adapter = new CloudflareKVAdapter(kvBinding);
    await adapter.putJSON("native-json", { native: true });
    expect(await adapter.getJSON("native-json")).toEqual({ native: true });
  });

  it("safely handles null/undefined kv binding", async () => {
    const adapter = new CloudflareKVAdapter(null);
    expect(await adapter.get("foo")).toBeNull();
    expect(await adapter.getJSON("foo")).toBeNull();
    await adapter.put("foo", "bar");
    await adapter.putJSON("foo", { a: 1 });
    await adapter.delete("foo");
  });
});

describe("SWR & Advanced Caching Features", () => {
  it("supports Stale-While-Revalidate (SWR) background revalidation", async () => {
    const adapter = new MemoryAdapter();
    await adapter.putJSON("swr:item:stale", { data: "stale-value" });

    const fetchFn = vi.fn().mockResolvedValue({ data: "fresh-value" });
    const waitUntil = vi.fn((promise) => promise);

    const result = await withCacheGeneric({
      adapter,
      cacheKey: "swr:item",
      fetchFn,
      enableSWR: true,
      waitUntil,
    });

    // Returns stale value immediately
    expect(result).toEqual({ data: "stale-value" });
    expect(waitUntil).toHaveBeenCalled();

    // Wait for async revalidation promise passed to waitUntil
    await waitUntil.mock.calls[0][0];
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Second call should return fresh value from primary cache
    const secondCall = await withCacheGeneric({
      adapter,
      cacheKey: "swr:item",
      fetchFn,
    });
    expect(secondCall).toEqual({ data: "fresh-value" });
  });

  it("respects bypassCache option", async () => {
    const adapter = new MemoryAdapter();
    await adapter.putJSON("key", { data: "cached" });

    const fetchFn = vi.fn().mockResolvedValue({ data: "bypass" });

    const result = await withCacheGeneric({
      adapter,
      cacheKey: "key",
      fetchFn,
      bypassCache: true,
    });

    expect(result).toEqual({ data: "bypass" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("supports non-JSON mode with custom serialize and deserialize functions", async () => {
    const adapter = new MemoryAdapter();
    const fetchFn = vi.fn().mockResolvedValue(12345);

    const res1 = await withCacheGeneric({
      adapter,
      cacheKey: "numKey",
      fetchFn,
      useJSON: false,
      serialize: (val) => String(val),
      deserialize: (raw) => Number(raw),
    });

    expect(res1).toBe(12345);

    // Primary read should use deserialize
    const res2 = await withCacheGeneric({
      adapter,
      cacheKey: "numKey",
      fetchFn,
      useJSON: false,
      serialize: (val) => String(val),
      deserialize: (raw) => Number(raw),
    });

    expect(res2).toBe(12345);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("handles TTL expiration in MemoryAdapter", async () => {
    const adapter = new MemoryAdapter();
    await adapter.put("ttlKey", "temp", { expirationTtl: 0.05 }); // 50ms
    expect(await adapter.get("ttlKey")).toBe("temp");

    await new Promise((r) => setTimeout(r, 60));
    expect(await adapter.get("ttlKey")).toBeNull();
  });

  it("VersionManager deleteKeys removes specified keys", async () => {
    const adapter = new MemoryAdapter();
    await adapter.put("k1", "v1");
    await adapter.put("k2", "v2");

    await VersionManager.deleteKeys(adapter, ["k1", "k2", null]);
    expect(await adapter.get("k1")).toBeNull();
    expect(await adapter.get("k2")).toBeNull();
  });
});
