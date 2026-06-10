/**
 * v2.1 — ModulesSection + all 11 ModuleCard components + SurveyControl
 * extracted from SettingsModal.tsx. Largest single chunk of the v2.1
 * SettingsModal refactor (~3000 LOC).
 *
 * Lazy-loaded so the per-module admin editors (RangeTest, Telemetry,
 * StoreForward, MQTT, ExternalNotification, DetectionSensor, Audio,
 * Serial, AmbientLighting, Paxcounter, RemoteHardware) plus the
 * timed-survey scheduler only enter the bundle when Settings ->
 * Modules is opened.
 */
import React from 'react';
import {
  Activity, AlertCircle, Ban, Check, Eye, EyeOff, Network, Plus, RefreshCw,
  Loader2, X, Trash2, Undo2,
} from 'lucide-react';
import type { LocalModuleConfigSnapshot } from '../../types';
import { meshDataService } from '../../services/meshDataService';
import { cn } from '../../lib/utils';

const API_BASE = import.meta.env.VITE_API_URL || '';

/** Local section header. Inline-duplicated per section so each lazy
 *  chunk is self-contained. */
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h4 className="text-sm font-bold uppercase tracking-tight text-brand-ink">{title}</h4>
      <p className="text-[11px] text-brand-muted mt-0.5">{subtitle}</p>
    </div>
  );
}

/** Subset of SettingsModalProps that ModulesSection actually reads. */
interface ModulesSectionProps {
  localModuleConfig: LocalModuleConfigSnapshot;
  radioConnected: boolean;
}

const NI_INTERVAL_PRESETS = [
  { value: 600,   label: '10 minutes' },
  { value: 1800,  label: '30 minutes (default)' },
  { value: 3600,  label: '1 hour' },
  { value: 7200,  label: '2 hours' },
  { value: 14400, label: '4 hours (firmware default)' },
  { value: 28800, label: '8 hours' },
  { value: 43200, label: '12 hours' },
];

