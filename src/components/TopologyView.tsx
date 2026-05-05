import React from 'react';
import * as d3 from 'd3';
import { Node as MeshNode } from '../types';
import { cn } from '../lib/utils';
import { Search } from 'lucide-react';

interface Node extends d3.SimulationNodeDatum {
  id: string;
  name: string;
  online: boolean;
  isHomeBase: boolean;
}

interface Link extends d3.SimulationLinkDatum<Node> {
  source: string;
  target: string;
  rssi: number;
}

export function TopologyView({ nodes, onNodeSelect }: { nodes: MeshNode[], onNodeSelect: (id: string) => void }) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const zoomBehaviorRef = React.useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const linkSelRef = React.useRef<d3.Selection<SVGLineElement, Link, SVGGElement, unknown> | null>(null);
  const nodeSelRef = React.useRef<d3.Selection<SVGGElement, Node, SVGGElement, unknown> | null>(null);
  const onNodeSelectRef = React.useRef(onNodeSelect);
  const [focusedNodeId, setFocusedNodeId] = React.useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null);
  const [isFocusMode, setIsFocusMode] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<MeshNode[]>([]);

  // Keep the callback ref fresh without destabilising the D3 effect
  React.useLayoutEffect(() => {
    onNodeSelectRef.current = onNodeSelect;
  });

  // Stable topology key — only rebuild D3 when node IDs or online status change
  const topologyKey = React.useMemo(() =>
    nodes.map(n => `${n.id}:${n.online ? '1' : '0'}`).sort().join('|'),
    [nodes]
  );

  const graphData = React.useMemo(() => {
    let activeNodes = nodes;

    if (isFocusMode && focusedNodeId) {
      const neighbors = new Set<string>();
      neighbors.add(focusedNodeId);
      const homeBase = nodes.find(n => n.id === '!abcdef01');
      if (focusedNodeId === '!abcdef01') {
        nodes.forEach(n => n.online && neighbors.add(n.id));
      } else if (homeBase) {
        neighbors.add(homeBase.id);
      }
      activeNodes = nodes.filter(n => neighbors.has(n.id));
    }

    const d3Nodes: Node[] = activeNodes.map(n => ({
      id: n.id,
      name: n.name,
      online: n.online,
      isHomeBase: n.id === '!abcdef01'
    }));

    const links: Link[] = [];
    const homeBase = activeNodes.find(n => n.id === '!abcdef01');
    if (homeBase) {
      activeNodes.forEach(node => {
        if (node.id !== homeBase.id && node.online) {
          links.push({ source: node.id, target: homeBase.id, rssi: node.telemetry?.rssi || -100 });
        }
      });
    }

    return { nodes: d3Nodes, links };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey, focusedNodeId, isFocusMode]);

  // Rebuild D3 only when topology changes — NOT when onNodeSelect reference changes
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

    const simulation = d3.forceSimulation<Node>(graphData.nodes)
      .force('link', d3.forceLink<Node, Link>(graphData.links).id(d => d.id).distance(150))
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(50));

    const link = container.append('g')
      .selectAll('line')
      .data(graphData.links)
      .enter().append('line')
      .attr('stroke-width', (d: any) => Math.max(1, (d.rssi + 140) / 20))
      .attr('stroke', (d: any) => {
        if (d.rssi > -70) return '#10b981';
        if (d.rssi > -90) return '#f59e0b';
        return '#ef4444';
      })
      .attr('stroke-opacity', 0.8)
      .attr('stroke-dasharray', (d: any) => d.rssi < -90 ? '4 2' : 'none');

    linkSelRef.current = link as any;

    const node = container.append('g')
      .selectAll('g')
      .data(graphData.nodes)
      .enter().append('g')
      .attr('cursor', 'pointer')
      .on('click', (event, d: any) => {
        setFocusedNodeId((prev: string | null) => d.id === prev ? null : d.id);
        onNodeSelectRef.current(d.id);
      })
      .on('mouseenter', (event, d: any) => { setHoveredNodeId(d.id); })
      .on('mouseleave', () => { setHoveredNodeId(null); })
      .call(d3.drag<SVGGElement, Node>()
        .on('start', (event, d: any) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d: any) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d: any) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
        }) as any);

    node.append('circle')
      .attr('class', 'glow-ring')
      .attr('r', (d: any) => d.isHomeBase ? 18 : 10)
      .attr('fill', 'transparent')
      .attr('stroke', (d: any) => d.online ? '#10b981' : '#ef4444')
      .attr('stroke-width', 2)
      .attr('stroke-opacity', 0.5);

    node.append('circle')
      .attr('class', 'inner-dot')
      .attr('r', (d: any) => d.isHomeBase ? 12 : 6)
      .attr('fill', (d: any) => d.isHomeBase ? '#10b981' : (d.online ? '#e2e8f0' : '#475569'))
      .attr('stroke', '#020617')
      .attr('stroke-width', 1.5);

    node.append('text')
      .attr('dy', 30)
      .attr('text-anchor', 'middle')
      .attr('fill', '#94a3b8')
      .attr('font-size', '10px')
      .attr('font-weight', 'normal')
      .attr('font-family', 'JetBrains Mono, monospace')
      .text((d: any) => d.name);

    nodeSelRef.current = node as any;

    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => (d.source as any).x)
        .attr('y1', (d: any) => (d.source as any).y)
        .attr('x2', (d: any) => (d.target as any).x)
        .attr('y2', (d: any) => (d.target as any).y);
      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    return () => { simulation.stop(); };
  }, [graphData]); // onNodeSelect intentionally excluded — accessed via ref

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

    nodeSel.attr('opacity', (d: any) => isNeighbor(d.id) ? 1 : 0.2);
    nodeSel.select('.glow-ring').attr('r', (d: any) => d.isHomeBase ? 18 : (d.id === activeId ? 14 : 10));
    nodeSel.select('.inner-dot')
      .attr('r', (d: any) => d.isHomeBase ? 12 : (d.id === activeId ? 10 : 6))
      .attr('stroke', (d: any) => d.id === activeId ? '#10b981' : '#020617');
    nodeSel.select('text')
      .attr('fill', (d: any) => d.id === activeId ? '#10b981' : '#94a3b8')
      .attr('font-size', (d: any) => d.id === activeId ? '12px' : '10px')
      .attr('font-weight', (d: any) => d.id === activeId ? 'bold' : 'normal');
    linkSel.attr('stroke-opacity', (d: any) => isLinkActive(d) ? 0.8 : 0.1);
  }, [hoveredNodeId, focusedNodeId, graphData.links]);

  React.useEffect(() => {
    if (focusedNodeId && svgRef.current && zoomBehaviorRef.current) {
      const node = graphData.nodes.find(n => n.id === focusedNodeId);
      if (node && node.x !== undefined && node.y !== undefined) {
        const svg = d3.select(svgRef.current);
        const width = svgRef.current.clientWidth;
        const height = svgRef.current.clientHeight;
        svg.transition().duration(750).call(
          zoomBehaviorRef.current.transform,
          d3.zoomIdentity.translate(width / 2, height / 2).scale(1.5).translate(-node.x!, -node.y!)
        );
      }
    }
  }, [focusedNodeId, graphData.nodes]);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearchQuery(q);
    if (q.trim()) {
      setSearchResults(nodes.filter(n =>
        n.name.toLowerCase().includes(q.toLowerCase()) ||
        n.id.toLowerCase().includes(q.toLowerCase())
      ));
    } else {
      setSearchResults([]);
    }
  };

  const selectSearchResult = (nodeId: string) => {
    setFocusedNodeId(nodeId);
    onNodeSelectRef.current(nodeId);
    setSearchQuery('');
    setSearchResults([]);
  };

  return (
    <div className="w-full h-full relative overflow-hidden bg-brand-bg/20 rounded-xl border border-brand-line">
      <svg ref={svgRef} className="w-full h-full" />

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
                    <span className="text-xs font-bold">{n.name}</span>
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
            <div className="w-2.5 h-2.5 rounded-full bg-brand-accent shadow-[0_0_8px_rgba(16,185,129,0.4)]" />
            <span className="text-[9px] mono-text uppercase">Home Base</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-slate-200 border border-emerald-500/50" />
            <span className="text-[9px] mono-text uppercase">Node Online</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-slate-600 border border-red-500/50" />
            <span className="text-[9px] mono-text uppercase">Node Offline</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-0.5 bg-emerald-500" />
            <span className="text-[9px] mono-text uppercase">Strong Link</span>
          </div>
        </div>
      </div>

      <div className="absolute top-4 left-4 flex flex-col gap-2">
        <p className="text-[10px] mono-text text-brand-muted bg-brand-bg/60 p-2 rounded border border-brand-line">
          CLICK NODE TO FOCUS | DRAG TO REPOSITION
        </p>

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
