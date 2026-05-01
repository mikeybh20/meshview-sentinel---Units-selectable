import { Node } from '../../types';

// custom component to render signal links between mesh nodes
export function MeshLinks({ nodes, latLngToPixel }: { nodes: Node[], latLngToPixel?: (latLng: [number, number]) => [number, number] }) {
  if (!latLngToPixel) return null;

  const homeBase = nodes.find(n => n.id === '!abcdef01');
  if (!homeBase || !homeBase.position) return null;

  const hbCoords = latLngToPixel([homeBase.position.lat, homeBase.position.lng]);

  return (
    <svg className="absolute inset-0 pointer-events-none z-10 w-full h-full">
      {nodes.filter(n => n.id !== '!abcdef01' && n.online && n.position).map(node => {
        const nodeCoords = latLngToPixel!([node.position!.lat, node.position!.lng]);
        const rssi = node.telemetry?.rssi || -100;
        
        let strokeColor = "#ef4444"; // default weak (red)
        if (rssi > -70) strokeColor = "#10b981"; // excellent (emerald)
        else if (rssi > -90) strokeColor = "#f59e0b"; // good (amber)

        return (
          <line
            key={`link-${node.id}`}
            x1={hbCoords[0]}
            y1={hbCoords[1]}
            x2={nodeCoords[0]}
            y2={nodeCoords[1]}
            stroke={strokeColor}
            strokeWidth="2"
            strokeDasharray="4 2"
            className="opacity-50"
          >
            <title>{node.name} RSSI: {rssi}dBm</title>
          </line>
        );
      })}
    </svg>
  );
}
