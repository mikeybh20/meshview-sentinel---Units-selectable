import React from 'react';

import { cn } from '../../lib/utils';

interface MatrixNode {
  id: string;
  name: string;
}

interface MatrixViewProps {
  matrixData: {
    nodes: MatrixNode[];
    matrix: Record<string, Record<string, { count: number; success: number }>>;
  };
}

export function MatrixView({ matrixData }: MatrixViewProps) {
  return (
    <div className="technical-panel flex-1 flex flex-col p-6">
      <div className="mb-6">
        <h3 className="text-sm font-bold uppercase tracking-widest text-brand-muted mb-1">Communication Adjacency Matrix</h3>
        <p className="text-[10px] mono-text opacity-50">Visualizing message density between peers (Sender Y {"->"} Recipient X)</p>
      </div>

      <div className="flex-1 overflow-auto flex items-center justify-center p-4">
         <div className="grid border-t border-l border-brand-line" style={{ gridTemplateColumns: `repeat(${matrixData.nodes.length + 1}, minmax(60px, 1fr))` }}>
            {/* Top Header */}
            <div className="p-2 border-b border-r border-brand-line bg-brand-line/20 flex items-center justify-center font-bold text-[10px] mono-text">X \ Y</div>
            {matrixData.nodes.map(node => (
              <div key={`h-${node.id}`} className="p-2 border-b border-r border-brand-line bg-brand-line/10 flex items-center justify-center font-bold text-[10px] mono-text uppercase rotate-45 sm:rotate-0">
                {node.name}
              </div>
            ))}

            {/* Rows */}
            {matrixData.nodes.map(rowNode => (
              <React.Fragment key={`row-${rowNode.id}`}>
                {/* Row Header */}
                <div className="p-2 border-b border-r border-brand-line bg-brand-line/10 flex items-center justify-center font-bold text-[10px] mono-text uppercase">
                  {rowNode.name}
                </div>
                {/* Cells */}
                {matrixData.nodes.map(colNode => {
                  const stats = matrixData.matrix[colNode.id][rowNode.id];
                  const intensity = Math.min(stats.count * 10, 80);
                  return (
                    <div 
                      key={`${rowNode.id}-${colNode.id}`}
                      className="aspect-square border-b border-r border-brand-line flex items-center justify-center relative group"
                      style={{ 
                        backgroundColor: stats.count > 0 ? `rgba(16, 185, 129, ${0.1 + intensity / 100})` : 'transparent'
                      }}
                    >
                      <span className={cn("text-[10px] mono-text font-bold", stats.count > 0 ? "text-white" : "text-brand-muted/20")}>
                        {stats.count}
                      </span>
                      
                      {/* Tooltip */}
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-brand-bg border border-brand-accent p-2 rounded shadow-xl hidden group-hover:block z-50 pointer-events-none">
                        <p className="text-[10px] font-bold text-brand-accent mb-1 uppercase tracking-tighter">Link Analysis</p>
                        <p className="text-[9px] mono-text text-brand-ink/80">{colNode.name} {"->"} {rowNode.name}</p>
                        <div className="mt-1 pt-1 border-t border-brand-line space-y-1">
                          <p className="text-[8px] flex justify-between"><span>PACKETS:</span> <span className="text-brand-accent">{stats.count}</span></p>
                          <p className="text-[8px] flex justify-between"><span>RELAY SCORE:</span> <span className="text-brand-ink">HIGH</span></p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
         </div>
      </div>

      <div className="mt-6 flex items-center gap-6">
         <div className="flex items-center gap-2">
           <div className="w-3 h-3 bg-brand-line border border-brand-line rounded" />
           <span className="text-[10px] mono-text uppercase">Null Traffic</span>
         </div>
         <div className="flex items-center gap-2">
           <div className="w-12 h-3 bg-gradient-to-r from-brand-accent/20 to-brand-accent rounded" />
           <span className="text-[10px] mono-text uppercase">Traffic Density</span>
         </div>
      </div>
    </div>
  );
}
