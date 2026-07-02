/**
 * v2.1 — BbsSection + BbsServiceNodePicker + WeatherSubscribers + NumberInput
 * extracted from SettingsModal.tsx.
 *
 * Bundles the BBS config form, service-node picker, and live weather
 * subscribers list. Lazy-loaded so the BBS state machine + alert poller
 * UI only enters the bundle when Settings → BBS is opened.
 */
import React from 'react';
import { AlertCircle, Check, RefreshCw, Loader2 } from 'lucide-react';
import { useIsAdmin } from '../../hooks/useAuth';
import { meshDataService } from '../../services/meshDataService';
import { cn } from '../../lib/utils';

const API_BASE = import.meta.env.VITE_API_URL || '';

/** Local section header. Inline-duplicated per section. */
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h4 className="text-sm font-bold uppercase tracking-tight text-brand-ink">{title}</h4>
      <p className="text-[11px] text-brand-muted mt-0.5">{subtitle}</p>
    </div>
  );
}

interface BbsConfigShape {
  enabled: boolean;
  mailTrigger: string;
  weatherTrigger: string;
  cmdTrigger: string;
  bodyMaxChars: number;
  retentionDays: number;
  replyPaceMs: number;
  homeZipCode: string;
  /** Array of "HH:MM" push times. Empty disables daily push (NWS alerts still fire). */
  dailyForecastTimes: string[];
  // v3.0 Subscriber Services triggers + defaults. Each of the three
  // services (tides, sun/moon almanac, MD traffic) has an independent
  // trigger keyword and default-argument field so operators can
  // enable/disable / retarget each one without touching the others.
  spotTrigger: string;
  tideTrigger: string;
  defaultTideStation: string;
  sunTrigger: string;
  sunLocationZip: string;
  mdotTrigger: string;
  mdotDefaultCounty: string;
}

function BbsServiceNodePicker() {
  const isAdmin = useIsAdmin();
  const [radioId, setRadioId] = React.useState<string | null>(null);
  const [candidates, setCandidates] = React.useState<Array<{ radio_id: string; long_name: string; workspace_id: number | null }>>([]);
  const [loading, setLoading] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    const r = await meshDataService.getBbsServiceNode();
    setLoading(false);
    if (r) { setRadioId(r.radioId); setCandidates(r.candidates ?? []); }
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  const handleChange = async (value: string) => {
    const target = value === '' ? null : value;
    setMsg(null);
    const r = await meshDataService.setBbsServiceNode(target);
    if (!r.ok) { setMsg({ tone: 'err', text: r.error || 'Set failed' }); return; }
    setMsg({ tone: 'ok', text: target ? `BBS service running on "${target}".` : 'BBS service disabled — pick a radio to re-enable.' });
    refresh();
  };

  return (
    <div className="space-y-2 pb-2 border-b border-brand-line/60">
      <h4 className="text-xs font-bold uppercase tracking-widest text-brand-muted">BBS service radio</h4>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={radioId ?? ''}
          onChange={e => handleChange(e.target.value)}
          disabled={!isAdmin || loading}
          className="bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm mono-text focus:outline-none focus:border-brand-accent disabled:opacity-50"
        >
          <option value="">— None (BBS disabled) —</option>
          {candidates.map(r => (
            <option key={r.radio_id} value={r.radio_id}>
              {r.radio_id} — {r.long_name}
            </option>
          ))}
        </select>
        {radioId && (
          <span className="text-[10px] uppercase font-bold tracking-widest px-2 py-0.5 rounded bg-brand-accent/20 text-brand-accent border border-brand-accent/40">
            Active
          </span>
        )}
      </div>
      {msg && (
        <div className={cn(
          'flex items-start gap-2 rounded border text-[11px] px-2 py-1.5',
          msg.tone === 'ok'
            ? 'border-brand-accent/40 bg-brand-accent/10 text-brand-accent'
            : 'border-red-500/40 bg-red-500/10 text-red-300',
        )}>
          {msg.tone === 'ok' ? <Check size={11} className="mt-0.5" /> : <AlertCircle size={11} className="mt-0.5" />}
          <span>{msg.text}</span>
        </div>
      )}
      <p className="text-[10px] text-brand-muted leading-snug pt-1">
        One radio install-wide handles BBS commands (<code className="text-brand-accent">:mail</code> / <code className="text-brand-accent">:wx</code> / <code className="text-brand-accent">:cmd</code>) and the weather alert / daily forecast push.
        Existing BBS mail + weather subscribers automatically re-stamp to the new radio so the history follows.
        Other radios stay as normal operator endpoints — BBS commands sent to them land as plain DMs.
        {!isAdmin && <span className="block mt-1 italic">Read-only for viewers — ask an admin to change.</span>}
      </p>
    </div>
  );
}

