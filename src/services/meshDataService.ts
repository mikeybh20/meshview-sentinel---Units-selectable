/**
 * Mesh Data Service
 * 
 * Polls the server for real mesh radio data and provides a subscribe()
 * interface identical to the simulator, so the app can switch between
 * real hardware and simulated data seamlessly.
 */
import { Node, Message, RadioEvent } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || '';

export type DataSource = 'live' | 'simulator';

interface MeshSnapshot {
  nodes: Node[];
  messages: Message[];
  events: RadioEvent[];
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

export class MeshDataService {
  private listeners: ((nodes: Node[], messages: Message[], events: RadioEvent[]) => void)[] = [];
  private statusListeners: ((status: MeshStatus | null) => void)[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatus: MeshStatus | null = null;
  private pollMs: number;

  constructor(pollMs = 3000) {
    this.pollMs = pollMs;
  }

  /** Start polling the server for live mesh data */
  start() {
    this.poll(); // immediate first fetch
    this.pollTimer = setInterval(() => this.poll(), this.pollMs);
    this.pollStatus();
    this.statusTimer = setInterval(() => this.pollStatus(), 5000);
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

  /** Send a message through the real radio */
  async sendMessage(text: string, to = '!ffffffff', channel = 0): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, to, channel }),
      });
      return res.ok;
    } catch {
      return false;
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
