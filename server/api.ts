import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { serialDiscovery } from './serialDiscovery.js';

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

const apiKey = process.env.GEMINI_API_KEY;
let ai: any = null;
if (apiKey) {
  ai = new GoogleGenAI({ apiKey });
}

app.post('/api/gemini', async (req, res) => {
  if (!ai) {
    return res.status(500).json({ error: 'Gemini API key not configured on server' });
  }

  const { prompt, systemInstruction } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        systemInstruction: systemInstruction || '',
        temperature: 0.7,
      },
    });

    return res.json({ text: response.text });
  } catch (error: any) {
    console.error('Gemini API Error:', error);
    return res.status(500).json({ error: error.message || 'Gemini API request failed' });
  }
});

// --- Serial device status API ---
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

// --- Start serial discovery if enabled ---
if (process.env.SERIAL_AUTO_DISCOVER === 'true') {
  serialDiscovery.start();
  serialDiscovery.on('connected', (device) => {
    console.log(`[API] LoRa radio connected at ${device.port}`);
  });
  serialDiscovery.on('disconnected', () => {
    console.log('[API] LoRa radio disconnected — will keep scanning');
  });
}

const PORT = process.env.API_PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
  console.log(`Serial auto-discover: ${process.env.SERIAL_AUTO_DISCOVER === 'true' ? 'ON' : 'OFF'}`);
});

export default app;
