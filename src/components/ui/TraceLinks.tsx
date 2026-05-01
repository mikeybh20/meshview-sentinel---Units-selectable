import { Node, Message } from '../../types';

// custom component to render an animated message trace path
export function TraceLinks({ nodes, messages, traceMessageId, latLngToPixel }: { nodes: Node[], messages: Message[], traceMessageId: string | null, latLngToPixel?: (latLng: [number, number]) => [number, number] }) {
  if (!latLngToPixel || !traceMessageId) return null;

  const message = messages.find(m => m.id === traceMessageId);
  if (!message || !message.hops || message.hops.length < 1) return null;

  // Build the path: From -> Hop1 -> Hop2 -> ... -> To
  const pathNodes = [message.from, ...message.hops, message.to];
  const points: [number, number][] = pathNodes
    .map(id => nodes.find(n => n.id === id)?.position)
    .filter((pos): pos is NonNullable<typeof pos> => !!pos)
    .map(pos => latLngToPixel([pos.lat, pos.lng]));

  if (points.length < 2) return null;

  return (
    <svg className="absolute inset-0 pointer-events-none z-20 w-full h-full">
      <defs>
        <filter id="trace-glow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      {/* Background path shadow */}
      <polyline
        points={points.map(p => p.join(',')).join(' ')}
        fill="none"
        stroke="#10b981"
        strokeWidth="6"
        strokeOpacity="0.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Main path - static for now to debug hook issues in map children */}
      <polyline
        points={points.map(p => p.join(',')).join(' ')}
        fill="none"
        stroke="#10b981"
        strokeWidth="3"
        strokeDasharray="10 10"
        filter="url(#trace-glow)"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Node indicators along the path */}
      {points.map((p, i) => (
        <circle
          key={`point-${i}`}
          cx={p[0]}
          cy={p[1]}
          r="4"
          fill="#10b981"
        />
      ))}
    </svg>
  );
}
