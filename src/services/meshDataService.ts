/**
 * Mesh Data Service
 * 
 * Polls the server for real mesh radio data and provides a subscribe()
 * interface identical to the simulator, so the app can switch between
 * real hardware and simulated data seamlessly.
 */
import { Node, Message, RadioEvent, Channel, Waypoint, TraceResult, NeighborInfoSnapshot, StoreForwardRouter, LocalModuleConfigSnapshot } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || '';

export type DataSource = 'live' | 'simulator';

interface MeshSnapshot {
  nodes: Node[];
  messages: Message[];
  events: RadioEvent[];
  channels?: Channel[];
  waypoints?: Waypoint[];
  traces?: TraceResult[];
  neighborInfo?: NeighborInfoSnapshot[];
  storeForwardRouters?: StoreForwardRouter[];
  localModuleConfig?: LocalModuleConfigSnapshot;
  radioConnected: boolean;
  localNodeId?: string | null;
}

export interface TransportInfo {
  mode: 'serial' | 'tcp' | null;
  serial?: { port: string };
  tcp?: { host: string; port: number };
}

interface MeshStatus {
  radioConnected: boolean;
  transport?: TransportInfo;
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
  private waypointListeners: ((waypoints: Waypoint[]) => void)[] = [];
  private neighborInfoListeners: ((info: NeighborInfoSnapshot[]) => void)[] = [];
  private lastNeighborInfo: NeighborInfoSnapshot[] = [];
  private sfRouterListeners: ((routers: StoreForwardRouter[]) => void)[] = [];
  private lastSfRouters: StoreForwardRouter[] = [];
  private moduleConfigListeners: ((cfg: LocalModuleConfigSnapshot) => void)[] = [];
  private lastModuleConfig: LocalModuleConfigSnapshot = {};
  private statusListeners: ((status: MeshStatus | null) => void)[] = [];
  private ackListeners: ((msgId: string, status: AckStatus, errorCode: number) => void)[] = [];
  private traceListeners: ((trace: TraceResult) => void)[] = [];
  private traceSnapshotListeners: ((traces: TraceResult[]) => void)[] = [];
  private lastTraces: TraceResult[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private debouncedPollTimer: ReturnType<typeof setTimeout> | null = null;
  private eventSource: EventSource | null = null;
  private lastStatus: MeshStatus | null = null;
  private lastChannels: Channel[] = [];
  private lastWaypoints: Waypoint[] = [];
  private lastLocalNodeId: string | null = null;
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
    if (this.debouncedPollTimer) {
      clearTimeout(this.debouncedPollTimer);
      this.debouncedPollTimer = null;
    }
  }

  /**
   * Schedule a poll() to run shortly. Called from SSE event handlers when the
   * server signals state changed but doesn't push the new state directly.
   * Coalesces bursts of events into a single fetch.
   */
  private schedulePoll(delayMs: number = 250) {
    if (this.debouncedPollTimer) return; // already pending
    this.debouncedPollTimer = setTimeout(() => {
      this.debouncedPollTimer = null;
      void this.poll();
    }, delayMs);
  }

  /** Subscribe to real-time ACK/status updates for sent messages */
  onAckUpdate(cb: (msgId: string, status: AckStatus, errorCode: number) => void) {
    this.ackListeners.push(cb);
    return () => { this.ackListeners = this.ackListeners.filter(l => l !== cb); };
  }

