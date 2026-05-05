import React, { useEffect, useState } from 'react';
import { X, Save, Plus, Trash2, Activity, AlertTriangle } from 'lucide-react';
import { Channel, ChannelRole } from '../types';
import { meshDataService } from '../services/meshDataService';

interface ChannelsModalProps {
  onClose: () => void;
}

const MAX_CHANNELS = 8;

function emptyChannel(index: number, role: ChannelRole = 'SECONDARY'): Channel {
  return {
    index,
    name: '',
    role,
    pskBase64: '',
    uplinkEnabled: false,
    downlinkEnabled: false,
  };
}

/** Generate a 16-byte PSK and return it as base64. */
function newRandomPsk(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

export function ChannelsModal({ onClose }: ChannelsModalProps) {
  const [channels, setChannels] = useState<Channel[]>(() => meshDataService.getChannels());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Refresh from latest snapshot when the modal opens
    const unsub = meshDataService.onChannels((list) => {
      // Only adopt server state if we haven't started editing
      if (!saving) {
        setChannels(prev => prev.length === 0 ? list : prev);
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sortedActive = channels
    .filter(c => c.role !== 'DISABLED')
    .sort((a, b) => a.index - b.index);

  const usedIndexes = new Set(channels.map(c => c.index));
  const nextFreeIndex = (() => {
    for (let i = 0; i < MAX_CHANNELS; i++) if (!usedIndexes.has(i)) return i;
    return -1;
  })();

  const handleAdd = () => {
    if (nextFreeIndex < 0) return;
    setChannels([...channels, emptyChannel(nextFreeIndex)]);
  };

  const handleRemove = (index: number) => {
    setChannels(channels.filter(c => c.index !== index));
  };

  const updateChannel = (index: number, patch: Partial<Channel>) => {
    setChannels(channels.map(c => c.index === index ? { ...c, ...patch } : c));
  };

  const handleSave = async () => {
    setError(null);

    // Validate: at most one PRIMARY
    const primaries = channels.filter(c => c.role === 'PRIMARY');
    if (primaries.length > 1) {
      setError('Only one channel may be marked PRIMARY.');
      return;
    }

    setSaving(true);
    const result = await meshDataService.saveChannels(channels);
    setSaving(false);

    if (!result.ok) {
      setError(result.error || 'Save failed.');
      return;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-brand-bg/80 backdrop-blur-md z-[200] flex items-center justify-center p-6">
      <div className="technical-panel w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-brand-line flex items-center justify-between bg-brand-line/10">
          <div>
            <h3 className="text-lg font-bold tracking-tight uppercase">Radio Channels</h3>
            <p className="text-[10px] text-brand-muted mono-text uppercase">Up to {MAX_CHANNELS} slots; saving writes to the locally attached radio.</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-brand-line rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {sortedActive.length === 0 && (
            <div className="text-sm text-brand-muted italic text-center py-8">
              No channels configured. Click "Add Channel" to create one.
            </div>
          )}

          {sortedActive.map(ch => (
            <div key={ch.index} className="border border-brand-line rounded p-3 space-y-3 bg-brand-line/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] mono-text bg-brand-line px-1.5 py-0.5 rounded">CH {ch.index}</span>
                  <select
                    value={ch.role}
                    onChange={e => updateChannel(ch.index, { role: e.target.value as ChannelRole })}
                    className="bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-xs uppercase font-bold focus:outline-none focus:border-brand-accent"
                  >
                    <option value="PRIMARY">Primary</option>
                    <option value="SECONDARY">Secondary</option>
                    <option value="DISABLED">Disabled</option>
                  </select>
                </div>
                <button
                  onClick={() => handleRemove(ch.index)}
                  className="text-brand-muted hover:text-red-400 p-1 rounded transition-colors"
                  title="Remove channel"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-brand-muted">Name</label>
                  <input
                    type="text"
                    maxLength={11}
                    value={ch.name}
                    onChange={e => updateChannel(ch.index, { name: e.target.value })}
                    placeholder={ch.role === 'PRIMARY' ? '(default LongFast)' : 'channel name'}
                    className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brand-accent"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-brand-muted">Slot Index</label>
                  <select
                    value={ch.index}
                    onChange={e => {
                      const newIdx = parseInt(e.target.value, 10);
                      if (channels.some(c => c.index === newIdx && c.index !== ch.index)) return;
                      updateChannel(ch.index, { index: newIdx });
                    }}
                    className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brand-accent"
                  >
                    {Array.from({ length: MAX_CHANNELS }).map((_, i) => (
                      <option key={i} value={i} disabled={channels.some(c => c.index === i && c.index !== ch.index)}>
                        {i}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-brand-muted flex items-center justify-between">
                  <span>Pre-Shared Key (base64)</span>
                  <button
                    onClick={() => updateChannel(ch.index, { pskBase64: newRandomPsk() })}
                    className="text-[9px] mono-text uppercase text-brand-accent hover:brightness-125"
                  >
                    Generate
                  </button>
                </label>
                <input
                  type="text"
                  value={ch.pskBase64}
                  onChange={e => updateChannel(ch.index, { pskBase64: e.target.value })}
                  placeholder="(empty = no encryption)"
                  className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-xs mono-text focus:outline-none focus:border-brand-accent"
                />
              </div>

              <div className="flex gap-4 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ch.uplinkEnabled}
                    onChange={e => updateChannel(ch.index, { uplinkEnabled: e.target.checked })}
                  />
                  Uplink
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ch.downlinkEnabled}
                    onChange={e => updateChannel(ch.index, { downlinkEnabled: e.target.checked })}
                  />
                  Downlink
                </label>
              </div>
            </div>
          ))}

          {nextFreeIndex >= 0 && (
            <button
              onClick={handleAdd}
              className="w-full border border-dashed border-brand-line rounded p-3 text-sm text-brand-muted hover:text-brand-accent hover:border-brand-accent flex items-center justify-center gap-2 transition-colors"
            >
              <Plus size={14} />
              Add Channel (slot {nextFreeIndex})
            </button>
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded p-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-brand-line flex justify-end gap-3 bg-brand-line/10">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-bold uppercase tracking-widest hover:text-white transition-colors"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className={`flex items-center gap-2 bg-brand-accent text-black px-6 py-2 rounded text-sm font-bold uppercase tracking-widest hover:brightness-110 transition-all ${saving ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {saving ? <Activity size={16} className="animate-spin" /> : <Save size={16} />}
            {saving ? 'Writing to radio...' : 'Save & Commit'}
          </button>
        </div>
      </div>
    </div>
  );
}
