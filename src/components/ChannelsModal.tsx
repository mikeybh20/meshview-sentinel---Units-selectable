import React, { useEffect, useState } from 'react';
import { X, Save, Plus, Trash2, Activity, AlertTriangle, Share2, Check, Copy } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Channel, ChannelRole } from '../types';
import { meshDataService } from '../services/meshDataService';
import { buildChannelShareUrl } from '../lib/channelShare';

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

/**
 * Per-channel position-precision presets. Higher `bits` = more precise. Each
 * dropped bit roughly doubles the on-the-air uncertainty radius. The labels
 * mirror what the official Meshtastic clients show, so operators get matching
 * vocabulary across tools.
 *
 *  0  = position broadcasts disabled on this channel
 *  32 = full precision (firmware default)
 */
const POSITION_PRECISION_PRESETS: Array<{ bits: number; label: string }> = [
  { bits: 32, label: 'Full precision (default)' },
  { bits: 19, label: '~ 1.6 km · neighborhood' },
  { bits: 17, label: '~ 6.4 km · small city' },
  { bits: 14, label: '~ 51 km · region' },
  { bits: 11, label: '~ 410 km · state-wide' },
  { bits: 0,  label: 'Disabled · do not share location' },
];

function PositionPrecisionPicker({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  // `undefined` falls back to the firmware default (32) for display purposes.
  const effective = typeof value === 'number' ? value : 32;
  const isPreset = POSITION_PRECISION_PRESETS.some(p => p.bits === effective);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] uppercase font-bold tracking-widest text-brand-muted flex items-center justify-between">
        <span>Position Precision</span>
        <span className="text-[8px] mono-text text-brand-muted normal-case tracking-tight" title="ChannelSettings.module_settings.position_precision">
          bits = {effective}
        </span>
      </label>
      <select
        value={isPreset ? String(effective) : 'custom'}
        onChange={e => {
          const v = e.target.value;
          if (v !== 'custom') onChange(parseInt(v, 10));
        }}
        className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-xs focus:outline-none focus:border-brand-accent"
      >
        {POSITION_PRECISION_PRESETS.map(p => (
          <option key={p.bits} value={p.bits}>{p.label}</option>
        ))}
        {!isPreset && <option value="custom">Custom: {effective} bits</option>}
      </select>
      <p className="text-[10px] text-brand-muted leading-snug mt-0.5">
        Controls how precisely your radio broadcasts its location on this channel.
        {effective === 0 && <> <span className="text-brand-warning font-bold">Off:</span> position will not be sent here at all.</>}
        {effective > 0 && effective < 32 && <> Lower-precision peers see a <span className="text-brand-warning font-bold">fuzzed coordinate</span> instead of your exact lat/lng — useful on broadcast / public channels.</>}
        {effective === 32 && <> Other nodes see your exact GPS coordinate. Pick a lower precision on public channels for privacy.</>}
      </p>
    </div>
  );
}

export function ChannelsModal({ onClose }: ChannelsModalProps) {
  const [channels, setChannels] = useState<Channel[]>(() => meshDataService.getChannels());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);

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
                  className="text-brand-muted hover:text-brand-error p-1 rounded transition-colors"
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

              <div className="flex flex-col gap-1">
                <p className="text-[9px] uppercase font-bold tracking-widest text-brand-muted">MQTT Bridge</p>
                <div className="flex gap-4 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer" title="Forward this channel's traffic from the radio to your MQTT broker">
                    <input
                      type="checkbox"
                      checked={ch.uplinkEnabled}
                      onChange={e => updateChannel(ch.index, { uplinkEnabled: e.target.checked })}
                    />
                    Uplink (radio → MQTT)
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer" title="Inject MQTT traffic onto this LoRa channel">
                    <input
                      type="checkbox"
                      checked={ch.downlinkEnabled}
                      onChange={e => updateChannel(ch.index, { downlinkEnabled: e.target.checked })}
                    />
                    Downlink (MQTT → radio)
                  </label>
                </div>
                {(ch.uplinkEnabled || ch.downlinkEnabled) && (
                  <p className="text-[9px] text-brand-accent mono-text uppercase mt-0.5">
                    Active: {ch.uplinkEnabled ? '↑' : '·'}{ch.downlinkEnabled ? '↓' : '·'}
                  </p>
                )}
              </div>

              <PositionPrecisionPicker
                value={ch.positionPrecision}
                onChange={v => updateChannel(ch.index, { positionPrecision: v })}
              />
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
            <div className="flex items-start gap-2 text-xs text-brand-error bg-brand-error/10 border border-brand-error/30 rounded p-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-brand-line flex justify-between items-center gap-3 bg-brand-line/10">
          <button
            onClick={() => setShowShare(true)}
            disabled={sortedActive.length === 0}
            title={sortedActive.length === 0 ? 'No channels to share yet' : 'Generate a Meshtastic-compatible QR + URL for these channels'}
            className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-widest text-brand-muted hover:text-brand-accent border border-brand-line hover:border-brand-accent/50 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Share2 size={14} />
            Share via QR
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-bold uppercase tracking-widest hover:text-brand-ink transition-colors"
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

      {showShare && (
        <ChannelShareQrOverlay
          channels={sortedActive}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}

/** Modal-on-modal: shows the QR + URL for the active channel set. */
function ChannelShareQrOverlay({ channels, onClose }: { channels: Channel[]; onClose: () => void }) {
  const url = React.useMemo(() => buildChannelShareUrl(channels), [channels]);
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div
      className="fixed inset-0 bg-brand-bg/80 backdrop-blur-md z-[300] flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="technical-panel w-full max-w-md bg-brand-surface border border-brand-accent/40 overflow-hidden"
      >
        <div className="p-4 border-b border-brand-line flex items-center justify-between bg-brand-line/10">
          <div>
            <h3 className="text-base font-bold tracking-tight uppercase text-brand-ink">Share Channel Set</h3>
            <p className="text-[10px] text-brand-muted mono-text uppercase">
              {channels.length} channel{channels.length === 1 ? '' : 's'} · scannable by every Meshtastic client
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-brand-line rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 flex flex-col items-center gap-4">
          <div className="bg-white p-3 rounded-lg">
            <QRCodeSVG value={url} size={224} level="M" />
          </div>

          <div className="w-full">
            <p className="text-[10px] uppercase font-bold text-brand-muted mb-1">Share URL</p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={url}
                onClick={e => (e.target as HTMLInputElement).select()}
                className="flex-1 bg-brand-line border border-brand-line rounded px-2 py-1.5 text-[10px] mono-text text-brand-ink truncate"
              />
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-2 py-1.5 rounded border border-brand-line hover:border-brand-accent/50 hover:bg-brand-accent/10 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-accent transition-colors"
              >
                {copied ? <Check size={12} className="text-brand-accent" /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <p className="text-[10px] text-brand-muted leading-snug">
            Anyone scanning this code (or opening the URL) on a Meshtastic client will be prompted to import the channel set, including PSKs and module settings. Treat it like a password — it grants full access to your private channels.
          </p>
        </div>
      </div>
    </div>
  );
}
