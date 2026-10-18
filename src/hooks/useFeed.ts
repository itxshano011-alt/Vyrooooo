"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api-client";

/**
 * Generic cursor-paginated list hook for VYRO list endpoints.
 *
 * Fetcher contract: fetchPage(cursor: string | null) -> Promise<{ items: T[], next_cursor: string | null }>.
 * The API layer pages with { created_at, id } cursors (see src/lib/db.ts); this
 * hook appends pages, dedupes by `id`, and exposes:
 *   items, loading (first page), loadingMore, error, retry, loadMore, hasMore, reset
 *
 * All endpoints return items shaped { id: string, ... }, so a generic
 * id-dedupe works here.
 */

interface PageResult<T> {
  items: T[];
  next_cursor: string | null;
}

interface Identifiable {
  id: string;
}

export function useFeed<T extends Identifiable>(
  fetchPage: (cursor: string | null) => Promise<PageResult<T>>,
  deps: unknown[] = []
) {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const depsKey = JSON.stringify(deps);
  const pageRef = useRef(0);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    const page = ++pageRef.current;
    try {
      const result = await fetchRef.current(cursor);
      if (page !== pageRef.current) return; // superseded by a newer request
      setItems((prev) => {
        const merged = append ? [...prev, ...result.items] : result.items;
        const seen = new Set<string>();
        return merged.filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
      });
      setNextCursor(result.next_cursor);
      setHasMore(result.next_cursor !== null);
      setError(null);
    } catch (e) {
      if (page === pageRef.current) {
        setError(e instanceof Error ? e : new Error("Failed to load"));
      }
    } finally {
      if (page === pageRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    void load(nextCursor, true);
  }, [hasMore, loadingMore, loading, nextCursor, load]);

  const retry = useCallback(() => {
    setError(null);
    setLoading(items.length === 0);
    setLoadingMore(items.length > 0);
    void load(items.length === 0 ? null : nextCursor, items.length > 0);
  }, [items.length, nextCursor, load]);

  const reset = useCallback(() => {
    pageRef.current++;
    setItems([]);
    setNextCursor(null);
    setHasMore(true);
    setError(null);
    setLoading(true);
    setLoadingMore(false);
  }, []);

  // Initial load + reload when deps change.
  useEffect(() => {
    reset();
    void load(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);

  return { items, loading, loadingMore, error, retry, loadMore, hasMore };
}

/** Build a fetcher for an endpoint that returns { videos, next_cursor }. */
export function videoPageFetcher<T extends Identifiable>(url: string) {
  return async (cursor: string | null): Promise<PageResult<T>> => {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    const data = await apiRequest<{ videos: T[]; next_cursor: string | null }>(
      qs ? `${url}?${qs}` : url
    );
    return { items: data.videos, next_cursor: data.next_cursor };
  };
}
