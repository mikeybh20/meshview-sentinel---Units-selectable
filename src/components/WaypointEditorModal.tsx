import React, { useState } from 'react';
import { X, Save, Trash2, MapPin } from 'lucide-react';
import EmojiPicker, { Theme, EmojiStyle } from 'emoji-picker-react';
import { Waypoint } from '../types';

type ExpirePreset = '0' | '3600' | '86400' | '259200' | '604800';

const EXPIRE_OPTIONS: { value: ExpirePreset; label: string }[] = [
  { value: '0',      label: 'Never' },
  { value: '3600',   label: '1 hour' },
  { value: '86400',  label: '24 hours' },
  { value: '259200', label: '72 hours' },
  { value: '604800', label: '7 days' },
];

interface WaypointEditorModalProps {
  /** lat/lng of the drop point (for new) or existing waypoint (for edit) */
  initial: {
    id?: number;
    lat: number;
    lng: number;
    name?: string;
    description?: string;
    icon?: number;
    expire?: number;        // epoch seconds; 0 = never
    lockedToSelf?: boolean;
  };
  isEditing: boolean;
  /** Called with the data to send to the server. */
  onSave: (data: {
    id?: number;
    lat: number;
    lng: number;
    name: string;
    description: string;
    icon: number;
    expire: number;
    lockedToSelf: boolean;
  }) => Promise<void> | void;
  onDelete?: () => Promise<void> | void;
  onClose: () => void;
}

/** Convert an emoji string (which can be 1-2 codepoints + ZWJ etc.) to its first codepoint. */
function emojiToCodepoint(emoji: string): number {
  return emoji.codePointAt(0) ?? 0;
}

function codepointToEmoji(cp: number): string {
  if (!cp) return '';
  try { return String.fromCodePoint(cp); } catch { return ''; }
}

/** Map a waypoint expire (epoch seconds) back to one of our presets, or '0' if no match. */
function expireToPreset(expire?: number): ExpirePreset {
  if (!expire || expire === 0) return '0';
  const remaining = expire - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return '0';
  // Snap to nearest preset
  if (remaining <= 3700) return '3600';
  if (remaining <= 90_000) return '86400';
  if (remaining <= 270_000) return '259200';
  return '604800';
}

export function WaypointEditorModal({ initial, isEditing, onSave, onDelete, onClose }: WaypointEditorModalProps) {
  const [name, setName] = useState(initial.name ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [icon, setIcon] = useState<number>(initial.icon ?? 0x1F4CD); // 📍 default
  const [expirePreset, setExpirePreset] = useState<ExpirePreset>(
    isEditing ? expireToPreset(initial.expire) : '259200', // default 72h for new
  );
  const [lockedToSelf, setLockedToSelf] = useState<boolean>(initial.lockedToSelf ?? false);
  const [showPicker, setShowPicker] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);
    const expireSecs = expirePreset === '0'
      ? 0
      : Math.floor(Date.now() / 1000) + parseInt(expirePreset, 10);
    try {
      await onSave({
        id: initial.id,
        lat: initial.lat,
        lng: initial.lng,
        name: name.trim(),
        description: description.trim(),
        icon,
        expire: expireSecs,
        lockedToSelf,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-brand-bg/85 backdrop-blur-md z-[200] flex items-center justify-center p-6">
      <div
        className="rounded-lg border border-emerald-500/30 w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]"
        style={{ background: '#020617', boxShadow: '0 20px 60px rgba(0,0,0,0.7)' }}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <MapPin size={16} className="text-emerald-400" />
            <h3 className="text-sm font-bold tracking-tight uppercase text-white">
              {isEditing ? 'Edit Waypoint' : 'Drop Waypoint'}
            </h3>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Position */}
          <div className="bg-slate-800/60 border border-slate-700 rounded px-3 py-2">
            <p className="text-[9px] uppercase font-semibold text-slate-400 mb-0.5">Position</p>
            <p className="text-xs mono-text text-slate-200">
              {initial.lat.toFixed(5)}, {initial.lng.toFixed(5)}
            </p>
          </div>

          {/* Icon picker */}
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-400">Icon</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowPicker(p => !p)}
                className="w-12 h-12 flex items-center justify-center text-2xl bg-slate-800 border border-slate-700 rounded hover:border-emerald-500/50 transition-colors"
              >
                {codepointToEmoji(icon) || '📍'}
              </button>
              <p className="text-[10px] text-slate-500">Click to change</p>
            </div>
            {showPicker && (
              <div className="rounded overflow-hidden border border-slate-700">
                <EmojiPicker
                  theme={Theme.DARK}
                  emojiStyle={EmojiStyle.NATIVE}
                  width="100%"
                  height={350}
                  searchDisabled={false}
                  skinTonesDisabled
                  previewConfig={{ showPreview: false }}
                  onEmojiClick={(e) => {
                    setIcon(emojiToCodepoint(e.emoji));
                    setShowPicker(false);
                  }}
                />
              </div>
            )}
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-400">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Trailhead, Repeater Site"
              maxLength={30}
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-400">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional notes"
              rows={3}
              maxLength={100}
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 resize-none"
            />
          </div>

          {/* Expire */}
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-400">Expires</label>
            <select
              value={expirePreset}
              onChange={e => setExpirePreset(e.target.value as ExpirePreset)}
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
            >
              {EXPIRE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Locked-to-self */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={lockedToSelf}
              onChange={e => setLockedToSelf(e.target.checked)}
              className="w-4 h-4 accent-emerald-500"
            />
            <span className="text-xs text-slate-200">Only I can edit or delete this waypoint</span>
          </label>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between gap-2">
          {isEditing && onDelete ? (
            confirmDelete ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => { await onDelete(); }}
                  className="text-xs font-bold uppercase tracking-widest text-red-400 hover:text-red-300 px-2 py-1.5"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-xs text-slate-400 hover:text-white px-2 py-1.5"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-red-400 hover:text-red-300 px-2 py-1.5"
              >
                <Trash2 size={12} />
                Delete
              </button>
            )
          ) : <div />}

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white px-3 py-1.5"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              <Save size={12} />
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