function ModulesSection({ localModuleConfig, radioConnected }: ModulesSectionProps) {
  const ni = localModuleConfig.neighborInfo;

  // Local-edit state. Initialise from the authoritative config when it arrives;
  // re-sync if the snapshot updates (e.g. another tab made a change).
  const [enabled, setEnabled] = React.useState<boolean>(ni?.enabled ?? false);
  const [intervalSecs, setIntervalSecs] = React.useState<number>(ni?.updateIntervalSecs ?? 1800);
  const [transmitOverLora, setTransmitOverLora] = React.useState<boolean>(ni?.transmitOverLora ?? true);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Re-sync local edit state whenever the authoritative snapshot changes
  // (e.g. first readback after connect, or another tab saved). Skip if the
  // user is mid-edit (busy = true).
  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!ni || busy) return;
    if (lastSyncedRef.current === ni.lastReadAt) return;
    lastSyncedRef.current = ni.lastReadAt;
    setEnabled(ni.enabled);
    setIntervalSecs(ni.updateIntervalSecs);
    setTransmitOverLora(ni.transmitOverLora);
  }, [ni?.lastReadAt, ni?.enabled, ni?.updateIntervalSecs, ni?.transmitOverLora, busy]);

  // Dirty when the form differs from the radio's last-known state. When we have
  // no baseline yet (firmware hasn't responded to a readback request), treat the
  // form as always saveable — the operator should be able to *set* values even
  // if the radio never acks the read. After Save, the bridge optimistically
  // populates `localModuleConfig.neighborInfo`, so subsequent edits dirty-check
  // properly.
  const dirty = !ni
    ? true
    : (enabled !== ni.enabled ||
       intervalSecs !== ni.updateIntervalSecs ||
       transmitOverLora !== ni.transmitOverLora);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setNeighborInfoConfig({ enabled, intervalSecs, transmitOverLora });
    setBusy(false);
    if (r.ok) {
      setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    } else {
      setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshNeighborInfoConfig();
    setRefreshing(false);
    if (!r.ok) {
      setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
    }
    // The actual config update arrives asynchronously via the snapshot poll;
    // the useEffect above will re-sync the form when ni.lastReadAt changes.
  };

  const lastReadLabel = ni?.lastReadAt
    ? new Date(ni.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Radio Modules"
        subtitle="Configure firmware modules on the locally-connected radio. Admin writes are local-only — they don't consume mesh airtime."
      />

      {!radioConnected && (
        <div className="bg-brand-warning/10 border border-brand-warning/30 rounded p-3 flex items-start gap-2">
          <AlertCircle size={14} className="text-brand-warning flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-brand-warning leading-relaxed">
            No live radio connected. Module configuration is only available when a real Meshtastic radio is attached via serial or TCP.
          </p>
        </div>
      )}

      {/* NeighborInfo */}
      <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Network size={14} className="text-brand-accent" />
              <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">NeighborInfo</h5>
              {ni && (
                <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border ${
                  ni.enabled
                    ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                    : 'text-brand-muted bg-brand-line border-brand-line'
                }`}>
                  {ni.enabled ? 'Enabled' : 'Disabled'}
                </span>
              )}
              {!ni && radioConnected && (
                <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                  Reading…
                </span>
              )}
            </div>
            <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
              Each node periodically broadcasts a list of its directly-heard neighbors with SNR.
              These broadcasts are what populate the Topology view's real edges.
            </p>
          </div>
          <button
            onClick={handleRefresh}
            disabled={!radioConnected || refreshing}
            title="Re-read the config from the radio"
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '...' : 'Refresh'}
          </button>
        </div>

        {/* Enabled toggle */}
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Enabled</p>
            <p className="text-[10px] text-brand-muted">When on, this radio broadcasts and ingests NeighborInfo packets.</p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            disabled={!radioConnected}
            className="w-4 h-4 accent-emerald-500"
          />
        </label>

        {/* Update interval */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">
            Update Interval
          </label>
          <select
            value={NI_INTERVAL_PRESETS.some(p => p.value === intervalSecs) ? String(intervalSecs) : 'custom'}
            onChange={e => {
              const v = e.target.value;
              if (v !== 'custom') setIntervalSecs(parseInt(v, 10));
            }}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          >
            {NI_INTERVAL_PRESETS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
            {!NI_INTERVAL_PRESETS.some(p => p.value === intervalSecs) && (
              <option value="custom">Custom: {intervalSecs}s</option>
            )}
          </select>

          {/* Manual / fine-grained input */}
          <div className="flex items-center gap-2 mt-1">
            <label className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Custom (s)</label>
            <input
              type="number"
              min={60}
              max={86400}
              step={60}
              value={intervalSecs}
              onChange={e => {
                const v = parseInt(e.target.value, 10);
                if (Number.isFinite(v)) setIntervalSecs(Math.max(60, Math.min(86400, v)));
              }}
              disabled={!radioConnected || !enabled}
              className="w-32 bg-brand-line border border-brand-line rounded px-2 py-1 text-[11px] mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
            />
            <span className="text-[9px] text-brand-muted">
              ≈ {intervalSecs < 3600
                ? `${Math.round(intervalSecs / 60)} min`
                : `${(intervalSecs / 3600).toFixed(1)} hr`}
              · {Math.round(86400 / intervalSecs)}/day per node
            </span>
          </div>
          <p className="text-[10px] text-brand-warning/80 leading-snug">
            ⚠️ Lower intervals (faster updates) consume more LoRa airtime. 30 min is the recommended balance for most meshes; 4 hr is the firmware default.
          </p>
        </div>

        {/* Transmit over LoRa */}
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Transmit over LoRa</p>
            <p className="text-[10px] text-brand-muted">If off, observations are local-only (MQTT-only meshes). Leave on for normal operation.</p>
          </div>
          <input
            type="checkbox"
            checked={transmitOverLora}
            onChange={e => setTransmitOverLora(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500"
          />
        </label>

        {/* Footer / status */}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line/50">
          <p className="text-[9px] mono-text text-brand-muted">
            {lastReadLabel
              ? `Last read: ${lastReadLabel}`
              : ni
                ? 'Set by you (no readback yet)'
                : 'No readback yet — Save will apply your values'}
          </p>
          <button
            onClick={handleSave}
            disabled={!radioConnected || busy || !dirty}
            className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
          </button>
        </div>

        {status && (
          <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
            {status.text}
          </p>
        )}

        <SurveyControl
          title="Site Survey"
          description="Temporarily speed up NeighborInfo broadcasts so the topology graph fills in within minutes instead of hours. Useful right after deploying a new node or fixed repeater. The radio's current NeighborInfo config is captured before the survey and restored when it expires."
          durationOptions={[
            { value: 5,  label: '5 minutes' },
            { value: 10, label: '10 minutes' },
            { value: 15, label: '15 minutes' },
            { value: 30, label: '30 minutes' },
            { value: 60, label: '1 hour' },
          ]}
          defaultDuration={10}
          cadenceOptions={[
            { value: 60,   label: 'Every 1 min · fast' },
            { value: 120,  label: 'Every 2 min' },
            { value: 300,  label: 'Every 5 min · airtime-friendly' },
            { value: 600,  label: 'Every 10 min' },
          ]}
          defaultCadence={120}
          expiresAt={localModuleConfig.activeSurveys?.neighborInfoExpiresAt ?? null}
          disabled={!radioConnected}
          onStart={(durationMinutes, intervalSecs) => meshDataService.startNeighborInfoSurvey({ durationMinutes, intervalSecs })}
          onCancel={() => meshDataService.cancelNeighborInfoSurvey()}
        />
      </div>

      {/* Range Test */}
      <RangeTestModuleCard
        radioConnected={radioConnected}
        rt={localModuleConfig.rangeTest}
        surveyExpiresAt={localModuleConfig.activeSurveys?.rangeTestExpiresAt ?? null}
      />

      {/* Telemetry */}
      <TelemetryModuleCard radioConnected={radioConnected} t={localModuleConfig.telemetry} />

      {/* Store & Forward */}
      <StoreForwardModuleCard radioConnected={radioConnected} sf={localModuleConfig.storeForward} />

      {/* External Notification */}
      <ExternalNotificationModuleCard radioConnected={radioConnected} en={localModuleConfig.externalNotification} />

      {/* MQTT */}
      <MqttModuleCard radioConnected={radioConnected} m={localModuleConfig.mqtt} />

      {/* Detection Sensor */}
      <DetectionSensorModuleCard radioConnected={radioConnected} ds={localModuleConfig.detectionSensor} />

      {/* Audio (Codec2 over LoRa) */}
      <AudioModuleCard radioConnected={radioConnected} a={localModuleConfig.audio} />

      {/* Serial (UART passthrough) */}
      <SerialModuleCard radioConnected={radioConnected} s={localModuleConfig.serial} />

      {/* Ambient Lighting (RGB LED) */}
      <AmbientLightingModuleCard radioConnected={radioConnected} al={localModuleConfig.ambientLighting} />

      {/* Paxcounter (WiFi/BLE device counting) */}
      <PaxcounterModuleCard radioConnected={radioConnected} px={localModuleConfig.paxcounter} />

      {/* Remote Hardware (GPIO remote control) */}
      <RemoteHardwareModuleCard radioConnected={radioConnected} rh={localModuleConfig.remoteHardware} />

      <p className="text-[10px] text-brand-muted leading-relaxed">
        All twelve firmware modules now configurable end-to-end.
      </p>
    </div>
  );
}

const RT_INTERVAL_PRESETS = [
  { value: 0,    label: 'Receive only (recommended)' },
  { value: 60,   label: 'Send every 1 minute' },
  { value: 300,  label: 'Send every 5 minutes' },
  { value: 900,  label: 'Send every 15 minutes' },
  { value: 1800, label: 'Send every 30 minutes' },
  { value: 3600, label: 'Send every 1 hour' },
];

/**
 * Shared survey-control widget for the Range Test and NeighborInfo cards.
 * Renders a "Run a survey" panel with a duration selector and a start/cancel
 * button, plus a live countdown when a survey is in progress. The actual
 * start/cancel work is delegated to the parent so each card can pass its
 * module-specific cadence + handler.
 */
function SurveyControl({
  title,
  description,
  durationOptions,
  defaultDuration,
  cadenceOptions,
  defaultCadence,
  expiresAt,
  disabled,
  onStart,
  onCancel,
}: {
  title: string;
  description: string;
  durationOptions: Array<{ value: number; label: string }>;
  defaultDuration: number;
  cadenceOptions: Array<{ value: number; label: string }>;
  defaultCadence: number;
  expiresAt: number | null;
  disabled?: boolean;
  onStart: (durationMinutes: number, cadenceSecs: number) => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const [duration, setDuration] = React.useState<number>(defaultDuration);
  const [cadence, setCadence] = React.useState<number>(defaultCadence);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Live-updating countdown for the active survey.
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  const remainingSecs = expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : 0;
  const remainingLabel = remainingSecs > 60
    ? `${Math.floor(remainingSecs / 60)}m ${String(remainingSecs % 60).padStart(2, '0')}s`
    : `${remainingSecs}s`;

  const handleStart = async () => {
    setBusy(true); setError(null);
    const r = await onStart(duration, cadence);
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Failed to start survey');
  };

  const handleCancel = async () => {
    setBusy(true); setError(null);
    const r = await onCancel();
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Failed to cancel survey');
  };

  const surveyActive = !!expiresAt && remainingSecs > 0;

  return (
    <div className="border-t border-brand-line pt-4 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] uppercase font-bold text-brand-muted tracking-widest">{title}</p>
        {surveyActive && (
          <span className="text-[10px] mono-text text-brand-warning bg-brand-warning/15 border border-brand-warning/40 px-1.5 py-0.5 rounded uppercase font-bold tracking-widest">
            Active · {remainingLabel} left
          </span>
        )}
      </div>
      <p className="text-[10px] text-brand-muted leading-snug">{description}</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[9px] uppercase font-bold text-brand-muted block mb-0.5">Duration</label>
          <select
            value={duration}
            onChange={e => setDuration(parseInt(e.target.value, 10))}
            disabled={disabled || surveyActive || busy}
            className="w-full bg-brand-line text-xs rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          >
            {durationOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[9px] uppercase font-bold text-brand-muted block mb-0.5">Survey cadence</label>
          <select
            value={cadence}
            onChange={e => setCadence(parseInt(e.target.value, 10))}
            disabled={disabled || surveyActive || busy}
            className="w-full bg-brand-line text-xs rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          >
            {cadenceOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <div className="flex items-center justify-end pt-1">
        {surveyActive ? (
          <button
            onClick={handleCancel}
            disabled={disabled || busy}
            className="flex items-center gap-1.5 bg-brand-error/15 hover:bg-brand-error/25 border border-brand-error/40 text-brand-error text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            Cancel survey · restore
          </button>
        ) : (
          <button
            onClick={handleStart}
            disabled={disabled || busy}
            className="flex items-center gap-1.5 bg-brand-warning/15 hover:bg-brand-warning/25 border border-brand-warning/40 text-brand-warning text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
            Start survey
          </button>
        )}
      </div>
      {error && <p className="text-[10px] text-brand-error">{error}</p>}
      <p className="text-[9px] text-brand-muted leading-snug">
        On expiry the radio is restored to the config that was active when the survey started.
        Cancelling early restores immediately. Server restart mid-survey leaves the survey config in place — re-open this card to revert.
      </p>
    </div>
  );
}

function RangeTestModuleCard({ radioConnected, rt, surveyExpiresAt }: { radioConnected: boolean; rt: import('../../types').RangeTestModuleConfig | undefined; surveyExpiresAt: number | null }) {
  const [enabled, setEnabled] = React.useState<boolean>(rt?.enabled ?? false);
  const [senderIntervalSecs, setSenderIntervalSecs] = React.useState<number>(rt?.senderIntervalSecs ?? 0);
  const [save, setSave] = React.useState<boolean>(rt?.save ?? false);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!rt || busy) return;
    if (lastSyncedRef.current === rt.lastReadAt) return;
    lastSyncedRef.current = rt.lastReadAt;
    setEnabled(rt.enabled);
    setSenderIntervalSecs(rt.senderIntervalSecs);
    setSave(rt.save);
  }, [rt?.lastReadAt, rt?.enabled, rt?.senderIntervalSecs, rt?.save, busy]);

  const dirty = !rt
    ? true
    : (enabled !== rt.enabled ||
       senderIntervalSecs !== rt.senderIntervalSecs ||
       save !== rt.save);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setRangeTestConfig({ enabled, senderIntervalSecs, save });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshRangeTestConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = rt?.lastReadAt
    ? new Date(rt.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const isSender = enabled && senderIntervalSecs > 0;

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Range Test</h5>
            {rt && (
              <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border ${
                rt.enabled
                  ? (rt.senderIntervalSecs > 0
                      ? 'text-brand-warning bg-brand-warning/10 border-brand-warning/30'
                      : 'text-brand-accent bg-brand-accent/10 border-brand-accent/30')
                  : 'text-brand-muted bg-brand-line border-brand-line'
              }`}>
                {rt.enabled ? (rt.senderIntervalSecs > 0 ? `Sending every ${rt.senderIntervalSecs}s` : 'Receive only') : 'Disabled'}
              </span>
            )}
            {!rt && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            The Range Test sender broadcasts numbered "seq N" packets at a fixed interval — other meshmates log them with SNR/RSSI so operators can map coverage. Receive-only mode is polite for shared meshes.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Enabled</p>
          <p className="text-[10px] text-brand-muted">When on, this radio participates in Range Test (as sender or receiver, depending on the interval).</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Sender Interval</label>
        <select
          value={RT_INTERVAL_PRESETS.some(p => p.value === senderIntervalSecs) ? String(senderIntervalSecs) : 'custom'}
          onChange={e => {
            const v = e.target.value;
            if (v !== 'custom') setSenderIntervalSecs(parseInt(v, 10));
          }}
          disabled={!radioConnected || !enabled}
          className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        >
          {RT_INTERVAL_PRESETS.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
          {!RT_INTERVAL_PRESETS.some(p => p.value === senderIntervalSecs) && (
            <option value="custom">Custom: {senderIntervalSecs}s</option>
          )}
        </select>

        <div className="flex items-center gap-2 mt-1">
          <label className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Custom (s)</label>
          <input
            type="number"
            min={0}
            max={86400}
            step={30}
            value={senderIntervalSecs}
            onChange={e => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v)) setSenderIntervalSecs(Math.max(0, Math.min(86400, v)));
            }}
            disabled={!radioConnected || !enabled}
            className="w-32 bg-brand-line border border-brand-line rounded px-2 py-1 text-[11px] mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
          <span className="text-[9px] text-brand-muted">
            {senderIntervalSecs === 0
              ? 'receive-only'
              : `≈ ${senderIntervalSecs < 3600
                    ? `${Math.round(senderIntervalSecs / 60)} min`
                    : `${(senderIntervalSecs / 3600).toFixed(1)} hr`} · ${Math.round(86400 / senderIntervalSecs)}/day`}
          </span>
        </div>
        {isSender && (
          <p className="text-[10px] text-brand-warning/90 leading-snug">
            ⚠️ Active sending consumes mesh airtime — every "seq N" packet is broadcast across the channel. Keep intervals at or above 5 min unless you're actively running a coverage survey, and disable when finished.
          </p>
        )}
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Save results to flash</p>
          <p className="text-[10px] text-brand-muted">Persist received Range Test packets to the radio's onboard CSV log. Off is fine for most users — server-side ingest already records them.</p>
        </div>
        <input
          type="checkbox"
          checked={save}
          onChange={e => setSave(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line/50">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : rt
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}

      <SurveyControl
        title="Coverage Survey"
        description="Run an accelerated Range Test sender for a fixed duration to map coverage. The radio's current Range Test config is captured before the survey and restored when it expires."
        durationOptions={[
          { value: 5,  label: '5 minutes' },
          { value: 10, label: '10 minutes' },
          { value: 15, label: '15 minutes' },
          { value: 30, label: '30 minutes' },
          { value: 60, label: '1 hour' },
        ]}
        defaultDuration={10}
        cadenceOptions={[
          { value: 30,   label: 'Every 30 s · fast' },
          { value: 60,   label: 'Every 1 min · default' },
          { value: 120,  label: 'Every 2 min' },
          { value: 300,  label: 'Every 5 min · airtime-friendly' },
        ]}
        defaultCadence={60}
        expiresAt={surveyExpiresAt}
        disabled={!radioConnected}
        onStart={(durationMinutes, senderIntervalSecs) => meshDataService.startRangeTestSurvey({ durationMinutes, senderIntervalSecs })}
        onCancel={() => meshDataService.cancelRangeTestSurvey()}
      />
    </div>
  );
}

