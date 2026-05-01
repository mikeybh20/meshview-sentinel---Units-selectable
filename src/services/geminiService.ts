import { Node, Message, RadioEvent } from "../types";

const API_BASE = import.meta.env.VITE_API_URL || '';

export class GeminiService {
  async askAssistant(prompt: string, context: { nodes: Node[], messages: Message[], events: RadioEvent[] }) {
    const systemInstruction = `You are a Meshtastic Network Assistant. 
You have access to the current state of a simulated Meshtastic mesh network.
The current network state is as follows:
- Nodes: ${context.nodes.length}
- Online Nodes: ${context.nodes.filter(n => n.online).map(n => n.name).join(', ')}
- Offline Nodes: ${context.nodes.filter(n => !n.online).map(n => n.name).join(', ')}
- Nodes with Raspberry Pi Bridges: ${context.nodes.filter(n => n.sensors?.bridge?.type === 'RASPBERRY_PI').map(n => n.name).join(', ')}
- Environmental Summary: Average Temp ${context.nodes.some(n => n.sensors?.temperature) ? (context.nodes.filter(n => n.sensors?.temperature).reduce((acc, n) => acc + n.sensors!.temperature!, 0) / context.nodes.filter(n => n.sensors?.temperature).length).toFixed(1) : 'N/A'}°C
- Total Messages: ${context.messages.length}
- Recent Events: ${context.events.slice(-5).map(e => e.details).join('; ')}

Help the user with network diagnostics, explaining topology, or summarizing message logs. 
You can also report on sensor data (Temperature, Humidity, IAQ) if requested. 
Keep your answers technical but accessible, in the style of a radio operator.
Use technical terms like SNR, RSSI, Hops, and Peripheral Bridge when appropriate.`;

    try {
      const response = await fetch(`${API_BASE}/api/gemini`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, systemInstruction }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(err.error || `API error: ${response.status}`);
      }

      const data = await response.json();
      return data.text;
    } catch (error) {
      console.error("Gemini API Error:", error);
      throw error;
    }
  }
}

export const geminiService = new GeminiService();
