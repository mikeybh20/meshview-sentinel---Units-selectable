import React from 'react';
import { X, Upload, FileJson, Link, RefreshCcw, Check, AlertCircle } from 'lucide-react';
import { Node } from '../types';
import { parseCSV } from '../lib/exportUtils';
import { simulator } from '../services/meshtasticSimulator';
import { cn } from '../lib/utils';

interface ImportModalProps {
  nodes: Node[];
  onClose: () => void;
}

export function ImportModal({ nodes, onClose }: ImportModalProps) {
  const [importSource, setImportSource] = React.useState<'file' | 'node'>('file');
  const [selectedNodeId, setSelectedNodeId] = React.useState<string>('');
  const [isImporting, setIsImporting] = React.useState(false);
  const [status, setStatus] = React.useState<{ type: 'success' | 'error', message: string } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setStatus(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const data = parseCSV(content);
        
        if (data.length > 0) {
          // In a real app, logic would map CSV fields to state
          // For the simulation, we'll just show success
          setTimeout(() => {
            setIsImporting(false);
            setStatus({ type: 'success', message: `Successfully parsed ${data.length} records from ${file.name}` });
          }, 1000);
        } else {
          throw new Error('No valid data found in file');
        }
      } catch (err) {
        setIsImporting(false);
        setStatus({ type: 'error', message: 'Failed to parse CSV file. Ensure format is correct.' });
      }
    };
    reader.readAsText(file);
  };

  const handleNodeSync = () => {
    if (!selectedNodeId) return;
    setIsImporting(true);
    setStatus(null);

    // Simulate fetching config from remote node over RF
    setTimeout(() => {
      const targetNode = nodes.find(n => n.id === selectedNodeId);
      if (targetNode) {
        setIsImporting(false);
        setStatus({ type: 'success', message: `Imported configuration from ${targetNode.name} (${targetNode.id})` });
        // Actually update a local simulator state (mock)
        simulator.addEvent('TELEMETRY', 'local', `Synced with ${targetNode.id}`);
      } else {
        setIsImporting(false);
        setStatus({ type: 'error', message: 'Node not found or offline' });
      }
    }, 2000);
  };

  return (
    <div className="fixed inset-0 bg-brand-bg/80 backdrop-blur-md z-[200] flex items-center justify-center p-6">
      <div className="technical-panel w-full max-w-md overflow-hidden flex flex-col">
        <div className="p-4 border-b border-brand-line flex items-center justify-between bg-brand-line/10">
          <div className="flex items-center gap-2">
            <Upload size={18} className="text-brand-accent" />
            <h3 className="text-lg font-bold tracking-tight uppercase">Import Data</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-brand-line rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="space-y-2">
            <label className="text-[10px] uppercase font-bold text-brand-muted">Source</label>
            <div className="grid grid-cols-2 gap-2">
              <button 
                onClick={() => setImportSource('file')}
                className={cn(
                  "flex items-center justify-center gap-2 px-3 py-3 rounded border transition-all text-[10px] font-bold uppercase tracking-widest",
                   importSource === 'file' 
                    ? 'bg-brand-accent border-brand-accent text-black' 
                    : 'border-brand-line hover:border-brand-muted bg-brand-line/20'
                )}
              >
                <FileJson size={14} /> File (CSV)
              </button>
              <button 
                onClick={() => setImportSource('node')}
                className={cn(
                  "flex items-center justify-center gap-2 px-3 py-3 rounded border transition-all text-[10px] font-bold uppercase tracking-widest",
                   importSource === 'node' 
                    ? 'bg-brand-accent border-brand-accent text-black' 
                    : 'border-brand-line hover:border-brand-muted bg-brand-line/20'
                )}
              >
                <RefreshCcw size={14} /> Remote Node
              </button>
            </div>
          </div>

          <div className="min-h-[140px] flex flex-col justify-center">
            {importSource === 'file' ? (
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-brand-line rounded-xl p-8 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-brand-accent hover:bg-brand-line/10 transition-all group"
              >
                <Upload className="text-brand-muted group-hover:text-brand-accent transition-colors" size={32} />
                <div className="text-center">
                  <p className="text-xs font-bold uppercase tracking-wider mb-1">Upload CSV Document</p>
                  <p className="text-[10px] text-brand-muted">Drag & drop or click to browse</p>
                </div>
                <input 
                  ref={fileInputRef}
                  type="file" 
                  accept=".csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase font-bold text-brand-muted">Select Node to Fetch From</label>
                  <select 
                    value={selectedNodeId}
                    onChange={e => setSelectedNodeId(e.target.value)}
                    className="w-full bg-brand-line/50 border border-brand-line rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-accent transition-colors"
                  >
                    <option value="">Choose Node...</option>
                    {nodes.filter(n => n.online).map(n => (
                      <option key={n.id} value={n.id}>{n.name} ({n.id})</option>
                    ))}
                  </select>
                </div>
                <button 
                  onClick={handleNodeSync}
                  disabled={!selectedNodeId || isImporting}
                  className={cn(
                    "w-full flex items-center justify-center gap-2 bg-brand-accent text-black py-2 rounded text-xs font-bold uppercase tracking-widest hover:brightness-110 transition-all",
                    (!selectedNodeId || isImporting) && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <Link size={14} />
                  {isImporting ? 'Connecting...' : 'Request Sync'}
                </button>
              </div>
            )}
          </div>

          {status && (
            <div className={cn(
              "p-3 rounded-lg flex items-start gap-3 text-xs animate-in fade-in slide-in-from-top-2",
              status.type === 'success' ? "bg-brand-accent/10 text-brand-accent border border-brand-accent/20" : "bg-brand-error/10 text-brand-error border border-brand-error/20"
            )}>
              {status.type === 'success' ? <Check size={16} className="shrink-0" /> : <AlertCircle size={16} className="shrink-0" />}
              <p>{status.message}</p>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-brand-line flex justify-end bg-brand-line/10">
          <button 
            onClick={onClose}
            className="px-6 py-2 text-sm font-bold uppercase tracking-widest hover:text-brand-ink transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
