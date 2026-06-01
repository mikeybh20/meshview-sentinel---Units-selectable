import express from 'express';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import dotenv from 'dotenv';
import { serialDiscovery } from './serialDiscovery.js';
import { meshBridge } from './meshtasticSerial.js';
import { meshDb } from './database.js';
// BbsService is no longer instantiated here in v2.0 — see [bridgeManager.ts](./bridgeManager.ts)
// which owns one BbsService per RadioContext. api.ts just plumbs config + endpoints.
import { loadBbsConfig, saveBbsConfig, normalizeBbsConfig, type BbsConfig } from './bbsConfig.js';
import { WeatherAlertPoller } from './weatherAlertPoller.js';
// v2.0 multi-radio. Importing for side effect: BridgeManager wires its
// auto-registration listeners onto meshBridge at module load. The exported
// singleton is also used by the /api/mesh/radios endpoint below.
import { bridgeManager, testTransportConnection } from './bridgeManager.js';
// v2.0 GPU sidecar boot probe. Logs sidecar reachability + detected GPU
// at startup so the operator immediately knows their acceleration tier.
import { probeGpuOnBoot, health as gpuHealth, clusterDbscan, buildTopology, buildHeatmap, simplifyTrace, routeStability } from './gpuClient.js';
import { sealBackup, openBackup } from './backup.js';
import { mdnsDiscovery } from './mdnsDiscovery.js';
probeGpuOnBoot();
mdnsDiscovery.start();

// v2.0 multi-radio: BbsService is instantiated per RadioContext inside
// BridgeManager.attachBbs() (default radio on auto-register, secondaries
// on spawn). api.ts only owns the shared BBS config + the weather poller.
//
// Load persisted BBS config and hand it to BridgeManager — it fans out to
// every BbsService now and on every subsequent save.
let bbsConfig: BbsConfig = loadBbsConfig();
bridgeManager.setBbsConfig(bbsConfig);

// Weather alert poller — starts immediately. The first poll fires ~10s after
// boot so the radio has time to settle; the ticker reads from bbsConfig each
// cycle so it picks up zip / enabled changes without restarting.
const weatherPoller = new WeatherAlertPoller(bridgeManager, () => bbsConfig);
weatherPoller.start();

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

// --- Serve built frontend in production ---
const distPath = join(__dirname, '..', 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
}

// =============================================
// AI Provider Configuration (persisted to file)
// =============================================
type AIProvider = 'anthropic' | 'gemini' | 'ollama';

interface AIConfig {
  /**
   * Master switch. When false, the AI Assistant launcher is hidden from the
   * dashboard and /api/ai/chat returns 503. Keys / models / preferences stay
   * persisted so flipping it back on doesn't require re-entering anything.
   * Defaults to false so fresh installs don't surface the feature until the
   * operator explicitly opts in.
   */
  enabled: boolean;
  provider: AIProvider;
  anthropicKey: string;
  geminiKey: string;
  anthropicModel: string;
  geminiModel: string;
  /** Base URL of an Ollama server (e.g. http://host.docker.internal:11434). No trailing slash. */
  ollamaBaseUrl: string;
  /** Ollama model tag (e.g. "llama3.1:8b", "qwen2.5:14b"). */
  ollamaModel: string;
  /**
   * When true, the AI Assistant strips node identifiers, names, and message
   * content from the system prompt and ships only aggregate counts.
   * Operators on third-party providers (Anthropic / Gemini) can use this to
   * keep mesh PII out of the cloud. The server itself does NOT enforce this
   * (the redaction happens client-side before the request), but we persist
   * the preference here so it's consistent across browser sessions / tabs.
   */
  redactPii: boolean;
}

const dataDir = join(__dirname, '..', 'data');
try {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
} catch { /* ok */ }
const CONFIG_PATH = join(dataDir, 'ai-config.json');

function loadConfig(): AIConfig {
  const defaults: AIConfig = {
    enabled: false,
    provider: 'anthropic',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    geminiKey: process.env.GEMINI_API_KEY || '',
    anthropicModel: 'claude-sonnet-4-20250514',
    geminiModel: 'gemini-3-flash-preview',
    // Inside Docker, `host.docker.internal` resolves to the host (with the
    // host-gateway alias declared in docker-compose.yml). Operators running
    // bare metal can override this in Settings → AI.
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434',
    ollamaModel: process.env.OLLAMA_MODEL || '',
    redactPii: false,
  };

  try {
    if (existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      return { ...defaults, ...saved };
    }
  } catch { /* use defaults */ }

  // Auto-detect provider from available keys
  if (!defaults.anthropicKey && defaults.geminiKey) {
    defaults.provider = 'gemini';
  }

  return defaults;
}

function saveConfig(cfg: AIConfig) {
  // Never persist keys to disk with the raw value visible — store them
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

let aiConfig = loadConfig();

function getAnthropicClient(): Anthropic | null {
  if (!aiConfig.anthropicKey) return null;
  return new Anthropic({ apiKey: aiConfig.anthropicKey });
}

function getGeminiClient(): any | null {
  if (!aiConfig.geminiKey) return null;
  return new GoogleGenAI({ apiKey: aiConfig.geminiKey });
}

// --- AI Config API ---
app.get('/api/ai/config', (_req, res) => {
  return res.json({
    enabled: aiConfig.enabled,
    provider: aiConfig.provider,
    anthropicModel: aiConfig.anthropicModel,
    geminiModel: aiConfig.geminiModel,
    ollamaBaseUrl: aiConfig.ollamaBaseUrl,
    ollamaModel: aiConfig.ollamaModel,
    redactPii: aiConfig.redactPii,
    hasAnthropicKey: !!aiConfig.anthropicKey,
    hasGeminiKey: !!aiConfig.geminiKey,
    // Mask keys — show last 4 chars only
    anthropicKeyHint: aiConfig.anthropicKey ? `...${aiConfig.anthropicKey.slice(-4)}` : '',
    geminiKeyHint: aiConfig.geminiKey ? `...${aiConfig.geminiKey.slice(-4)}` : '',
  });
});

app.post('/api/ai/config', (req, res) => {
  const {
    enabled,
    provider,
    anthropicKey, geminiKey,
    anthropicModel, geminiModel,
    ollamaBaseUrl, ollamaModel,
    redactPii,
  } = req.body;

  if (typeof enabled === 'boolean') aiConfig.enabled = enabled;
  if (provider === 'anthropic' || provider === 'gemini' || provider === 'ollama') {
    aiConfig.provider = provider;
  }
  if (anthropicKey !== undefined) aiConfig.anthropicKey = anthropicKey;
  if (geminiKey !== undefined) aiConfig.geminiKey = geminiKey;
  if (anthropicModel) aiConfig.anthropicModel = anthropicModel;
  if (geminiModel) aiConfig.geminiModel = geminiModel;
  if (typeof ollamaBaseUrl === 'string') {
    aiConfig.ollamaBaseUrl = ollamaBaseUrl.replace(/\/+$/, ''); // strip trailing slashes
  }
  if (typeof ollamaModel === 'string') aiConfig.ollamaModel = ollamaModel.trim();
  if (typeof redactPii === 'boolean') aiConfig.redactPii = redactPii;

  saveConfig(aiConfig);
  console.log(`[AI Config] Enabled: ${aiConfig.enabled}, Provider: ${aiConfig.provider}, Anthropic key: ${aiConfig.anthropicKey ? 'SET' : 'EMPTY'}, Gemini key: ${aiConfig.geminiKey ? 'SET' : 'EMPTY'}, Ollama: ${aiConfig.ollamaBaseUrl || 'unset'} / ${aiConfig.ollamaModel || 'no-model'}`);

  return res.json({ ok: true, enabled: aiConfig.enabled, provider: aiConfig.provider });
});

// --- Ollama: list available models on a remote/local server ---
// Operators use this to populate the Settings dropdown without typing tags.
app.get('/api/ai/ollama/tags', async (req, res) => {
  // Allow probing a candidate URL via ?baseUrl=… so the UI can preview-test
  // before saving config. Otherwise fall back to the persisted setting.
  const probeUrl = typeof req.query.baseUrl === 'string'
    ? String(req.query.baseUrl).replace(/\/+$/, '')
    : aiConfig.ollamaBaseUrl;
  if (!probeUrl) return res.status(400).json({ error: 'No Ollama base URL configured' });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const upstream = await fetch(`${probeUrl}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      return res.status(502).json({ error: `Ollama returned ${upstream.status}: ${txt.slice(0, 200)}` });
    }
    const body = await upstream.json() as { models?: Array<{ name?: string; model?: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }> };
    const models = (body.models ?? []).map(m => ({
      name: m.name || m.model || '',
      sizeBytes: m.size ?? null,
      parameterSize: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
    })).filter(m => m.name);
    return res.json({ baseUrl: probeUrl, models });
  } catch (err: any) {
    const msg = err?.name === 'AbortError'
      ? `Connection timed out after 5s — is the Ollama server reachable at ${probeUrl}?`
      : `Could not reach ${probeUrl}: ${err?.message || String(err)}`;
    return res.status(502).json({ error: msg });
  }
});

// --- Unified AI Chat endpoint ---
app.post('/api/ai/chat', async (req, res) => {
  if (!aiConfig.enabled) {
    return res.status(503).json({ error: 'AI Assistant is disabled. Enable it in Settings → AI.' });
  }
  const { prompt, systemInstruction } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  try {
    let text: string;

    if (aiConfig.provider === 'anthropic') {
      const client = getAnthropicClient();
      if (!client) {
        return res.status(500).json({ error: 'Anthropic API key not configured. Go to Settings to add it.' });
      }

      const response = await client.messages.create({
        model: aiConfig.anthropicModel,
        max_tokens: 2048,
        system: systemInstruction || '',
        messages: [{ role: 'user', content: prompt }],
      });

      text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('');
    } else if (aiConfig.provider === 'ollama') {
      if (!aiConfig.ollamaBaseUrl) {
        return res.status(500).json({ error: 'Ollama base URL not configured. Go to Settings → AI to set it.' });
      }
      if (!aiConfig.ollamaModel) {
        return res.status(500).json({ error: 'No Ollama model selected. Go to Settings → AI and pick one.' });
      }

      // Ollama exposes an OpenAI-compatible endpoint at /v1/chat/completions.
      // Using fetch directly (no SDK dep) keeps the dependency tree small.
      const messages: Array<{ role: string; content: string }> = [];
      if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
      messages.push({ role: 'user', content: prompt });

      const ctrl = new AbortController();
      // Local models can take a while on first call (model load); allow up to 2 min.
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      let upstream: Response;
      try {
        upstream = await fetch(`${aiConfig.ollamaBaseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: aiConfig.ollamaModel,
            messages,
            stream: false,
            temperature: 0.7,
          }),
          signal: ctrl.signal,
        });
      } catch (err: any) {
        const msg = err?.name === 'AbortError'
          ? `Ollama request timed out — model warming up? (${aiConfig.ollamaBaseUrl})`
          : `Could not reach Ollama at ${aiConfig.ollamaBaseUrl}: ${err?.message || String(err)}`;
        return res.status(502).json({ error: msg });
      } finally {
        clearTimeout(timer);
      }

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        return res.status(502).json({ error: `Ollama returned ${upstream.status}: ${errText.slice(0, 300)}` });
      }
      const body = await upstream.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      text = body.choices?.[0]?.message?.content ?? '';
      if (!text) {
        return res.status(502).json({ error: 'Ollama returned an empty response' });
      }
    } else {
      const client = getGeminiClient();
      if (!client) {
        return res.status(500).json({ error: 'Gemini API key not configured. Go to Settings to add it.' });
      }

      const response = await client.models.generateContent({
        model: aiConfig.geminiModel,
        contents: prompt,
        config: {
          systemInstruction: systemInstruction || '',
          temperature: 0.7,
        },
      });

      text = response.text;
    }

    return res.json({ text });
  } catch (error: any) {
    console.error(`[${aiConfig.provider}] API Error:`, error);
    return res.status(500).json({ error: error.message || 'AI request failed' });
  }
});

// =============================================
// Mesh Radio API (real hardware data)
// =============================================

// Sourced from .env SYSTEM_VERSION so it stays in lockstep with the bundle
// the browser is loading. Falls back to "dev" when the env var is missing.
const SYSTEM_VERSION = (process.env.SYSTEM_VERSION || '').trim() || 'dev';
console.log(`[API] MeshView Sentinel ${SYSTEM_VERSION}`);

// v2.0 Beta 3: mDNS-discovered Meshtastic radios on the LAN. The firmware
// advertises `_meshtastic._tcp.local` on port 4403 whenever WiFi is up; the
// scanner in mdnsDiscovery.ts watches for these announcements and the Add
// Radio form uses this endpoint to populate an auto-discover dropdown. If
// Sentinel is running in a Docker bridge container (default), mDNS multicast
// will not traverse to the container and this list will stay empty — switch
// the meshview service to `network_mode: host` to enable discovery.
app.get('/api/mesh/discover/mdns', (_req, res) => {
  return res.json({ services: mdnsDiscovery.list() });
});

// Status: is the radio connected?
app.get('/api/mesh/status', (_req, res) => {
  const device = serialDiscovery.getDevice();
  // v2.0 Beta 3: same fix as /api/mesh/snapshot — route local-radio fields
  // through the default-radio bridge in BridgeManager rather than reading
  // meshBridge directly. The singleton can be silently rebound by
  // /api/mesh/connect/tcp, leaving its `.connected` / .getLocalNodeId()
  // stale while contexts[defaultRadioId].bridge holds the real state.
  // The "RADIO OFFLINE" indicator in the left rail polls this endpoint.
  const defaultBridge = bridgeManager.getDefault()?.bridge ?? meshBridge;
  return res.json({
    systemVersion: SYSTEM_VERSION,
    radioConnected: defaultBridge.connected,
    transport: defaultBridge.getTransport(),
    serialDevice: device ? {
      port: device.port,
      vendor: device.vendor,
      product: device.product,
      isLoRa: device.isLoRa,
    } : null,
    nodeCount: defaultBridge.getNodes().length,
    messageCount: defaultBridge.getMessages().length,
    localNodeId: defaultBridge.getLocalNodeId(),
    firmwareVersion: defaultBridge.getLocalFirmwareVersion(),
    rebootCount: defaultBridge.getLocalRebootCount(),
    defaultRadioId: bridgeManager.getDefaultRadioId(),
  });
});

