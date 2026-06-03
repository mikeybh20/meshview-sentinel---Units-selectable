/**
 * v2.0 Beta 5 — Labeled Devices view.
 *
 * Operator-facing page for managing e-ink signage devices like the
 * Heltec Vision Master. Each device's `long_name` shows on its
 * physical display; this page is where the bartender (or whoever)
 * updates "what's on tap" without needing admin role.
 *
 * Layout:
 *   - Page header with workspace context
 *   - Per-device card showing display_name (Sentinel-side label),
 *     current label + short on device, connection target, last push
 *     timestamp / error
 *   - Inline edit-and-push form on each card
 *   - Admin-only "Add device" form at the top
 *
 * Workspace scoping is enforced server-side — list/push endpoints
 * filter to the user's workspace memberships.
 */
import React from 'react';
import { Tag, Plus, Trash2, RefreshCw, Check, AlertCircle, Edit3 } from 'lucide-react';
import { meshDataService } from '../../services/meshDataService';
import { useIsAdmin } from '../../hooks/useAuth';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { cn } from '../../lib/utils';

interface LabeledDevice {
  id: number;
  workspaceId: number;
  displayName: string;
  host: string;
  port: number;
  currentLabel: string | null;
  currentShort: string | null;
  lastPushedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function relTime(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function LabeledDevicesView() {
  const isAdmin = useIsAdmin();
  const { workspaces, currentWorkspaceId } = useWorkspaces();
  const [devices, setDevices] = React.useState<LabeledDevice[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // Add-device form
  const [showAdd, setShowAdd] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [newHost, setNewHost] = React.useState('');
  const [newPort, setNewPort] = React.useState(4403);
  const [newWorkspaceId, setNewWorkspaceId] = React.useState<number | null>(currentWorkspaceId);

  React.useEffect(() => { setNewWorkspaceId(currentWorkspaceId); }, [currentWorkspaceId]);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    const r = await meshDataService.listLabeledDevices();
    setLoading(false);
    setDevices(r?.devices ?? []);
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  const handleAdd = async () => {
    if (!newWorkspaceId) { setMsg({ tone: 'err', text: 'Pick a workspace first' }); return; }
    setMsg(null);
    const r = await meshDataService.createLabeledDevice({
      workspaceId: newWorkspaceId,
      displayName: newName.trim(),
      host: newHost.trim(),
      port: newPort,
    });
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Add failed' }); return; }
    setMsg({ tone: 'ok', text: `Added "${newName.trim()}".` });
    setShowAdd(false); setNewName(''); setNewHost(''); setNewPort(4403);
    refresh();
  };

  const handleDelete = async (d: LabeledDevice) => {
    if (!confirm(`Delete labeled device "${d.displayName}"? The physical device keeps whatever label was last pushed; you just lose Sentinel-side tracking.`)) return;
    setMsg(null);
    const r = await meshDataService.deleteLabeledDevice(d.id);
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Delete failed' }); return; }
    setMsg({ tone: 'ok', text: `Removed "${d.displayName}".` });
    refresh();
  };

  return (
    <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <Tag size={20} className="text-brand-accent" />
          <div>
            <h2 className="text-base font-bold uppercase tracking-tight">Device Labels</h2>
            <p className="text-[10px] text-brand-muted mt-0.5">
              Physical e-ink signage (Heltec Vision Master, etc.) — push a label and the device's home screen updates.
              Pushing opens a one-shot TCP connection to the device, sets its <code className="text-brand-accent">long_name</code> + <code className="text-brand-accent">short_name</code>, disconnects.
              Workspace-scoped; any member can update labels in their workspace.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-brand-line hover:bg-brand-line/40 disabled:opacity-50 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={cn(loading && 'animate-spin')} />
            REFRESH
          </button>
          {isAdmin && (
            <button
              onClick={() => setShowAdd(s => !s)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-brand-accent/40 bg-brand-accent/10 hover:bg-brand-accent/20 text-brand-accent transition-colors"
            >
              <Plus size={11} /> ADD DEVICE
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className={cn(
          'flex items-start gap-2 rounded border text-[11px] px-3 py-2 flex-shrink-0',
          msg.tone === 'ok'
            ? 'border-brand-accent/40 bg-brand-accent/10 text-brand-accent'
            : 'border-red-500/40 bg-red-500/10 text-red-300',
        )}>
          {msg.tone === 'ok' ? <Check size={12} className="mt-0.5" /> : <AlertCircle size={12} className="mt-0.5" />}
          <span>{msg.text}</span>
        </div>
      )}

      {/* Add form */}
      {showAdd && isAdmin && (
        <div className="rounded border border-brand-line bg-brand-bg/40 p-4 space-y-3 flex-shrink-0">
          <h3 className="text-xs font-bold uppercase tracking-widest text-brand-muted">New device</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Display name</label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Tap 5"
                maxLength={64}
                className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] focus:outline-none focus:border-brand-accent"
              />
              <p className="text-[10px] text-brand-muted/80">Sentinel-side name (not on the device itself)</p>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Workspace</label>
              <select
                value={newWorkspaceId ?? ''}
                onChange={e => setNewWorkspaceId(e.target.value ? Number(e.target.value) : null)}
                className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] focus:outline-none focus:border-brand-accent"
              >
                {workspaces.map(w => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Host (IP or hostname)</label>
              <input
                type="text"
                value={newHost}
                onChange={e => setNewHost(e.target.value)}
                placeholder="192.168.1.42"
                className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] mono-text focus:outline-none focus:border-brand-accent"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Port</label>
              <input
                type="number"
                value={newPort}
                onChange={e => setNewPort(Number(e.target.value))}
                min={1}
                max={65535}
                className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] mono-text focus:outline-none focus:border-brand-accent"
              />
              <p className="text-[10px] text-brand-muted/80">Meshtastic TCP default is 4403</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={!newName.trim() || !newHost.trim() || !newWorkspaceId}
              className="bg-brand-accent text-black text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5 hover:brightness-110 disabled:opacity-40"
            >
              Create
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Device cards */}
      <div className="flex-1 overflow-y-auto space-y-3">
        {devices == null && (
          <div className="text-center text-[11px] text-brand-muted py-8 italic">Loading…</div>
        )}
        {devices && devices.length === 0 && (
          <div className="text-center text-[11px] text-brand-muted py-8 italic max-w-md mx-auto leading-relaxed">
            No labeled devices yet. {isAdmin ? 'Click ADD DEVICE to register your first Heltec Vision Master.' : 'An admin needs to add devices before you can push labels.'}
          </div>
        )}
        {devices?.map(d => (
          <DeviceCard key={d.id} device={d} workspaces={workspaces} onDelete={handleDelete} onChanged={refresh} isAdmin={isAdmin} />
        ))}
      </div>
    </div>
  );
}

function DeviceCard({ device, workspaces, onDelete, onChanged, isAdmin }: {
  device: LabeledDevice;
  workspaces: Array<{ id: number; name: string }>;
  onDelete: (d: LabeledDevice) => void;
  onChanged: () => void;
  isAdmin: boolean;
}) {
  const [label, setLabel] = React.useState(device.currentLabel ?? '');
  const [short, setShort] = React.useState(device.currentShort ?? '');
  const [pushing, setPushing] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editHost, setEditHost] = React.useState(device.host);
  const [editPort, setEditPort] = React.useState(device.port);
  const [editName, setEditName] = React.useState(device.displayName);
  const [err, setErr] = React.useState<string | null>(null);

  // Keep inputs in sync if the device updates (e.g. after a successful push).
  React.useEffect(() => {
    setLabel(device.currentLabel ?? '');
    setShort(device.currentShort ?? '');
  }, [device.currentLabel, device.currentShort]);

  const wsName = workspaces.find(w => w.id === device.workspaceId)?.name ?? `Workspace #${device.workspaceId}`;

  const handlePush = async () => {
    setErr(null);
    if (!label.trim()) { setErr('Label is required'); return; }
    if (!short.trim()) { setErr('Short name is required (≤4 chars)'); return; }
    if (short.length > 4) { setErr('Short must be ≤4 chars'); return; }
    if (label.length > 40) { setErr('Label must be ≤40 chars'); return; }
    setPushing(true);
    const r = await meshDataService.pushLabel(device.id, label.trim(), short.trim());
    setPushing(false);
    if (!r.ok) { setErr(r.error || 'Push failed'); return; }
    onChanged();
  };

  const handleSaveEdit = async () => {
    const r = await meshDataService.updateLabeledDevice(device.id, {
      displayName: editName.trim(),
      host: editHost.trim(),
      port: editPort,
    });
    if (!r.ok) { setErr(r.error || 'Save failed'); return; }
    setEditing(false);
    onChanged();
  };

  return (
    <div className="rounded-lg border border-brand-line bg-brand-bg/30 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          {editing && isAdmin ? (
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                className="bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] focus:outline-none focus:border-brand-accent"
                placeholder="Display name"
              />
              <input
                value={editHost}
                onChange={e => setEditHost(e.target.value)}
                className="bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] mono-text focus:outline-none focus:border-brand-accent"
                placeholder="host"
              />
              <input
                type="number"
                value={editPort}
                onChange={e => setEditPort(Number(e.target.value))}
                className="w-20 bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] mono-text focus:outline-none focus:border-brand-accent"
              />
            </div>
          ) : (
            <>
              <h3 className="text-sm font-bold tracking-tight">{device.displayName}</h3>
              <p className="text-[10px] mono-text text-brand-muted">
                {device.host}:{device.port} · {wsName}
              </p>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isAdmin && !editing && (
            <button
              onClick={() => setEditing(true)}
              title="Edit device"
              className="p-1.5 rounded text-brand-muted hover:text-brand-ink hover:bg-brand-line/40"
            >
              <Edit3 size={12} />
            </button>
          )}
          {isAdmin && editing && (
            <>
              <button onClick={handleSaveEdit} className="text-[10px] font-bold uppercase text-brand-accent hover:underline px-1">Save</button>
              <button onClick={() => { setEditing(false); setEditName(device.displayName); setEditHost(device.host); setEditPort(device.port); }} className="text-[10px] font-bold uppercase text-brand-muted hover:text-brand-ink px-1">Cancel</button>
            </>
          )}
          {isAdmin && !editing && (
            <button
              onClick={() => onDelete(device)}
              title="Remove device"
              className="p-1.5 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Current state */}
      <div className="grid grid-cols-2 gap-3 text-[10px] mono-text">
        <div>
          <span className="text-brand-muted">Last pushed:</span>{' '}
          <span className="text-brand-ink" title={device.lastPushedAt ? new Date(device.lastPushedAt).toLocaleString() : ''}>
            {relTime(device.lastPushedAt)}
          </span>
        </div>
        <div>
          {device.lastError ? (
            <span className="text-brand-error" title={device.lastError}>
              Last error: {device.lastError.length > 40 ? device.lastError.slice(0, 40) + '…' : device.lastError}
            </span>
          ) : device.lastPushedAt ? (
            <span className="text-brand-accent">No errors on last push</span>
          ) : (
            <span className="text-brand-muted italic">Never pushed</span>
          )}
        </div>
      </div>

      {/* Push form */}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 pt-1">
        <input
          type="text"
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Label (e.g. Tap 5: IPA — Hop Forward)"
          maxLength={40}
          className="bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brand-accent"
        />
        <input
          type="text"
          value={short}
          onChange={e => setShort(e.target.value.slice(0, 4))}
          placeholder="Tag"
          maxLength={4}
          className="w-20 bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm mono-text focus:outline-none focus:border-brand-accent"
          title="≤4 char badge (Meshtastic short_name)"
        />
        <button
          onClick={handlePush}
          disabled={pushing || !label.trim() || !short.trim()}
          className="px-4 py-1.5 bg-brand-accent text-black text-xs font-bold uppercase tracking-widest rounded hover:brightness-110 disabled:opacity-40"
        >
          {pushing ? 'Pushing…' : 'Push label'}
        </button>
      </div>
      {err && (
        <div className="flex items-start gap-2 text-[11px] text-red-300">
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}
    </div>
  );
}
