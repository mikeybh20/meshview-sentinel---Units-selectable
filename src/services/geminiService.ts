import { Node, Message, RadioEvent } from "../types";

const API_BASE = import.meta.env.VITE_API_URL || '';

interface AskOptions {
  /**
   * If true, strip node identifiers, names, and message content from the
   * system prompt — ship only aggregate counts. Useful when the AI provider
   * is a third-party cloud (Anthropic / Gemini) and the operator doesn't
   * want mesh PII leaving the network.
   */
  redactPii?: boolean;
}

function buildFullSystemInstruction(context: { nodes: Node[]; messages: Message[]; events: RadioEvent[] }): string {
  const { nodes, messages, events } = context;
  const onlineNames = nodes.filter(n => n.online).map(n => n.name).join(', ');
  const offlineNames = nodes.filter(n => !n.online).map(n => n.name).join(', ');
  const piNames = nodes.filter(n => n.sensors?.bridge?.type === 'RASPBERRY_PI').map(n => n.name).join(', ');
  const tempNodes = nodes.filter(n => n.sensors?.temperature);
  const avgTemp = tempNodes.length > 0
    ? (tempNodes.reduce((acc, n) => acc + n.sensors!.temperature!, 0) / tempNodes.length).toFixed(1) + '°C'
    : 'N/A';
  const recent = events.slice(-5).map(e => e.details).join('; ');

  return `You are a Meshtastic Network Assistant.
You have access to the current state of a Meshtastic mesh network.
The current network state is as follows:
- Nodes: ${nodes.length}
- Online Nodes: ${onlineNames}
- Offline Nodes: ${offlineNames}
- Nodes with Raspberry Pi Bridges: ${piNames}
- Environmental Summary: Average Temp ${avgTemp}
- Total Messages: ${messages.length}
- Recent Events: ${recent}

Help the user with network diagnostics, explaining topology, or summarizing message logs.
You can also report on sensor data (Temperature, Humidity, IAQ) if requested.
Keep your answers technical but accessible, in the style of a radio operator.
Use technical terms like SNR, RSSI, Hops, and Peripheral Bridge when appropriate.`;
}

function buildRedactedSystemInstruction(context: { nodes: Node[]; messages: Message[]; events: RadioEvent[] }): string {
  const { nodes, messages, events } = context;
  const online = nodes.filter(n => n.online).length;
  const offline = nodes.filter(n => !n.online).length;
  const favorites = nodes.filter(n => n.favorite).length;
  const withPosition = nodes.filter(n => n.position).length;
  const withTelemetry = nodes.filter(n => n.telemetry).length;
  const piBridges = nodes.filter(n => n.sensors?.bridge?.type === 'RASPBERRY_PI').length;
  const tempNodes = nodes.filter(n => n.sensors?.temperature);
  const avgTemp = tempNodes.length > 0
    ? (tempNodes.reduce((acc, n) => acc + n.sensors!.temperature!, 0) / tempNodes.length).toFixed(1) + '°C'
    : 'N/A';

  // Aggregate event counts by type for the same "what's happening on the mesh"
  // signal as recent-event details, without leaking specific text or node ids.
  const eventCounts = new Map<string, number>();
  for (const e of events.slice(-50)) eventCounts.set(e.type, (eventCounts.get(e.type) ?? 0) + 1);
  const eventSummary = [...eventCounts.entries()].map(([t, c]) => `${t}=${c}`).join(', ') || 'none';

  return `You are a Meshtastic Network Assistant.
PRIVACY MODE: the operator has redacted node identifiers and message content
from this prompt. You only have aggregate counts; specific node names, IDs,
positions, and message text are unavailable.

Aggregate mesh state:
- Total nodes known: ${nodes.length}
- Online: ${online}
- Offline: ${offline}
- Favorites: ${favorites}
- Nodes with a known position: ${withPosition}
- Nodes reporting telemetry: ${withTelemetry}
- Raspberry Pi bridges present: ${piBridges}
- Avg temperature across reporting sensors: ${avgTemp}
- Total messages on record: ${messages.length}
- Recent event-type counts (last 50): ${eventSummary}

Help the user reason about general mesh patterns, configuration choices, or
troubleshooting based on these aggregates. If they ask about a specific node
or a specific message, explain that those details have been redacted from
this prompt for privacy and suggest they retry with redaction disabled if
they need node-level answers.
Keep your answers technical but accessible, in the style of a radio operator.
Use technical terms like SNR, RSSI, Hops, and Peripheral Bridge when appropriate.`;
}

export class GeminiService {
  async askAssistant(
    prompt: string,
    context: { nodes: Node[], messages: Message[], events: RadioEvent[] },
    opts: AskOptions = {},
  ) {
    const systemInstruction = opts.redactPii
      ? buildRedactedSystemInstruction(context)
      : buildFullSystemInstruction(context);

    try {
      const response = await fetch(`${API_BASE}/api/ai/chat`, {
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
      console.error('AI Assistant error:', error);
      throw error;
    }
  }
}

export const geminiService = new GeminiService();