// --- v2.0 multi-radio: CRUD for the radios table. ---
// Phase 2 ships full CRUD over the metadata table. Actually opening a
// second transport (connecting a second radio) lands in Phase 3 when
// BridgeManager spawns secondary bridge instances. For now, adding a
// row here just persists the operator's intent.

// --- v2.0 multi-radio palette (matches PHASE_2_COLOR_PALETTE in
// [../src/lib/radioColors.ts](../src/lib/radioColors.ts)). Stays in
// sync with the client so DB-stored colors round-trip identically.
const RADIO_COLOR_PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
];

function nextAvailableColor(existing: string[]): string {
  for (const c of RADIO_COLOR_PALETTE) {
    if (!existing.includes(c)) return c;
  }
  // All used — recycle from the start so we don't blow up over 8 radios.
  return RADIO_COLOR_PALETTE[existing.length % RADIO_COLOR_PALETTE.length];
}

const SHORT_NAME_RE = /^[A-Za-z0-9_!-]{1,4}$/;

app.get('/api/mesh/radios', (_req, res) => {
  const rows = meshDb().listRadios();
  return res.json({
    radios: rows,
    defaultRadioId: bridgeManager.getDefaultRadioId(),
    palette: RADIO_COLOR_PALETTE,
  });
});

app.post('/api/mesh/radios', (req, res) => {
  const body = req.body ?? {};
  const radio_id = String(body.radio_id ?? '').trim();
  const long_name = String(body.long_name ?? '').trim();
  const transport = String(body.transport ?? '').trim();
  const target = String(body.target ?? '').trim();

  if (!radio_id || !SHORT_NAME_RE.test(radio_id)) {
    return res.status(400).json({ error: 'radio_id must be 1-4 chars (A-Z, 0-9, _, !, -)' });
  }
  if (!long_name) return res.status(400).json({ error: 'long_name is required' });
  if (transport !== 'serial' && transport !== 'tcp' && transport !== 'ble') {
    return res.status(400).json({ error: 'transport must be serial|tcp|ble' });
  }
  if (!target) return res.status(400).json({ error: 'target is required' });

  const db = meshDb();
  if (db.getRadio(radio_id)) {
    return res.status(409).json({ error: `radio_id "${radio_id}" already exists` });
  }

  const existingColors = db.listRadios().map(r => r.color_hex).filter((c): c is string => !!c);
  const now = Date.now();
  db.upsertRadio({
    radio_id,
    long_name,
    transport: transport as 'serial' | 'tcp' | 'ble',
    target,
    region:          body.region ?? null,
    modem_preset:    body.modem_preset ?? null,
    frequency_slot:  Number.isFinite(body.frequency_slot) ? body.frequency_slot : null,
    primary_channel: body.primary_channel ?? null,
    num_hops:        Number.isFinite(body.num_hops) ? body.num_hops : 3,
    enabled:         body.enabled === false ? 0 : 1,
    color_hex:       body.color_hex ?? nextAvailableColor(existingColors),
    network_label:   body.network_label ?? null,
    // First radio added becomes default if no default exists yet.
    is_default:      db.getDefaultRadio() ? 0 : 1,
    created_at:      now,
    updated_at:      now,
  });
  return res.status(201).json(db.getRadio(radio_id));
});

app.put('/api/mesh/radios/:radioId', (req, res) => {
  const { radioId } = req.params;
  const db = meshDb();
  const existing = db.getRadio(radioId);
  if (!existing) return res.status(404).json({ error: 'radio not found' });

  const body = req.body ?? {};
  db.upsertRadio({
    ...existing,
    long_name:       body.long_name       ?? existing.long_name,
    transport:       body.transport       ?? existing.transport,
    target:          body.target          ?? existing.target,
    region:          body.region          !== undefined ? body.region          : existing.region,
    modem_preset:    body.modem_preset    !== undefined ? body.modem_preset    : existing.modem_preset,
    frequency_slot:  body.frequency_slot  !== undefined ? body.frequency_slot  : existing.frequency_slot,
    primary_channel: body.primary_channel !== undefined ? body.primary_channel : existing.primary_channel,
    num_hops:        body.num_hops        !== undefined ? body.num_hops        : existing.num_hops,
    enabled:         body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
    color_hex:       body.color_hex       !== undefined ? body.color_hex       : existing.color_hex,
    network_label:   body.network_label   !== undefined ? body.network_label   : existing.network_label,
  });
  return res.json(db.getRadio(radioId));
});

app.delete('/api/mesh/radios/:radioId', (req, res) => {
  const { radioId } = req.params;
  const db = meshDb();
  const existing = db.getRadio(radioId);
  if (!existing) return res.status(404).json({ error: 'radio not found' });
  // v2.0 bugfix: gate deletion on the LIVE singleton, not the DB column —
  // the DB column reflects operator preference and might point at a radio
  // that isn't currently connected (which is fine to delete). What we
  // really can't delete is whichever radio is currently held by the
  // auto-discovered singleton bridge.
  if (radioId === bridgeManager.getDefaultRadioId()) {
    return res.status(409).json({ error: 'cannot delete the currently auto-connected singleton radio' });
  }
  const ok = db.deleteRadio(radioId);
  if (!ok) return res.status(500).json({ error: 'delete failed' });
  return res.json({ ok: true });
});

app.post('/api/mesh/radios/:radioId/default', (req, res) => {
  const { radioId } = req.params;
  const ok = meshDb().setDefaultRadio(radioId);
  if (!ok) return res.status(404).json({ error: 'radio not found' });
  return res.json({ ok: true, defaultRadioId: radioId });
});

// --- v2.0 Phase 3b: secondary-bridge connect / disconnect / status ---
// The default radio is auto-managed; these endpoints only operate on
// non-default radios stored in the radios table. Connecting spawns a
// fresh MeshtasticSerialBridge instance that streams its packets into
// the unified node/message/event view via the BridgeManager aggregator.

app.post('/api/mesh/radios/:radioId/connect', async (req, res) => {
  const result = await bridgeManager.spawnSecondary(req.params.radioId);
  if (!result.ok) return res.status(409).json({ error: (result as { ok: false; error: string }).error });
  return res.json({ ok: true });
});

app.post('/api/mesh/radios/:radioId/disconnect', async (req, res) => {
  const result = await bridgeManager.disconnectRadio(req.params.radioId);
  if (!result.ok) return res.status(409).json({ error: (result as { ok: false; error: string }).error });
  return res.json({ ok: true });
});

// v2.0 Beta 2: hot-swap the singleton. See BridgeManager.promoteToSingleton.
app.post('/api/mesh/radios/:radioId/promote-to-singleton', async (req, res) => {
  const result = await bridgeManager.promoteToSingleton(req.params.radioId);
  if (!result.ok) return res.status(409).json({ error: (result as { ok: false; error: string }).error });
  return res.json(result);
});

app.get('/api/mesh/radios/connections', (_req, res) => {
  return res.json({
    states: bridgeManager.connectionStates(),
    defaultRadioId: bridgeManager.getDefaultRadioId(),
  });
});

// --- v2.0 Phase 2 polish: dry-run connection test. ---
// Two use cases:
//   1. Add Radio form pre-submit — auto-fill short_name + long_name from the
//      radio's firmware before the operator commits the row.
//   2. Edit Radio "Test Connection" button — verify the configured target
//      still reaches a live radio without leaving the bridge connected.
app.post('/api/mesh/radios/test', async (req, res) => {
  const body = req.body ?? {};
  const transport = String(body.transport ?? '').trim();
  const target = String(body.target ?? '').trim();
  if (transport !== 'serial' && transport !== 'tcp') {
    return res.status(400).json({ error: 'transport must be serial or tcp' });
  }
  if (!target) return res.status(400).json({ error: 'target is required' });
  const timeoutMs = Number.isFinite(body.timeout_ms) ? Math.max(500, Math.min(15000, Math.floor(body.timeout_ms))) : 5000;

  // v2.0 bugfix: serial ports are exclusive — if the requested target is
  // already held by a connected radio (default or secondary), a fresh open
  // attempt fails with "Resource temporarily unavailable, cannot lock port".
  // Detect that case and return the LIVE state from the already-connected
  // bridge instead, so the caller sees the radio's real identity + LoRa
  // config without the doomed reopen.
  const conflictingCtx = bridgeManager.list().find(c => c.meta.target === target && c.bridge.connected);
  if (conflictingCtx) {
    const live = conflictingCtx.bridge.getLocalLoraConfig();
    const localId = conflictingCtx.bridge.getLocalNodeId();
    const localNode = localId ? conflictingCtx.bridge.getNodes().find(n => n.id === localId) : undefined;
    if (localNode) {
      return res.json({
        ok: true,
        identity: {
          shortName: localNode.shortName ?? conflictingCtx.radioId,
          longName:  localNode.name ?? '',
          nodeId:    localId ?? '',
        },
        lora: live ? {
          region:        live.region,
          modemPreset:   live.modemPreset,
          frequencySlot: live.frequencySlot,
          hopLimit:      live.hopLimit,
        } : undefined,
        alreadyConnectedAs: conflictingCtx.radioId,
      });
    }
  }
  // Same for the default radio (which isn't in bridgeManager.list() the
  // same way — its bridge IS the singleton meshBridge).
  const defaultCtx = bridgeManager.getDefault();
  if (defaultCtx && defaultCtx.bridge.connected && defaultCtx.meta.target === target) {
    const live = defaultCtx.bridge.getLocalLoraConfig();
    const localId = defaultCtx.bridge.getLocalNodeId();
    const localNode = localId ? defaultCtx.bridge.getNodes().find(n => n.id === localId) : undefined;
    if (localNode) {
      return res.json({
        ok: true,
        identity: {
          shortName: localNode.shortName ?? defaultCtx.radioId,
          longName:  localNode.name ?? '',
          nodeId:    localId ?? '',
        },
        lora: live ? {
          region:        live.region,
          modemPreset:   live.modemPreset,
          frequencySlot: live.frequencySlot,
          hopLimit:      live.hopLimit,
        } : undefined,
        alreadyConnectedAs: defaultCtx.radioId,
      });
    }
  }

  const r = await testTransportConnection({ transport: transport as 'serial' | 'tcp', target, timeoutMs });
  if (!r.ok) return res.status(502).json({ error: (r as { ok: false; error: string }).error });
  return res.json(r);
});

// --- LoRa config read + write (firmware admin) ---
// GET returns the most-recently-read LoRa config from the radio + the cached
// radios.row values. POST writes new values via admin.set_config and triggers
// a fresh readback.
//
// v2.0 bugfix: previously these endpoints all read/wrote against the default
// bridge regardless of `:radioId`. For multi-radio operators that meant the
// NOVA radio's LoRa editor would display MBNT's slot. Now we resolve the
// per-radio bridge via bridgeManager.get(radioId) and route there.
app.get('/api/mesh/radios/:radioId/lora', (req, res) => {
  const { radioId } = req.params;
  const row = meshDb().getRadio(radioId);
  if (!row) return res.status(404).json({ error: 'radio not found' });

  const ctx = bridgeManager.get(radioId);
  // Each bridge holds its OWN LoRa snapshot — read from the matching one.
  const live = ctx ? ctx.bridge.getLocalLoraConfig() : null;
  return res.json({
    radio: row,
    live, // null until first readback completes for this specific radio
  });
});

