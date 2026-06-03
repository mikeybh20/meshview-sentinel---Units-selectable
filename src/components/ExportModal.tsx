/**
 * v2.0 Beta 5: server-side CSV export.
 *
 * Pre-Beta-5 this filtered props.messages / props.events in the browser,
 * which only ever saw what the /api/mesh/snapshot endpoint had loaded —
 * most-recent N rows trimmed by the snapshot's retention window. A
 * "messages from last month" export returned empty even with the rows
 * sitting in SQLite. Now we just hit /api/mesh/export/<type>.csv with
 * date / node / radio filters as query params; the server streams from
 * the source of truth.
 *
 * Optional radio scope comes from the existing useRadios hook so it
 * matches whatever's selected in the top RadioBar.
 */
import React from 'react';
import { X, Download, Filter, Calendar, FileText } from 'lucide-react';
import { Node } from '../types';
import { downloadFile } from '../lib/exportUtils';
import { INSTALLATION_GUIDE_DELL_GB10 } from '../constants/installationGuide';
import { useRadios } from '../hooks/useRadios';

interface ExportModalProps {
  nodes: Node[];
  onClose: () => void;
}

const API_BASE = import.meta.env.VITE_API_URL || '';

export function ExportModal({ nodes, onClose }: ExportModalProps) {
  const { selectedRadioId } = useRadios();
  const [exportType, setExportType] = React.useState<'messages' | 'events' | 'telemetry'>('messages');
  const [selectedNodeId, setSelectedNodeId] = React.useState<string>('all');
  const [dateRange, setDateRange] = React.useState({
    start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });

  const handleExport = () => {
    // Date inputs come in as YYYY-MM-DD; convert to ms boundaries. Start = 00:00
    // local, end = 23:59:59.999 local — matches the operator's intuitive
    // "include this whole day" semantics.
    const fromMs = new Date(dateRange.start).getTime();
    const toMs   = new Date(dateRange.end).setHours(23, 59, 59, 999);

    const params = new URLSearchParams();
    params.set('from', String(fromMs));
    params.set('to', String(toMs));
    if (selectedNodeId !== 'all') params.set('node_id', selectedNodeId);
    // Telemetry has no radio_id column — skip the param so the filename
    // stays clean. Server ignores radio_id on telemetry anyway, but the
    // filename builder uses it.
    if (selectedRadioId && exportType !== 'telemetry') params.set('radio_id', selectedRadioId);

    const url = `${API_BASE}/api/mesh/export/${exportType}.csv?${params.toString()}`;
    // Trigger a same-origin download via a transient anchor. The server
    // sets Content-Disposition, so the filename comes from there — we
    // don't pass a `download` value here.
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    onClose();
  };

  const handleDownloadRecipe = () => {
    downloadFile(INSTALLATION_GUIDE_DELL_GB10, 'DELL_GB10_INSTALLATION_RECIPE.md', 'text/markdown');
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-brand-bg/80 backdrop-blur-md z-[200] flex items-center justify-center p-6">
      <div className="technical-panel w-full max-w-md overflow-hidden flex flex-col">
        <div className="p-4 border-b border-brand-line flex items-center justify-between bg-brand-line/10">
          <div className="flex items-center gap-2">
            <Download size={18} className="text-brand-accent" />
            <h3 className="text-lg font-bold tracking-tight uppercase">Data Export & Resources</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-brand-line rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="space-y-4">
            <label className="text-[10px] uppercase font-bold text-brand-accent">Station Resources</label>
            <button
              onClick={handleDownloadRecipe}
              className="w-full flex items-center justify-between p-4 bg-brand-accent/5 border border-brand-accent/20 rounded-xl hover:bg-brand-accent/10 transition-all group"
            >
              <div className="flex items-center gap-3 text-left">
                <FileText size={20} className="text-brand-accent" />
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest leading-none">Installation Recipe</p>
                  <p className="text-[10px] text-brand-muted mt-1">Dell GB10 Gateway Setup Guide (.md)</p>
                </div>
              </div>
              <Download size={16} className="text-brand-muted group-hover:text-brand-accent transition-colors" />
            </button>
          </div>

          <div className="border-t border-brand-line mt-6 pt-6"></div>

          <div className="space-y-2">
            <label className="text-[10px] uppercase font-bold text-brand-muted">Operational Data</label>
            <div className="grid grid-cols-3 gap-2">
              {(['messages', 'events', 'telemetry'] as const).map(type => (
                <button
                  key={type}
                  onClick={() => setExportType(type)}
                  className={`px-3 py-2 text-[10px] font-bold rounded border transition-all uppercase ${
                    exportType === type
                      ? 'bg-brand-accent border-brand-accent text-black'
                      : 'border-brand-line hover:border-brand-muted bg-brand-line/20'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase font-bold text-brand-muted flex items-center gap-1">
                <Filter size={10} /> Filter by Node
              </label>
              <select
                value={selectedNodeId}
                onChange={e => setSelectedNodeId(e.target.value)}
                className="w-full bg-brand-line/50 border border-brand-line rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-accent transition-colors"
              >
                <option value="all">All Nodes</option>
                {nodes.map(n => <option key={n.id} value={n.id}>{n.name} ({n.id})</option>)}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase font-bold text-brand-muted flex items-center gap-1">
                <Calendar size={10} /> Date Range
              </label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="date"
                  value={dateRange.start}
                  onChange={e => setDateRange({ ...dateRange, start: e.target.value })}
                  className="bg-brand-line/50 border border-brand-line rounded px-3 py-1.5 text-xs focus:outline-none focus:border-brand-accent transition-colors"
                />
                <input
                  type="date"
                  value={dateRange.end}
                  onChange={e => setDateRange({ ...dateRange, end: e.target.value })}
                  className="bg-brand-line/50 border border-brand-line rounded px-3 py-1.5 text-xs focus:outline-none focus:border-brand-accent transition-colors"
                />
              </div>
            </div>

            <p className="text-[10px] text-brand-muted/80 leading-snug">
              Streams from SQLite — covers the full retention window, not just what's currently in your browser snapshot.
              {selectedRadioId && exportType !== 'telemetry' && (
                <> Scoped to radio <span className="mono-text text-brand-accent">{selectedRadioId}</span> (matches the top RadioBar).</>
              )}
              {exportType === 'telemetry' && (
                <> Telemetry has no per-radio scope (rows are per-node).</>
              )}
            </p>
          </div>
        </div>

        <div className="p-4 border-t border-brand-line flex justify-end gap-3 bg-brand-line/10">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-bold uppercase tracking-widest hover:text-brand-ink transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 bg-brand-accent text-black px-6 py-2 rounded text-sm font-bold uppercase tracking-widest hover:brightness-110 transition-all"
          >
            <Download size={16} />
            Export CSV
          </button>
        </div>
      </div>
    </div>
  );
}