const TELEMETRY_INTERVAL_PRESETS = [
  { value: 0,     label: 'Firmware default' },
  { value: 300,   label: '5 minutes' },
  { value: 600,   label: '10 minutes' },
  { value: 900,   label: '15 minutes' },
  { value: 1800,  label: '30 minutes' },
  { value: 3600,  label: '1 hour' },
  { value: 7200,  label: '2 hours' },
];

function TelemetryModuleCard({ radioConnected, t }: { radioConnected: boolean; t: import('../../types').TelemetryModuleConfig | undefined }) {
  const [deviceUpdateIntervalSecs, setDeviceUpdateIntervalSecs] = React.useState<number>(t?.deviceUpdateIntervalSecs ?? 0);
  const [environmentEnabled, setEnvironmentEnabled] = React.useState<boolean>(t?.environmentEnabled ?? false);
  const [environmentUpdateIntervalSecs, setEnvironmentUpdateIntervalSecs] = React.useState<number>(t?.environmentUpdateIntervalSecs ?? 0);
  const [powerEnabled, setPowerEnabled] = React.useState<boolean>(t?.powerEnabled ?? false);
  const [powerUpdateIntervalSecs, setPowerUpdateIntervalSecs] = React.useState<number>(t?.powerUpdateIntervalSecs ?? 0);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!t || busy) return;
    if (lastSyncedRef.current === t.lastReadAt) return;
    lastSyncedRef.current = t.lastReadAt;
    setDeviceUpdateIntervalSecs(t.deviceUpdateIntervalSecs);
    setEnvironmentEnabled(t.environmentEnabled);
    setEnvironmentUpdateIntervalSecs(t.environmentUpdateIntervalSecs);
    setPowerEnabled(t.powerEnabled);
    setPowerUpdateIntervalSecs(t.powerUpdateIntervalSecs);
  }, [t?.lastReadAt, t?.deviceUpdateIntervalSecs, t?.environmentEnabled, t?.environmentUpdateIntervalSecs, t?.powerEnabled, t?.powerUpdateIntervalSecs, busy]);

  const dirty = !t
    ? true
    : (deviceUpdateIntervalSecs !== t.deviceUpdateIntervalSecs ||
       environmentEnabled !== t.environmentEnabled ||
       environmentUpdateIntervalSecs !== t.environmentUpdateIntervalSecs ||
       powerEnabled !== t.powerEnabled ||
       powerUpdateIntervalSecs !== t.powerUpdateIntervalSecs);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setTelemetryConfig({
      deviceUpdateIntervalSecs,
      environmentEnabled,
      environmentUpdateIntervalSecs,
      powerEnabled,
      powerUpdateIntervalSecs,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshTelemetryConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = t?.lastReadAt
    ? new Date(t.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const intervalSelect = (val: number, onChange: (v: number) => void, disabled: boolean) => (
    <>
      <select
        value={TELEMETRY_INTERVAL_PRESETS.some(p => p.value === val) ? String(val) : 'custom'}
        onChange={e => {
          const v = e.target.value;
          if (v !== 'custom') onChange(parseInt(v, 10));
        }}
        disabled={disabled}
        className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
      >
        {TELEMETRY_INTERVAL_PRESETS.map(p => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
        {!TELEMETRY_INTERVAL_PRESETS.some(p => p.value === val) && (
          <option value="custom">Custom: {val}s</option>
        )}
      </select>
      <div className="flex items-center gap-2 mt-1">
        <label className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Custom (s)</label>
        <input
          type="number"
          min={0}
          max={86400}
          step={30}
          value={val}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) onChange(Math.max(0, Math.min(86400, v)));
          }}
          disabled={disabled}
          className="w-32 bg-brand-line border border-brand-line rounded px-2 py-1 text-[11px] mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
      </div>
    </>
  );

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Telemetry</h5>
            {t && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border text-brand-accent bg-brand-accent/10 border-brand-accent/30">
                Active
              </span>
            )}
            {!t && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            How often the local radio broadcasts telemetry: device metrics (battery, voltage, channel utilization), environment sensors (BME280 etc.), and power monitors (INA219/INA260). Lower intervals give fresher data at the cost of mesh airtime.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Device Metrics Interval</label>
        {intervalSelect(deviceUpdateIntervalSecs, setDeviceUpdateIntervalSecs, !radioConnected)}
        <p className="text-[10px] text-brand-muted leading-snug">Battery percentage, voltage, channel utilization, air-tx utilization. Firmware default is typically 30 minutes.</p>
      </div>

      <div className="border-t border-brand-line/50 pt-4 space-y-1.5">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Environment Sensors</p>
            <p className="text-[10px] text-brand-muted">Temperature / humidity / pressure from a connected BME280, BME680, etc.</p>
          </div>
          <input
            type="checkbox"
            checked={environmentEnabled}
            onChange={e => setEnvironmentEnabled(e.target.checked)}
            disabled={!radioConnected}
            className="w-4 h-4 accent-emerald-500"
          />
        </label>
        {environmentEnabled && (
          <div className="pt-1">
            <label className="text-[10px] uppercase font-bold text-brand-muted block mb-1">Environment Interval</label>
            {intervalSelect(environmentUpdateIntervalSecs, setEnvironmentUpdateIntervalSecs, !radioConnected)}
          </div>
        )}
      </div>

      <div className="border-t border-brand-line/50 pt-4 space-y-1.5">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Power Monitor</p>
            <p className="text-[10px] text-brand-muted">Per-channel current / voltage / power readings from an INA219 or INA260.</p>
          </div>
          <input
            type="checkbox"
            checked={powerEnabled}
            onChange={e => setPowerEnabled(e.target.checked)}
            disabled={!radioConnected}
            className="w-4 h-4 accent-emerald-500"
          />
        </label>
        {powerEnabled && (
          <div className="pt-1">
            <label className="text-[10px] uppercase font-bold text-brand-muted block mb-1">Power Interval</label>
            {intervalSelect(powerUpdateIntervalSecs, setPowerUpdateIntervalSecs, !radioConnected)}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line/50">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : t
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

const SF_RECORDS_PRESETS = [
  { value: 0,    label: 'Firmware default' },
  { value: 100,  label: '100 records' },
  { value: 250,  label: '250 records' },
  { value: 500,  label: '500 records' },
  { value: 1000, label: '1,000 records' },
];

const SF_RETURN_MAX_PRESETS = [
  { value: 0,   label: 'Firmware default' },
  { value: 25,  label: '25 records / request' },
  { value: 50,  label: '50 records / request' },
  { value: 100, label: '100 records / request' },
];

const SF_WINDOW_PRESETS = [
  { value: 0,    label: 'Firmware default' },
  { value: 60,   label: '1 hour' },
  { value: 240,  label: '4 hours' },
  { value: 720,  label: '12 hours' },
  { value: 1440, label: '24 hours' },
];

function StoreForwardModuleCard({ radioConnected, sf }: { radioConnected: boolean; sf: import('../../types').StoreForwardLocalConfig | undefined }) {
  const [enabled, setEnabled] = React.useState<boolean>(sf?.enabled ?? false);
  const [isServer, setIsServer] = React.useState<boolean>(sf?.isServer ?? false);
  const [heartbeat, setHeartbeat] = React.useState<boolean>(sf?.heartbeat ?? false);
  const [records, setRecords] = React.useState<number>(sf?.records ?? 0);
  const [historyReturnMax, setHistoryReturnMax] = React.useState<number>(sf?.historyReturnMax ?? 0);
  const [historyReturnWindow, setHistoryReturnWindow] = React.useState<number>(sf?.historyReturnWindow ?? 0);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!sf || busy) return;
    if (lastSyncedRef.current === sf.lastReadAt) return;
    lastSyncedRef.current = sf.lastReadAt;
    setEnabled(sf.enabled);
    setIsServer(sf.isServer);
    setHeartbeat(sf.heartbeat);
    setRecords(sf.records);
    setHistoryReturnMax(sf.historyReturnMax);
    setHistoryReturnWindow(sf.historyReturnWindow);
  }, [sf?.lastReadAt, sf?.enabled, sf?.isServer, sf?.heartbeat, sf?.records, sf?.historyReturnMax, sf?.historyReturnWindow, busy]);

  const dirty = !sf
    ? true
    : (enabled !== sf.enabled ||
       isServer !== sf.isServer ||
       heartbeat !== sf.heartbeat ||
       records !== sf.records ||
       historyReturnMax !== sf.historyReturnMax ||
       historyReturnWindow !== sf.historyReturnWindow);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setStoreForwardConfig({
      enabled,
      isServer,
      heartbeat,
      records,
      historyReturnMax,
      historyReturnWindow,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshStoreForwardConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = sf?.lastReadAt
    ? new Date(sf.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const presetSelect = (
    val: number,
    onChange: (v: number) => void,
    presets: Array<{ value: number; label: string }>,
    disabled: boolean,
    customMax = 100000,
  ) => (
    <>
      <select
        value={presets.some(p => p.value === val) ? String(val) : 'custom'}
        onChange={e => {
          const v = e.target.value;
          if (v !== 'custom') onChange(parseInt(v, 10));
        }}
        disabled={disabled}
        className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
      >
        {presets.map(p => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
        {!presets.some(p => p.value === val) && (
          <option value="custom">Custom: {val}</option>
        )}
      </select>
      <div className="flex items-center gap-2 mt-1">
        <label className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Custom</label>
        <input
          type="number"
          min={0}
          max={customMax}
          step={10}
          value={val}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) onChange(Math.max(0, Math.min(customMax, v)));
          }}
          disabled={disabled}
          className="w-32 bg-brand-line border border-brand-line rounded px-2 py-1 text-[11px] mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
      </div>
    </>
  );

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Store &amp; Forward</h5>
            {sf && (
              <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border ${
                sf.enabled
                  ? (sf.isServer
                      ? 'text-brand-warning bg-brand-warning/10 border-brand-warning/30'
                      : 'text-brand-accent bg-brand-accent/10 border-brand-accent/30')
                  : 'text-brand-muted bg-brand-line border-brand-line'
              }`}>
                {sf.enabled ? (sf.isServer ? 'Router / server' : 'Client') : 'Disabled'}
              </span>
            )}
            {!sf && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            S&amp;F lets a powered, always-on radio buffer mesh traffic and replay it to peers that come back online.
            Client mode (the default) just listens for and requests replays. Router/server mode means this radio buffers
            for everyone — only enable on a stable-power node.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Enabled</p>
          <p className="text-[10px] text-brand-muted">Turn the S&amp;F module on. With server mode off, this is the standard client-side replay-request behavior.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Act as router / server</p>
          <p className="text-[10px] text-brand-muted">Buffer traffic for the whole mesh and serve replays. Requires stable power; not for battery nodes.</p>
        </div>
        <input
          type="checkbox"
          checked={isServer}
          onChange={e => setIsServer(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      {isServer && enabled && (
        <div className="border-t border-brand-line/50 pt-4 space-y-4">
          <p className="text-[10px] uppercase font-bold text-brand-warning/90 tracking-widest">Router parameters</p>

          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <p className="text-xs font-bold text-brand-ink">Heartbeat</p>
              <p className="text-[10px] text-brand-muted">Periodically broadcast that this node is an active S&amp;F router so peers know they can request replays.</p>
            </div>
            <input
              type="checkbox"
              checked={heartbeat}
              onChange={e => setHeartbeat(e.target.checked)}
              disabled={!radioConnected}
              className="w-4 h-4 accent-emerald-500"
            />
          </label>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-brand-muted block">Buffer size (records)</label>
            {presetSelect(records, setRecords, SF_RECORDS_PRESETS, !radioConnected, 100000)}
            <p className="text-[10px] text-brand-muted leading-snug">Maximum messages this router will retain. More = longer history but more flash usage.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-brand-muted block">Max replay per request</label>
            {presetSelect(historyReturnMax, setHistoryReturnMax, SF_RETURN_MAX_PRESETS, !radioConnected, 100000)}
            <p className="text-[10px] text-brand-muted leading-snug">How many records to send to a single CLIENT_HISTORY request — caps the airtime burst when a peer comes back online.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-brand-muted block">Replay time window (minutes)</label>
            {presetSelect(historyReturnWindow, setHistoryReturnWindow, SF_WINDOW_PRESETS, !radioConnected, 1440)}
            <p className="text-[10px] text-brand-muted leading-snug">Maximum age of records that will be replayed. 0 = firmware default (typically 4 hours).</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line/50">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : sf
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

const EN_DURATION_PRESETS = [
  { value: 250,   label: 'Quick beep (250 ms)' },
  { value: 500,   label: 'Short (500 ms)' },
  { value: 1000,  label: 'Default (1 s)' },
  { value: 2000,  label: 'Long (2 s)' },
  { value: 5000,  label: 'Very long (5 s)' },
];
const EN_NAG_PRESETS = [
  { value: 0,     label: 'Off (alert once, no nag)' },
  { value: 30,    label: 'Nag for 30 s' },
  { value: 60,    label: 'Nag for 1 min' },
  { value: 300,   label: 'Nag for 5 min' },
  { value: 900,   label: 'Nag for 15 min' },
];

function ExternalNotificationModuleCard({ radioConnected, en }: {
  radioConnected: boolean;
  en: import('../../types').ExternalNotificationModuleConfig | undefined;
}) {
  // Operator-editable knobs
  const [enabled, setEnabled] = React.useState<boolean>(en?.enabled ?? false);
  const [alertMessage, setAlertMessage] = React.useState<boolean>(en?.alertMessage ?? false);
  const [alertBell, setAlertBell] = React.useState<boolean>(en?.alertBell ?? true);
  const [outputMs, setOutputMs] = React.useState<number>(en?.outputMs ?? 1000);
  const [nagTimeout, setNagTimeout] = React.useState<number>(en?.nagTimeout ?? 0);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!en || busy) return;
    if (lastSyncedRef.current === en.lastReadAt) return;
    lastSyncedRef.current = en.lastReadAt;
    setEnabled(en.enabled);
    setAlertMessage(en.alertMessage);
    setAlertBell(en.alertBell);
    setOutputMs(en.outputMs || 1000);
    setNagTimeout(en.nagTimeout);
  }, [en?.lastReadAt, en?.enabled, en?.alertMessage, en?.alertBell, en?.outputMs, en?.nagTimeout, busy]);

  const dirty = !en
    ? true
    : (enabled !== en.enabled ||
       alertMessage !== en.alertMessage ||
       alertBell !== en.alertBell ||
       outputMs !== en.outputMs ||
       nagTimeout !== en.nagTimeout);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    // Pass-through fields preserve board-specific GPIO assignments and the
    // advanced PWM/I2S/vibra/buzzer routing the operator hasn't touched.
    const r = await meshDataService.setExternalNotificationConfig({
      enabled,
      outputMs,
      output: en?.output ?? 0,
      active: en?.active ?? false,
      alertMessage,
      alertBell,
      usePwm: en?.usePwm ?? false,
      outputVibra: en?.outputVibra ?? 0,
      outputBuzzer: en?.outputBuzzer ?? 0,
      alertMessageVibra: en?.alertMessageVibra ?? false,
      alertMessageBuzzer: en?.alertMessageBuzzer ?? false,
      alertBellVibra: en?.alertBellVibra ?? false,
      alertBellBuzzer: en?.alertBellBuzzer ?? false,
      nagTimeout,
      useI2sAsBuzzer: en?.useI2sAsBuzzer ?? false,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshExternalNotificationConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = en?.lastReadAt
    ? new Date(en.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const presetSelect = (val: number, onChange: (v: number) => void, presets: Array<{ value: number; label: string }>, customMax: number, disabled: boolean) => (
    <>
      <select
        value={presets.some(p => p.value === val) ? String(val) : 'custom'}
        onChange={e => {
          const v = e.target.value;
          if (v !== 'custom') onChange(parseInt(v, 10));
        }}
        disabled={disabled}
        className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
      >
        {presets.map(p => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
        {!presets.some(p => p.value === val) && (
          <option value="custom">Custom: {val}</option>
        )}
      </select>
      <div className="flex items-center gap-2 mt-1">
        <label className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Custom</label>
        <input
          type="number"
          min={0}
          max={customMax}
          step={50}
          value={val}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) onChange(Math.max(0, Math.min(customMax, v)));
          }}
          disabled={disabled}
          className="w-32 bg-brand-line border border-brand-line rounded px-2 py-1 text-[11px] mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
      </div>
    </>
  );

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">External Notification</h5>
            {en && (
              <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border ${
                en.enabled
                  ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                  : 'text-brand-muted bg-brand-line border-brand-line'
              }`}>
                {en.enabled ? 'Enabled' : 'Disabled'}
              </span>
            )}
            {!en && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            Drive a buzzer, LED, or vibration motor wired to the radio when text messages arrive. GPIO pin assignments come from your board's firmware build and are preserved on save — the controls below only change the high-level alerting behavior.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch for the External Notification module.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Alert on any text message</p>
          <p className="text-[10px] text-brand-muted">Trigger the alert pin / buzzer for every received text message (channel + DM). Noisy on busy meshes.</p>
        </div>
        <input
          type="checkbox"
          checked={alertMessage}
          onChange={e => setAlertMessage(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Alert on bell character only</p>
          <p className="text-[10px] text-brand-muted">Trigger only when a sender embeds the bell character (^G) in their message. Quieter; lets specific senders raise an alert intentionally.</p>
        </div>
        <input
          type="checkbox"
          checked={alertBell}
          onChange={e => setAlertBell(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Alert Duration (ms)</label>
        {presetSelect(outputMs, setOutputMs, EN_DURATION_PRESETS, 60000, !radioConnected || !enabled)}
        <p className="text-[10px] text-brand-muted leading-snug">How long the buzzer / LED stays on per alert.</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Nag Timeout (s)</label>
        {presetSelect(nagTimeout, setNagTimeout, EN_NAG_PRESETS, 86400, !radioConnected || !enabled)}
        <p className="text-[10px] text-brand-muted leading-snug">If &gt; 0, keep re-alerting every {Math.max(outputMs / 1000, 1).toFixed(0)}s for up to this duration until the user dismisses on the radio. Useful for sleeping operators; annoying otherwise.</p>
      </div>

      {en && (en.output > 0 || en.outputBuzzer > 0 || en.outputVibra > 0) && (
        <div className="border-t border-brand-line/50 pt-3 text-[10px] text-brand-muted mono-text leading-relaxed">
          <p className="text-brand-muted uppercase font-bold mb-1 tracking-widest">Hardware (read-only)</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {en.output > 0      && <><span>output pin</span><span>GPIO {en.output}{en.active ? ' (active-high)' : ' (active-low)'}</span></>}
            {en.outputBuzzer > 0 && <><span>buzzer pin</span><span>GPIO {en.outputBuzzer}{en.usePwm ? ' (PWM)' : ''}</span></>}
            {en.outputVibra > 0  && <><span>vibra pin</span><span>GPIO {en.outputVibra}</span></>}
            {en.useI2sAsBuzzer    && <><span>i2s as buzzer</span><span>yes</span></>}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line/50">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : en
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// MQTT module card (broker URL / auth / encryption / topic)
// ============================================================================
function MqttModuleCard({ radioConnected, m }: {
  radioConnected: boolean;
  m: import('../../types').MqttModuleConfig | undefined;
}) {
  const [enabled, setEnabled] = React.useState<boolean>(m?.enabled ?? false);
  const [address, setAddress] = React.useState<string>(m?.address ?? '');
  const [username, setUsername] = React.useState<string>(m?.username ?? '');
  const [password, setPassword] = React.useState<string>(m?.password ?? '');
  const [encryptionEnabled, setEncryptionEnabled] = React.useState<boolean>(m?.encryptionEnabled ?? true);
  const [jsonEnabled, setJsonEnabled] = React.useState<boolean>(m?.jsonEnabled ?? false);
  const [tlsEnabled, setTlsEnabled] = React.useState<boolean>(m?.tlsEnabled ?? false);
  const [root, setRoot] = React.useState<string>(m?.root ?? '');
  const [proxyToClientEnabled, setProxyToClientEnabled] = React.useState<boolean>(m?.proxyToClientEnabled ?? false);
  const [mapReportingEnabled, setMapReportingEnabled] = React.useState<boolean>(m?.mapReportingEnabled ?? false);
  const [showPassword, setShowPassword] = React.useState(false);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!m || busy) return;
    if (lastSyncedRef.current === m.lastReadAt) return;
    lastSyncedRef.current = m.lastReadAt;
    setEnabled(m.enabled);
    setAddress(m.address);
    setUsername(m.username);
    setPassword(m.password);
    setEncryptionEnabled(m.encryptionEnabled);
    setJsonEnabled(m.jsonEnabled);
    setTlsEnabled(m.tlsEnabled);
    setRoot(m.root);
    setProxyToClientEnabled(m.proxyToClientEnabled);
    setMapReportingEnabled(m.mapReportingEnabled);
  }, [m?.lastReadAt, m, busy]);

  const dirty = !m
    ? true
    : (enabled !== m.enabled ||
       address !== m.address ||
       username !== m.username ||
       password !== m.password ||
       encryptionEnabled !== m.encryptionEnabled ||
       jsonEnabled !== m.jsonEnabled ||
       tlsEnabled !== m.tlsEnabled ||
       root !== m.root ||
       proxyToClientEnabled !== m.proxyToClientEnabled ||
       mapReportingEnabled !== m.mapReportingEnabled);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setMqttConfig({
      enabled,
      address,
      username,
      password,
      encryptionEnabled,
      jsonEnabled,
      tlsEnabled,
      root,
      proxyToClientEnabled,
      mapReportingEnabled,
      // Pass through MapReportSettings opaque blob from the readback so we don't drop unmodelled fields.
      mapReportSettingsRaw: m?.mapReportSettingsRaw ?? null,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshMqttConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = m?.lastReadAt
    ? new Date(m.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  // Encryption + JSON together is contradictory — JSON requires unencrypted payloads.
  // Surface a soft warning rather than blocking the operator.
  const conflictWarning = encryptionEnabled && jsonEnabled
    ? 'Encryption + JSON together: most firmware builds will silently drop the JSON publish. Pick one.'
    : null;

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">MQTT Bridge</h5>
            {m && (
              <span className={cn(
                'text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border',
                m.enabled
                  ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                  : 'text-brand-muted bg-brand-line border-brand-line',
              )}>
                {m.enabled ? (m.proxyToClientEnabled ? 'Active · proxy' : 'Active') : 'Disabled'}
              </span>
            )}
            {!m && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            Bridges per-channel mesh traffic to/from an MQTT broker. Per-channel uplink/downlink toggles still live in <span className="text-brand-ink font-bold">Channels</span>; this card configures the broker the radio talks to.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch for the MQTT module on the local radio.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Broker Address</label>
        <input
          type="text"
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder="mqtt.meshtastic.org"
          disabled={!radioConnected || !enabled}
          className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
        <p className="text-[10px] text-brand-muted leading-snug">
          Hostname or IP of your broker. Empty value falls back to the firmware default (usually the public Meshtastic broker).
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Username</label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="(blank = anonymous)"
            disabled={!radioConnected || !enabled}
            autoComplete="off"
            className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Password</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="(blank = anonymous)"
              disabled={!radioConnected || !enabled}
              autoComplete="off"
              className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 pr-9 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShowPassword(s => !s)}
              disabled={!radioConnected || !enabled}
              tabIndex={-1}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-brand-muted hover:text-brand-ink disabled:opacity-50"
            >
              {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Topic Root</label>
        <input
          type="text"
          value={root}
          onChange={e => setRoot(e.target.value)}
          placeholder="msh/US/2/e/"
          disabled={!radioConnected || !enabled}
          className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
        <p className="text-[10px] text-brand-muted leading-snug">
          Topic prefix for publish/subscribe. Must match what other gateways on your broker use. Empty = firmware default.
        </p>
      </div>

      <div className="border-t border-brand-line pt-3 grid grid-cols-2 gap-3">
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div className="min-w-0">
            <p className="text-xs font-bold text-brand-ink">TLS</p>
            <p className="text-[10px] text-brand-muted leading-snug">Encrypt the connection to the broker.</p>
          </div>
          <input
            type="checkbox"
            checked={tlsEnabled}
            onChange={e => setTlsEnabled(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div className="min-w-0">
            <p className="text-xs font-bold text-brand-ink">Channel encryption</p>
            <p className="text-[10px] text-brand-muted leading-snug">Encrypt payloads with the per-channel PSK before publish.</p>
          </div>
          <input
            type="checkbox"
            checked={encryptionEnabled}
            onChange={e => setEncryptionEnabled(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div className="min-w-0">
            <p className="text-xs font-bold text-brand-ink">JSON publish</p>
            <p className="text-[10px] text-brand-muted leading-snug">Plaintext JSON for IoT consumers. Disables channel encryption in practice.</p>
          </div>
          <input
            type="checkbox"
            checked={jsonEnabled}
            onChange={e => setJsonEnabled(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div className="min-w-0">
            <p className="text-xs font-bold text-brand-ink">Proxy to client</p>
            <p className="text-[10px] text-brand-muted leading-snug">Use the connected client (this app) as the MQTT relay; useful when the radio has no WiFi.</p>
          </div>
          <input
            type="checkbox"
            checked={proxyToClientEnabled}
            onChange={e => setProxyToClientEnabled(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
      </div>

      <label className="flex items-center justify-between cursor-pointer pt-1 border-t border-brand-line">
        <div className="pt-3">
          <p className="text-xs font-bold text-brand-ink">Map reporting</p>
          <p className="text-[10px] text-brand-muted">Publish the local node's position to the public Meshtastic map. Only enable if you're OK broadcasting your location.</p>
        </div>
        <input
          type="checkbox"
          checked={mapReportingEnabled}
          onChange={e => setMapReportingEnabled(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      {conflictWarning && (
        <p className="text-[10px] text-brand-warning leading-snug flex items-start gap-1.5">
          <AlertCircle size={11} className="flex-shrink-0 mt-0.5" />
          <span>{conflictWarning}</span>
        </p>
      )}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : m
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-brand-accent text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Detection Sensor module — broadcasts when a monitored GPIO changes state
// ============================================================================
function DetectionSensorModuleCard({ radioConnected, ds }: {
  radioConnected: boolean;
  ds: import('../../types').DetectionSensorModuleConfig | undefined;
}) {
  const [enabled, setEnabled] = React.useState<boolean>(ds?.enabled ?? false);
  const [name, setName] = React.useState<string>(ds?.name ?? '');
  const [minimumBroadcastSecs, setMinimumBroadcastSecs] = React.useState<number>(ds?.minimumBroadcastSecs ?? 30);
  const [stateBroadcastSecs, setStateBroadcastSecs] = React.useState<number>(ds?.stateBroadcastSecs ?? 0);
  const [sendBell, setSendBell] = React.useState<boolean>(ds?.sendBell ?? true);
  const [monitorPin, setMonitorPin] = React.useState<number>(ds?.monitorPin ?? 0);
  const [detectionTriggeredHigh, setDetectionTriggeredHigh] = React.useState<boolean>(ds?.detectionTriggeredHigh ?? false);
  const [usePullup, setUsePullup] = React.useState<boolean>(ds?.usePullup ?? true);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!ds || busy) return;
    if (lastSyncedRef.current === ds.lastReadAt) return;
    lastSyncedRef.current = ds.lastReadAt;
    setEnabled(ds.enabled);
    setName(ds.name);
    setMinimumBroadcastSecs(ds.minimumBroadcastSecs);
    setStateBroadcastSecs(ds.stateBroadcastSecs);
    setSendBell(ds.sendBell);
    setMonitorPin(ds.monitorPin);
    setDetectionTriggeredHigh(ds.detectionTriggeredHigh);
    setUsePullup(ds.usePullup);
  }, [ds?.lastReadAt, ds, busy]);

  const dirty = !ds
    ? true
    : (enabled !== ds.enabled ||
       name !== ds.name ||
       minimumBroadcastSecs !== ds.minimumBroadcastSecs ||
       stateBroadcastSecs !== ds.stateBroadcastSecs ||
       sendBell !== ds.sendBell ||
       monitorPin !== ds.monitorPin ||
       detectionTriggeredHigh !== ds.detectionTriggeredHigh ||
       usePullup !== ds.usePullup);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setDetectionSensorConfig({
      enabled, name, minimumBroadcastSecs, stateBroadcastSecs, sendBell,
      monitorPin, detectionTriggeredHigh, usePullup,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshDetectionSensorConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = ds?.lastReadAt
    ? new Date(ds.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Detection Sensor</h5>
            {ds && (
              <span className={cn(
                'text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border',
                ds.enabled
                  ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                  : 'text-brand-muted bg-brand-line border-brand-line',
              )}>
                {ds.enabled ? `Watching pin ${ds.monitorPin}` : 'Disabled'}
              </span>
            )}
            {!ds && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            Broadcast a text message to the mesh whenever a monitored GPIO pin changes state. Useful for door sensors, mailbox flags, PIR motion detectors, reed switches, etc. The pin is wired to your radio's exposed GPIO header.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch for the Detection Sensor module.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Sensor Name</label>
        <input
          type="text"
          maxLength={20}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Front door"
          disabled={!radioConnected || !enabled}
          className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
        <p className="text-[10px] text-brand-muted leading-snug">
          Shown in broadcast messages, e.g. "Front door triggered". Keep short — bandwidth is precious.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Monitor pin (GPIO)</label>
          <input
            type="number"
            min={0}
            max={64}
            value={monitorPin}
            onChange={e => setMonitorPin(Math.max(0, Math.min(64, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Min broadcast (s)</label>
          <input
            type="number"
            min={0}
            max={86400}
            step={5}
            value={minimumBroadcastSecs}
            onChange={e => setMinimumBroadcastSecs(Math.max(0, Math.min(86400, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Periodic state (s)</label>
          <input
            type="number"
            min={0}
            max={86400}
            step={60}
            value={stateBroadcastSecs}
            onChange={e => setStateBroadcastSecs(Math.max(0, Math.min(86400, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
          <p className="text-[10px] text-brand-muted leading-snug">0 = no periodic; only on change.</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 border-t border-brand-line pt-3">
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Active high</p>
            <p className="text-[10px] text-brand-muted leading-snug">Trigger on HIGH (off) or LOW (on).</p>
          </div>
          <input
            type="checkbox"
            checked={detectionTriggeredHigh}
            onChange={e => setDetectionTriggeredHigh(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Pullup</p>
            <p className="text-[10px] text-brand-muted leading-snug">Internal pullup resistor.</p>
          </div>
          <input
            type="checkbox"
            checked={usePullup}
            onChange={e => setUsePullup(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Send bell (^G)</p>
            <p className="text-[10px] text-brand-muted leading-snug">Triggers buzzer on receivers.</p>
          </div>
          <input
            type="checkbox"
            checked={sendBell}
            onChange={e => setSendBell(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : ds
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Audio module — Codec2 voice over LoRa (very experimental)
// ============================================================================
const AUDIO_BITRATE_OPTIONS = [
  { value: 0, label: 'Codec2 default' },
  { value: 1, label: 'Codec2 3200 bps' },
  { value: 2, label: 'Codec2 2400 bps' },
  { value: 3, label: 'Codec2 1600 bps' },
  { value: 4, label: 'Codec2 1400 bps' },
  { value: 5, label: 'Codec2 1300 bps' },
  { value: 6, label: 'Codec2 1200 bps' },
  { value: 7, label: 'Codec2 700B bps' },
];

function AudioModuleCard({ radioConnected, a }: {
  radioConnected: boolean;
  a: import('../../types').AudioModuleConfig | undefined;
}) {
  const [codec2Enabled, setCodec2Enabled] = React.useState<boolean>(a?.codec2Enabled ?? false);
  const [pttPin, setPttPin] = React.useState<number>(a?.pttPin ?? 0);
  const [bitrate, setBitrate] = React.useState<number>(a?.bitrate ?? 0);
  const [i2sWs, setI2sWs] = React.useState<number>(a?.i2sWs ?? 0);
  const [i2sSd, setI2sSd] = React.useState<number>(a?.i2sSd ?? 0);
  const [i2sDin, setI2sDin] = React.useState<number>(a?.i2sDin ?? 0);
  const [i2sSck, setI2sSck] = React.useState<number>(a?.i2sSck ?? 0);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!a || busy) return;
    if (lastSyncedRef.current === a.lastReadAt) return;
    lastSyncedRef.current = a.lastReadAt;
    setCodec2Enabled(a.codec2Enabled);
    setPttPin(a.pttPin);
    setBitrate(a.bitrate);
    setI2sWs(a.i2sWs);
    setI2sSd(a.i2sSd);
    setI2sDin(a.i2sDin);
    setI2sSck(a.i2sSck);
  }, [a?.lastReadAt, a, busy]);

  const dirty = !a
    ? true
    : (codec2Enabled !== a.codec2Enabled ||
       pttPin !== a.pttPin ||
       bitrate !== a.bitrate ||
       i2sWs !== a.i2sWs ||
       i2sSd !== a.i2sSd ||
       i2sDin !== a.i2sDin ||
       i2sSck !== a.i2sSck);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setAudioConfig({
      codec2Enabled, pttPin, bitrate, i2sWs, i2sSd, i2sDin, i2sSck,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshAudioConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = a?.lastReadAt
    ? new Date(a.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const pinInput = (val: number, onChange: (v: number) => void, label: string) => (
    <div className="space-y-1">
      <label className="text-[10px] uppercase font-bold text-brand-muted block">{label}</label>
      <input
        type="number"
        min={0}
        max={64}
        value={val}
        onChange={e => onChange(Math.max(0, Math.min(64, parseInt(e.target.value, 10) || 0)))}
        disabled={!radioConnected || !codec2Enabled}
        className="w-full bg-brand-line text-xs mono-text rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
      />
    </div>
  );

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Audio</h5>
            {a && (
              <span className={cn(
                'text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border',
                a.codec2Enabled
                  ? 'text-brand-warning bg-brand-warning/10 border-brand-warning/30'
                  : 'text-brand-muted bg-brand-line border-brand-line',
              )}>
                {a.codec2Enabled ? 'Codec2 active' : 'Disabled'}
              </span>
            )}
            {!a && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            <span className="text-brand-warning font-bold">Experimental.</span> Codec2 voice over LoRa requires an I2S microphone + speaker wired to the radio. Most off-the-shelf Meshtastic boards (T-Beam, Heltec v3, etc.) do <span className="font-bold">not</span> ship with the necessary hardware. Leave disabled unless you've explicitly built for it.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Codec2 enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch — disables every Audio control below when off.</p>
        </div>
        <input
          type="checkbox"
          checked={codec2Enabled}
          onChange={e => setCodec2Enabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">PTT pin</label>
          <input
            type="number"
            min={0}
            max={64}
            value={pttPin}
            onChange={e => setPttPin(Math.max(0, Math.min(64, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !codec2Enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Bitrate</label>
          <select
            value={bitrate}
            onChange={e => setBitrate(parseInt(e.target.value, 10))}
            disabled={!radioConnected || !codec2Enabled}
            className="w-full bg-brand-line text-xs rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          >
            {AUDIO_BITRATE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="border-t border-brand-line pt-3">
        <p className="text-[10px] uppercase font-bold tracking-widest text-brand-muted mb-2">I2S Pins</p>
        <div className="grid grid-cols-4 gap-2">
          {pinInput(i2sWs, setI2sWs, 'WS')}
          {pinInput(i2sSd, setI2sSd, 'SD')}
          {pinInput(i2sDin, setI2sDin, 'DIN')}
          {pinInput(i2sSck, setI2sSck, 'SCK')}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : a
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Serial module — UART passthrough to an external device
// ----------------------------------------------------------------------------
const SERIAL_BAUD_OPTIONS = [
  { value: 0, label: 'Default' },
  { value: 4, label: '1200 baud' },
  { value: 7, label: '9600 baud' },
  { value: 8, label: '19200 baud' },
  { value: 9, label: '38400 baud' },
  { value: 10, label: '57600 baud' },
  { value: 11, label: '115200 baud' },
  { value: 12, label: '230400 baud' },
];
const SERIAL_MODE_OPTIONS = [
  { value: 0, label: 'Default' },
  { value: 1, label: 'Simple (raw passthrough)' },
  { value: 2, label: 'Proto (framed)' },
  { value: 3, label: 'Text messages' },
  { value: 4, label: 'NMEA (GPS out)' },
  { value: 5, label: 'CalTopo' },
  { value: 6, label: 'WS85 weather station' },
  { value: 7, label: 'VE.Direct (Victron)' },
];

function SerialModuleCard({ radioConnected, s }: {
  radioConnected: boolean;
  s: import('../../types').SerialModuleConfig | undefined;
}) {
  const [enabled, setEnabled] = React.useState<boolean>(s?.enabled ?? false);
  const [echo, setEcho] = React.useState<boolean>(s?.echo ?? false);
  const [rxd, setRxd] = React.useState<number>(s?.rxd ?? 0);
  const [txd, setTxd] = React.useState<number>(s?.txd ?? 0);
  const [baud, setBaud] = React.useState<number>(s?.baud ?? 0);
  const [timeout, setTimeoutMs] = React.useState<number>(s?.timeout ?? 0);
  const [mode, setMode] = React.useState<number>(s?.mode ?? 0);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!s || busy) return;
    if (lastSyncedRef.current === s.lastReadAt) return;
    lastSyncedRef.current = s.lastReadAt;
    setEnabled(s.enabled);
    setEcho(s.echo);
    setRxd(s.rxd);
    setTxd(s.txd);
    setBaud(s.baud);
    setTimeoutMs(s.timeout);
    setMode(s.mode);
  }, [s?.lastReadAt, s, busy]);

  const dirty = !s
    ? true
    : (enabled !== s.enabled || echo !== s.echo || rxd !== s.rxd || txd !== s.txd ||
       baud !== s.baud || timeout !== s.timeout || mode !== s.mode);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setSerialConfig({ enabled, echo, rxd, txd, baud, timeout, mode });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshSerialConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = s?.lastReadAt
    ? new Date(s.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Serial</h5>
            {s && (
              <span className={cn(
                'text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border',
                s.enabled
                  ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                  : 'text-brand-muted bg-brand-line border-brand-line',
              )}>
                {s.enabled ? 'Enabled' : 'Disabled'}
              </span>
            )}
            {!s && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            UART passthrough to a wired peripheral — GPS feeds, weather stations (WS85), Victron solar (VE.Direct), or raw text bridging. Leave disabled unless you have a device wired to the radio's TX/RX pins.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Serial module enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch — disables every Serial control below when off.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Mode</label>
          <select
            value={mode}
            onChange={e => setMode(parseInt(e.target.value, 10))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          >
            {SERIAL_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Baud</label>
          <select
            value={baud}
            onChange={e => setBaud(parseInt(e.target.value, 10))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          >
            {SERIAL_BAUD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">RX pin</label>
          <input
            type="number" min={0} max={64} value={rxd}
            onChange={e => setRxd(Math.max(0, Math.min(64, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">TX pin</label>
          <input
            type="number" min={0} max={64} value={txd}
            onChange={e => setTxd(Math.max(0, Math.min(64, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Timeout (ms)</label>
          <input
            type="number" min={0} max={60000} value={timeout}
            onChange={e => setTimeoutMs(Math.max(0, Math.min(60000, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Echo</p>
          <p className="text-[10px] text-brand-muted">Loop received bytes back out the port (debug aid).</p>
        </div>
        <input
          type="checkbox"
          checked={echo}
          onChange={e => setEcho(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel ? `Last read: ${lastReadLabel}` : s ? 'Set by you (no readback yet)' : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Ambient Lighting module — onboard RGB LED control
// ----------------------------------------------------------------------------
function AmbientLightingModuleCard({ radioConnected, al }: {
  radioConnected: boolean;
  al: import('../../types').AmbientLightingModuleConfig | undefined;
}) {
  const [ledState, setLedState] = React.useState<boolean>(al?.ledState ?? false);
  const [current, setCurrent] = React.useState<number>(al?.current ?? 10);
  const [red, setRed] = React.useState<number>(al?.red ?? 0);
  const [green, setGreen] = React.useState<number>(al?.green ?? 0);
  const [blue, setBlue] = React.useState<number>(al?.blue ?? 0);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!al || busy) return;
    if (lastSyncedRef.current === al.lastReadAt) return;
    lastSyncedRef.current = al.lastReadAt;
    setLedState(al.ledState);
    setCurrent(al.current);
    setRed(al.red);
    setGreen(al.green);
    setBlue(al.blue);
  }, [al?.lastReadAt, al, busy]);

  const dirty = !al
    ? true
    : (ledState !== al.ledState || current !== al.current ||
       red !== al.red || green !== al.green || blue !== al.blue);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setAmbientLightingConfig({ ledState, current, red, green, blue });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshAmbientLightingConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = al?.lastReadAt
    ? new Date(al.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const swatch = `rgb(${red}, ${green}, ${blue})`;
  const channel = (val: number, set: (v: number) => void, label: string, accent: string) => (
    <div className="space-y-1">
      <label className="text-[10px] uppercase font-bold text-brand-muted block">{label} <span className="mono-text text-brand-ink">{val}</span></label>
      <input
        type="range" min={0} max={255} value={val}
        onChange={e => set(parseInt(e.target.value, 10))}
        disabled={!radioConnected || !ledState}
        className="w-full disabled:opacity-50"
        style={{ accentColor: accent }}
      />
    </div>
  );

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Ambient Lighting</h5>
            {al && (
              <span className={cn(
                'text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border',
                al.ledState
                  ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                  : 'text-brand-muted bg-brand-line border-brand-line',
              )}>
                {al.ledState ? 'On' : 'Off'}
              </span>
            )}
            {!al && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            Drives an onboard or attached WS2812/NeoPixel RGB LED. Only boards with the LED wired (e.g. some Heltec / RAK variants) will respond.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">LED on</p>
          <p className="text-[10px] text-brand-muted">Master switch — disables the color controls below when off.</p>
        </div>
        <input
          type="checkbox"
          checked={ledState}
          onChange={e => setLedState(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded border border-brand-line flex-shrink-0"
          style={{ background: ledState ? swatch : 'transparent' }}
          title={swatch}
        />
        <div className="flex-1 grid grid-cols-3 gap-3">
          {channel(red, setRed, 'Red', '#ef4444')}
          {channel(green, setGreen, 'Green', '#22c55e')}
          {channel(blue, setBlue, 'Blue', '#3b82f6')}
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">LED current <span className="mono-text text-brand-ink">{current}</span></label>
        <input
          type="number" min={0} max={255} value={current}
          onChange={e => setCurrent(Math.max(0, Math.min(255, parseInt(e.target.value, 10) || 0)))}
          disabled={!radioConnected || !ledState}
          className="w-full bg-brand-line text-xs mono-text rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
        <p className="text-[10px] text-brand-muted">Driver current register (board-specific; lower = dimmer). Leave at default if unsure.</p>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel ? `Last read: ${lastReadLabel}` : al ? 'Set by you (no readback yet)' : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Paxcounter module — count nearby WiFi / BLE devices (foot-traffic estimation)
// ----------------------------------------------------------------------------
function PaxcounterModuleCard({ radioConnected, px }: {
  radioConnected: boolean;
  px: import('../../types').PaxcounterModuleConfig | undefined;
}) {
  const [enabled, setEnabled] = React.useState<boolean>(px?.enabled ?? false);
  const [updateIntervalSecs, setUpdateIntervalSecs] = React.useState<number>(px?.updateIntervalSecs ?? 0);
  const [wifiThreshold, setWifiThreshold] = React.useState<number>(px?.wifiThreshold ?? 0);
  const [bleThreshold, setBleThreshold] = React.useState<number>(px?.bleThreshold ?? 0);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!px || busy) return;
    if (lastSyncedRef.current === px.lastReadAt) return;
    lastSyncedRef.current = px.lastReadAt;
    setEnabled(px.enabled);
    setUpdateIntervalSecs(px.updateIntervalSecs);
    setWifiThreshold(px.wifiThreshold);
    setBleThreshold(px.bleThreshold);
  }, [px?.lastReadAt, px, busy]);

  const dirty = !px
    ? true
    : (enabled !== px.enabled || updateIntervalSecs !== px.updateIntervalSecs ||
       wifiThreshold !== px.wifiThreshold || bleThreshold !== px.bleThreshold);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setPaxcounterConfig({ enabled, updateIntervalSecs, wifiThreshold, bleThreshold });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshPaxcounterConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = px?.lastReadAt
    ? new Date(px.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Paxcounter</h5>
            {px && (
              <span className={cn(
                'text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border',
                px.enabled
                  ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                  : 'text-brand-muted bg-brand-line border-brand-line',
              )}>
                {px.enabled ? 'Enabled' : 'Disabled'}
              </span>
            )}
            {!px && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            Counts nearby WiFi + BLE devices as a rough foot-traffic estimate and broadcasts the tally as telemetry. Privacy-preserving — it counts, it doesn't track. Repurposes the radio's WiFi/BLE, so it won't pair with a phone while active.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Paxcounter enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch — disables the controls below when off.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Interval (s)</label>
          <input
            type="number" min={0} max={86400} value={updateIntervalSecs}
            onChange={e => setUpdateIntervalSecs(Math.max(0, Math.min(86400, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">WiFi thresh</label>
          <input
            type="number" min={0} max={255} value={wifiThreshold}
            onChange={e => setWifiThreshold(Math.max(0, Math.min(255, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">BLE thresh</label>
          <input
            type="number" min={0} max={255} value={bleThreshold}
            onChange={e => setBleThreshold(Math.max(0, Math.min(255, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
      </div>
      <p className="text-[10px] text-brand-muted leading-snug">Interval 0 = firmware default. Thresholds 0 = firmware default; raise to ignore weak/distant signals.</p>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel ? `Last read: ${lastReadLabel}` : px ? 'Set by you (no readback yet)' : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Remote Hardware module — expose GPIO pins for read/write across the mesh
// ----------------------------------------------------------------------------
const REMOTE_HW_PIN_TYPE_OPTIONS = [
  { value: 0, label: 'Unknown / disabled' },
  { value: 1, label: 'Digital read (input)' },
  { value: 2, label: 'Digital write (output)' },
];

function RemoteHardwareModuleCard({ radioConnected, rh }: {
  radioConnected: boolean;
  rh: import('../../types').RemoteHardwareModuleConfig | undefined;
}) {
  const [enabled, setEnabled] = React.useState<boolean>(rh?.enabled ?? false);
  const [allowUndefined, setAllowUndefined] = React.useState<boolean>(rh?.allowUndefinedPinAccess ?? false);
  const [pins, setPins] = React.useState<import('../../types').RemoteHardwarePin[]>(rh?.availablePins ?? []);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!rh || busy) return;
    if (lastSyncedRef.current === rh.lastReadAt) return;
    lastSyncedRef.current = rh.lastReadAt;
    setEnabled(rh.enabled);
    setAllowUndefined(rh.allowUndefinedPinAccess);
    setPins(rh.availablePins);
  }, [rh?.lastReadAt, rh, busy]);

  const samePins = (a: import('../../types').RemoteHardwarePin[], b: import('../../types').RemoteHardwarePin[]) =>
    a.length === b.length && a.every((p, i) => p.gpioPin === b[i].gpioPin && p.name === b[i].name && p.type === b[i].type);
  const dirty = !rh
    ? true
    : (enabled !== rh.enabled || allowUndefined !== rh.allowUndefinedPinAccess || !samePins(pins, rh.availablePins));

  const addPin = () => setPins(p => [...p, { gpioPin: 0, name: '', type: 1 }]);
  const removePin = (i: number) => setPins(p => p.filter((_, idx) => idx !== i));
  const updatePin = (i: number, patch: Partial<import('../../types').RemoteHardwarePin>) =>
    setPins(p => p.map((pin, idx) => idx === i ? { ...pin, ...patch } : pin));

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setRemoteHardwareConfig({
      enabled,
      allowUndefinedPinAccess: allowUndefined,
      availablePins: pins,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshRemoteHardwareConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = rh?.lastReadAt
    ? new Date(rh.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Remote Hardware</h5>
            {rh && (
              <span className={cn(
                'text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border',
                rh.enabled
                  ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                  : 'text-brand-muted bg-brand-line border-brand-line',
              )}>
                {rh.enabled ? `Enabled · ${rh.availablePins.length} pin${rh.availablePins.length === 1 ? '' : 's'}` : 'Disabled'}
              </span>
            )}
            {!rh && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            Lets mesh peers read or toggle GPIO pins on this radio (e.g. mailbox-open sensor, gate latch). Each pin is whitelisted by name + type. <span className="text-brand-warning font-bold">Allowing undefined pin access</span> exposes <span className="italic">every</span> GPIO to anyone on the mesh — generally a bad idea.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Module enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch — disables every Remote Hardware control below when off.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-warning">Allow undefined pin access</p>
          <p className="text-[10px] text-brand-muted">Off (default) restricts access to the whitelist below. On = mesh peers can read/write any GPIO.</p>
        </div>
        <input
          type="checkbox"
          checked={allowUndefined}
          onChange={e => setAllowUndefined(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-amber-500"
        />
      </label>

      <div className="border-t border-brand-line pt-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Available pins</p>
          <button
            onClick={addPin}
            disabled={!radioConnected || !enabled}
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-accent hover:text-brand-ink border border-brand-accent/40 hover:border-brand-accent rounded px-2 py-1 transition-colors disabled:opacity-40"
          >
            <Plus size={10} /> Add pin
          </button>
        </div>
        {pins.length === 0 && (
          <p className="text-[11px] text-brand-muted italic">No pins whitelisted. Click <em>Add pin</em> to expose a GPIO to the mesh.</p>
        )}
        {pins.map((pin, i) => (
          <div key={i} className="flex items-center gap-2 bg-brand-bg/40 border border-brand-line rounded p-2">
            <div className="flex-1 grid grid-cols-[80px_1fr_180px] gap-2">
              <input
                type="number"
                min={0}
                max={64}
                value={pin.gpioPin}
                onChange={e => updatePin(i, { gpioPin: Math.max(0, Math.min(64, parseInt(e.target.value, 10) || 0)) })}
                disabled={!radioConnected || !enabled}
                placeholder="GPIO"
                className="bg-brand-line text-xs mono-text rounded px-2 py-1 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
              />
              <input
                type="text"
                maxLength={32}
                value={pin.name}
                onChange={e => updatePin(i, { name: e.target.value })}
                disabled={!radioConnected || !enabled}
                placeholder="Name (e.g. Mailbox)"
                className="bg-brand-line text-xs rounded px-2 py-1 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
              />
              <select
                value={pin.type}
                onChange={e => updatePin(i, { type: parseInt(e.target.value, 10) })}
                disabled={!radioConnected || !enabled}
                className="bg-brand-line text-xs rounded px-2 py-1 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
              >
                {REMOTE_HW_PIN_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <button
              onClick={() => removePin(i)}
              disabled={!radioConnected || !enabled}
              title="Remove pin"
              className="text-brand-muted hover:text-brand-error border border-brand-line hover:border-brand-error/40 rounded p-1 transition-colors disabled:opacity-40"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel ? `Last read: ${lastReadLabel}` : rh ? 'Set by you (no readback yet)' : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}



export default ModulesSection;
