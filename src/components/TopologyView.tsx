import React from 'react';
import * as d3 from 'd3';
import { Node as MeshNode, NeighborInfoSnapshot, NeighborInfoModuleConfig, Group } from '../types';
import { cn } from '../lib/utils';
import { Search, Maximize2 } from 'lucide-react';
import { hexToRgba } from '../lib/color';
import { roleLabel, hardwareLabel } from '../lib/meshEnums';

/** localStorage key prefix for persisting drag positions per node id. */
const TOPOLOGY_LAYOUT_STORAGE_KEY = 'mesh.topologyLayout';

interface PersistedLayout { [nodeId: string]: { x: number; y: number } }

function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(TOPOLOGY_LAYOUT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as PersistedLayout;
  } catch { /* ignore */ }
  return {};
}

function saveLayoutEntry(nodeId: string, x: number, y: number) {
  try {
    const layout = loadLayout();
    layout[nodeId] = { x, y };
    localStorage.setItem(TOPOLOGY_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch { /* private mode etc. */ }
}

function clearLayoutEntry(nodeId: string) {
  try {
    const layout = loadLayout();
    delete layout[nodeId];
    localStorage.setItem(TOPOLOGY_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch { /* ignore */ }
}

interface Node extends d3.SimulationNodeDatum {
  id: string;
  label: string;     // short name for the in-circle label
  fullName: string;  // long name for the label below
  online: boolean;
  isHomeBase: boolean;
  favorite: boolean;
  /** Group color (hex like '#10b981') if the node is assigned to a group. */
  groupColor?: string;
}

interface Link extends d3.SimulationLinkDatum<Node> {
  source: string | Node;
  target: string | Node;
  /** SNR for NeighborInfo edges (dB), RSSI for fallback edges (dBm). */
  signal: number;
  /** 'neighbor' = direct-link observation; 'inferred' = home-base-radial guess. */
  kind: 'neighbor' | 'inferred';
}

interface TopologyViewProps {
  nodes: MeshNode[];
  neighborInfo?: NeighborInfoSnapshot[];
  groups?: Group[];
  localNodeId?: string | null;
  /** Whether a real radio is connected (vs simulator). Controls availability of admin actions. */
  canConfigureRadio?: boolean;
  /** Authoritative NeighborInfo config from the radio (preferred over inferred state). */
  neighborInfoConfig?: NeighborInfoModuleConfig;
  /** Configure the NeighborInfo module on the local radio. Returns success/error. */
  onConfigureNeighborInfo?: (opts: { enabled: boolean; intervalSecs?: number }) => Promise<{ ok: boolean; error?: string }>;
  onNodeSelect: (id: string) => void;
}

export function TopologyView({
  nodes,
  neighborInfo = [],
  groups = [],
  localNodeId,
  canConfigureRadio = false,
  neighborInfoConfig,
  onConfigureNeighborInfo,
  onNodeSelect,
}: TopologyViewProps) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const zoomBehaviorRef = React.useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const linkSelRef = React.useRef<d3.Selection<SVGLineElement, Link, SVGGElement, unknown> | null>(null);
  const nodeSelRef = React.useRef<d3.Selection<SVGGElement, Node, SVGGElement, unknown> | null>(null);
  const onNodeSelectRef = React.useRef(onNodeSelect);
  const [focusedNodeId, setFocusedNodeId] = React.useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null);
  const [hoverPos, setHoverPos] = React.useState<{ x: number; y: number } | null>(null);
  const [isFocusMode, setIsFocusMode] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<MeshNode[]>([]);
  const [niBusy, setNiBusy] = React.useState(false);
  const [niResult, setNiResult] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Use the real local node as home base — falls back to the simulator's
  // hardcoded id only when no live radio is connected.
  const homeBaseId = localNodeId || '!abcdef01';

  // Keep the callback ref fresh without destabilising the D3 effect
  React.useLayoutEffect(() => {
    onNodeSelectRef.current = onNodeSelect;
  });

  // Stable topology key — only rebuild D3 when the structural shape changes.
  // Critically, focusedNodeId is NOT in here: clicks must not tear down the
  // simulation, otherwise all node positions get recomputed and the focus
  // zoom can't find the just-clicked node.
  const topologyKey = React.useMemo(() => {
    const nodeKey = nodes.map(n => `${n.id}:${n.online ? '1' : '0'}:${n.groupId ?? ''}`).sort().join('|');
    const neighborKey = neighborInfo.map(ni =>
      `${ni.fromNodeId}>${ni.neighbors.map(x => x.nodeId).sort().join(',')}`
    ).sort().join('|');
    const groupKey = groups.map(g => `${g.id}:${g.color}`).sort().join('|');
    return `${nodeKey}#${neighborKey}#${groupKey}#${homeBaseId}#${isFocusMode ? '1' : '0'}#${isFocusMode ? focusedNodeId ?? '' : ''}`;
  }, [nodes, neighborInfo, groups, homeBaseId, isFocusMode, focusedNodeId]);

  const graphData = React.useMemo(() => {
    let activeNodes = nodes;

    // Build edges first so we can use them for focus-mode neighbor expansion.
    // Primary edges come from NeighborInfo (real direct-link observations);
    // fall back to a home-base-radial graph when no NeighborInfo data exists.
    const edges: Link[] = [];
    const seenEdge = new Set<string>(); // canonical "min|max" key to dedupe both directions

    for (const ni of neighborInfo) {
      for (const nb of ni.neighbors) {
        const a = ni.fromNodeId;
        const b = nb.nodeId;
        if (a === b) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        edges.push({ source: a, target: b, signal: nb.snr, kind: 'neighbor' });
      }
    }

    // If we have NO real edges, fall back to inferred radial from home base.
    // This keeps the graph non-empty during the warm-up period before
    // NeighborInfo packets have circulated.
    if (edges.length === 0) {
      const homeBase = nodes.find(n => n.id === homeBaseId);
      if (homeBase) {
        for (const node of nodes) {
          if (node.id === homeBase.id) continue;
          if (!node.online) continue;
          edges.push({
            source: node.id,
            target: homeBase.id,
            signal: node.telemetry?.rssi ?? -100,
            kind: 'inferred',
          });
        }
      }
    }

    // Focus mode: limit nodes to the focused node + its direct neighbors per the
    // edge set. (Previously this was hardcoded to "everything online if home base is focused".)
    if (isFocusMode && focusedNodeId) {
      const keep = new Set<string>([focusedNodeId]);
      for (const e of edges) {
        const s = typeof e.source === 'string' ? e.source : e.source.id;
        const t = typeof e.target === 'string' ? e.target : e.target.id;
        if (s === focusedNodeId) keep.add(t);
        if (t === focusedNodeId) keep.add(s);
      }
      activeNodes = nodes.filter(n => keep.has(n.id));
    }

    const activeIds = new Set(activeNodes.map(n => n.id));
    const filteredEdges = edges.filter(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      return activeIds.has(s) && activeIds.has(t);
    });

    const groupById = new Map(groups.map(g => [g.id, g]));
    const d3Nodes: Node[] = activeNodes.map(n => ({
      id: n.id,
      label: n.shortName || n.id.slice(-4).toUpperCase(),
      fullName: n.name || n.id,
      online: n.online,
      isHomeBase: n.id === homeBaseId,
      favorite: n.favorite,
      groupColor: n.groupId ? groupById.get(n.groupId)?.color : undefined,
    }));

    return { nodes: d3Nodes, links: filteredEdges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey]);

  // Build/rebuild D3 only when the underlying topology changes.
  React.useEffect(() => {
    if (!svgRef.current) return;

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const container = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => { container.attr('transform', event.transform); });

    svg.call(zoom);
    zoomBehaviorRef.current = zoom;

    // Restore any persisted drag positions before the simulation starts so
    // operators don't have to re-arrange the graph on every page load.
    const savedLayout = loadLayout();
    for (const n of graphData.nodes) {
      const saved = savedLayout[n.id];
      if (saved) {
        n.x = saved.x;
        n.y = saved.y;
        n.fx = saved.x;
        n.fy = saved.y;
      }
    }

    // Force simulation tuning notes:
    //  - `distanceMax` bounds the charge force to the nearest ~350 px so we get
    //    Barnes-Hut-with-cutoff behavior. Without this, every node attracts every
    //    other node every tick, which is O(N²) and visibly stutters past ~120 nodes.
    //  - `alphaDecay` was the default 0.0228 (settles in ~300 ticks); 0.045 cuts
    //    that to ~150 ticks — perceptibly faster on a 134-node mesh, and the
    //    final layout difference is invisible.
    //  - `velocityDecay` 0.55 (was default 0.4) damps the bouncy oscillation that
    //    otherwise persists for several seconds when many nodes are near-overlap.
    //  - `forceManyBody` strength reduced -500 → -380 to compensate for the cutoff.
    //  - `forceCollide.iterations` 1 (was default 1; explicit) keeps collide cheap.
    const simulation = d3.forceSimulation<Node>(graphData.nodes)
      .force('link', d3.forceLink<Node, Link>(graphData.links).id(d => d.id).distance(140).strength(0.6))
      .force('charge', d3.forceManyBody().strength(-380).distanceMax(350))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(36).iterations(1))
      .alphaDecay(0.045)
      .velocityDecay(0.55);

    // ---- Edges ----
    const link = container.append('g').attr('class', 'links')
      .selectAll('line')
      .data(graphData.links)
      .enter().append('line')
      .attr('stroke-width', (d: any) => {
        // Neighbor edges: SNR-based (-20..+20 dB → 1..4)
        if (d.kind === 'neighbor') return Math.max(1, Math.min(4, (d.signal + 20) / 10));
        // Inferred (RSSI): -140..-50 → 1..4
        return Math.max(1, Math.min(4, (d.signal + 140) / 25));
      })
      .attr('stroke', (d: any) => {
        // Color by signal strength regardless of kind
        const s = d.signal;
        if (d.kind === 'neighbor') {
          if (s > 5) return '#10b981';
          if (s > -5) return '#f59e0b';
          return '#ef4444';
        }
        if (s > -70) return '#10b981';
        if (s > -90) return '#f59e0b';
        return '#ef4444';
      })
      .attr('stroke-opacity', (d: any) => d.kind === 'neighbor' ? 0.85 : 0.45)
      .attr('stroke-dasharray', (d: any) => d.kind === 'inferred' ? '4 3' : 'none');

    linkSelRef.current = link as any;

    // ---- Nodes ----
    const node = container.append('g').attr('class', 'nodes')
      .selectAll('g')
      .data(graphData.nodes)
      .enter().append('g')
      .attr('cursor', 'pointer')
      .on('click', (event, d: any) => {
        event.stopPropagation();
        // Capture position BEFORE any state change — graphData may regenerate
        // and lose the simulation's coordinates by the time a useEffect fires.
        const cx = d.x;
        const cy = d.y;
        setFocusedNodeId((prev: string | null) => d.id === prev ? null : d.id);
        onNodeSelectRef.current(d.id);

        if (cx !== undefined && cy !== undefined && svgRef.current && zoomBehaviorRef.current) {
          const w = svgRef.current.clientWidth;
          const h = svgRef.current.clientHeight;
          d3.select(svgRef.current).transition().duration(600).call(
            zoomBehaviorRef.current.transform,
            d3.zoomIdentity.translate(w / 2, h / 2).scale(1.6).translate(-cx, -cy)
          );
        }
      })
      .on('mouseenter', (event: MouseEvent, d: any) => {
        setHoveredNodeId(d.id);
        if (svgRef.current) {
          const rect = svgRef.current.getBoundingClientRect();
          setHoverPos({ x: event.clientX - rect.left, y: event.clientY - rect.top });
        }
      })
      .on('mousemove', (event: MouseEvent) => {
        if (svgRef.current) {
          const rect = svgRef.current.getBoundingClientRect();
          setHoverPos({ x: event.clientX - rect.left, y: event.clientY - rect.top });
        }
      })
      .on('mouseleave', () => { setHoveredNodeId(null); setHoverPos(null); })
      .call(d3.drag<SVGGElement, Node>()
        .on('start', (event, d: any) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d: any) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d: any) => {
          if (!event.active) simulation.alphaTarget(0);
          // Pin the node where the operator dropped it (don't release fx/fy
          // back to null) and persist so the layout survives reloads.
          if (typeof d.fx === 'number' && typeof d.fy === 'number') {
            saveLayoutEntry(d.id, d.fx, d.fy);
          }
        }) as any);

    // Color resolution helpers — group color overrides favorite which overrides online/offline.
    const ringStroke = (d: Node): string => {
      if (d.groupColor) return d.groupColor;
      if (d.isHomeBase) return '#10b981';
      if (d.favorite) return '#f59e0b';
      if (d.online) return '#10b981';
      return '#64748b';
    };
    const fillRgba = (d: Node): string => {
      if (d.groupColor) return hexToRgba(d.groupColor, 0.18) ?? 'rgba(16,185,129,0.18)';
      if (d.isHomeBase) return 'rgba(16,185,129,0.25)';
      if (d.favorite) return 'rgba(245,158,11,0.18)';
      if (d.online) return 'rgba(16,185,129,0.18)';
      return 'rgba(30,41,59,0.85)';
    };
    const labelFill = (d: Node): string => {
      if (d.groupColor) return d.groupColor;
      if (d.isHomeBase) return '#34d399';
      if (d.favorite) return '#fbbf24';
      if (d.online) return '#34d399';
      return '#cbd5e1';
    };

    // Outer glow ring
    node.append('circle')
      .attr('class', 'glow-ring')
      .attr('r', (d: any) => d.isHomeBase ? 26 : 20)
      .attr('fill', 'none')
      .attr('stroke', (d: any) => ringStroke(d))
      .attr('stroke-width', 2)
      .attr('stroke-opacity', 0.55);

    // Solid filled circle (the "marker")
    node.append('circle')
      .attr('class', 'inner-dot')
      .attr('r', (d: any) => d.isHomeBase ? 22 : 16)
      .attr('fill', (d: any) => fillRgba(d))
      .attr('stroke', (d: any) => ringStroke(d))
      .attr('stroke-width', 2);

    // In-circle short-name label (Meshtastic-style)
    node.append('text')
      .attr('class', 'short-label')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-weight', '700')
      .attr('font-size', (d: any) => {
        const len = (d.label as string).length;
        if (d.isHomeBase) return len <= 2 ? '14px' : len <= 3 ? '12px' : '10px';
        return len <= 2 ? '12px' : len <= 3 ? '10px' : '8px';
      })
      .attr('fill', (d: any) => labelFill(d))
      .attr('pointer-events', 'none')
      .text((d: any) => d.label);

    // Long-name label below the circle
    node.append('text')
      .attr('class', 'name-label')
      .attr('dy', (d: any) => d.isHomeBase ? 42 : 34)
      .attr('text-anchor', 'middle')
      .attr('fill', '#e2e8f0')
      .attr('font-size', '11px')
      .attr('font-weight', '600')
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('pointer-events', 'none')
      .attr('paint-order', 'stroke')
      .attr('stroke', '#020617')
      .attr('stroke-width', '3px')
      .attr('stroke-linejoin', 'round')
      .text((d: any) => {
        const name = d.fullName as string;
        return name.length > 18 ? name.slice(0, 17) + '…' : name;
      });

    nodeSelRef.current = node as any;

    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => (d.source as any).x)
        .attr('y1', (d: any) => (d.source as any).y)
        .attr('x2', (d: any) => (d.target as any).x)
        .attr('y2', (d: any) => (d.target as any).y);
      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    // Auto fit-to-view once the simulation settles enough to have stable
    // positions. We fire after a short delay (~600ms) to let the layout
    // breathe; if the operator already moved the camera, we skip.
    let didAutoFit = false;
    const autoFitTimer = setTimeout(() => {
      if (didAutoFit) return;
      didAutoFit = true;
      fitToView();
    }, 800);

    return () => {
      clearTimeout(autoFitTimer);
      simulation.stop();
    };
  }, [graphData]);

  /**
   * Frame the camera so all nodes are visible with a comfortable margin.
   * Computes the bounding box from live D3 data (node.x/.y) so it works
   * regardless of where the simulation has settled.
   */
  const fitToView = React.useCallback(() => {
    const sel = nodeSelRef.current;
    const svgEl = svgRef.current;
    const zoom = zoomBehaviorRef.current;
    if (!sel || !svgEl || !zoom) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    sel.each((d: any) => {
      if (typeof d.x !== 'number' || typeof d.y !== 'number') return;
      if (d.x < minX) minX = d.x;
      if (d.y < minY) minY = d.y;
      if (d.x > maxX) maxX = d.x;
      if (d.y > maxY) maxY = d.y;
    });
    if (!isFinite(minX) || !isFinite(maxX)) return;

    const w = svgEl.clientWidth;
    const h = svgEl.clientHeight;
    const padding = 60;
    const dx = Math.max(1, maxX - minX);
    const dy = Math.max(1, maxY - minY);
    const scale = Math.max(0.1, Math.min(1.5, Math.min((w - 2 * padding) / dx, (h - 2 * padding) / dy)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    d3.select(svgEl).transition().duration(500).call(
      zoom.transform,
      d3.zoomIdentity.translate(w / 2, h / 2).scale(scale).translate(-cx, -cy),
    );
  }, []);

  /** Clear all persisted drag positions and re-trigger the layout. */
  const resetLayout = React.useCallback(() => {
    try { localStorage.removeItem(TOPOLOGY_LAYOUT_STORAGE_KEY); } catch { /* ignore */ }
    // Unpin every live node and let the simulation re-layout naturally
    const sel = nodeSelRef.current;
    if (sel) {
      sel.each((d: any) => { d.fx = null; d.fy = null; });
    }
    // Trigger a fit after layout settles
    setTimeout(() => fitToView(), 1000);
  }, [fitToView]);

  // Lightweight visual update on hover/focus — no simulation rebuild
  React.useEffect(() => {
    const nodeSel = nodeSelRef.current;
    const linkSel = linkSelRef.current;
    if (!nodeSel || !linkSel) return;

    const activeId = hoveredNodeId || focusedNodeId;

    const isNeighbor = (nodeId: string) => {
      if (!activeId) return true;
      if (nodeId === activeId) return true;
      return graphData.links.some(l => {
        const srcId = typeof l.source === 'string' ? l.source : (l.source as any).id;
        const tgtId = typeof l.target === 'string' ? l.target : (l.target as any).id;
        return (srcId === activeId && tgtId === nodeId) || (tgtId === activeId && srcId === nodeId);
      });
    };

    const isLinkActive = (l: any) => {
      if (!activeId) return true;
      const srcId = typeof l.source === 'string' ? l.source : l.source.id;
      const tgtId = typeof l.target === 'string' ? l.target : l.target.id;
      return srcId === activeId || tgtId === activeId;
    };

    nodeSel.attr('opacity', (d: any) => isNeighbor(d.id) ? 1 : 0.3);
    nodeSel.select('.glow-ring')
      .attr('r', (d: any) => d.id === activeId ? (d.isHomeBase ? 32 : 26) : (d.isHomeBase ? 26 : 20))
      .attr('stroke-opacity', (d: any) => d.id === activeId ? 0.95 : 0.55);
    linkSel.attr('stroke-opacity', (d: any) => isLinkActive(d) ? 0.95 : 0.12);
  }, [hoveredNodeId, focusedNodeId, graphData.links]);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearchQuery(q);
    if (q.trim()) {
      setSearchResults(nodes.filter(n =>
        n.name.toLowerCase().includes(q.toLowerCase()) ||
        n.id.toLowerCase().includes(q.toLowerCase()) ||
        (n.shortName && n.shortName.toLowerCase().includes(q.toLowerCase()))
      ).slice(0, 12));
    } else {
      setSearchResults([]);
    }
  };

  const selectSearchResult = (nodeId: string) => {
    // Find the node's current simulation position from the live D3 selection
    // and zoom to it without round-tripping through state.
    const sel = nodeSelRef.current;
    const target = sel?.filter((d: any) => d.id === nodeId).datum() as Node | undefined;
    setFocusedNodeId(nodeId);
    onNodeSelectRef.current(nodeId);
    setSearchQuery('');
    setSearchResults([]);
    if (target?.x !== undefined && target?.y !== undefined && svgRef.current && zoomBehaviorRef.current) {
      const w = svgRef.current.clientWidth;
      const h = svgRef.current.clientHeight;
      d3.select(svgRef.current).transition().duration(600).call(
        zoomBehaviorRef.current.transform,
        d3.zoomIdentity.translate(w / 2, h / 2).scale(1.6).translate(-target.x, -target.y)
      );
    }
  };

  const edgeCount = graphData.links.length;
  const neighborEdgeCount = graphData.links.filter(l => l.kind === 'neighbor').length;
  const usingInferredEdges = edgeCount > 0 && neighborEdgeCount === 0;

  // Prefer the authoritative readback from the firmware admin response. If we
  // haven't received that yet, fall back to inferring from observed traffic
  // (presence of the local node in the neighborInfo array means it's broadcasting).
  const localNiSnapshot = localNodeId ? neighborInfo.find(ni => ni.fromNodeId === localNodeId) : undefined;
  const niLocallyActive = neighborInfoConfig
    ? neighborInfoConfig.enabled
    : !!localNiSnapshot;
  const niStateAuthoritative = !!neighborInfoConfig;
  const niIntervalSecs = neighborInfoConfig?.updateIntervalSecs ?? localNiSnapshot?.intervalSecs ?? 0;

  // First-connect race: NodeInfo for the local node arrives a few seconds after
  // the serial port opens. Until we know `localNodeId` we can't tell whether the
  // banner should say "NOT BROADCASTING" — and in that brief window it would
  // wrongly accuse a healthy radio. Suppress the negative state for the first
  // ~6 s after a `localNodeId === null` mount so it shows "Identifying…" instead.
  const [identifying, setIdentifying] = React.useState(localNodeId == null);
  React.useEffect(() => {
    if (localNodeId) { setIdentifying(false); return; }
    setIdentifying(true);
    const t = setTimeout(() => setIdentifying(false), 6000);
    return () => clearTimeout(t);
  }, [localNodeId]);

  return (
    <div className="w-full h-full relative overflow-hidden bg-brand-bg/20 rounded-xl border border-brand-line">
      <svg ref={svgRef} className="w-full h-full" />

      {/* Hover tooltip — follows cursor when hovering a topology node */}
      {hoveredNodeId && hoverPos && (() => {
        const node = nodes.find(n => n.id === hoveredNodeId);
        if (!node) return null;
        const minutesSince = Math.floor((Date.now() - node.lastSeen) / 60000);
        const lastSeenText = minutesSince < 1 ? 'just now' :
          minutesSince < 60 ? `${minutesSince}m ago` :
          minutesSince < 1440 ? `${Math.floor(minutesSince / 60)}h ago` :
          `${Math.floor(minutesSince / 1440)}d ago`;
        const role = roleLabel(node.role, true);
        const hw = hardwareLabel(node.hwModel);
        const groupName = groups.find(g => g.id === node.groupId)?.name;
        const svgW = svgRef.current?.clientWidth ?? 0;
        const svgH = svgRef.current?.clientHeight ?? 0;
        // Flip the tooltip to the cursor's other side near the edges so it stays visible.
        const flipX = hoverPos.x > svgW - 240;
        const flipY = hoverPos.y > svgH - 160;
        const left = flipX ? hoverPos.x - 12 - 220 : hoverPos.x + 18;
        const top = flipY ? hoverPos.y - 12 - 140 : hoverPos.y + 14;
        return (
          <div
            className="absolute z-20 pointer-events-none technical-panel bg-brand-bg/95 backdrop-blur-md p-2.5 min-w-[200px] max-w-[260px] shadow-lg"
            style={{ left, top }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              {node.shortName && (
                <span className="text-[9px] mono-text text-brand-accent bg-brand-accent/10 border border-brand-accent/30 px-1 py-0.5 rounded shrink-0">
                  {node.shortName}
                </span>
              )}
              <span className="text-xs font-bold truncate">{node.name}</span>
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0 ml-auto", node.online ? 'bg-brand-accent' : 'bg-brand-muted')} />
            </div>
            <div className="text-[10px] mono-text text-brand-muted truncate">
              {node.id}{hw ? ` · ${hw}` : ''}
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] mono-text">
              <span className="text-brand-muted">Last seen</span>
              <span className="text-brand-ink text-right">{lastSeenText}</span>
              {role && (<><span className="text-brand-muted">Role</span><span className="text-brand-ink text-right">{role}</span></>)}
              {node.isLicensed && (<><span className="text-brand-muted">Licensed</span><span className="text-brand-warning text-right">LIC</span></>)}
              {node.lastVia === 'mqtt' && (<><span className="text-brand-muted">Via</span><span className="text-brand-info text-right">MQTT</span></>)}
              {node.telemetry && (
                <>
                  {typeof node.telemetry.battery === 'number' && node.telemetry.battery > 0 && (
                    <><span className="text-brand-muted">Battery</span><span className="text-brand-ink text-right">{Math.round(node.telemetry.battery)}%</span></>
                  )}
                  {typeof node.telemetry.snr === 'number' && node.telemetry.snr !== 0 && (
                    <><span className="text-brand-muted">SNR</span><span className="text-brand-ink text-right">{node.telemetry.snr.toFixed(1)} dB</span></>
                  )}
                  {typeof node.telemetry.rssi === 'number' && node.telemetry.rssi !== 0 && (
                    <><span className="text-brand-muted">RSSI</span><span className="text-brand-ink text-right">{Math.round(node.telemetry.rssi)} dBm</span></>
                  )}
                </>
              )}
              {groupName && (<><span className="text-brand-muted">Group</span><span className="text-brand-ink text-right truncate">{groupName}</span></>)}
              {node.favorite && (<><span className="text-brand-muted">Favorite</span><span className="text-brand-warning text-right">★</span></>)}
            </div>
          </div>
        );
      })()}

      {/* Camera controls — fit-to-view + reset layout */}
      <div className="absolute top-4 right-72 z-10 flex items-center gap-1 pointer-events-auto">
        <button
          onClick={fitToView}
          title="Fit all nodes in view"
          className="bg-brand-bg/80 backdrop-blur-md border border-brand-line hover:border-brand-accent text-brand-muted hover:text-brand-accent rounded px-2 py-2 transition-colors"
        >
          <Maximize2 size={13} />
        </button>
        <button
          onClick={() => {
            if (confirm('Reset all dragged node positions and re-run the layout?')) {
              resetLayout();
            }
          }}
          title="Reset saved layout (clears all pinned positions)"
          className="bg-brand-bg/80 backdrop-blur-md border border-brand-line hover:border-brand-accent text-brand-muted hover:text-brand-accent rounded px-2 py-2 text-[10px] mono-text uppercase font-bold transition-colors"
        >
          Reset
        </button>
      </div>

      {/* Search Bar */}
      <div className="absolute top-4 right-4 z-10 w-64">
        <div className="relative">
          <input
            type="text"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={handleSearch}
            className="w-full bg-brand-bg/80 backdrop-blur-md border border-brand-line rounded-lg py-2 pl-9 pr-4 text-xs mono-text focus:outline-none focus:border-brand-accent transition-all placeholder:text-brand-muted"
          />
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />

          {searchResults.length > 0 && (
            <div className="absolute top-full left-0 w-full mt-1 technical-panel bg-brand-bg/95 backdrop-blur-md max-h-48 overflow-y-auto">
              {searchResults.map(n => (
                <button
                  key={n.id}
                  onClick={() => selectSearchResult(n.id)}
                  className="w-full text-left px-3 py-2 hover:bg-brand-line transition-colors flex items-center justify-between group"
                >
                  <div className="flex flex-col">
                    <span className="text-xs font-bold flex items-center gap-1.5">
                      {n.shortName && (
                        <span className="text-[9px] mono-text text-brand-accent bg-brand-accent/10 border border-brand-accent/30 px-1 py-0.5 rounded">
                          {n.shortName}
                        </span>
                      )}
                      {n.name}
                    </span>
                    <span className="text-[10px] mono-text text-brand-muted">{n.id}</span>
                  </div>
                  <div className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    n.online ? "bg-brand-accent" : "bg-brand-muted"
                  )} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 right-4 technical-panel p-3 bg-brand-bg/80 backdrop-blur-md pointer-events-none">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-2">Topology Legend</h4>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-brand-accent/30 border-2 border-emerald-400" />
            <span className="text-[9px] mono-text uppercase">Home / Online</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-brand-warning/20 border-2 border-amber-400" />
            <span className="text-[9px] mono-text uppercase">Favorite</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-brand-line border-2 border-brand-muted" />
            <span className="text-[9px] mono-text uppercase">Offline</span>
          </div>
          <div className="flex items-center gap-2 pt-1 border-t border-brand-line">
            <div className="w-4 h-0.5 bg-emerald-500" />
            <span className="text-[9px] mono-text uppercase">NeighborInfo Link</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-0.5 bg-brand-accent/50" style={{ borderTop: '1px dashed' }} />
            <span className="text-[9px] mono-text uppercase">Inferred Link</span>
          </div>
        </div>
      </div>

      {/* Status banner — explains why edges look the way they do */}
      <div className="absolute top-4 left-4 flex flex-col gap-2 max-w-md">
        <div className="bg-brand-bg/70 backdrop-blur-md border border-brand-line rounded p-2 space-y-1">
          <p className="text-[10px] mono-text text-brand-muted">
            CLICK NODE TO FOCUS · DRAG TO REPOSITION · SCROLL TO ZOOM
          </p>
          <p className="text-[9px] mono-text">
            <span className="text-brand-accent font-bold">{graphData.nodes.length}</span>
            <span className="text-brand-muted"> nodes · </span>
            <span className="text-brand-accent font-bold">{neighborEdgeCount}</span>
            <span className="text-brand-muted"> NeighborInfo links{edgeCount > neighborEdgeCount ? ` · ${edgeCount - neighborEdgeCount} inferred` : ''}</span>
          </p>
          {edgeCount === 0 && (
            <p className="text-[9px] text-brand-warning leading-snug">
              No edges yet. Topology fills in as nodes report (NeighborInfo packets every few minutes when the module is enabled).
            </p>
          )}
          {usingInferredEdges && (
            <p className="text-[9px] text-brand-warning/80 leading-snug">
              Showing inferred home-base links — enable the NeighborInfo module on your radio for accurate topology.
            </p>
          )}

          {canConfigureRadio && onConfigureNeighborInfo && (
            <div className="pt-1.5 border-t border-brand-line/50 mt-1 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      identifying ? 'bg-brand-warning animate-pulse'
                      : niLocallyActive ? 'bg-brand-accent animate-pulse'
                      : 'bg-brand-muted'
                    }`}
                    title={
                      identifying ? 'Waiting for the radio to report its node id (MyNodeInfo)'
                      : niLocallyActive ? 'Local radio is broadcasting NeighborInfo'
                      : 'No NeighborInfo broadcasts observed from local radio yet'
                    }
                  />
                  <span className="text-[9px] font-bold uppercase tracking-widest text-brand-muted">
                    NeighborInfo:
                  </span>
                  <span className={`text-[9px] font-bold mono-text ${
                    identifying ? 'text-brand-warning'
                    : niLocallyActive ? 'text-brand-accent'
                    : 'text-brand-muted'
                  }`}>
                    {identifying
                      ? 'IDENTIFYING…'
                      : niLocallyActive
                        ? `ACTIVE${niIntervalSecs ? ` · ${Math.round(niIntervalSecs / 60)}min` : ''}`
                        : niStateAuthoritative ? 'DISABLED' : 'NOT BROADCASTING'}
                  </span>
                  {!identifying && !niStateAuthoritative && canConfigureRadio && (
                    <span title="Inferred from observed traffic (no admin readback yet)" className="text-[8px] text-brand-muted italic">
                      inferred
                    </span>
                  )}
                </div>

                {niLocallyActive ? (
                  <button
                    onClick={async () => {
                      setNiBusy(true);
                      setNiResult(null);
                      const r = await onConfigureNeighborInfo({ enabled: false });
                      setNiBusy(false);
                      if (r.ok) setNiResult({ kind: 'ok', text: 'Disabled — local radio will stop broadcasting (existing observations remain visible)' });
                      else setNiResult({ kind: 'error', text: r.error ?? 'Disable failed' });
                    }}
                    disabled={niBusy}
                    className="text-[9px] font-bold uppercase tracking-widest bg-brand-error/10 hover:bg-brand-error/20 border border-brand-error/40 text-brand-error hover:text-red-200 rounded px-2 py-1 transition-colors disabled:opacity-50 pointer-events-auto"
                  >
                    {niBusy ? 'Disabling…' : 'Disable'}
                  </button>
                ) : (
                  <button
                    onClick={async () => {
                      setNiBusy(true);
                      setNiResult(null);
                      // 30 minutes — balance between freshness and airtime
                      const r = await onConfigureNeighborInfo({ enabled: true, intervalSecs: 1800 });
                      setNiBusy(false);
                      if (r.ok) setNiResult({ kind: 'ok', text: 'Enabled — first packet should arrive within ~1 min' });
                      else setNiResult({ kind: 'error', text: r.error ?? 'Enable failed' });
                    }}
                    disabled={niBusy}
                    className="text-[9px] font-bold uppercase tracking-widest bg-brand-accent/15 hover:bg-brand-accent/25 border border-brand-accent/40 text-brand-accent rounded px-2 py-1 transition-colors disabled:opacity-50 pointer-events-auto"
                  >
                    {niBusy ? 'Enabling…' : 'Enable'}
                  </button>
                )}
              </div>
              {niResult && (
                <p className={`text-[9px] leading-snug ${niResult.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
                  {niResult.text}
                </p>
              )}
            </div>
          )}
        </div>

        {focusedNodeId && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsFocusMode(!isFocusMode)}
              className={cn(
                "px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-widest border transition-all pointer-events-auto",
                isFocusMode
                  ? "bg-brand-accent text-black border-brand-accent"
                  : "bg-brand-line text-brand-ink border-brand-line hover:border-brand-accent"
              )}
            >
              {isFocusMode ? "Exit Focus Mode" : "Focus Neighborhood"}
            </button>
            <button
              onClick={() => { setFocusedNodeId(null); setIsFocusMode(false); }}
              className="px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-widest bg-brand-line text-brand-muted border border-brand-line hover:text-brand-ink transition-all pointer-events-auto"
            >
              Clear
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
