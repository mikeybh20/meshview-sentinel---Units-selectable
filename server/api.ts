import express from 'express';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { serialDiscovery } from './serialDiscovery.js';
import { meshBridge } from './meshtasticSerial.js';

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

// All mesh nodes seen by the radio
app.get('/api/mesh/nodes', (_req, res) => {
  return res.json(meshBridge.getNodes());
});

// All messages received by the radio
app.get('/api/mesh/messages', (_req, res) => {
  return res.json(meshBridge.getMessages());
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
    radioConnected: meshBridge.connected,
  });
});

// Send a text message through the radio
app.post('/api/mesh/send', async (req, res) => {
  const { text, to, channel } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (!meshBridge.connected) return res.status(503).json({ error: 'Radio not connected' });

  try {
    await meshBridge.sendMessage(text, to || '!ffffffff', channel || 0);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
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
async function connectBridge(port: string) {
  console.log(`[API] LoRa device found at ${port} — connecting mesh bridge...`);
  try {
    await meshBridge.connect(port);
    console.log(`[API] Mesh bridge connected to ${port}`);
  } catch (err: any) {
    console.error(`[API] Failed to connect mesh bridge:`, err.message);
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
}

const PORT = process.env.API_PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
  console.log(`Serial auto-discover: ${process.env.SERIAL_AUTO_DISCOVER === 'true' ? 'ON' : 'OFF'}`);
});

export default app;