// v2.1: types previously defined between sections (used by BbsSection +
// AiSection). They were inadvertently swept along with the
// DataSection / DiskSection extractions; live here until each owning
// section gets its own extraction.
interface BbsConfigShape {
  enabled: boolean;
  mailTrigger: string;
  weatherTrigger: string;
  cmdTrigger: string;
  bodyMaxChars: number;
  retentionDays: number;
  replyPaceMs: number;
  homeZipCode: string;
  /** Array of "HH:MM" push times. Empty disables daily push (NWS alerts still fire). */
  dailyForecastTimes: string[];
  // v3.0 Subscriber Services triggers + defaults. Each of the three
  // services (tides, sun/moon almanac, MD traffic) has an independent
  // trigger keyword and default-argument field so operators can
  // enable/disable / retarget each one without touching the others.
  spotTrigger: string;
  tideTrigger: string;
  defaultTideStation: string;
  sunTrigger: string;
  sunLocationZip: string;
  mdotTrigger: string;
  mdotDefaultCounty: string;
}

type AIProvider = 'anthropic' | 'gemini' | 'ollama';

interface AIConfig {
  enabled: boolean;
  provider: AIProvider;
  anthropicModel: string;
  geminiModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  redactPii: boolean;
  hasAnthropicKey: boolean;
  hasGeminiKey: boolean;
  anthropicKeyHint: string;
  geminiKeyHint: string;
}

interface OllamaModelInfo {
  name: string;
  sizeBytes: number | null;
  parameterSize: string | null;
  quantization: string | null;
}

function formatOllamaModelLabel(m: OllamaModelInfo): string {
  const parts: string[] = [m.name];
  if (m.parameterSize) parts.push(m.parameterSize);
  if (m.sizeBytes != null) {
    const gib = m.sizeBytes / (1024 ** 3);
    parts.push(`${gib.toFixed(1)} GB`);
  }
  return parts.join(' · ');
}