app.post('/api/mesh/radios/:radioId/lora/refresh', async (req, res) => {
  const { radioId } = req.params;
  const ctx = bridgeManager.get(radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${radioId}" is not connected` });

  try {
    await ctx.bridge.requestLoraConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// --- v2.0 Beta 2: Network + Power config admin (per radio) ---
app.get('/api/mesh/radios/:radioId/network', (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  return res.json({ live: ctx.bridge.getLocalNetworkConfig() });
});

app.post('/api/mesh/radios/:radioId/network/refresh', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  try { await ctx.bridge.requestNetworkConfig(); return res.json({ ok: true }); }
  catch (err: any) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/mesh/radios/:radioId/power', (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  return res.json({ live: ctx.bridge.getLocalPowerConfig() });
});

// --- v2.0 Beta 3: Web Status (TCP radios only) ---
// Proxy fetch of the firmware's built-in /json/report endpoint. The Meshtastic
// firmware serves an HTTP status JSON on port 80 whenever WiFi is enabled —
// includes live battery / wifi RSSI / uptime / memory / channel airtime, all
// data Sentinel doesn't ordinarily collect over the StreamAPI. We proxy
// rather than letting the browser fetch directly so:
//   1. No CORS hassle (radio webserver doesn't emit Access-Control-Allow-*)
//   2. Works from anywhere the dashboard is open, not just on the same LAN
//      as the radio
// Only meaningful for TCP-transport radios; serial/BLE radios have no IP.
app.get('/api/mesh/radios/:radioId/web-status', async (req, res) => {
  const row = meshDb().getRadio(req.params.radioId);
  if (!row) return res.status(404).json({ error: 'radio not found' });
  if (row.transport !== 'tcp') {
    return res.status(400).json({ error: 'web-status is only available for TCP-transport radios' });
  }
  // target is "<host>:<port>" or bare "<host>"; the webserver lives on :80
  const host = (row.target || '').split(':')[0].trim();
  if (!host) return res.status(400).json({ error: 'radio target has no resolvable host' });

  const url = `http://${host}/json/report`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return res.status(502).json({ error: `radio webserver returned HTTP ${r.status}` });
    const body = await r.json();
    return res.json({ ok: true, source: url, fetched_at: Date.now(), data: body });
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? 'timeout after 5s' : (err?.message || 'fetch failed');
    return res.status(502).json({ error: `couldn't reach ${url}: ${msg}` });
  } finally {
    clearTimeout(t);
  }
});

app.post('/api/mesh/radios/:radioId/power/refresh', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  try { await ctx.bridge.requestPowerConfig(); return res.json({ ok: true }); }
  catch (err: any) { return res.status(500).json({ error: err.message }); }
});

app.put('/api/mesh/radios/:radioId/power', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  const body = req.body ?? {};
  try {
    await ctx.bridge.setPowerConfig({
      isPowerSaving:              typeof body.isPowerSaving === 'boolean'              ? body.isPowerSaving              : undefined,
      onBatteryShutdownAfterSecs: typeof body.onBatteryShutdownAfterSecs === 'number'  ? body.onBatteryShutdownAfterSecs : undefined,
      waitBluetoothSecs:          typeof body.waitBluetoothSecs === 'number'           ? body.waitBluetoothSecs          : undefined,
      sdsSecs:                    typeof body.sdsSecs === 'number'                     ? body.sdsSecs                    : undefined,
      lsSecs:                     typeof body.lsSecs === 'number'                      ? body.lsSecs                     : undefined,
      minWakeSecs:                typeof body.minWakeSecs === 'number'                 ? body.minWakeSecs                : undefined,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// --- v2.0 Beta 3: Device config (per radio) ---
app.get('/api/mesh/radios/:radioId/device', (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  return res.json({ live: ctx.bridge.getLocalDeviceConfig() });
});

app.post('/api/mesh/radios/:radioId/device/refresh', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  try { await ctx.bridge.requestDeviceConfig(); return res.json({ ok: true }); }
  catch (err: any) { return res.status(500).json({ error: err.message }); }
});

app.put('/api/mesh/radios/:radioId/device', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  const body = req.body ?? {};
  try {
    await ctx.bridge.setDeviceConfig({
      role:                   typeof body.role === 'number'                   ? body.role                   : undefined,
      rebroadcastMode:        typeof body.rebroadcastMode === 'number'        ? body.rebroadcastMode        : undefined,
      nodeInfoBroadcastSecs:  typeof body.nodeInfoBroadcastSecs === 'number'  ? body.nodeInfoBroadcastSecs  : undefined,
      doubleTapAsButtonPress: typeof body.doubleTapAsButtonPress === 'boolean' ? body.doubleTapAsButtonPress : undefined,
      disableTripleClick:     typeof body.disableTripleClick === 'boolean'    ? body.disableTripleClick     : undefined,
      tzdef:                  typeof body.tzdef === 'string'                  ? body.tzdef                  : undefined,
      ledHeartbeatDisabled:   typeof body.ledHeartbeatDisabled === 'boolean'  ? body.ledHeartbeatDisabled   : undefined,
      buzzerMode:             typeof body.buzzerMode === 'number'             ? body.buzzerMode             : undefined,
    });
    return res.json({ ok: true });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// --- v2.0 Beta 3: Position config (per radio) ---
app.get('/api/mesh/radios/:radioId/position', (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  return res.json({ live: ctx.bridge.getLocalPositionConfig() });
});

app.post('/api/mesh/radios/:radioId/position/refresh', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  try { await ctx.bridge.requestPositionConfig(); return res.json({ ok: true }); }
  catch (err: any) { return res.status(500).json({ error: err.message }); }
});

app.put('/api/mesh/radios/:radioId/position', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  const body = req.body ?? {};
  try {
    await ctx.bridge.setPositionConfig({
      positionBroadcastSecs:      typeof body.positionBroadcastSecs === 'number'      ? body.positionBroadcastSecs      : undefined,
      smartEnabled:               typeof body.smartEnabled === 'boolean'              ? body.smartEnabled               : undefined,
      fixedPosition:              typeof body.fixedPosition === 'boolean'             ? body.fixedPosition              : undefined,
      gpsUpdateIntervalSecs:      typeof body.gpsUpdateIntervalSecs === 'number'      ? body.gpsUpdateIntervalSecs      : undefined,
      positionFlags:              typeof body.positionFlags === 'number'              ? body.positionFlags              : undefined,
      smartMinimumDistanceMeters: typeof body.smartMinimumDistanceMeters === 'number' ? body.smartMinimumDistanceMeters : undefined,
      smartMinimumIntervalSecs:   typeof body.smartMinimumIntervalSecs === 'number'   ? body.smartMinimumIntervalSecs   : undefined,
      gpsMode:                    typeof body.gpsMode === 'number'                    ? body.gpsMode                    : undefined,
    });
    return res.json({ ok: true });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// --- v2.0 Beta 3: Display config (per radio) ---
app.get('/api/mesh/radios/:radioId/display', (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  return res.json({ live: ctx.bridge.getLocalDisplayConfig() });
});

app.post('/api/mesh/radios/:radioId/display/refresh', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  try { await ctx.bridge.requestDisplayConfig(); return res.json({ ok: true }); }
  catch (err: any) { return res.status(500).json({ error: err.message }); }
});

app.put('/api/mesh/radios/:radioId/display', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  const body = req.body ?? {};
  try {
    await ctx.bridge.setDisplayConfig({
      screenOnSecs:           typeof body.screenOnSecs === 'number'            ? body.screenOnSecs           : undefined,
      autoScreenCarouselSecs: typeof body.autoScreenCarouselSecs === 'number'  ? body.autoScreenCarouselSecs : undefined,
      flipScreen:             typeof body.flipScreen === 'boolean'             ? body.flipScreen             : undefined,
      units:                  typeof body.units === 'number'                   ? body.units                  : undefined,
      oled:                   typeof body.oled === 'number'                    ? body.oled                   : undefined,
      displayMode:            typeof body.displayMode === 'number'             ? body.displayMode            : undefined,
      headingBold:            typeof body.headingBold === 'boolean'            ? body.headingBold            : undefined,
      wakeOnTapOrMotion:      typeof body.wakeOnTapOrMotion === 'boolean'      ? body.wakeOnTapOrMotion      : undefined,
      compassOrientation:     typeof body.compassOrientation === 'number'      ? body.compassOrientation     : undefined,
      use12hClock:            typeof body.use12hClock === 'boolean'            ? body.use12hClock            : undefined,
      useLongNodeName:        typeof body.useLongNodeName === 'boolean'        ? body.useLongNodeName        : undefined,
      enableMessageBubbles:   typeof body.enableMessageBubbles === 'boolean'   ? body.enableMessageBubbles   : undefined,
    });
    return res.json({ ok: true });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// --- v2.0 Beta 3: Bluetooth config (per radio) ---
app.get('/api/mesh/radios/:radioId/bluetooth', (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  return res.json({ live: ctx.bridge.getLocalBluetoothConfig() });
});

app.post('/api/mesh/radios/:radioId/bluetooth/refresh', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  try { await ctx.bridge.requestBluetoothConfig(); return res.json({ ok: true }); }
  catch (err: any) { return res.status(500).json({ error: err.message }); }
});

app.put('/api/mesh/radios/:radioId/bluetooth', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  const body = req.body ?? {};
  try {
    await ctx.bridge.setBluetoothConfig({
      enabled:  typeof body.enabled === 'boolean' ? body.enabled  : undefined,
      mode:     typeof body.mode === 'number'     ? body.mode     : undefined,
      fixedPin: typeof body.fixedPin === 'number' ? body.fixedPin : undefined,
    });
    return res.json({ ok: true });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// --- v2.0 Beta 2: Canned Messages (per radio) ---
app.get('/api/mesh/radios/:radioId/canned-messages', (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  return res.json({ messages: ctx.bridge.getCannedMessages() });
});

app.post('/api/mesh/radios/:radioId/canned-messages/refresh', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  try { await ctx.bridge.requestCannedMessages(); return res.json({ ok: true }); }
  catch (err: any) { return res.status(500).json({ error: err.message }); }
});

app.put('/api/mesh/radios/:radioId/canned-messages', async (req, res) => {
  const ctx = bridgeManager.get(req.params.radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${req.params.radioId}" is not connected` });
  const messages = req.body?.messages;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'Body must be { messages: string[] }' });
  try {
    await ctx.bridge.setCannedMessages(messages.map(String));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/mesh/radios/:radioId/lora', async (req, res) => {
  const { radioId } = req.params;
  const ctx = bridgeManager.get(radioId);
  if (!ctx) return res.status(404).json({ error: 'radio not found or not connected' });
  if (!ctx.bridge.connected) return res.status(503).json({ error: `radio "${radioId}" is not connected` });

  const body = req.body ?? {};
  try {
    await ctx.bridge.setLoraConfig({
      region:        typeof body.region === 'number'        ? body.region        : undefined,
      modemPreset:   typeof body.modemPreset === 'number'   ? body.modemPreset   : undefined,
      usePreset:     typeof body.usePreset === 'boolean'    ? body.usePreset     : undefined,
      frequencySlot: typeof body.frequencySlot === 'number' ? body.frequencySlot : undefined,
      hopLimit:      typeof body.hopLimit === 'number'      ? body.hopLimit      : undefined,
      txEnabled:     typeof body.txEnabled === 'boolean'    ? body.txEnabled     : undefined,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// --- v2.0 GPU sidecar health passthrough. ---
// Settings → GPU panel (Phase 5) will surface this.
app.get('/api/gpu/health', async (_req, res) => {
  const h = await gpuHealth();
  return res.json(h);
});

// --- v2.0 Beta 2: encrypted config backup / restore ---
// Bundles the radios registry + channels (with PSKs) + BBS config into a
// passphrase-sealed AES-256-GCM envelope. See [backup.ts](./backup.ts).
app.post('/api/mesh/backup', (req, res) => {
  const passphrase = String(req.body?.passphrase ?? '');
  try {
    const payload = {
      kind: 'meshview-sentinel-backup',
      exportedAt: Date.now(),
      systemVersion: SYSTEM_VERSION,
      radios: meshDb().listRadios(),
      channels: meshDb().loadChannels(),
      bbsConfig,
    };
    const envelope = sealBackup(payload, passphrase);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="sentinel-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.send(JSON.stringify(envelope, null, 2));
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/mesh/restore', (req, res) => {
  const passphrase = String(req.body?.passphrase ?? '');
  const envelope = req.body?.envelope;
  if (!envelope || typeof envelope !== 'object') {
    return res.status(400).json({ error: 'envelope is required' });
  }
  let payload: any;
  try {
    payload = openBackup(envelope, passphrase);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
  if (payload?.kind !== 'meshview-sentinel-backup') {
    return res.status(400).json({ error: 'not a Sentinel backup envelope' });
  }
  // Restore is Sentinel-side only: rewrites the radios table, channels cache,
  // and BBS config. Does NOT push anything to radio firmware — devices keep
  // their own config; reconnecting re-reads their actual channel state.
  const summary = { radios: 0, channels: 0, bbsConfig: false };
  try {
    if (Array.isArray(payload.radios)) {
      for (const r of payload.radios) { meshDb().upsertRadio(r); summary.radios++; }
    }
    if (Array.isArray(payload.channels)) {
      for (const c of payload.channels) { meshDb().upsertChannel(c); summary.channels++; }
    }
    if (payload.bbsConfig && typeof payload.bbsConfig === 'object') {
      bbsConfig = normalizeBbsConfig(payload.bbsConfig);
      saveBbsConfig(bbsConfig);
      bridgeManager.setBbsConfig(bbsConfig);
      summary.bbsConfig = true;
    }
    return res.json({ ok: true, restored: summary });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// --- v2.0 Phase 5: host system info ---
// Powers the boot-time RAM advisory in Settings → Radios. Reports total RAM,
// free RAM, CPU count, and detected platform hints (Jetson via device-tree)
// so the client can show a "tight memory" banner when adding/connecting
// secondary radios would push past comfortable headroom.
app.get('/api/system/info', (_req, res) => {
  let isJetson = false;
  try {
    if (existsSync('/proc/device-tree/compatible')) {
      const compat = readFileSync('/proc/device-tree/compatible', 'utf-8');
      isJetson = /tegra|jetson/i.test(compat);
    }
  } catch { /* not a Linux host or no perms — fine */ }
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return res.json({
    platform:  process.platform,
    arch:      process.arch,
    cpuCount:  os.cpus().length,
    memTotal:  totalBytes,
    memFree:   freeBytes,
    memTotalGB: +(totalBytes / 1024 / 1024 / 1024).toFixed(2),
    memFreeGB:  +(freeBytes  / 1024 / 1024 / 1024).toFixed(2),
    isJetson,
    uptimeSecs: Math.floor(os.uptime()),
    nodeVersion: process.version,
  });
});

// --- v2.0 Phase 5 GPU position trace simplification passthrough. ---
// Takes a node_id, pulls its position_history from the DB, runs RDP at the
// requested tolerance, returns the kept indexes + simplified series. Used by
// the Node Detail panel's Position Log → "Show simplified trace" affordance.
app.post('/api/gpu/trace-simplify', async (req, res) => {
  const body = req.body ?? {};
  const nodeId = typeof body.node_id === 'string' ? body.node_id : null;
  if (!nodeId && !Array.isArray(body.points)) {
    return res.status(400).json({ error: 'either node_id or points[] is required' });
  }
  const tolerance = typeof body.simplify_tolerance_m === 'number' ? body.simplify_tolerance_m : 5;

  // Resolve points: explicit array wins; otherwise pull from DB.
  let points: Array<{ node_id: string; timestamp: number; lat: number; lng: number }>;
  if (Array.isArray(body.points)) {
    points = body.points;
  } else {
    const rows = meshDb().loadPositionHistory(nodeId!, typeof body.limit === 'number' ? body.limit : 1000);
    // DB returns newest-first; flip so RDP sees chronological order.
    rows.reverse();
    points = rows.map(r => ({ node_id: nodeId!, timestamp: r.timestamp, lat: r.lat, lng: r.lng }));
  }

  try {
    const result = await simplifyTrace({ points, simplify_tolerance_m: tolerance });
    // Echo back the kept points so the client doesn't have to re-fetch.
    const kept = result.keep.map(i => points[i]);
    return res.json({ ...result, points: kept });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'trace simplify failed' });
  }
});

// --- v2.0 Phase 5 GPU signal coverage heatmap passthrough. ---
// The Map widget's "Coverage" toggle calls this with the current map bbox +
// all positioned nodes (using their last RSSI as the sample value). Result
// is rasterized into a colored overlay. Falls back to a pure-TS IDW when
// the sidecar is unreachable.
app.post('/api/gpu/heatmap', async (req, res) => {
  const body = req.body ?? {};
  if (!Array.isArray(body.bbox) || body.bbox.length !== 4) {
    return res.status(400).json({ error: 'bbox must be [south, west, north, east]' });
  }
  let observations: Array<{ lat: number; lng: number; rssi: number; snr?: number | null }> = [];
  if (Array.isArray(body.observations)) {
    observations = body.observations;
  } else {
    // Auto-derive from positioned nodes' last RSSI.
    const ctxs = bridgeManager.list();
    const nodes = ctxs.length === 0 ? meshBridge.getNodes() : bridgeManager.getAllNodes();
    for (const n of nodes) {
      if (!n.position || n.telemetry?.rssi == null) continue;
      observations.push({
        lat: n.position.lat,
        lng: n.position.lng,
        rssi: n.telemetry.rssi,
        snr:  n.telemetry.snr ?? null,
      });
    }
  }
  try {
    const result = await buildHeatmap({
      observations,
      bbox: body.bbox as [number, number, number, number],
      grid_width:  typeof body.grid_width  === 'number' ? body.grid_width  : 64,
      grid_height: typeof body.grid_height === 'number' ? body.grid_height : 64,
      method: 'idw',
      power: typeof body.power === 'number' ? body.power : 2,
      max_radius_m: typeof body.max_radius_m === 'number' ? body.max_radius_m : 5000,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'heatmap build failed' });
  }
});

// --- v2.0 Phase 4 GPU topology passthrough. ---
// Builds the unified mesh topology graph from heard-by edges. Used by the
// Topology / Network view to render the connectivity graph + centrality
// scores. Server can derive edges from neighbor_info + heardBy if the
// caller doesn't pass them explicitly.
app.post('/api/gpu/topology', async (req, res) => {
  const body = req.body ?? {};
  let edges: Array<{ src: string; dst: string; snr?: number | null; rssi?: number | null; last_seen?: number | null }> = [];

  if (Array.isArray(body.edges)) {
    edges = body.edges;
  } else {
    // Auto-derive edges from server-side neighbor_info — every NeighborInfoSnapshot
    // contains a list of neighbors that node has directly heard.
    const ctxs = bridgeManager.list();
    const sources = ctxs.length === 0 ? [meshBridge] : ctxs.map(c => c.bridge);
    const seen = new Set<string>();
    for (const br of sources) {
      for (const snap of br.getNeighborInfo()) {
        for (const nbr of snap.neighbors ?? []) {
          const key = `${snap.fromNodeId}|${nbr.nodeId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            src: snap.fromNodeId,
            dst: nbr.nodeId,
            snr: typeof nbr.snr === 'number' ? nbr.snr : null,
            last_seen: snap.lastSeen ?? null,
          });
        }
      }
    }
  }

  try {
    const result = await buildTopology({
      edges,
      compute_centrality: !!body.compute_centrality,
      k_shortest: typeof body.k_shortest === 'number' ? body.k_shortest : undefined,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'topology build failed' });
  }
});

// --- v2.0 Beta 2: traceroute route-stability analysis. ---
// Groups the persisted traceroute history by target and scores how consistent
// the chosen path is over time, plus tallies the most-used directed links
// (mesh "backbone"). Powers the Route Stability panel in the Topology view.
//
// Traceroutes aren't tagged with the radio that issued them (the shared
// trace_results table has no radio_id), so we attribute origin to the primary
// radio's local node — the common case is a single radio running traces. The
// full path we reconstruct is [origin, ...relays, target]; `route` holds only
// the intermediate relays (empty = direct hop).
app.post('/api/gpu/route-stability', async (_req, res) => {
  const origin = meshBridge.getLocalNodeId();
  const traces = meshBridge.getTraces()
    .filter(t => t.status === 'response')
    .map(t => {
      const relays = (t.route ?? []).map(h => h.nodeId);
      const path = (origin ? [origin, ...relays, t.targetId] : [...relays, t.targetId]);
      return { target: t.targetId, origin, completed_at: t.completedAt ?? null, path };
    });

  try {
    const result = await routeStability({ traces });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'route-stability build failed' });
  }
});

// --- v2.0 Phase 3 GPU clustering passthrough. ---
// The dashboard map calls this when its viewport / zoom / node set changes
// so overlapping pins collapse into a `+N` cluster badge instead of stacking
// invisibly. Falls back to a pure-TS DBSCAN if the sidecar is unreachable
// (the gpuClient does this transparently — clients always get a result).
app.post('/api/gpu/cluster', async (req, res) => {
  const body = req.body ?? {};
  if (!Array.isArray(body.points)) {
    return res.status(400).json({ error: 'points must be an array of {lat, lng, ...}' });
  }
  const eps = Number(body.eps_meters);
  if (!Number.isFinite(eps) || eps <= 0) {
    return res.status(400).json({ error: 'eps_meters must be a positive number' });
  }
  try {
    const result = await clusterDbscan({
      points: body.points,
      eps_meters: eps,
      min_samples: Number.isFinite(body.min_samples) ? body.min_samples : 2,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'clustering failed' });
  }
});

// --- TCP transport: connect / disconnect ---
const TCP_CONFIG_PATH = join(dataDir, 'tcp-endpoint.json');

interface TcpEndpointConfig { host: string; port: number; }

function loadTcpEndpoint(): TcpEndpointConfig | null {
  try {
    if (existsSync(TCP_CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(TCP_CONFIG_PATH, 'utf-8'));
      if (typeof saved.host === 'string' && typeof saved.port === 'number') return saved;
    }
  } catch { /* ignore */ }
  return null;
}

function saveTcpEndpoint(ep: TcpEndpointConfig | null) {
  try {
    if (ep) writeFileSync(TCP_CONFIG_PATH, JSON.stringify(ep, null, 2), 'utf-8');
    else if (existsSync(TCP_CONFIG_PATH)) writeFileSync(TCP_CONFIG_PATH, '', 'utf-8');
  } catch (err: any) {
    console.error('[API] saveTcpEndpoint failed:', err.message);
  }
}

app.post('/api/mesh/connect/tcp', async (req, res) => {
  const { host, port } = req.body ?? {};
  if (typeof host !== 'string' || !host.trim()) {
    return res.status(400).json({ error: 'host is required' });
  }
  const portNum = Number.isFinite(port) ? Math.floor(port) : 4403;
  if (portNum < 1 || portNum > 65535) {
    return res.status(400).json({ error: 'port out of range' });
  }
  try {
    await meshBridge.connectTcp(host.trim(), portNum);
    saveTcpEndpoint({ host: host.trim(), port: portNum });
    return res.json({ ok: true, transport: meshBridge.getTransport() });
  } catch (err: any) {
    return res.status(502).json({ error: err.message || 'connect failed' });
  }
});

app.post('/api/mesh/disconnect', async (_req, res) => {
  try {
    await meshBridge.disconnect();
    saveTcpEndpoint(null);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Re-issue want_config_id to pull a fresh NodeDB / channel set from the radio.
// Useful when a phone (BLE) has changed config out-of-band and the UI is showing
// stale liveness or channel-index drift.
app.post('/api/mesh/refresh', (req, res) => {
  // v2.0: optional ?radio_id=NOVA scopes the refresh to a single radio. When
  // omitted, refreshes the default radio (Phase 3a); Phase 3b will fan out
  // to every connected secondary bridge when none is specified.
  const radioId = typeof req.query.radio_id === 'string' ? req.query.radio_id : null;
  const targetIds = radioId ? [radioId] : [];
  try {
    if (radioId) {
      if (radioId !== bridgeManager.getDefaultRadioId()) {
        return res.status(501).json({
          error: 'Per-radio refresh of non-default radios lands in Phase 3b (secondary-bridge support)',
        });
      }
    }
    meshBridge.refreshNodeDb();
    return res.json({ ok: true, refreshed: targetIds.length ? targetIds : ['<default>'] });
  } catch (err: any) {
    return res.status(409).json({ error: err.message || 'refresh failed' });
  }
});

// All mesh nodes — v2.0 aggregates across every connected radio so a single
// list reflects the union of meshes the operator is bridging. heardByRadios
// preserves attribution per node.
app.get('/api/mesh/nodes', (_req, res) => {
  // Fall back to the singleton's view if BridgeManager has no contexts yet
  // (very early boot before auto-registration completes).
  const ctxs = bridgeManager.list();
  if (ctxs.length === 0) return res.json(meshBridge.getNodes());
  return res.json(bridgeManager.getAllNodes());
});

// Node groups (operator-defined organizational tags)
app.get('/api/mesh/groups', (_req, res) => {
  return res.json(meshBridge.getGroups());
});

app.post('/api/mesh/groups', (req, res) => {
  const { name, color } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return res.status(400).json({ error: 'color must be a 6-digit hex like #10b981' });
  }
  try {
    const group = meshBridge.createGroup(name, color);
    broadcastGroupsChanged();
    return res.json({ ok: true, group });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/mesh/groups/:id', (req, res) => {
  const { name, color } = req.body ?? {};
  if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return res.status(400).json({ error: 'color must be a 6-digit hex like #10b981' });
  }
  try {
    const group = meshBridge.updateGroup(req.params.id, { name, color });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    broadcastGroupsChanged();
    return res.json({ ok: true, group });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

app.delete('/api/mesh/groups/:id', (req, res) => {
  const ok = meshBridge.deleteGroup(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Group not found' });
  broadcastGroupsChanged();
  return res.json({ ok: true });
});

// Assign / unassign a node to a group (body: { groupId: string | null })
app.post('/api/mesh/nodes/:id/group', (req, res) => {
  const { groupId } = req.body ?? {};
  if (groupId !== null && groupId !== undefined && typeof groupId !== 'string') {
    return res.status(400).json({ error: 'groupId must be a string or null' });
  }
  if (!req.params.id.startsWith('!')) {
    return res.status(400).json({ error: 'id must be a !hex node id' });
  }
  const ok = meshBridge.setNodeGroup(req.params.id, groupId ?? null);
  if (!ok) return res.status(404).json({ error: 'Node or group not found' });
  // Node-update event already fans out via the existing 'node' SSE channel
  return res.json({ ok: true });
});

// Toggle favorite flag (purely a client-side preference; no radio packet)
app.post('/api/mesh/nodes/:id/favorite', (req, res) => {
  const id = req.params.id;
  const favorite = !!(req.body?.favorite);
  if (!id.startsWith('!')) return res.status(400).json({ error: 'id must be a !hex node id' });
  const ok = meshBridge.setFavorite(id, favorite);
  if (!ok) return res.status(404).json({ error: 'Node not found' });
  return res.json({ ok: true, id, favorite });
});

// Group create/update/delete + node assignment all use the same fanOut
// channel so other clients re-poll and see the change instantly.
const broadcastGroupsChanged = () => {
  const payload = `event: groups\ndata: ${JSON.stringify({ ts: Date.now(), radioId: bridgeManager.getDefaultRadioId() })}\n\n`;
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
};

// Server-side block list (replaces the per-browser localStorage version).
// Blocking is purely a client-side filter — the radio still receives traffic
// from these nodes; we just persist the list centrally so multi-tab and
// multi-machine operators stay in sync.
const broadcastBlockedChanged = () => {
  const payload = `event: blocked\ndata: ${JSON.stringify({ ts: Date.now(), radioId: bridgeManager.getDefaultRadioId() })}\n\n`;
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
};

app.get('/api/mesh/blocked', (_req, res) => {
  try {
    return res.json({ blocked: meshDb().loadBlockedNodes() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/blocked', (req, res) => {
  const { nodeId } = req.body ?? {};
  if (typeof nodeId !== 'string' || !nodeId.startsWith('!')) {
    return res.status(400).json({ error: 'nodeId must be a !hex node id' });
  }
  try {
    const added = meshDb().addBlockedNode(nodeId);
    if (added) broadcastBlockedChanged();
    return res.json({ ok: true, added });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/mesh/blocked/:nodeId', (req, res) => {
  const nodeId = req.params.nodeId;
  if (!nodeId.startsWith('!')) {
    return res.status(400).json({ error: 'nodeId must be a !hex node id' });
  }
  try {
    const removed = meshDb().removeBlockedNode(nodeId);
    if (removed) broadcastBlockedChanged();
    return res.json({ ok: true, removed });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// All messages — aggregates across all bridges, with optional ?radio_id filter.
// v2.0 Phase 4: when a per-radio filter is active the client passes the id so
// the response only contains messages stamped with that radio_id (the bridge
// that sent or received them).
app.get('/api/mesh/messages', (req, res) => {
  const radioId = typeof req.query.radio_id === 'string' && req.query.radio_id ? req.query.radio_id : null;
  const ctxs = bridgeManager.list();
  let msgs = ctxs.length === 0 ? meshBridge.getMessages() : bridgeManager.getAllMessages();
  if (radioId) {
    // The aggregator already concatenates per-bridge in-memory caches, but
    // each message object doesn't carry a radio_id (the column is DB-only).
    // For correctness, query the DB for the radio_id of each message and
    // filter. For now, fall back to per-context iteration to avoid the DB
    // hit on the hot path — secondary bridges' messages came from the
    // matching radio context already.
    const fromCtx = ctxs.find(c => c.radioId === radioId)?.bridge.getMessages() ?? [];
    msgs = fromCtx;
  }
  return res.json(msgs);
});

// Full-text search across all persisted messages
app.get('/api/mesh/messages/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  if (!q) return res.json([]);
  try {
    return res.json(meshDb().searchMessages(q, limit));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Event log — aggregates across all bridges.
app.get('/api/mesh/events', (_req, res) => {
  const ctxs = bridgeManager.list();
  if (ctxs.length === 0) return res.json(meshBridge.getEvents());
  return res.json(bridgeManager.getAllEvents());
});

// Full snapshot (nodes + messages + events in one call)
app.get('/api/mesh/snapshot', (_req, res) => {
  let blocked: string[] = [];
  try { blocked = meshDb().loadBlockedNodes(); } catch { /* fall back to empty */ }
  const ctxs = bridgeManager.list();
  const useAgg = ctxs.length > 0;
  // v2.0 Beta 3 bugfix: pull channels from the *default radio's* bridge in
  // BridgeManager rather than the raw singleton. They diverge after the
  // operator points `/api/mesh/connect/tcp` at a different radio: meshBridge
  // gets rebound to that new target's transport but BridgeManager's contexts
  // (which the per-radio /api/mesh/channels?radio_id=X endpoint reads from)
  // keep pointing at their original bridge instances. Result was that the
  // snapshot's channel list could be a different radio's slots than what the
  // /api/mesh/channels?radio_id=<default> endpoint returned — so the
  // sidebar's "default radio" view showed someone else's channels.
  const defaultBridge = bridgeManager.getDefault()?.bridge ?? meshBridge;
  // v2.0 Beta 3 bugfix: ALL "the local radio's …" fields route through the
  // default-radio bridge from BridgeManager, NOT meshBridge directly. Same
  // root cause as the channels fix above — meshBridge can be silently
  // rebound by /api/mesh/connect/tcp and end up holding stale or
  // wrong-radio state. radioConnected + localNodeId driving MailView /
  // RadioStatus gating on the wrong bridge made the BBS Mail page show
  // "MAIL UNAVAILABLE — Waiting for the local radio to identify itself"
  // even with two radios visibly connected. waypoints / traces /
  // neighborInfo / store-forward / module-config / groups all sourced
  // from the same authoritative bridge.
  return res.json({
    nodes:    useAgg ? bridgeManager.getAllNodes()    : defaultBridge.getNodes(),
    messages: useAgg ? bridgeManager.getAllMessages() : defaultBridge.getMessages(),
    events:   useAgg ? bridgeManager.getAllEvents()   : defaultBridge.getEvents(),
    channels: defaultBridge.getChannels(),
    waypoints: defaultBridge.getWaypoints(),
    traces: defaultBridge.getTraces(),
    neighborInfo: defaultBridge.getNeighborInfo(),
    storeForwardRouters: defaultBridge.getStoreForwardRouters(),
    localModuleConfig: defaultBridge.getLocalModuleConfig(),
    groups: defaultBridge.getGroups(),
    blocked,
    radioConnected: defaultBridge.connected,
    localNodeId: defaultBridge.getLocalNodeId(),
  });
});

// Trigger a readback of the local NeighborInfo module config from the radio.
// Admin to local node only — does not consume mesh airtime.
app.post('/api/mesh/modules/neighbor-info/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestNeighborInfoConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/mesh/neighbor-info', (_req, res) => {
  return res.json(meshBridge.getNeighborInfo());
});

// Configure the NeighborInfo module on the connected radio (admin write).
app.post('/api/mesh/modules/neighbor-info', async (req, res) => {
  const { enabled, intervalSecs, transmitOverLora } = req.body ?? {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  if (intervalSecs !== undefined && (typeof intervalSecs !== 'number' || intervalSecs < 60 || intervalSecs > 86400)) {
    return res.status(400).json({ error: 'intervalSecs must be between 60 and 86400' });
  }
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setNeighborInfoConfig({
      enabled,
      intervalSecs,
      transmitOverLora: typeof transmitOverLora === 'boolean' ? transmitOverLora : true,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Range Test survey: kick off a timed sender session that auto-restores
// the previous config when it expires. Body: { durationMinutes, senderIntervalSecs }
app.post('/api/mesh/modules/range-test/survey', async (req, res) => {
  const { durationMinutes, senderIntervalSecs } = req.body ?? {};
  if (typeof durationMinutes !== 'number' || durationMinutes < 1 || durationMinutes > 120) {
    return res.status(400).json({ error: 'durationMinutes must be 1..120' });
  }
  if (typeof senderIntervalSecs !== 'number' || senderIntervalSecs < 15 || senderIntervalSecs > 3600) {
    return res.status(400).json({ error: 'senderIntervalSecs must be 15..3600' });
  }
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    const r = await meshBridge.startRangeTestSurvey({ durationMinutes, senderIntervalSecs });
    return res.json({ ok: true, expiresAt: r.expiresAt });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/mesh/modules/range-test/survey', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.cancelRangeTestSurvey();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// NeighborInfo survey: same pattern — temporarily speed up the broadcast cadence
// to map topology faster during deployment, then auto-restore.
app.post('/api/mesh/modules/neighbor-info/survey', async (req, res) => {
  const { durationMinutes, intervalSecs } = req.body ?? {};
  if (typeof durationMinutes !== 'number' || durationMinutes < 1 || durationMinutes > 120) {
    return res.status(400).json({ error: 'durationMinutes must be 1..120' });
  }
  if (typeof intervalSecs !== 'number' || intervalSecs < 60 || intervalSecs > 14400) {
    return res.status(400).json({ error: 'intervalSecs must be 60..14400' });
  }
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    const r = await meshBridge.startNeighborInfoSurvey({ durationMinutes, intervalSecs });
    return res.json({ ok: true, expiresAt: r.expiresAt });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/mesh/modules/neighbor-info/survey', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.cancelNeighborInfoSurvey();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Range Test module: refresh + write
app.post('/api/mesh/modules/range-test/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestRangeTestConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/range-test', async (req, res) => {
  const { enabled, senderIntervalSecs, save } = req.body ?? {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  // 0 = receive-only; positive senderIntervalSecs must be in a sane band.
  if (senderIntervalSecs !== undefined && (typeof senderIntervalSecs !== 'number' || senderIntervalSecs < 0 || senderIntervalSecs > 86400)) {
    return res.status(400).json({ error: 'senderIntervalSecs must be between 0 and 86400' });
  }
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setRangeTestConfig({
      enabled,
      senderIntervalSecs,
      save: typeof save === 'boolean' ? save : false,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Telemetry module: refresh + write
app.post('/api/mesh/modules/telemetry/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestTelemetryConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/telemetry', async (req, res) => {
  const {
    deviceUpdateIntervalSecs,
    environmentEnabled,
    environmentUpdateIntervalSecs,
    powerEnabled,
    powerUpdateIntervalSecs,
  } = req.body ?? {};

  const checkInterval = (v: any, name: string) => {
    if (v === undefined) return null;
    if (typeof v !== 'number' || v < 0 || v > 86400) return `${name} must be between 0 and 86400`;
    return null;
  };
  const errs = [
    checkInterval(deviceUpdateIntervalSecs, 'deviceUpdateIntervalSecs'),
    checkInterval(environmentUpdateIntervalSecs, 'environmentUpdateIntervalSecs'),
    checkInterval(powerUpdateIntervalSecs, 'powerUpdateIntervalSecs'),
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setTelemetryConfig({
      deviceUpdateIntervalSecs,
      environmentEnabled: typeof environmentEnabled === 'boolean' ? environmentEnabled : undefined,
      environmentUpdateIntervalSecs,
      powerEnabled: typeof powerEnabled === 'boolean' ? powerEnabled : undefined,
      powerUpdateIntervalSecs,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Store & Forward module: refresh + write
app.post('/api/mesh/modules/store-forward/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestStoreForwardConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/store-forward', async (req, res) => {
  const {
    enabled,
    isServer,
    heartbeat,
    records,
    historyReturnMax,
    historyReturnWindow,
  } = req.body ?? {};

  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  const checkUint = (v: any, name: string, max = 100000) => {
    if (v === undefined) return null;
    if (typeof v !== 'number' || v < 0 || v > max) return `${name} must be between 0 and ${max}`;
    return null;
  };
  const errs = [
    checkUint(records, 'records', 100000),
    checkUint(historyReturnMax, 'historyReturnMax', 100000),
    checkUint(historyReturnWindow, 'historyReturnWindow', 1440), // window is in minutes; 24h cap
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setStoreForwardConfig({
      enabled,
      isServer: typeof isServer === 'boolean' ? isServer : undefined,
      heartbeat: typeof heartbeat === 'boolean' ? heartbeat : undefined,
      records,
      historyReturnMax,
      historyReturnWindow,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// MQTT module: refresh + write
app.post('/api/mesh/modules/mqtt/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestMqttConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/mqtt', async (req, res) => {
  const body = req.body ?? {};
  const requireBool = (v: any, name: string) => typeof v === 'boolean' ? null : `${name} must be a boolean`;
  const requireString = (v: any, name: string, maxLen = 255) =>
    typeof v === 'string' && v.length <= maxLen ? null : `${name} must be a string ≤ ${maxLen} chars`;

  const errs: (string | null)[] = [
    requireBool(body.enabled, 'enabled'),
    requireString(body.address, 'address', 200),
    requireString(body.username, 'username', 100),
    requireString(body.password, 'password', 200),
    requireBool(body.encryptionEnabled, 'encryptionEnabled'),
    requireBool(body.jsonEnabled, 'jsonEnabled'),
    requireBool(body.tlsEnabled, 'tlsEnabled'),
    requireString(body.root, 'root', 100),
    requireBool(body.proxyToClientEnabled, 'proxyToClientEnabled'),
    requireBool(body.mapReportingEnabled, 'mapReportingEnabled'),
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setMqttConfig({
      enabled: body.enabled,
      address: body.address,
      username: body.username,
      password: body.password,
      encryptionEnabled: body.encryptionEnabled,
      jsonEnabled: body.jsonEnabled,
      tlsEnabled: body.tlsEnabled,
      root: body.root,
      proxyToClientEnabled: body.proxyToClientEnabled,
      mapReportingEnabled: body.mapReportingEnabled,
      // Pass-through: if the client has a captured raw MapReportSettings, echo it.
      mapReportSettingsRaw: typeof body.mapReportSettingsRaw === 'string' ? body.mapReportSettingsRaw : null,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Detection Sensor module: refresh + write
app.post('/api/mesh/modules/detection-sensor/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestDetectionSensorConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/detection-sensor', async (req, res) => {
  const body = req.body ?? {};
  const requireBool = (v: any, name: string) => typeof v === 'boolean' ? null : `${name} must be a boolean`;
  const requireUint = (v: any, name: string, max: number) =>
    typeof v === 'number' && v >= 0 && v <= max ? null : `${name} must be 0..${max}`;
  const requireString = (v: any, name: string, max: number) =>
    typeof v === 'string' && v.length <= max ? null : `${name} must be a string ≤ ${max} chars`;

  const errs: (string | null)[] = [
    requireBool(body.enabled, 'enabled'),
    requireUint(body.minimumBroadcastSecs, 'minimumBroadcastSecs', 86400),
    requireUint(body.stateBroadcastSecs, 'stateBroadcastSecs', 86400),
    requireBool(body.sendBell, 'sendBell'),
    requireString(body.name, 'name', 20),
    requireUint(body.monitorPin, 'monitorPin', 64),
    requireBool(body.detectionTriggeredHigh, 'detectionTriggeredHigh'),
    requireBool(body.usePullup, 'usePullup'),
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setDetectionSensorConfig({
      enabled: body.enabled,
      minimumBroadcastSecs: body.minimumBroadcastSecs,
      stateBroadcastSecs: body.stateBroadcastSecs,
      sendBell: body.sendBell,
      name: body.name,
      monitorPin: body.monitorPin,
      detectionTriggeredHigh: body.detectionTriggeredHigh,
      usePullup: body.usePullup,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Audio module: refresh + write
app.post('/api/mesh/modules/audio/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestAudioConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/audio', async (req, res) => {
  const body = req.body ?? {};
  const requireBool = (v: any, name: string) => typeof v === 'boolean' ? null : `${name} must be a boolean`;
  const requireUint = (v: any, name: string, max: number) =>
    typeof v === 'number' && v >= 0 && v <= max ? null : `${name} must be 0..${max}`;

  const errs: (string | null)[] = [
    requireBool(body.codec2Enabled, 'codec2Enabled'),
    requireUint(body.pttPin, 'pttPin', 64),
    requireUint(body.bitrate, 'bitrate', 16),
    requireUint(body.i2sWs, 'i2sWs', 64),
    requireUint(body.i2sSd, 'i2sSd', 64),
    requireUint(body.i2sDin, 'i2sDin', 64),
    requireUint(body.i2sSck, 'i2sSck', 64),
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setAudioConfig({
      codec2Enabled: body.codec2Enabled,
      pttPin: body.pttPin,
      bitrate: body.bitrate,
      i2sWs: body.i2sWs,
      i2sSd: body.i2sSd,
      i2sDin: body.i2sDin,
      i2sSck: body.i2sSck,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Serial module: refresh + write
app.post('/api/mesh/modules/serial/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestSerialConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/serial', async (req, res) => {
  const body = req.body ?? {};
  const requireBool = (v: any, name: string) => typeof v === 'boolean' ? null : `${name} must be a boolean`;
  const requireUint = (v: any, name: string, max: number) =>
    typeof v === 'number' && v >= 0 && v <= max ? null : `${name} must be 0..${max}`;

  const errs: (string | null)[] = [
    requireBool(body.enabled, 'enabled'),
    requireBool(body.echo, 'echo'),
    requireUint(body.rxd, 'rxd', 64),
    requireUint(body.txd, 'txd', 64),
    requireUint(body.baud, 'baud', 15),
    requireUint(body.timeout, 'timeout', 60000),
    requireUint(body.mode, 'mode', 7),
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setSerialConfig({
      enabled: body.enabled,
      echo: body.echo,
      rxd: body.rxd,
      txd: body.txd,
      baud: body.baud,
      timeout: body.timeout,
      mode: body.mode,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Ambient Lighting module: refresh + write
app.post('/api/mesh/modules/ambient-lighting/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestAmbientLightingConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/ambient-lighting', async (req, res) => {
  const body = req.body ?? {};
  const requireBool = (v: any, name: string) => typeof v === 'boolean' ? null : `${name} must be a boolean`;
  const requireUint = (v: any, name: string, max: number) =>
    typeof v === 'number' && v >= 0 && v <= max ? null : `${name} must be 0..${max}`;

  const errs: (string | null)[] = [
    requireBool(body.ledState, 'ledState'),
    requireUint(body.current, 'current', 255),
    requireUint(body.red, 'red', 255),
    requireUint(body.green, 'green', 255),
    requireUint(body.blue, 'blue', 255),
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setAmbientLightingConfig({
      ledState: body.ledState,
      current: body.current,
      red: body.red,
      green: body.green,
      blue: body.blue,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Paxcounter module: refresh + write
app.post('/api/mesh/modules/paxcounter/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestPaxcounterConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/paxcounter', async (req, res) => {
  const body = req.body ?? {};
  const requireBool = (v: any, name: string) => typeof v === 'boolean' ? null : `${name} must be a boolean`;
  const requireUint = (v: any, name: string, max: number) =>
    typeof v === 'number' && v >= 0 && v <= max ? null : `${name} must be 0..${max}`;

  const errs: (string | null)[] = [
    requireBool(body.enabled, 'enabled'),
    requireUint(body.updateIntervalSecs, 'updateIntervalSecs', 86400),
    requireUint(body.wifiThreshold, 'wifiThreshold', 255),
    requireUint(body.bleThreshold, 'bleThreshold', 255),
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setPaxcounterConfig({
      enabled: body.enabled,
      updateIntervalSecs: body.updateIntervalSecs,
      wifiThreshold: body.wifiThreshold,
      bleThreshold: body.bleThreshold,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Remote Hardware module: refresh + write
app.post('/api/mesh/modules/remote-hardware/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestRemoteHardwareConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/remote-hardware', async (req, res) => {
  const body = req.body ?? {};
  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  if (typeof body.allowUndefinedPinAccess !== 'boolean') {
    return res.status(400).json({ error: 'allowUndefinedPinAccess must be a boolean' });
  }
  if (!Array.isArray(body.availablePins)) {
    return res.status(400).json({ error: 'availablePins must be an array' });
  }
  // Validate each pin
  const pins: { gpioPin: number; name: string; type: number }[] = [];
  for (let i = 0; i < body.availablePins.length; i++) {
    const p = body.availablePins[i];
    if (typeof p !== 'object' || p === null) {
      return res.status(400).json({ error: `availablePins[${i}] must be an object` });
    }
    if (typeof p.gpioPin !== 'number' || p.gpioPin < 0 || p.gpioPin > 64) {
      return res.status(400).json({ error: `availablePins[${i}].gpioPin must be 0..64` });
    }
    if (typeof p.name !== 'string') {
      return res.status(400).json({ error: `availablePins[${i}].name must be a string` });
    }
    if (typeof p.type !== 'number' || p.type < 0 || p.type > 3) {
      return res.status(400).json({ error: `availablePins[${i}].type must be 0..3` });
    }
    pins.push({ gpioPin: p.gpioPin, name: p.name.slice(0, 32), type: p.type });
  }

  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setRemoteHardwareConfig({
      enabled: body.enabled,
      allowUndefinedPinAccess: body.allowUndefinedPinAccess,
      availablePins: pins,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// External Notification module: refresh + write
app.post('/api/mesh/modules/external-notification/refresh', async (_req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestExternalNotificationConfig();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/mesh/modules/external-notification', async (req, res) => {
  const body = req.body ?? {};
  const requireBool = (v: any, name: string) => typeof v === 'boolean' ? null : `${name} must be a boolean`;
  const requireUint = (v: any, name: string, max: number) =>
    typeof v === 'number' && v >= 0 && v <= max ? null : `${name} must be a number between 0 and ${max}`;

  const errs: (string | null)[] = [
    requireBool(body.enabled, 'enabled'),
    requireBool(body.active, 'active'),
    requireBool(body.alertMessage, 'alertMessage'),
    requireBool(body.alertBell, 'alertBell'),
    requireBool(body.usePwm, 'usePwm'),
    requireBool(body.alertMessageVibra, 'alertMessageVibra'),
    requireBool(body.alertMessageBuzzer, 'alertMessageBuzzer'),
    requireBool(body.alertBellVibra, 'alertBellVibra'),
    requireBool(body.alertBellBuzzer, 'alertBellBuzzer'),
    requireBool(body.useI2sAsBuzzer, 'useI2sAsBuzzer'),
    requireUint(body.outputMs, 'outputMs', 60_000),
    requireUint(body.output, 'output', 64),
    requireUint(body.outputVibra, 'outputVibra', 64),
    requireUint(body.outputBuzzer, 'outputBuzzer', 64),
    requireUint(body.nagTimeout, 'nagTimeout', 86400),
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.setExternalNotificationConfig({
      enabled: body.enabled,
      outputMs: body.outputMs,
      output: body.output,
      active: body.active,
      alertMessage: body.alertMessage,
      alertBell: body.alertBell,
      usePwm: body.usePwm,
      outputVibra: body.outputVibra,
      outputBuzzer: body.outputBuzzer,
      alertMessageVibra: body.alertMessageVibra,
      alertMessageBuzzer: body.alertMessageBuzzer,
      alertBellVibra: body.alertBellVibra,
      alertBellBuzzer: body.alertBellBuzzer,
      nagTimeout: body.nagTimeout,
      useI2sAsBuzzer: body.useI2sAsBuzzer,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Range Test: aggregated coverage observations for the map / coverage view.
app.get('/api/mesh/range-test/coverage', (req, res) => {
  // windowMs=0 (or omitted) means "all"; otherwise observations from the last `windowMs` ms.
  const wRaw = String(req.query.windowMs ?? '0');
  const windowMs = Math.max(0, Math.min(parseInt(wRaw, 10) || 0, 90 * 24 * 3600 * 1000));
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '5000'), 10) || 5000, 20000));
  try {
    const rows = meshDb().getRangeTestObservations(windowMs || undefined, limit);

    // Aggregate per sender: count, best/worst/avg SNR + RSSI, latest position.
    type Agg = {
      senderId: string;
      count: number;
      bestSnr: number | null;
      worstSnr: number | null;
      sumSnr: number;
      snrSamples: number;
      bestRssi: number | null;
      worstRssi: number | null;
      sumRssi: number;
      rssiSamples: number;
      lastSeen: number;
      lastLat: number | null;
      lastLng: number | null;
    };
    const bySender = new Map<string, Agg>();
    for (const r of rows) {
      let a = bySender.get(r.senderId);
      if (!a) {
        a = {
          senderId: r.senderId, count: 0,
          bestSnr: null, worstSnr: null, sumSnr: 0, snrSamples: 0,
          bestRssi: null, worstRssi: null, sumRssi: 0, rssiSamples: 0,
          lastSeen: 0, lastLat: null, lastLng: null,
        };
        bySender.set(r.senderId, a);
      }
      a.count += 1;
      if (typeof r.snr === 'number') {
        a.sumSnr += r.snr; a.snrSamples += 1;
        a.bestSnr = a.bestSnr == null ? r.snr : Math.max(a.bestSnr, r.snr);
        a.worstSnr = a.worstSnr == null ? r.snr : Math.min(a.worstSnr, r.snr);
      }
      if (typeof r.rssi === 'number') {
        a.sumRssi += r.rssi; a.rssiSamples += 1;
        a.bestRssi = a.bestRssi == null ? r.rssi : Math.max(a.bestRssi, r.rssi);
        a.worstRssi = a.worstRssi == null ? r.rssi : Math.min(a.worstRssi, r.rssi);
      }
      if (r.timestamp > a.lastSeen) {
        a.lastSeen = r.timestamp;
        if (r.senderLat != null && r.senderLng != null) {
          a.lastLat = r.senderLat; a.lastLng = r.senderLng;
        }
      }
    }

    const aggregates = Array.from(bySender.values()).map(a => ({
      senderId: a.senderId,
      count: a.count,
      avgSnr: a.snrSamples ? a.sumSnr / a.snrSamples : null,
      bestSnr: a.bestSnr,
      worstSnr: a.worstSnr,
      avgRssi: a.rssiSamples ? a.sumRssi / a.rssiSamples : null,
      bestRssi: a.bestRssi,
      worstRssi: a.worstRssi,
      lastSeen: a.lastSeen,
      lastLat: a.lastLat,
      lastLng: a.lastLng,
    }));

    return res.json({
      windowMs,
      total: rows.length,
      aggregates,
      observations: rows,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Store & Forward: list routers, request history replay
app.get('/api/mesh/store-forward', (_req, res) => {
  return res.json(meshBridge.getStoreForwardRouters());
});

app.post('/api/mesh/store-forward/request-history', async (req, res) => {
  const { to, windowMinutes, channel } = req.body ?? {};
  if (typeof to !== 'string' || !to.startsWith('!')) {
    return res.status(400).json({ error: 'to must be a !hex node id' });
  }
  const minutes = typeof windowMinutes === 'number' ? windowMinutes : 60;
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
    return res.status(400).json({ error: 'windowMinutes must be between 1 and 1440' });
  }
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    await meshBridge.requestStoreForwardHistory(to, minutes, typeof channel === 'number' ? channel : 0);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Waypoints: list / create-update / delete
app.get('/api/mesh/waypoints', (_req, res) => {
  return res.json(meshBridge.getWaypoints());
});

app.post('/api/mesh/waypoints', (req, res) => {
  const { id, lat, lng, name, description, icon, expire, lockedToSelf, channel } = req.body ?? {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng must be numbers' });
  }
  try {
    const wp = meshBridge.sendWaypoint(
      { id, lat, lng, name, description, icon, expire, lockedToSelf },
      typeof channel === 'number' ? channel : 0,
    );
    return res.json({ ok: true, waypoint: wp });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/mesh/waypoints/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid waypoint id' });
  }
  try {
    const ok = meshBridge.deleteWaypoint(id);
    return res.json({ ok });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Traceroute: kick off a request, get the requestId back. The actual response
// arrives asynchronously and is broadcast via SSE + included in /snapshot.
app.post('/api/mesh/traceroute', async (req, res) => {
  const { to, channel } = req.body ?? {};
  if (typeof to !== 'string' || !to.startsWith('!')) {
    return res.status(400).json({ error: 'to must be a !hex node id' });
  }
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  try {
    const r = await meshBridge.sendTraceroute(to, typeof channel === 'number' ? channel : 0);
    return res.json({ ok: true, requestId: r.requestId });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/mesh/traces', (_req, res) => {
  return res.json(meshBridge.getTraces());
});

/**
 * Route Intel — per-pair detail. Aggregates from the in-memory `messages`
 * cache + node session history. Computes delivery rate, avg latency (from the
 * `delivery_ms` column captured at ACK), most-common hop sequence, and a
 * relay-frequency table. The `windowMs` query param caps the historical window
 * (default 24h, max 30d).
 */
app.get('/api/mesh/route-intel/pair', (req, res) => {
  const fromId = String(req.query.from ?? '');
  const toId = String(req.query.to ?? '');
  if (!fromId || !toId) return res.status(400).json({ error: 'from and to are required' });

  const windowMs = Math.max(60_000, Math.min(parseInt(String(req.query.windowMs ?? ''), 10) || 24 * 3600_000, 30 * 24 * 3600_000));
  const sinceMs = Date.now() - windowMs;

  try {
    const allMessages = meshBridge.getMessages();
    // Filter on the in-memory cache; channel = "" or "BroadcastDM peer" — we
    // match by from/to ids regardless of channel since the same pair can
    // happen on either DM or a broadcast channel.
    const subset = allMessages.filter(m =>
      m.from === fromId &&
      m.to === toId &&
      m.timestamp >= sinceMs &&
      !m.isReaction
    );

    if (subset.length === 0) {
      return res.json({
        fromId, toId, totalMessages: 0,
        successful: 0, failed: 0, pending: 0, successRate: null,
        avgDeliveryMs: null, bestRoute: [], relays: [], windowMs,
      });
    }

    let successful = 0, failed = 0, pending = 0;
    let sumLatency = 0, latencySamples = 0;
    const relayCounts = new Map<string, { count: number; success: number; sumLatency: number; latencySamples: number }>();
    const routeCounts = new Map<string, number>();

    for (const m of subset) {
      if (m.status === 'acked') successful++;
      else if (m.status === 'error') failed++;
      else pending++;

      if (typeof m.deliveryMs === 'number') {
        sumLatency += m.deliveryMs;
        latencySamples += 1;
      }

      // Hops array: includes from + relays + to (both endpoints included by
      // the bridge today). Strip the endpoints to derive intermediate relays.
      const hops = Array.isArray(m.hops) ? m.hops : [];
      const relays = hops.filter(h => h !== fromId && h !== toId);
      for (const r of relays) {
        let acc = relayCounts.get(r);
        if (!acc) { acc = { count: 0, success: 0, sumLatency: 0, latencySamples: 0 }; relayCounts.set(r, acc); }
        acc.count += 1;
        if (m.status === 'acked') acc.success += 1;
        if (typeof m.deliveryMs === 'number') {
          acc.sumLatency += m.deliveryMs;
          acc.latencySamples += 1;
        }
      }
      // "Best route" = the most common ordered relay sequence
      if (relays.length > 0) {
        const key = relays.join('>');
        routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
      }
    }

    let bestRoute: string[] = [];
    let bestRouteCount = 0;
    for (const [key, n] of routeCounts) {
      if (n > bestRouteCount) { bestRoute = key.split('>'); bestRouteCount = n; }
    }

    const total = subset.length;
    const totalEnded = successful + failed; // exclude pending from rate
    const aggregateRelays = Array.from(relayCounts.entries()).map(([nodeId, a]) => {
      const node = meshBridge.getNodes().find(n => n.id === nodeId);
      return {
        nodeId,
        nodeName: node?.name || node?.shortName || nodeId,
        relayPercent: total ? (a.count / total) * 100 : 0,
        successRate: a.count ? (a.success / a.count) * 100 : 0,
        avgDeliveryMs: a.latencySamples ? a.sumLatency / a.latencySamples : null,
        count: a.count,
      };
    }).sort((a, b) => b.count - a.count);

    return res.json({
      fromId,
      toId,
      fromName: meshBridge.getNodes().find(n => n.id === fromId)?.name ?? fromId,
      toName: meshBridge.getNodes().find(n => n.id === toId)?.name ?? toId,
      totalMessages: total,
      successful,
      failed,
      pending,
      successRate: totalEnded ? (successful / totalEnded) * 100 : null,
      avgDeliveryMs: latencySamples ? sumLatency / latencySamples : null,
      bestRoute,
      relays: aggregateRelays,
      windowMs,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Route Intel — per-node uptime stats over a window. Computes uptime %,
 * session count, average session length, and a 24-hour peak-hours histogram
 * from the node_sessions table. Useful both for the Dashboard's per-node
 * NODE_DETAILS widget and for the send-window heatmap inside the matrix's
 * pair drill-down.
 */
app.get('/api/mesh/route-intel/uptime', (req, res) => {
  const windowMs = Math.max(3600_000, Math.min(parseInt(String(req.query.windowMs ?? ''), 10) || 7 * 24 * 3600_000, 30 * 24 * 3600_000));
  const nodeId = req.query.nodeId ? String(req.query.nodeId) : null;
  try {
    const all = meshDb().computeNodeUptime(windowMs);
    const filtered = nodeId ? all.filter(s => s.nodeId === nodeId) : all;
    const nodes = meshBridge.getNodes();
    const enriched = filtered.map(s => {
      const node = nodes.find(n => n.id === s.nodeId);
      return {
        ...s,
        nodeName: node?.name || node?.shortName || s.nodeId,
        currentlyOnline: !!node?.online,
        uptimePercent: windowMs > 0 ? Math.min(100, (s.onlineMs / windowMs) * 100) : 0,
      };
    });
    return res.json({ windowMs, results: enriched });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// --- Event-log retention (how long to keep entries in the event stream) ---
const RETENTION_CONFIG_PATH = join(dataDir, 'log-retention.json');
const ALLOWED_RETENTION_HOURS = [6, 24, 36, 48, 72];

function loadRetention(): number {
  try {
    if (existsSync(RETENTION_CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(RETENTION_CONFIG_PATH, 'utf-8'));
      if (typeof saved.hours === 'number' && ALLOWED_RETENTION_HOURS.includes(saved.hours)) {
        return saved.hours;
      }
    }
  } catch { /* fall through */ }
  return 24; // default
}

function saveRetention(hours: number) {
  try { writeFileSync(RETENTION_CONFIG_PATH, JSON.stringify({ hours }, null, 2), 'utf-8'); }
  catch (err: any) { console.error('[API] saveRetention failed:', err.message); }
}

// --- Message retention (parallel to event retention; 0 = keep all up to count cap) ---
const MESSAGE_RETENTION_CONFIG_PATH = join(dataDir, 'message-retention.json');
// 0 = unlimited (count cap only); other values are days converted to hours.
const ALLOWED_MESSAGE_RETENTION_HOURS = [0, 24, 24 * 3, 24 * 7, 24 * 30, 24 * 90];

function loadMessageRetention(): number {
  try {
    if (existsSync(MESSAGE_RETENTION_CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(MESSAGE_RETENTION_CONFIG_PATH, 'utf-8'));
      if (typeof saved.hours === 'number' && ALLOWED_MESSAGE_RETENTION_HOURS.includes(saved.hours)) {
        return saved.hours;
      }
    }
  } catch { /* fall through */ }
  return 0; // default: no time-based prune
}

function saveMessageRetention(hours: number) {
  try { writeFileSync(MESSAGE_RETENTION_CONFIG_PATH, JSON.stringify({ hours }, null, 2), 'utf-8'); }
  catch (err: any) { console.error('[API] saveMessageRetention failed:', err.message); }
}

// Apply persisted retention on boot.
try { meshBridge.setEventRetention(loadRetention()); } catch (err: any) {
  console.error('[API] could not apply persisted retention:', err.message);
}
try { meshBridge.setMessageRetention(loadMessageRetention()); } catch (err: any) {
  console.error('[API] could not apply persisted message retention:', err.message);
}

app.get('/api/mesh/log-retention', (_req, res) => {
  return res.json({ hours: meshBridge.getEventRetention(), allowed: ALLOWED_RETENTION_HOURS });
});

app.post('/api/mesh/log-retention', (req, res) => {
  const { hours } = req.body ?? {};
  if (typeof hours !== 'number' || !ALLOWED_RETENTION_HOURS.includes(hours)) {
    return res.status(400).json({ error: `hours must be one of ${ALLOWED_RETENTION_HOURS.join(', ')}` });
  }
  try {
    meshBridge.setEventRetention(hours);
    saveRetention(hours);
    return res.json({ ok: true, hours });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/mesh/message-retention', (_req, res) => {
  return res.json({ hours: meshBridge.getMessageRetention(), allowed: ALLOWED_MESSAGE_RETENTION_HOURS });
});

app.post('/api/mesh/message-retention', (req, res) => {
  const { hours } = req.body ?? {};
  if (typeof hours !== 'number' || !ALLOWED_MESSAGE_RETENTION_HOURS.includes(hours)) {
    return res.status(400).json({ error: `hours must be one of ${ALLOWED_MESSAGE_RETENTION_HOURS.join(', ')}` });
  }
  try {
    meshBridge.setMessageRetention(hours);
    saveMessageRetention(hours);
    return res.json({ ok: true, hours });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Database stats (counts of persisted rows)
app.get('/api/mesh/db/stats', (_req, res) => {
  try {
    return res.json(meshDb().stats());
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/mesh/db/disk — comprehensive disk-usage inventory for the
 * Settings → Disk panel. Returns per-table row counts + oldest/newest
 * timestamps + retention policy descriptions, plus file-size measurements
 * for the SQLite DB itself (including the WAL sidecar).
 */
app.get('/api/mesh/db/disk', (_req, res) => {
  try {
    const db = meshDb();
    const dbPath = db.getDbPath();

    // File sizes — SQLite WAL mode creates -wal and -shm sidecars; sum them
    // so the operator sees the true on-disk footprint, not just the main file.
    const fileSize = (p: string): number => {
      try { return require('fs').statSync(p).size as number; } catch { return 0; }
    };
    const mainBytes = fileSize(dbPath);
    const walBytes  = fileSize(`${dbPath}-wal`);
    const shmBytes  = fileSize(`${dbPath}-shm`);

    return res.json({
      dbPath,
      onDisk: {
        main: mainBytes,
        wal:  walBytes,
        shm:  shmBytes,
        total: mainBytes + walBytes + shmBytes,
      },
      logicalBytes: db.logicalDbBytes(),
      tables: db.diskInventory(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/** POST /api/mesh/db/vacuum — reclaim space from deleted rows. Blocks until
 *  done (could be seconds on a large DB). UI should confirm before calling. */
app.post('/api/mesh/db/vacuum', (_req, res) => {
  try {
    const result = meshDb().vacuum();
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Telemetry history for one node
app.get('/api/mesh/nodes/:id/telemetry', (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 2000);
  try {
    return res.json(meshDb().getTelemetryHistory(req.params.id, limit));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/** GET /api/mesh/nodes/:id/positions — per-node position history (newest first). */
app.get('/api/mesh/nodes/:id/positions', (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 2000);
  try {
    return res.json(meshDb().loadPositionHistory(req.params.id, limit));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/mesh/nodes/:id/traces — trace results targeting this node.
 * Reuses the global trace results table filtered by target_id. Useful for the
 * iOS-style Trace Route Log section on the node detail panel.
 */
app.get('/api/mesh/nodes/:id/traces', (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 500);
  try {
    const all = meshDb().loadTraceResults(2000);
    const filtered = all.filter(t => t.targetId === req.params.id).slice(0, limit);
    return res.json(filtered);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Channel configuration. v2.0 Phase 4: optional ?radio_id picks the source
// radio so an operator with multiple radios can read each radio's channel
// list independently. Omitting the param returns the default radio's.
app.get('/api/mesh/channels', (req, res) => {
  const radioId = typeof req.query.radio_id === 'string' && req.query.radio_id ? req.query.radio_id : null;
  if (radioId) {
    const ctx = bridgeManager.get(radioId);
    if (!ctx) return res.status(404).json({ error: `radio "${radioId}" is not currently connected` });
    return res.json(ctx.bridge.getChannels());
  }
  // v2.0 Beta 3 bugfix: no radio_id → return the default radio's bridge
  // channels from BridgeManager, NOT meshBridge directly. See the analogous
  // fix in /api/mesh/snapshot — these two paths must agree on which bridge
  // instance is authoritative for the default radio.
  const defaultBridge = bridgeManager.getDefault()?.bridge ?? meshBridge;
  return res.json(defaultBridge.getChannels());
});

// v2.0 Phase 4: same optional `radio_id` in the body routes the channel
// write to a specific bridge. Channel-share imports use this to apply a
// pasted URL to whichever radio the operator picks in the import overlay.
app.post('/api/mesh/channels', async (req, res) => {
  const channels = req.body?.channels;
  const radioIdRaw = req.body?.radio_id;
  if (!Array.isArray(channels)) return res.status(400).json({ error: 'Body must be { channels: [...] }' });

  const radioId = typeof radioIdRaw === 'string' && radioIdRaw ? radioIdRaw : null;
  const ctx = radioId ? bridgeManager.get(radioId) : null;
  const bridge = ctx?.bridge ?? meshBridge;
  if (radioId && !ctx) {
    return res.status(404).json({ error: `radio "${radioId}" is not currently connected` });
  }
  if (!bridge.connected) return res.status(503).json({ error: 'Radio not connected' });

  try {
    await bridge.setChannels(channels);
    return res.json({ ok: true, radioId: bridge.getRadioId() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// BBS Mail endpoints
// ---------------------------------------------------------------------

/** GET /api/mesh/bbs/config — current BBS configuration. */
app.get('/api/mesh/bbs/config', (_req, res) => {
  return res.json(bbsConfig);
});

/**
 * POST /api/mesh/bbs/config — replace the BBS configuration. Inputs are
 * normalized (trigger lowercase, body cap clamped, ZIP validated) before
 * being applied; an invalid POST won't brick the BBS, it just gets safe
 * defaults for the bad fields. The live BbsService picks up the new config
 * immediately and the weather poller will pick up the new home ZIP on its
 * next tick (or right now via pollNow if the ZIP changed).
 */
app.post('/api/mesh/bbs/config', (req, res) => {
  try {
    const oldZip = bbsConfig.homeZipCode;
    bbsConfig = normalizeBbsConfig(req.body ?? {});
    saveBbsConfig(bbsConfig);
    // v2.0: fan the config out to every per-radio BbsService.
    bridgeManager.setBbsConfig(bbsConfig);
    // If the home ZIP changed (or just got set), trigger a poll right away
    // so the operator sees alerts within seconds instead of waiting 20 min.
    if (bbsConfig.homeZipCode && bbsConfig.homeZipCode !== oldZip) {
      weatherPoller.pollNow().catch(err =>
        console.warn('[BBSConfig] immediate weather poll failed:', err?.message)
      );
    }
    // Fan out to all SSE clients so other dashboard tabs re-render their
    // settings panel with the new values.
    for (const send of sseClients) {
      try { send(`event: bbsConfig\ndata: ${JSON.stringify(bbsConfig)}\n\n`); } catch { /* client gone */ }
    }
    return res.json({ ok: true, config: bbsConfig });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/** GET /api/mesh/bbs/inbox?nodeId=<hex>&radio_id=<short>  — defaults to local node + all radios */
app.get('/api/mesh/bbs/inbox', (req, res) => {
  const localNodeId = (meshBridge as any).localNodeId as string | null;
  const nodeId = (req.query.nodeId as string) || localNodeId;
  if (!nodeId) return res.status(400).json({ error: 'nodeId required (local node unknown)' });
  const limit = parseInt(String(req.query.limit ?? '200'), 10) || 200;
  // v2.0: optional radio_id filter scopes the inbox to one radio's mail.
  const radioId = typeof req.query.radio_id === 'string' && req.query.radio_id ? req.query.radio_id : null;
  try {
    return res.json({
      nodeId,
      radioId,
      unread: meshDb().countUnread(nodeId, radioId),
      mail: meshDb().loadInbox(nodeId, Math.min(500, Math.max(1, limit)), radioId),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/** GET /api/mesh/bbs/outbox?nodeId=<hex>&radio_id=<short>  — defaults to local node + all radios */
app.get('/api/mesh/bbs/outbox', (req, res) => {
  const localNodeId = (meshBridge as any).localNodeId as string | null;
  const nodeId = (req.query.nodeId as string) || localNodeId;
  if (!nodeId) return res.status(400).json({ error: 'nodeId required (local node unknown)' });
  const limit = parseInt(String(req.query.limit ?? '200'), 10) || 200;
  const radioId = typeof req.query.radio_id === 'string' && req.query.radio_id ? req.query.radio_id : null;
  try {
    return res.json({
      nodeId,
      radioId,
      mail: meshDb().loadOutbox(nodeId, Math.min(500, Math.max(1, limit)), radioId),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mesh/bbs/compose
 * { recipientNodeId, body }
 *
 * Sender = local node (the dashboard operator). The body is capped at 200
 * chars at the DB layer; we trim and reject empty here for a clearer error.
 * Push notification fires the same as a remote-sourced send.
 */
app.post('/api/mesh/bbs/compose', async (req, res) => {
  const { recipientNodeId, body, radio_id: radioIdRaw } = req.body ?? {};
  if (typeof recipientNodeId !== 'string' || !/^![0-9a-f]{8}$/i.test(recipientNodeId)) {
    return res.status(400).json({ error: 'recipientNodeId must be a hex node id like !02eb3bec' });
  }
  if (typeof body !== 'string') return res.status(400).json({ error: 'body required' });
  const clean = body.trim().slice(0, 200);
  if (!clean) return res.status(400).json({ error: 'body must be non-empty' });

  // v2.0: optional radio_id routes the compose through a specific radio's
  // bridge. Omit to use the default radio (1.x behavior).
  const radioId = typeof radioIdRaw === 'string' && radioIdRaw ? radioIdRaw : null;
  const ctx = radioId ? bridgeManager.get(radioId) : null;
  const bridge = ctx?.bridge ?? meshBridge;
  if (radioId && !ctx) {
    return res.status(404).json({ error: `radio "${radioId}" is not currently connected` });
  }
  const localNodeId = (bridge as any).localNodeId as string | null;
  if (!localNodeId) return res.status(503).json({ error: 'Local node not identified — radio still booting' });
  if (!bridge.connected) return res.status(503).json({ error: 'Radio not connected' });

  const localNode = bridge.getNodes().find(n => n.id === localNodeId);
  const recipientNode = bridge.getNodes().find(n => n.id === recipientNodeId.toLowerCase());
  if (!recipientNode) return res.status(404).json({ error: `Unknown recipient ${recipientNodeId} on radio ${bridge.getRadioId() ?? '<default>'}` });

  try {
    const mailId = meshDb().insertMail({
      sender_node_id: localNodeId,
      sender_short_name: localNode?.shortName || localNodeId.slice(-4),
      recipient_node_id: recipientNodeId.toLowerCase(),
      posted_at: Date.now(),
      body: clean,
      radio_id: bridge.getRadioId(),
    });
    bridge.emit('bbsMail', { recipientNodeId: recipientNodeId.toLowerCase(), mailId, source: 'dashboard' });
    // Push notify the recipient via DM. Fire-and-forget; the mail is stored
    // regardless of notification success.
    const sender = localNode?.shortName || localNodeId.slice(-4);
    const notice = `✉ Mail from ${sender}. DM :mail R to read.`;
    bridge.sendMessage(notice, recipientNodeId.toLowerCase(), 0)
      .then(() => meshDb().markMailDelivered(mailId))
      .catch(err => console.warn(`[BBS API] push notify failed: ${err?.message}`));
    return res.json({ ok: true, mailId, radioId: bridge.getRadioId() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/** POST /api/mesh/bbs/:id/read  — mark a piece of mail as read */
app.post('/api/mesh/bbs/:id/read', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = meshDb().markMailRead(id);
  if (ok) meshBridge.emit('bbsMail', { mailId: id, read: true });
  return res.json({ ok });
});

/** DELETE /api/mesh/bbs/:id  — delete a piece of mail */
app.delete('/api/mesh/bbs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = meshDb().deleteMail(id);
  if (ok) meshBridge.emit('bbsMail', { mailId: id, deleted: true });
  return res.json({ ok });
});

/**
 * GET /api/mesh/bbs/users — list of every node that has sent or received mail
 * through this BBS, with sent / received / unread counts and last-activity
 * timestamp. Sorted newest-activity-first.
 */
app.get('/api/mesh/bbs/users', (_req, res) => {
  try {
    const users = meshDb().listMailUsers();
    // Decorate with the local node's friendly name + short_name when known,
    // so the UI doesn't have to re-fetch nodes just to label rows.
    const nodes = meshBridge.getNodes();
    const nodeByid = new Map(nodes.map(n => [n.id, n]));
    const localNodeId = (meshBridge as any).localNodeId as string | null;
    const decorated = users.map(u => {
      const node = nodeByid.get(u.nodeId);
      return {
        ...u,
        name: node?.name || null,
        shortName: node?.shortName || null,
        isLocal: u.nodeId === localNodeId,
      };
    });
    return res.json({ users: decorated, total: decorated.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/** GET /api/mesh/bbs/weather/subscribers?radio_id=<short>  — list of nodes opted into alerts. */
app.get('/api/mesh/bbs/weather/subscribers', (req, res) => {
  const radioId = typeof req.query.radio_id === 'string' && req.query.radio_id ? req.query.radio_id : null;
  try {
    return res.json({
      subscribers: meshDb().listWeatherSubscribers(radioId),
      total: meshDb().countWeatherSubscribers(radioId),
      radioId,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/mesh/bbs/weather/subscribers/:nodeId — operator-side removal.
 *  Useful when a subscriber goes silent / is removed from the mesh and you
 *  want to stop trying to push them alerts. */
app.delete('/api/mesh/bbs/weather/subscribers/:nodeId', (req, res) => {
  const nodeId = req.params.nodeId;
  if (!/^![0-9a-f]{8}$/i.test(nodeId)) {
    return res.status(400).json({ error: 'nodeId must be a hex node id like !02ea5e70' });
  }
  try {
    const ok = meshDb().removeWeatherSubscriber(nodeId.toLowerCase());
    if (ok) meshBridge.emit('bbsSubscriber', { nodeId, action: 'unsubscribed' });
    return res.json({ ok });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Send a text message through the radio (also handles replies and reactions).
// v2.0 Phase 4: optional `radio_id` in the body picks the originating radio;
// when omitted, falls back to the default radio so 1.x clients keep working.
app.post('/api/mesh/send', async (req, res) => {
  const { text, to, channel, replyTo, isReaction, radio_id: radioIdRaw } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const radioId = typeof radioIdRaw === 'string' && radioIdRaw ? radioIdRaw : null;
  // Resolve the target bridge: explicit radio_id → that context's bridge;
  // otherwise the singleton (= default radio).
  const ctx = radioId ? bridgeManager.get(radioId) : null;
  const bridge = ctx?.bridge ?? meshBridge;
  if (radioId && !ctx) {
    return res.status(404).json({ error: `radio "${radioId}" is not currently connected` });
  }
  if (!bridge.connected) return res.status(503).json({ error: 'Radio not connected' });

  try {
    const messageId = await bridge.sendMessage(text, to || '!ffffffff', channel ?? 0, {
      replyTo: typeof replyTo === 'number' ? replyTo : undefined,
      isReaction: !!isReaction,
    });
    return res.json({ ok: true, messageId, radioId: bridge.getRadioId() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Server-Sent Events stream for real-time ACK/status updates
const sseClients = new Set<(data: string) => void>();

// v2.0 Phase 3b: every SSE payload carries the source radio_id so the
// client can filter by selected radio. BridgeManager re-broadcasts events
// from every connected bridge (default + secondaries) and appends the
// origin radio_id as the final argument — see [bridgeManager.ts](./bridgeManager.ts).
function radioIdFromArgs(args: any[]): string | null {
  const last = args[args.length - 1];
  return typeof last === 'string' || last === null ? last : bridgeManager.getDefaultRadioId();
}

bridgeManager.on('ackUpdate', (...args: any[]) => {
  const [msgId, status, errorCode] = args;
  const payload = `event: ack\ndata: ${JSON.stringify({ msgId, status, errorCode: errorCode ?? 0, radioId: radioIdFromArgs(args) })}\n\n`;
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
});

bridgeManager.on('traceUpdate', (...args: any[]) => {
  const [trace] = args;
  const payload = `event: trace\ndata: ${JSON.stringify({ ...trace, radioId: radioIdFromArgs(args) })}\n\n`;
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
});

// Waypoint changes fan out to every connected client so a drop-pin on one
// browser tab appears instantly on every other open tab.
bridgeManager.on('waypointsChanged', (...args: any[]) => {
  const payload = `event: waypoints\ndata: ${JSON.stringify({ ts: Date.now(), radioId: radioIdFromArgs(args) })}\n\n`;
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
});

// Generic "something interesting changed" multiplexer. The bridge fires these
// fairly frequently (nodeUpdate fires on every telemetry/position update, etc.)
// — the client debounces them server-side could be added later if needed.
const fanOut = (eventName: string) => (...args: any[]) => {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify({ ts: Date.now(), radioId: radioIdFromArgs(args) })}\n\n`;
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
};

bridgeManager.on('nodeUpdate',              fanOut('node'));
bridgeManager.on('event',                   fanOut('eventLog'));
bridgeManager.on('storeForwardUpdate',      fanOut('storeForward'));
bridgeManager.on('neighborInfoUpdate',      fanOut('neighborInfo'));
bridgeManager.on('localModuleConfigUpdate', fanOut('moduleConfig'));
bridgeManager.on('bbsMail',                 fanOut('bbsMail'));
bridgeManager.on('bbsSubscriber',           fanOut('bbsSubscriber'));
// v2.0: LoRa config readback completed — Settings → Radios re-fetches.
bridgeManager.on('loraConfigUpdate',        fanOut('loraConfig'));

app.get('/api/mesh/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: string) => res.write(data);
  sseClients.add(send);

  // Keep-alive ping every 25 s
  const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ka); } }, 25_000);

  req.on('close', () => {
    clearInterval(ka);
    sseClients.delete(send);
  });
});

// Legacy serial status (backwards compat)
app.get('/api/serial/status', (_req, res) => {
  const device = serialDiscovery.getDevice();
  return res.json({
    connected: device !== null,
    device: device ? {
      port: device.port,
      vendor: device.vendor,
      product: device.product,
      isLoRa: device.isLoRa,
    } : null,
  });
});

// --- SPA fallback for client-side routing ---
if (existsSync(distPath)) {
  app.get('*', (_req, res) => {
    res.sendFile(join(distPath, 'index.html'));
  });
}

// --- Start serial discovery + auto-connect mesh bridge ---
let bridgeConnecting = false;
async function connectBridge(port: string) {
  if (bridgeConnecting || meshBridge.connected) return;
  bridgeConnecting = true;
  console.log(`[API] LoRa device found at ${port} — connecting mesh bridge...`);
  try {
    await meshBridge.connect(port);
    console.log(`[API] Mesh bridge connected to ${port}`);
  } catch (err: any) {
    console.error(`[API] Failed to connect mesh bridge:`, err.message);
  } finally {
    bridgeConnecting = false;
  }
}

if (process.env.SERIAL_AUTO_DISCOVER === 'true') {
  // Register listeners BEFORE start() to avoid missing the immediate poll event
  serialDiscovery.on('connected', (device) => { connectBridge(device.port); });
  serialDiscovery.on('disconnected', async () => {
    console.log('[API] LoRa device disconnected — mesh bridge will auto-retry');
  });
  serialDiscovery.start();

  // If the first poll already found a device before listeners fired, connect now
  const alreadyFound = serialDiscovery.getDevice();
  if (alreadyFound && !meshBridge.connected) {
    connectBridge(alreadyFound.port);
  }
} else if (process.env.SERIAL_PORT) {
  // Manual port override
  connectBridge(process.env.SERIAL_PORT);
} else {
  // No serial config — try the last saved TCP endpoint, if any.
  const saved = loadTcpEndpoint();
  if (saved) {
    console.log(`[API] Reconnecting saved TCP endpoint ${saved.host}:${saved.port}`);
    meshBridge.connectTcp(saved.host, saved.port).catch(err =>
      console.warn(`[API] Saved TCP endpoint reconnect failed: ${err.message}`)
    );
  }
}

// v2.0 Beta 3: auto-reconnect-secondaries on boot.
// SerialDiscovery handles the singleton (whichever serial device enumerates
// first), but TCP-configured radios + serial radios on non-default ports
// otherwise sit unconnected after every container restart — the operator
// would have to click Connect on each one manually. This pass iterates the
// radios DB after a short delay (gives SerialDiscovery + identity exchange
// time to settle so we know what the singleton is actually serving), then
// spawns secondaries for every enabled row that isn't the singleton.
// spawnSecondary's target-collision check refuses any row whose target is
// already held — those get logged and skipped cleanly. Runs regardless of
// which transport branch above fired.
setTimeout(async () => {
  const rows = meshDb().listRadios();
  for (const r of rows) {
    if (!r.enabled) continue;
    const result = await bridgeManager.spawnSecondary(r.radio_id);
    if (!result.ok) {
      // Refused due to singleton-collision / already-connected / target-busy.
      // These are expected and harmless — log at debug-level rather than error.
      console.log(`[API] auto-reconnect: skipped "${r.radio_id}" — ${(result as { ok: false; error: string }).error}`);
      continue;
    }
    console.log(`[API] auto-reconnect: spawned "${r.radio_id}" (${r.transport}:${r.target})`);
  }
}, 8000);

const PORT = process.env.API_PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
  console.log(`Serial auto-discover: ${process.env.SERIAL_AUTO_DISCOVER === 'true' ? 'ON' : 'OFF'}`);
});

export default app;