  private connectEvents() {
    if (this.eventSource) return;
    try {
      this.eventSource = new EventSource(`${API_BASE}/api/mesh/stream`);

      this.eventSource.addEventListener('ack', (e: MessageEvent) => {
        try {
          const { msgId, status, errorCode } = JSON.parse(e.data);
          this.ackListeners.forEach(l => l(msgId, status as AckStatus, errorCode ?? 0));
        } catch { /* malformed */ }
      });

      this.eventSource.addEventListener('trace', (e: MessageEvent) => {
        try {
          const trace = JSON.parse(e.data) as TraceResult;
          this.traceListeners.forEach(l => l(trace));
          // Merge into snapshot
          const idx = this.lastTraces.findIndex(t => t.id === trace.id);
          if (idx >= 0) this.lastTraces[idx] = trace;
          else this.lastTraces.unshift(trace);
          this.traceSnapshotListeners.forEach(l => l([...this.lastTraces]));
        } catch { /* malformed */ }
      });

      // Waypoint changes: server tells us "something changed" — re-poll
      // immediately so the new state hits the UI without waiting for the
      // next 3-second interval.
      this.eventSource.addEventListener('waypoints', () => {
        void this.poll();
      });

      // Other state-changed signals: debounce so a burst of node updates
      // (e.g. several telemetry packets in a second) collapses into a
      // single full-snapshot fetch. 250 ms is short enough to feel instant
      // but long enough to absorb most bursts.
      const triggerDebouncedPoll = () => this.schedulePoll();
      this.eventSource.addEventListener('node', triggerDebouncedPoll);
      this.eventSource.addEventListener('eventLog', triggerDebouncedPoll);
      this.eventSource.addEventListener('storeForward', triggerDebouncedPoll);
      this.eventSource.addEventListener('neighborInfo', triggerDebouncedPoll);
      this.eventSource.addEventListener('moduleConfig', triggerDebouncedPoll);

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
  async sendMessage(
    text: string,
    to = '!ffffffff',
    channel = 0,
    opts: { replyTo?: number; isReaction?: boolean } = {},
  ): Promise<{ ok: boolean; messageId?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, to, channel, replyTo: opts.replyTo, isReaction: opts.isReaction }),
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

  /** Subscribe to waypoint updates (replays the last known list immediately). */
  onWaypoints(callback: (waypoints: Waypoint[]) => void) {
    this.waypointListeners.push(callback);
    callback(this.lastWaypoints);
    return () => {
      this.waypointListeners = this.waypointListeners.filter(l => l !== callback);
    };
  }

  getWaypoints(): Waypoint[] {
    return [...this.lastWaypoints];
  }

  getLocalNodeId(): string | null {
    return this.lastLocalNodeId;
  }

  /** Create or edit a waypoint via the radio. */
  async saveWaypoint(input: {
    id?: number;
    lat: number;
    lng: number;
    name?: string;
    description?: string;
    icon?: number;
    expire?: number;
    lockedToSelf?: boolean;
    channel?: number;
  }): Promise<{ ok: boolean; waypoint?: Waypoint; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/waypoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      const body = await res.json();
      // Optimistically refresh
      await this.poll();
      return { ok: true, waypoint: body.waypoint };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Subscribe to NeighborInfo snapshots (replays last known list immediately). */
  onNeighborInfo(callback: (info: NeighborInfoSnapshot[]) => void) {
    this.neighborInfoListeners.push(callback);
    callback(this.lastNeighborInfo);
    return () => { this.neighborInfoListeners = this.neighborInfoListeners.filter(l => l !== callback); };
  }

  getNeighborInfo(): NeighborInfoSnapshot[] {
    return [...this.lastNeighborInfo];
  }

  /** Subscribe to authoritative module-config snapshots read back from the radio. */
  onModuleConfig(callback: (cfg: LocalModuleConfigSnapshot) => void) {
    this.moduleConfigListeners.push(callback);
    callback(this.lastModuleConfig);
    return () => { this.moduleConfigListeners = this.moduleConfigListeners.filter(l => l !== callback); };
  }

  getLocalModuleConfig(): LocalModuleConfigSnapshot {
    return { ...this.lastModuleConfig };
  }

  /** Ask the radio to re-send its current NeighborInfo module config. Local admin only. */
  async refreshNeighborInfoConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/neighbor-info/refresh`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Enable or disable the NeighborInfo module on the connected radio (firmware-side admin write). */
  async setNeighborInfoConfig(opts: { enabled: boolean; intervalSecs?: number; transmitOverLora?: boolean }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/neighbor-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
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

  /** Mark a node as favorite (or unfavorite). Server persists to SQLite. */
  async setFavorite(nodeId: string, favorite: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/nodes/${encodeURIComponent(nodeId)}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      // Trigger an immediate poll so the favorite flag reflects in state right away
      await this.poll();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Subscribe to known Store & Forward routers (replays the last known list immediately). */
  onStoreForwardRouters(callback: (routers: StoreForwardRouter[]) => void) {
    this.sfRouterListeners.push(callback);
    callback(this.lastSfRouters);
    return () => { this.sfRouterListeners = this.sfRouterListeners.filter(l => l !== callback); };
  }

  getStoreForwardRouters(): StoreForwardRouter[] {
    return [...this.lastSfRouters];
  }

  /** Ask a Store & Forward router to replay the last `windowMinutes` of traffic. */
  async requestStoreForwardHistory(routerId: string, windowMinutes: number = 60, channel: number = 0): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/store-forward/request-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: routerId, windowMinutes, channel }),
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

  /** Full-text search across all persisted messages (server-side SQLite FTS5). */
  async searchMessages(query: string, limit: number = 50): Promise<Message[]> {
    if (!query.trim()) return [];
    try {
      const res = await fetch(`${API_BASE}/api/mesh/messages/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  /** Subscribe to live trace updates. Each call receives a single TraceResult. */
  onTraceUpdate(callback: (trace: TraceResult) => void) {
    this.traceListeners.push(callback);
    return () => { this.traceListeners = this.traceListeners.filter(l => l !== callback); };
  }

  /** Subscribe to the snapshot of all traces. Replays the last known list immediately. */
  onTraces(callback: (traces: TraceResult[]) => void) {
    this.traceSnapshotListeners.push(callback);
    callback(this.lastTraces);
    return () => { this.traceSnapshotListeners = this.traceSnapshotListeners.filter(l => l !== callback); };
  }

  getTraces(): TraceResult[] {
    return [...this.lastTraces];
  }

  /** Kick off a traceroute. Resolves with the requestId; result arrives via SSE 'trace' events. */
  async sendTraceroute(to: string, channel: number = 0): Promise<{ ok: boolean; requestId?: string; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/traceroute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, channel }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      const body = await res.json();
      return { ok: true, requestId: body.requestId };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Tell the server to open a TCP connection to a Meshtastic radio. */
  async connectTcp(host: string, port: number = 4403): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/connect/tcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port }),
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

  /** Disconnect the server's bridge from any radio (serial or TCP). */
  async disconnect(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/disconnect`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  async deleteWaypoint(id: number): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/waypoints/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      await this.poll();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
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

      if (data.waypoints) {
        this.lastWaypoints = data.waypoints;
        this.waypointListeners.forEach(l => l(data.waypoints!));
      }

      if (data.traces) {
        this.lastTraces = data.traces;
        this.traceSnapshotListeners.forEach(l => l(data.traces!));
      }

      if (data.neighborInfo) {
        this.lastNeighborInfo = data.neighborInfo;
        this.neighborInfoListeners.forEach(l => l(data.neighborInfo!));
      }

      if (data.storeForwardRouters) {
        this.lastSfRouters = data.storeForwardRouters;
        this.sfRouterListeners.forEach(l => l(data.storeForwardRouters!));
      }

      if (data.localModuleConfig) {
        this.lastModuleConfig = data.localModuleConfig;
        this.moduleConfigListeners.forEach(l => l(data.localModuleConfig!));
      }

      if (data.localNodeId !== undefined) {
        this.lastLocalNodeId = data.localNodeId;
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
