/**
 * v2.1 Map clustering — calls the /api/gpu/cluster sidecar endpoint.
 *
 * Sentinel's MapView shows a marker per positioned node. With 300+
 * nodes on a typical regional mesh, the markers stack at common
 * locations (city centers, repeater sites) into illegible piles.
 * DBSCAN-based spatial clustering groups markers within `eps_meters`
 * of each other into one cluster pin that shows the count + expands
 * on click.
 *
 * The hook:
 *   - debounces the cluster fetch by 400ms so panning / filter changes
 *     don't fire one request per frame
 *   - resolves the backend tier from the response so the UI can show
 *     'GPU' vs 'Sidecar' (CPU) vs 'Local' for the same clustering
 *   - falls through silently when the sidecar is unreachable — the
 *     caller renders un-clustered markers
 *
 * Performance note: the GPU path (cuML DBSCAN) starts winning at
 * ~5000 points; below that, the CPU sidecar path is fine. We still
 * route through the sidecar so the operator can observe via the
 * /health endpoint which tier is active.
 */

import React from 'react';

import type { Node } from '../types';
import { meshDataService } from '../services/meshDataService';

export interface ClusterMarker {
  id: number;
  count: number;
  lat: number;
  lng: number;
  node_ids: string[];
  radio_ids: string[];
}

export interface ClusterResult {
  clusters: ClusterMarker[];
  /** Map from node id → cluster id, so callers can look up "which
   *  cluster does this node belong to?" without iterating clusters. */
  byNodeId: Map<string, number>;
  /** Where the clustering work happened — surfaces in the UI badge. */
  backend: 'cuml' | 'cpu' | 'cpu_ts' | 'noop' | 'unknown';
}

export interface UseMapClusteringOptions {
  /** Master switch. When false, the hook does nothing and returns null. */
  enabled: boolean;
  /** Spatial radius in metres for the DBSCAN eps parameter. Sensible
   *  defaults: 25 for "merge markers that are essentially on top of
   *  each other", 100 for "collapse city-block-scale overlap." */
  epsMeters?: number;
  /** Minimum points for a cluster. Below this the points are
   *  promoted to singleton clusters by the server. */
  minSamples?: number;
  /** Debounce window for the cluster refetch. Defaults to 400ms,
   *  high enough to swallow a typical pan/zoom interaction. */
  debounceMs?: number;
}

const EMPTY_RESULT: ClusterResult = {
  clusters: [],
  byNodeId: new Map(),
  backend: 'noop',
};

export function useMapClustering(
  nodes: Node[],
  opts: UseMapClusteringOptions,
): ClusterResult | null {
  const { enabled, epsMeters = 50, minSamples = 2, debounceMs = 400 } = opts;
  const [result, setResult] = React.useState<ClusterResult | null>(null);

  // Stable-stringify the positioned-node set so React can compare it
  // for change. We DO NOT depend on `nodes` directly because that
  // reference flips every poll even when positions are unchanged,
  // which would re-fire the cluster fetch needlessly. The key is
  // `<id>:<lat:4f>:<lng:4f>` per node, sorted — captures "real change."
  const positionedKey = React.useMemo(() => {
    const parts: string[] = [];
    for (const n of nodes) {
      if (n.position) {
        parts.push(`${n.id}:${n.position.lat.toFixed(4)}:${n.position.lng.toFixed(4)}`);
      }
    }
    parts.sort();
    return parts.join('|');
  }, [nodes]);

  React.useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    const positioned = nodes.filter(n => n.position);
    if (positioned.length === 0) {
      setResult(EMPTY_RESULT);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      const r = await meshDataService.clusterMapPoints({
        points: positioned.map(n => ({
          lat: n.position!.lat,
          lng: n.position!.lng,
          node_id: n.id,
        })),
        eps_meters: epsMeters,
        min_samples: minSamples,
      });
      if (cancelled) return;
      if (!r) {
        // Sidecar unreachable — leave the existing result in place so
        // the UI doesn't flash empty + recover; just don't update.
        return;
      }
      const byNodeId = new Map<string, number>();
      for (const c of r.clusters) {
        for (const nid of c.node_ids) byNodeId.set(nid, c.id);
      }
      setResult({
        clusters: r.clusters,
        byNodeId,
        backend: r.backend ?? 'unknown',
      });
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // positionedKey gates the refetch on real position change; the
    // other knobs gate on parameter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, positionedKey, epsMeters, minSamples, debounceMs]);

  return result;
}
