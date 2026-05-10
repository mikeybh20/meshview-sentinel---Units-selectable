import { useCallback, useEffect, useRef, useState } from 'react';
import { meshDataService } from '../services/meshDataService';

/**
 * @deprecated localStorage path is now a fallback only. Server is authoritative.
 * Kept as an offline-cache so the UI shows a stable list when the server is
 * briefly unreachable, and as the source for one-time migration of any
 * pre-server-side block lists.
 */
const STORAGE_KEY = 'mesh.blockedNodeIds';

function readStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const list = JSON.parse(raw);
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function writeStorage(blocked: Set<string>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...blocked])); }
  catch { /* private mode etc. */ }
}

/**
 * Persistent set of blocked node IDs, server-side. Blocking is purely a
 * client-side filter — the radio still receives traffic from these nodes,
 * we just hide it in the UI. Storing centrally on the server means multi-tab
 * and multi-machine operators stay in sync.
 *
 * Behavior:
 *   - On mount: subscribes to the data service's `onBlocked` stream (driven by
 *     `/api/mesh/snapshot`'s `blocked: string[]` field, refreshed via a
 *     dedicated `blocked` SSE event when a peer changes the list).
 *   - First-mount migration: if localStorage has entries the server doesn't,
 *     pushes them up so legacy block lists aren't lost.
 *   - block/unblock: optimistic UI update + server POST/DELETE; on server
 *     failure we revert and surface no error (the next snapshot will reconcile).
 *   - localStorage is kept as a stale read-through cache so the initial render
 *     after a refresh isn't empty while the snapshot is still in flight.
 */
export function useBlockList() {
  const [blocked, setBlocked] = useState<Set<string>>(() => readStorage());
  const migratedRef = useRef(false);

  useEffect(() => {
    const unsub = meshDataService.onBlocked(serverBlocked => {
      const serverSet = new Set(serverBlocked);

      // One-time migration: if we have entries from before server-side block
      // lists shipped, push them up the first time we see the server's list.
      if (!migratedRef.current) {
        migratedRef.current = true;
        const local = readStorage();
        const toPush: string[] = [];
        for (const id of local) {
          if (!serverSet.has(id)) toPush.push(id);
        }
        if (toPush.length > 0) {
          for (const id of toPush) {
            void meshDataService.blockNode(id); // fire-and-forget
            serverSet.add(id);
          }
        }
      }

      setBlocked(serverSet);
      writeStorage(serverSet);
    });
    return unsub;
  }, []);

  const block = useCallback(async (nodeId: string) => {
    setBlocked(prev => {
      if (prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.add(nodeId);
      writeStorage(next);
      return next;
    });
    const r = await meshDataService.blockNode(nodeId);
    if (!r.ok) {
      // Revert on failure — the next snapshot will reconcile anyway.
      setBlocked(prev => {
        if (!prev.has(nodeId)) return prev;
        const next = new Set(prev);
        next.delete(nodeId);
        writeStorage(next);
        return next;
      });
    }
  }, []);

  const unblock = useCallback(async (nodeId: string) => {
    setBlocked(prev => {
      if (!prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.delete(nodeId);
      writeStorage(next);
      return next;
    });
    const r = await meshDataService.unblockNode(nodeId);
    if (!r.ok) {
      setBlocked(prev => {
        if (prev.has(nodeId)) return prev;
        const next = new Set(prev);
        next.add(nodeId);
        writeStorage(next);
        return next;
      });
    }
  }, []);

  const isBlocked = useCallback((nodeId: string) => blocked.has(nodeId), [blocked]);

  return { blocked, block, unblock, isBlocked };
}
