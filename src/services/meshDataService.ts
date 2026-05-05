/**
 * Mesh Data Service
 * 
 * Polls the server for real mesh radio data and provides a subscribe()
 * interface identical to the simulator, so the app can switch between
 * real hardware and simulated data seamlessly.
 */
import { Node, Message, RadioEvent, Channel } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || '';

export type DataSource = 'live' | 'simulator';

interface MeshSnapshot {
  nodes: Node[];
  messages: Message[];
  events: RadioEvent[];
  channels?: Channel[];
  radioConnected: boolean;
}

interface MeshStatus {
  radioConnected: boolean;
  serialDevice: {
    port: string;
    vendor: string;
    product: string;
    isLoRa: boolean;
  } | null;
  nodeCount: number;
  messageCount: number;
}

export type AckStatus = 'sending' | 'sent' | 'acked' | 'error';

export class MeshDataService {
  private listeners: ((nodes: Node[], messages: Message[], events: RadioEvent[]) => void)[] = [];
  private channelListeners: ((channels: Channel[]) => void)[] = [];
  private statusListeners: ((status: MeshStatus | null) => void)[] = [];
  private ackListeners: ((msgId: string, status: AckStatus, errorCode: number) => void)[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private eventSource: EventSource | null = null;
  private lastStatus: MeshStatus | null = null;
  private lastChannels: Channel[] = [];
  private pollMs: number;

  constructor(pollMs = 3000) {
    this.pollMs = pollMs;
  }

  /** Start polling the server for live mesh data and open the SSE stream */
  start() {
    this.poll(); // immediate first fetch
    this.pollTimer = setInterval(() => this.poll(), this.pollMs);
    this.pollStatus();
    this.statusTimer = setInterval(() => this.pollStatus(), 5000);
    this.connectEvents();
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /** Subscribe to real-time ACK/status updates for sent messages */
  onAckUpdate(cb: (msgId: string, status: AckStatus, errorCode: number) => void) {
    this.ackListeners.push(cb);
    return () => { this.ackListeners = this.ackListeners.filter(l => l !== cb); };
  }

  private connectEvents() {
    if (this.eventSource) return;
    try {
      this.eventSource = new EventSource(`${API_BASE}/api/mesh/events`);
      this.eventSource.onmessage = (e) => {
        try {
          const { msgId, status, errorCode } = JSON.parse(e.data);
          this.ackListeners.forEach(l => l(msgId, status as AckStatus, errorCode ?? 0));
        } catch { /* malformed event */ }
      };
      this.eventSource.onerror = () => {
        // Browser will auto-reconnect; no action needed
      };
    } catch {
      // EventSource not available (e.g. test env) — polling fallback is fine
    }
  }

  /** Subscribe to data updates (same interface as simulator) */
  subscribe(callback: (nodes: Node[], messages: Message[], events: RadioEvent[]) => void) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  /** Subscribe to radio connection status changes */
  onStatus(callback: (status: MeshStatus | null) => void) {
    this.statusListeners.push(callback);
    callback(this.lastStatus);
    return () => {
      this.statusListeners = this.statusListeners.filter(l => l !== callback);
    };
  }

  getStatus(): MeshStatus | null {
    return this.lastStatus;
  }

  /** Send a message through the real radio. Returns the server-assigned messageId on success. */
  async sendMessage(text: string, to = '!ffffffff', channel = 0): Promise<{ ok: boolean; messageId?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, to, channel }),
      });
      if (!res.ok) return { ok: false };
      const body = await res.json();
      // Immediately refresh so the optimistic message shows up in state
      await this.poll();
      return { ok: true, messageId: body.messageId };
    } catch {
      return { ok: false };
    }
  }

  /** Subscribe to channel list updates (replays the last known list immediately). */
  onChannels(callback: (channels: Channel[]) => void) {
    this.channelListeners.push(callback);
    callback(this.lastChannels);
    return () => {
      this.channelListeners = this.channelListeners.filter(l => l !== callback);
    };
  }

  getChannels(): Channel[] {
    return [...this.lastChannels];
  }

  /** Persist a full channel list to the radio. Server fills any missing slots
   *  as DISABLED, then commits and re-reads from the radio. */
  async saveChannels(channels: Channel[]): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  private async poll() {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/snapshot`);
      if (!res.ok) return;

      const data: MeshSnapshot = await res.json();

      // Map to ensure all expected fields have defaults
      const nodes: Node[] = data.nodes.map(n => ({
        favorite: false,
        ...n,
        // Ensure online status based on lastSeen if not set
        online: n.online ?? (Date.now() - n.lastSeen < 15 * 60 * 1000),
      }));

      this.listeners.forEach(l => l(nodes, data.messages, data.events));

      if (data.channels) {
        this.lastChannels = data.channels;
        this.channelListeners.forEach(l => l(data.channels!));
      }
    } catch {
      // Server unreachable — skip this tick
    }
  }

  private async pollStatus() {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/status`);
      if (!res.ok) return;
      const status: MeshStatus = await res.json();
      this.lastStatus = status;
      this.statusListeners.forEach(l => l(status));
    } catch {
      this.lastStatus = null;
      this.statusListeners.forEach(l => l(null));
    }
  }
}

export const meshDataService = new MeshDataService();