function BbsSection() {
  const [cfg, setCfg] = React.useState<BbsConfigShape | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    fetch(`${API_BASE}/api/mesh/bbs/config`)
      .then(r => r.json())
      .then((c: BbsConfigShape) => setCfg(c))
      .catch(err => setError(err?.message || 'Failed to load BBS config'))
      .finally(() => setLoading(false));
  }, []);

  const update = <K extends keyof BbsConfigShape>(key: K, val: BbsConfigShape[K]) => {
    setCfg(prev => prev ? { ...prev, [key]: val } : prev);
  };

  // Trigger validation: must start with `:`, 2-16 chars, lowercase alnum/-/_.
  const validateTrigger = (t: string): string | null => {
    if (!t.startsWith(':')) return 'Must start with ":"';
    if (t.length < 2 || t.length > 16) return '2-16 characters';
    if (!/^:[a-z0-9_-]+$/.test(t)) return 'Lowercase letters, digits, - or _ only';
    return null;
  };

  const mailErr = cfg ? validateTrigger(cfg.mailTrigger) : null;
  const weatherErr = cfg ? validateTrigger(cfg.weatherTrigger) : null;
  const cmdErr = cfg ? validateTrigger(cfg.cmdTrigger) : null;
  const triggersIdentical = cfg
    ? cfg.mailTrigger === cfg.weatherTrigger
      || cfg.mailTrigger === cfg.cmdTrigger
      || cfg.weatherTrigger === cfg.cmdTrigger
    : false;
  const zipErr = cfg && cfg.homeZipCode && !/^\d{5}$/.test(cfg.homeZipCode)
    ? 'Must be exactly 5 digits (or empty)'
    : null;
  // v2.0 Beta 5: array of HH:MM 24-hour push times. The Settings UI
  // edits this as a comma-separated text field; each entry must parse.
  // Empty array = daily push disabled (NWS alerts still fire).
  const timeErr = cfg && (() => {
    const list = cfg.dailyForecastTimes ?? [];
    const bad = list.find(t => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t));
    return bad ? `"${bad}" isn't a valid HH:MM time` : null;
  })();

  const canSave = cfg && !mailErr && !weatherErr && !cmdErr && !triggersIdentical && !zipErr && !timeErr;

  const handleSave = async () => {
    if (!cfg || !canSave) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await fetch(`${API_BASE}/api/mesh/bbs/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = await res.json() as { config: BbsConfigShape };
      setCfg(body.config); // server may have normalized values
      setSaved(true);
      setTimeout(() => setSaved(false), 2_000);
    } catch (err: any) {
      setError(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-brand-muted">
        <Loader2 size={14} className="animate-spin" />
        Loading BBS configuration…
      </div>
    );
  }

  if (!cfg) {
    return (
      <div className="text-sm text-brand-error">
        Failed to load BBS configuration{error ? `: ${error}` : '.'}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h3 className="text-base font-bold tracking-tight uppercase">BBS Mail &amp; Weather</h3>
        <p className="text-xs text-brand-muted leading-snug mt-1">
          Configure the bulletin-board state machine that handles inbound <code className="text-brand-accent">:</code>-prefixed
          DMs to your local node. Trigger keywords are matched case-insensitively. All changes apply immediately —
          no radio restart needed.
        </p>
      </div>

      {/* Master switch */}
      <div className="technical-panel p-4 space-y-3">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={e => update('enabled', e.target.checked)}
            className="w-4 h-4 accent-brand-accent"
          />
          <div>
            <div className="text-sm font-bold uppercase tracking-tight">BBS Enabled</div>
            <div className="text-[10px] text-brand-muted mt-0.5">
              When off, all BBS triggers are ignored and incoming :mail / :weather DMs flow through to the normal message log.
            </div>
          </div>
        </label>
      </div>

      {/* Triggers */}
      <div className="space-y-3">
        <h4 className="text-xs font-bold uppercase tracking-widest text-brand-muted">Trigger Keywords</h4>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Mail trigger</label>
            <input
              type="text"
              value={cfg.mailTrigger}
              onChange={e => update('mailTrigger', e.target.value.toLowerCase())}
              placeholder=":mail"
              className={cn(
                "w-full bg-brand-line/50 border rounded px-2 py-1.5 text-sm mono-text focus:outline-none",
                mailErr ? "border-brand-error" : "border-brand-line focus:border-brand-accent"
              )}
            />
            {mailErr && <div className="text-[10px] text-brand-error">{mailErr}</div>}
          </div>
          <div className="space-y-1">
            <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Weather trigger</label>
            <input
              type="text"
              value={cfg.weatherTrigger}
              onChange={e => update('weatherTrigger', e.target.value.toLowerCase())}
              placeholder=":wx"
              className={cn(
                "w-full bg-brand-line/50 border rounded px-2 py-1.5 text-sm mono-text focus:outline-none",
                weatherErr ? "border-brand-error" : "border-brand-line focus:border-brand-accent"
              )}
            />
            {weatherErr && <div className="text-[10px] text-brand-error">{weatherErr}</div>}
            {/* v2.0 Beta 5 BBS (alias): :wx ↔ :weather always work as
                aliases for each other regardless of which one is saved
                here, so a subscriber's muscle memory keeps working when
                you (or a co-admin) rename the trigger. */}
            <div className="text-[10px] text-brand-muted leading-relaxed">
              {cfg.weatherTrigger === ':wx'
                ? <><code className="text-brand-accent">:weather</code> also works as an alias.</>
                : cfg.weatherTrigger === ':weather'
                ? <><code className="text-brand-accent">:wx</code> also works as an alias.</>
                : <>Built-in aliases <code className="text-brand-accent">:wx</code> and <code className="text-brand-accent">:weather</code> both route here.</>}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Command index</label>
            <input
              type="text"
              value={cfg.cmdTrigger}
              onChange={e => update('cmdTrigger', e.target.value.toLowerCase())}
              placeholder=":cmd"
              className={cn(
                "w-full bg-brand-line/50 border rounded px-2 py-1.5 text-sm mono-text focus:outline-none",
                cmdErr ? "border-brand-error" : "border-brand-line focus:border-brand-accent"
              )}
            />
            {cmdErr && <div className="text-[10px] text-brand-error">{cmdErr}</div>}
          </div>
        </div>
        {triggersIdentical && (
          <div className="text-[11px] text-brand-error flex items-center gap-1.5">
            <AlertCircle size={11} /> Triggers must all be different.
          </div>
        )}
        <p className="text-[10px] text-brand-muted leading-snug">
          DMing the command-index trigger returns a one-packet list of every
          active root (e.g. <code className="text-brand-accent">{cfg.cmdTrigger}</code> → <code className="text-brand-accent">Cmds: {cfg.mailTrigger} {cfg.weatherTrigger} {cfg.cmdTrigger}</code>) — classic BBS discoverability.
        </p>
      </div>

      {/* Limits */}
      <div className="space-y-3">
        <h4 className="text-xs font-bold uppercase tracking-widest text-brand-muted">Limits</h4>
        <div className="grid grid-cols-3 gap-3">
          <NumberInput
            label="Body cap (chars)"
            value={cfg.bodyMaxChars}
            min={50}
            max={228}
            onChange={v => update('bodyMaxChars', v)}
            hint="50-228 (default 200)"
          />
          <NumberInput
            label="Retention (days)"
            value={cfg.retentionDays}
            min={1}
            max={365}
            onChange={v => update('retentionDays', v)}
            hint="1-365 (default 30)"
          />
          <NumberInput
            label="Reply pace (ms)"
            value={cfg.replyPaceMs}
            min={0}
            max={10_000}
            step={100}
            onChange={v => update('replyPaceMs', v)}
            hint="0-10000 (default 2000)"
          />
        </div>
      </div>

      {/* v2.0 Beta 5 Phase 2: BBS service node picker — install-wide
          choice of which radio runs BBS commands + the weather poller.
          Admin-only; viewers see the current value disabled. */}
      <BbsServiceNodePicker />

      {/* Home ZIP + weather */}
      <div className="space-y-3">
        <h4 className="text-xs font-bold uppercase tracking-widest text-brand-muted">Home Weather Alerts</h4>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Home ZIP code</label>
          <input
            type="text"
            value={cfg.homeZipCode}
            onChange={e => update('homeZipCode', e.target.value.replace(/\D/g, '').slice(0, 5))}
            placeholder="(empty = no alerts)"
            inputMode="numeric"
            className={cn(
              "w-32 bg-brand-line/50 border rounded px-2 py-1.5 text-sm mono-text focus:outline-none",
              zipErr ? "border-brand-error" : "border-brand-line focus:border-brand-accent"
            )}
          />
          {zipErr && <div className="text-[10px] text-brand-error">{zipErr}</div>}
          <p className="text-[10px] text-brand-muted leading-snug pt-1">
            When set, the server polls the National Weather Service every 20 minutes for active alerts
            (warnings, watches, advisories) at this ZIP. New alerts post to the Event Log as <span className="text-brand-error font-bold">WEATHER_ALERT</span> entries,
            trigger a browser notification if you've granted permission, AND get pushed to every node that
            subscribed via <code className="text-brand-accent">:weather subscribe</code>. Leave empty to disable.
            The on-demand <code className="text-brand-accent">:weather</code> command works regardless.
          </p>
        </div>

        {/* Daily forecast push */}
        <div className="space-y-1 pt-2 border-t border-brand-line/40">
          <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Daily forecast push times</label>
          <div className="flex items-center gap-2 flex-wrap">
            {/* v2.0 Beta 5: comma-separated list of HH:MM times. Each
                entry fires once per day. Default '07:30, 12:00, 17:30'
                (morning, midday, evening). Empty = daily push off,
                NWS alerts still fire. */}
            <input
              type="text"
              value={(cfg.dailyForecastTimes ?? []).join(', ')}
              onChange={e => {
                // Split on comma, trim, drop empties. Validation runs in
                // timeErr above — bad entries show the error inline and
                // disable Save. We keep the raw split here so the user
                // can type "07:30, 12:" without us erasing their input
                // mid-edit.
                const parts = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                update('dailyForecastTimes' as any, parts as any);
              }}
              placeholder="07:30, 12:00, 17:30"
              className={cn(
                "w-56 bg-brand-line/50 border rounded px-2 py-1.5 text-sm mono-text focus:outline-none",
                timeErr ? "border-brand-error" : "border-brand-line focus:border-brand-accent"
              )}
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  const r = await fetch(`${API_BASE}/api/mesh/bbs/weather/test-forecast`, { method: 'POST' });
                  const b = await r.json().catch(() => ({}));
                  if (!r.ok) {
                    setError(b.error || `HTTP ${r.status}`);
                  } else {
                    setError('');
                    setSaved(true);
                    setTimeout(() => setSaved(false), 3000);
                  }
                } catch (err: any) {
                  setError(err?.message || 'Test send failed');
                }
              }}
              disabled={!cfg.homeZipCode || !cfg.enabled}
              title={cfg.homeZipCode ? 'Send the daily forecast to all subscribers now' : 'Set a home ZIP first'}
              className="text-[10px] font-bold uppercase tracking-widest px-2 py-1.5 rounded border border-brand-accent/40 text-brand-accent hover:bg-brand-accent/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Send test
            </button>
          </div>
          {timeErr && <div className="text-[10px] text-brand-error">{timeErr}</div>}
          <p className="text-[10px] text-brand-muted leading-snug pt-1">
            Comma-separated list of <code className="text-brand-accent">HH:MM</code> times in 24-hour <strong>server-local time</strong> (set via <code className="text-brand-accent">TZ</code> in docker-compose).
            Each entry fires once per day and DMs the current NWS forecast for your home ZIP to every
            <code className="text-brand-accent"> :weather subscribe</code>d node (also reachable via <code className="text-brand-accent">:wx subscribe</code> — same flow).
            Sender shown as <code className="text-brand-accent">FX</code> for forecast vs <code className="text-brand-accent">WX</code> for alert.
            Leave empty to disable daily push (NWS alerts still fire). Requires Home ZIP above to be set.
          </p>
        </div>
      </div>

      <WeatherSubscribers />

      {/* v3.0 Subscriber Services — content commands beyond weather.
          Each row: trigger keyword + default argument (station id /
          ZIP / county). Blank default = subscribers can still query
          the service by supplying an argument, but the no-arg form
          is disabled with an operator-friendly error message. */}
      <SubscriberServicesBlock cfg={cfg} update={update} />

      {error && (
        <div className="px-3 py-2 rounded border border-brand-error/30 bg-brand-error/10 text-xs text-brand-error flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-brand-line">
        {saved && (
          <span className="text-xs text-brand-accent flex items-center gap-1.5">
            <Check size={12} /> Saved
          </span>
        )}
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="bg-brand-accent text-black px-4 py-1.5 rounded text-xs font-bold uppercase tracking-widest hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {saving ? 'Saving…' : 'Save BBS Config'}
        </button>
      </div>
    </div>
  );
}

interface WeatherSubscriber {
  nodeId: string;
  subscribedAt: number;
  channelIndex: number;
  lastAlertAt: number | null;
  /** v2.0 multi-radio: which radio received this subscription. NULL for
   *  legacy 1.x rows that pre-date the multi-radio split. */
  radioId: string | null;
}

/**
 * v3.0 Subscriber Services — settings block exposing trigger keyword
 * + default argument for each of the three content commands:
 *
 *   :tide   → tide predictions (NOAA CO-OPS)
 *   :sun    → sun/moon almanac (offline via SunCalc)
 *   :mdot   → Maryland CHART traffic incidents
 *
 * Each service has:
 *   - A trigger text input (e.g. ":tide" — must start with colon)
 *   - A default-argument input (station id / ZIP / county). Empty
 *     disables the no-arg form; subscribers can still supply an
 *     argument explicitly.
 *
 * Default-argument fields validate loosely at the client (right
 * format hint) and strictly at the server (sanitizer rejects bad
 * values back to empty rather than saving a broken default that
 * would silently mislead subscribers).
 */
// v3.0: Maryland county names as CHART returns them, duplicated
// client-side to feed the county dropdown. Keep in sync with
// server/bbsConfig.ts MD_COUNTIES — drift is unlikely (24 counties
// don't change often) so a shared module would be over-engineering.
const MD_COUNTY_OPTIONS: readonly string[] = [
  'Allegany', 'Anne Arundel', 'Baltimore', 'Baltimore City',
  'Calvert', 'Caroline', 'Carroll', 'Cecil', 'Charles',
  'Dorchester', 'Frederick', 'Garrett', 'Harford', 'Howard',
  'Kent', 'Montgomery', "Prince George's", "Queen Anne's",
  'Somerset', "St. Mary's", 'Talbot', 'Washington',
  'Wicomico', 'Worcester',
];

function SubscriberServicesBlock({
  cfg,
  update,
}: {
  cfg: BbsConfigShape;
  update: <K extends keyof BbsConfigShape>(key: K, value: BbsConfigShape[K]) => void;
}) {
  // Loose validation hints — server sanitizer is authoritative.
  const tideStationErr = cfg.defaultTideStation && !/^\d{7}$/.test(cfg.defaultTideStation)
    ? '7-digit NOAA CO-OPS station id (e.g. 8574680)'
    : null;
  const sunZipErr = cfg.sunLocationZip && !/^\d{5}$/.test(cfg.sunLocationZip)
    ? '5-digit US ZIP'
    : null;

  return (
    <div className="space-y-4 pt-4 border-t border-brand-line/60">
      <SectionHeader
        title="Subscriber Services (v3.0)"
        subtitle="Content commands beyond weather — subscribers DM these to the BBS for tide predictions, sun/moon times, and MD traffic."
      />

      {/* Row: :tide */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-3 border-b border-brand-line/40">
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Tide trigger</label>
          <input
            type="text"
            value={cfg.tideTrigger}
            onChange={e => update('tideTrigger', e.target.value.toLowerCase())}
            placeholder=":tide"
            className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm mono-text focus:outline-none focus:border-brand-accent"
          />
          <p className="text-[10px] text-brand-muted leading-snug">
            NOAA tide predictions. Subscribers DM this trigger to get the next few high/low events.
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Default tide station</label>
          <input
            type="text"
            value={cfg.defaultTideStation}
            onChange={e => update('defaultTideStation', e.target.value.replace(/\D/g, '').slice(0, 7))}
            placeholder="8574680"
            inputMode="numeric"
            className={cn(
              "w-full bg-brand-line/50 border rounded px-2 py-1.5 text-sm mono-text focus:outline-none",
              tideStationErr ? "border-brand-error" : "border-brand-line focus:border-brand-accent",
            )}
          />
          {tideStationErr && <div className="text-[10px] text-brand-error">{tideStationErr}</div>}
          <p className="text-[10px] text-brand-muted leading-snug">
            7-digit NOAA CO-OPS station id. Chesapeake examples: <span className="mono-text">8574680</span> Baltimore, <span className="mono-text">8575512</span> Annapolis, <span className="mono-text">8577330</span> Solomons Island. Refreshed at 00:00, 06:00, 12:00, 18:00 server-local. Empty disables the no-arg form.
          </p>
        </div>
      </div>

      {/* Row: :sun */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-3 border-b border-brand-line/40">
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Sun trigger</label>
          <input
            type="text"
            value={cfg.sunTrigger}
            onChange={e => update('sunTrigger', e.target.value.toLowerCase())}
            placeholder=":sun"
            className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm mono-text focus:outline-none focus:border-brand-accent"
          />
          <p className="text-[10px] text-brand-muted leading-snug">
            Offline sun/moon almanac — sunrise, sunset, twilight, moon phase. No internet needed.
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Default sun ZIP</label>
          <input
            type="text"
            value={cfg.sunLocationZip}
            onChange={e => update('sunLocationZip', e.target.value.replace(/\D/g, '').slice(0, 5))}
            placeholder="21701"
            inputMode="numeric"
            className={cn(
              "w-full bg-brand-line/50 border rounded px-2 py-1.5 text-sm mono-text focus:outline-none",
              sunZipErr ? "border-brand-error" : "border-brand-line focus:border-brand-accent",
            )}
          />
          {sunZipErr && <div className="text-[10px] text-brand-error">{sunZipErr}</div>}
          <p className="text-[10px] text-brand-muted leading-snug">
            5-digit US ZIP for the no-arg <code className="text-brand-accent">:sun</code> form. Subscribers can also send <code className="text-brand-accent">:sun 90210</code> or <code className="text-brand-accent">:sun 39.42,-77.41</code> to override. Empty disables the no-arg form.
          </p>
        </div>
      </div>

      {/* Row: :mdot */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">MDOT trigger</label>
          <input
            type="text"
            value={cfg.mdotTrigger}
            onChange={e => update('mdotTrigger', e.target.value.toLowerCase())}
            placeholder=":mdot"
            className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm mono-text focus:outline-none focus:border-brand-accent"
          />
          <p className="text-[10px] text-brand-muted leading-snug">
            Maryland CHART traffic incident lookup. 5-minute server-side cache; API is free + no auth.
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">Default MDOT county</label>
          <select
            value={cfg.mdotDefaultCounty}
            onChange={e => update('mdotDefaultCounty', e.target.value)}
            className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm mono-text focus:outline-none focus:border-brand-accent"
          >
            <option value="">— Statewide (no filter) —</option>
            {MD_COUNTY_OPTIONS.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <p className="text-[10px] text-brand-muted leading-snug">
            Filters incidents to one Maryland county for the no-arg <code className="text-brand-accent">:mdot</code> form. Subscribers can send <code className="text-brand-accent">:mdot Baltimore</code> or <code className="text-brand-accent">:mdot all</code> to override.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Lists nodes that have DM'd `:weather subscribe` and gives the operator a
 * remove button per row. Subscribers add/remove themselves over the air; this
 * panel is purely management visibility for the operator.
 */
function WeatherSubscribers() {
  const [subs, setSubs] = React.useState<WeatherSubscriber[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [removing, setRemoving] = React.useState<string | null>(null);
  /** v2.1: BBS bridge's local node id. Used to flag self-subscribed
   *  rows in the list so the operator understands why those alerts
   *  show up in the inbox but not as device-level DMs. */
  const [bbsLocalNodeId, setBbsLocalNodeId] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/mesh/bbs/weather/subscribers`);
      if (!res.ok) return;
      const body = await res.json() as { subscribers: WeatherSubscriber[] };
      setSubs(body.subscribers);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
    // Fetch the BBS bridge's local node id once on mount so the
    // self-subscribed badge can render. Pre-Beta-5 builds returned
    // no localNodeId; we tolerate null by simply not flagging anyone.
    meshDataService.getBbsServiceNode().then(info => {
      setBbsLocalNodeId(info?.localNodeId ?? null);
    });
    // Re-fetch on SSE bbsSubscriber events so the panel updates live as
    // remote nodes subscribe / unsubscribe over the air.
    const es = new EventSource(`${API_BASE}/api/mesh/stream`);
    es.addEventListener('bbsSubscriber', () => { refresh(); });
    return () => es.close();
  }, [refresh]);

  // Count self-subscribed rows so we can show a banner explaining the
  // mail-only behavior when at least one exists.
  const selfSubscribedCount = bbsLocalNodeId
    ? subs.filter(s => s.nodeId === bbsLocalNodeId).length
    : 0;

  const handleRemove = async (nodeId: string) => {
    setRemoving(nodeId);
    try {
      await fetch(`${API_BASE}/api/mesh/bbs/weather/subscribers/${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
      await refresh();
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-bold uppercase tracking-widest text-brand-muted">
          Subscribers ({subs.length})
        </h4>
        <button
          onClick={refresh}
          className="text-[10px] mono-text uppercase tracking-widest text-brand-muted hover:text-brand-accent flex items-center gap-1 transition-colors"
          disabled={loading}
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
      {/* v2.1: when the operator is also subscribed via the same radio
          that hosts the BBS, explain that no device-level DM arrives
          for self-subscribed rows — Meshtastic firmware silently
          absorbs self-DMs. The mail row still persists so dashboard
          users see the alert; this banner tells the operator why
          their phone never buzzed. */}
      {selfSubscribedCount > 0 && (
        <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
          <span>
            <strong>{selfSubscribedCount === 1 ? 'One subscriber is' : `${selfSubscribedCount} subscribers are`} the BBS radio's own local node.</strong>
            {' '}Meshtastic firmware doesn't deliver self-DMs, so alerts won't arrive on those devices. The dashboard BBS Mail inbox + Event Log still show them. To receive over-the-air DMs, subscribe from a different node.
          </span>
        </div>
      )}
      {subs.length === 0 ? (
        <p className="text-[11px] text-brand-muted italic">
          No subscribers yet. Remote nodes can opt in by DMing <code className="text-brand-accent">:wx subscribe</code> (or <code className="text-brand-accent">:weather subscribe</code>) to your node.
        </p>
      ) : (
        <div className="border border-brand-line rounded overflow-hidden">
          {subs.map(s => {
            const isSelf = !!bbsLocalNodeId && s.nodeId === bbsLocalNodeId;
            return (
              <div
                key={s.nodeId}
                className="flex items-center gap-2 px-2 py-1.5 text-xs border-b border-brand-line/40 last:border-b-0 hover:bg-brand-line/30 transition-colors"
              >
                <span className="mono-text text-brand-ink shrink-0 w-28">{s.nodeId}</span>
                <span className="mono-text text-[10px] text-brand-muted shrink-0">ch{s.channelIndex}</span>
                {isSelf && (
                  <span
                    className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300 bg-amber-500/10 shrink-0"
                    title="This subscriber is the BBS radio's own local node — alerts land in the inbox but firmware absorbs the self-DM, so no device notification."
                  >
                    self
                  </span>
                )}
                <span className="text-[10px] text-brand-muted flex-1 truncate">
                  subscribed {relTime(s.subscribedAt)}
                  {s.lastAlertAt && ` · last alert ${relTime(s.lastAlertAt)}`}
                </span>
                <button
                  onClick={() => handleRemove(s.nodeId)}
                  disabled={removing === s.nodeId}
                  className="text-[10px] mono-text uppercase tracking-widest text-brand-muted hover:text-brand-error transition-colors disabled:opacity-40"
                  title="Remove this subscriber"
                >
                  {removing === s.nodeId ? '…' : 'Remove'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function NumberInput({ label, value, min, max, step = 1, onChange, hint }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">{label}</label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={e => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm mono-text focus:outline-none focus:border-brand-accent"
      />
      {hint && <div className="text-[9px] text-brand-muted mono-text tracking-widest">{hint}</div>}
    </div>
  );
}

// ============================================================================
// Users (v2.0 Beta 5 Phase 3 — admin management of accounts)
// ============================================================================

interface UserRow {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  createdAt: number;
  lastLoginAt: number | null;
  locked: number;
}


export default BbsSection;
