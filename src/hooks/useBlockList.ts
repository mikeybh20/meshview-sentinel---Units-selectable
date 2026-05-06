import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'mesh.blockedNodeIds';

/**
 * Persistent set of blocked node IDs (localStorage). Blocking is purely a
 * client-side filter — the radio still receives traffic from these nodes,
 * we just hide it in the UI.
 */
export function useBlockList() {
  const [blocked, setBlocked] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Set();
      const list = JSON.parse(raw);
      return new Set(Array.isArray(list) ? list : []);
    } catch {
      return new Set();
    }
  });

  // Persist whenever the set changes
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...blocked])); }
    catch { /* private mode etc. */ }
  }, [blocked]);

  const block = useCallback((nodeId: string) => {
    setBlocked(prev => {
      if (prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });
  }, []);

  const unblock = useCallback((nodeId: string) => {
    setBlocked(prev => {
      if (!prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.delete(nodeId);
      return next;
    });
  }, []);

  const isBlocked = useCallback((nodeId: string) => blocked.has(nodeId), [blocked]);

  return { blocked, block, unblock, isBlocked };
}
