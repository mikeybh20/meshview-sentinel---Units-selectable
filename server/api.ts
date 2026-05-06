import express from 'express';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { serialDiscovery } from './serialDiscovery.js';
import { meshBridge } from './meshtasticSerial.js';
import { meshDb } from './database.js';

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
type AIProvider = 'anthropic' | 'gemini';

interface AIConfig {
  provider: AIProvider;
  anthropicKey: string;
  geminiKey: string;
  anthropicModel: string;
  geminiModel: string;
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
    provider: 'anthropic',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    geminiKey: process.env.GEMINI_API_KEY || '',
    anthropicModel: 'claude-sonnet-4-20250514',
    geminiModel: 'gemini-3-flash-preview',
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
    provider: aiConfig.provider,
    anthropicModel: aiConfig.anthropicModel,
    geminiModel: aiConfig.geminiModel,
    hasAnthropicKey: !!aiConfig.anthropicKey,
    hasGeminiKey: !!aiConfig.geminiKey,
    // Mask keys — show last 4 chars only
    anthropicKeyHint: aiConfig.anthropicKey ? `...${aiConfig.anthropicKey.slice(-4)}` : '',
    geminiKeyHint: aiConfig.geminiKey ? `...${aiConfig.geminiKey.slice(-4)}` : '',
  });
});

app.post('/api/ai/config', (req, res) => {
  const { provider, anthropicKey, geminiKey, anthropicModel, geminiModel } = req.body;

  if (provider && (provider === 'anthropic' || provider === 'gemini')) {
    aiConfig.provider = provider;
  }
  if (anthropicKey !== undefined) aiConfig.anthropicKey = anthropicKey;
  if (geminiKey !== undefined) aiConfig.geminiKey = geminiKey;
  if (anthropicModel) aiConfig.anthropicModel = anthropicModel;
  if (geminiModel) aiConfig.geminiModel = geminiModel;

  saveConfig(aiConfig);
  console.log(`[AI Config] Provider: ${aiConfig.provider}, Anthropic key: ${aiConfig.anthropicKey ? 'SET' : 'EMPTY'}, Gemini key: ${aiConfig.geminiKey ? 'SET' : 'EMPTY'}`);

  return res.json({ ok: true, provider: aiConfig.provider });
});

// --- Unified AI Chat endpoint ---
app.post('/api/ai/chat', async (req, res) => {
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

// Keep legacy endpoint working
app.post('/api/gemini', (req, res) => {
  // Redirect to unified endpoint
  req.url = '/api/ai/chat';
  app.handle(req, res);
});

// =============================================
// Mesh Radio API (real hardware data)
// =============================================

// Status: is the radio connected?
app.get('/api/mesh/status', (_req, res) => {
  const device = serialDiscovery.getDevice();
  return res.json({
    radioConnected: meshBridge.connected,
    transport: meshBridge.getTransport(),
    serialDevice: device ? {
      port: device.port,
      vendor: device.vendor,
      product: device.product,
      isLoRa: device.isLoRa,
    } : null,
    nodeCount: meshBridge.getNodes().length,
    messageCount: meshBridge.getMessages().length,
  });
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

// All mesh nodes seen by the radio
app.get('/api/mesh/nodes', (_req, res) => {
  return res.json(meshBridge.getNodes());
});

// All messages received by the radio
app.get('/api/mesh/messages', (_req, res) => {
  return res.json(meshBridge.getMessages());
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

// Event log
app.get('/api/mesh/events', (_req, res) => {
  return res.json(meshBridge.getEvents());
});

// Full snapshot (nodes + messages + events in one call)
app.get('/api/mesh/snapshot', (_req, res) => {
  return res.json({
    nodes: meshBridge.getNodes(),
    messages: meshBridge.getMessages(),
    events: meshBridge.getEvents(),
    channels: meshBridge.getChannels(),
    waypoints: meshBridge.getWaypoints(),
    traces: meshBridge.getTraces(),
    neighborInfo: meshBridge.getNeighborInfo(),
    storeForwardRouters: meshBridge.getStoreForwardRouters(),
    radioConnected: meshBridge.connected,
    localNodeId: meshBridge.getLocalNodeId(),
  });
});

app.get('/api/mesh/neighbor-info', (_req, res) => {
  return res.json(meshBridge.getNeighborInfo());
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

// Apply persisted retention on boot.
try { meshBridge.setEventRetention(loadRetention()); } catch (err: any) {
  console.error('[API] could not apply persisted retention:', err.message);
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

// Database stats (counts of persisted rows)
app.get('/api/mesh/db/stats', (_req, res) => {
  try {
    return res.json(meshDb().stats());
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

// Channel configuration
app.get('/api/mesh/channels', (_req, res) => {
  return res.json(meshBridge.getChannels());
});

app.post('/api/mesh/channels', async (req, res) => {
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });
  const channels = req.body?.channels;
  if (!Array.isArray(channels)) return res.status(400).json({ error: 'Body must be { channels: [...] }' });
  try {
    await meshBridge.setChannels(channels);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Send a text message through the radio (also handles replies and reactions)
app.post('/api/mesh/send', async (req, res) => {
  const { text, to, channel, replyTo, isReaction } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });

  try {
    const messageId = await meshBridge.sendMessage(text, to || '!ffffffff', channel ?? 0, {
      replyTo: typeof replyTo === 'number' ? replyTo : undefined,
      isReaction: !!isReaction,
    });
    return res.json({ ok: true, messageId });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Server-Sent Events stream for real-time ACK/status updates
const sseClients = new Set<(data: string) => void>();

meshBridge.on('ackUpdate', (msgId: string, status: string, errorCode: number) => {
  const payload = `event: ack\ndata: ${JSON.stringify({ msgId, status, errorCode: errorCode ?? 0 })}\n\n`;
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
});

meshBridge.on('traceUpdate', (trace: any) => {
  const payload = `event: trace\ndata: ${JSON.stringify(trace)}\n\n`;
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
});

// Waypoint changes fan out to every connected client so a drop-pin on one
// browser tab appears instantly on every other open tab.
meshBridge.on('waypointsChanged', () => {
  const payload = `event: waypoints\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`;
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
});

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

const PORT = process.env.API_PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
  console.log(`Serial auto-discover: ${process.env.SERIAL_AUTO_DISCOVER === 'true' ? 'ON' : 'OFF'}`);
});

export default app;
