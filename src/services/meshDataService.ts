/**
 * Mesh Data Service
 * 
 * Polls the server for real mesh radio data and provides a subscribe()
 * interface identical to the simulator, so the app can switch between
 * real hardware and simulated data seamlessly.
 */
import { Node, Message, RadioEvent, Channel, Waypoint, TraceResult, NeighborInfoSnapshot, StoreForwardRouter, LocalModuleConfigSnapshot, Group } from '../types';

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
  groups?: Group[];
  blocked?: string[];
  radioConnected: boolean;
  localNodeId?: string | null;
}

export interface TransportInfo {
  mode: 'serial' | 'tcp' | null;
  serial?: { port: string };
  tcp?: { host: string; port: number };
}

export interface MeshStatus {
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
  /** Local-radio firmware version string (e.g. "2.5.13.55c2c5b"), if reported. */
  firmwareVersion?: string | null;
  /** Local-radio reboot count (uptime / stability hint), if reported. */
  rebootCount?: number | null;
  /** Local node `!hex` id, once MyNodeInfo has been received. */
  localNodeId?: string | null;
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
  private groupListeners: ((groups: Group[]) => void)[] = [];
  private lastGroups: Group[] = [];
  private blockedListeners: ((blocked: string[]) => void)[] = [];
  private lastBlocked: string[] = [];
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

  /**
   * Subscribe to a fine-grained TX/RX activity feed. Each callback firing
   * represents one packet's worth of radio activity:
   *   'tx' — we successfully wrote a frame to the radio (status='sent' on ackUpdate)
   *   'rx' — the radio gave us a parsed packet (node/event/ack SSE arrival)
   *
   * Intended for tiny UI activity LEDs — not for state mirroring. We don't
   * buffer or replay; if there's no listener, nothing is emitted.
   */
  onActivity(cb: (kind: 'tx' | 'rx') => void) {
    this.activityListeners.push(cb);
    return () => { this.activityListeners = this.activityListeners.filter(l => l !== cb); };
  }

  private activityListeners: Array<(kind: 'tx' | 'rx') => void> = [];

  private emitActivity(kind: 'tx' | 'rx') {
    for (const l of this.activityListeners) {
      try { l(kind); } catch { /* listener exploded — keep firing the others */ }
    }
  }

  private connectEvents() {
    if (this.eventSource) return;
    try {
      this.eventSource = new EventSource(`${API_BASE}/api/mesh/stream`);

      this.eventSource.addEventListener('ack', (e: MessageEvent) => {
        try {
          const { msgId, status, errorCode } = JSON.parse(e.data);
          this.ackListeners.forEach(l => l(msgId, status as AckStatus, errorCode ?? 0));
          // 'sent' = bytes left our process for the radio → TX activity.
          // Other statuses (queued/acked/error) come from packets arriving FROM
          // the radio and are accounted for via the rx-side listeners below.
          if (status === 'sent') this.emitActivity('tx');
          else this.emitActivity('rx');
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
      // RX-side: every parsed packet from the radio fans out on one of these
      // SSE channels. Pulse the activity LED on each one (not on the debounced
      // poll — that collapses bursts and would hide rapid activity).
      const triggerDebouncedPoll = () => this.schedulePoll();
      const rxPulseAndPoll = () => { this.emitActivity('rx'); this.schedulePoll(); };
      this.eventSource.addEventListener('node', rxPulseAndPoll);
      this.eventSource.addEventListener('eventLog', rxPulseAndPoll);
      this.eventSource.addEventListener('storeForward', triggerDebouncedPoll);
      this.eventSource.addEventListener('neighborInfo', rxPulseAndPoll);
      this.eventSource.addEventListener('moduleConfig', triggerDebouncedPoll);
      this.eventSource.addEventListener('groups', triggerDebouncedPoll);
      this.eventSource.addEventListener('blocked', triggerDebouncedPoll);
      // BBS mail changes — fan out to listeners so the Mail view + nav badge
      // refresh in real time without a full poll.
      this.eventSource.addEventListener('bbsMail', () => {
        this.emitActivity('rx');
        this.bbsMailListeners.forEach(l => { try { l(); } catch { /* keep firing */ } });
      });

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

  // -------- BBS Mail --------

  /** Mail row shape returned by /api/mesh/bbs/inbox (recipient side). */
  // (declared inline to avoid creating a separate type file for one feature)
  private bbsMailListeners: Array<() => void> = [];

  /** Subscribe to "something about BBS mail changed" notifications. The callback
   *  fires after any mail insert / read / delete and is the cue to re-fetch
   *  the inbox/outbox via getBbsInbox/getBbsOutbox. */
  onBbsMail(cb: () => void): () => void {
    this.bbsMailListeners.push(cb);
    return () => { this.bbsMailListeners = this.bbsMailListeners.filter(l => l !== cb); };
  }

  async getBbsInbox(nodeId?: string): Promise<{
    nodeId: string;
    unread: number;
    mail: Array<{
      id: number; senderNodeId: string; senderShortName: string;
      postedAt: number; body: string; readAt: number | null; deliveredAt: number | null;
    }>;
  } | null> {
    try {
      const q = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
      const res = await fetch(`${API_BASE}/api/mesh/bbs/inbox${q}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async getBbsOutbox(nodeId?: string): Promise<{
    nodeId: string;
    mail: Array<{
      id: number; recipientNodeId: string; senderShortName: string;
      postedAt: number; body: string; readAt: number | null;
    }>;
  } | null> {
    try {
      const q = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
      const res = await fetch(`${API_BASE}/api/mesh/bbs/outbox${q}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async composeBbsMail(recipientNodeId: string, body: string): Promise<{ ok: boolean; mailId?: number; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/bbs/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientNodeId, body }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        return { ok: false, error: b.error || `HTTP ${res.status}` };
      }
      const b = await res.json();
      return { ok: true, mailId: b.mailId };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'request failed' };
    }
  }

  async markBbsRead(id: number): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/bbs/${id}/read`, { method: 'POST' });
      return res.ok;
    } catch { return false; }
  }

  async deleteBbsMail(id: number): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/bbs/${id}`, { method: 'DELETE' });
      return res.ok;
    } catch { return false; }
  }

  /** Per-node position history (newest first). */
  async getNodePositionHistory(nodeId: string, limit = 200): Promise<Array<{
    id: number;
    timestamp: number;
    lat: number;
    lng: number;
    alt: number | null;
    source: 'manual' | 'gps' | null;
    precisionBits: number | null;
  }> | null> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/nodes/${encodeURIComponent(nodeId)}/positions?limit=${limit}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Trace-route results that targeted this node. */
  async getNodeTraces(nodeId: string, limit = 50): Promise<TraceResult[] | null> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/nodes/${encodeURIComponent(nodeId)}/traces?limit=${limit}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async getBbsUsers(): Promise<{
    users: Array<{
      nodeId: string;
      sentCount: number;
      receivedCount: number;
      unreadCount: number;
      lastActivity: number;
      name: string | null;
      shortName: string | null;
      isLocal: boolean;
    }>;
    total: number;
  } | null> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/bbs/users`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * Ask the radio to re-emit its full NodeDB / channel set / module configs.
   * The bridge already issues this on connect; this is a manual nudge for when
   * a phone (BLE) has changed config out-of-band and the UI looks stale.
   */
  /**
   * v2.0: optional `radioId` scopes the refresh to a single radio. When
   * omitted, the server refreshes the default radio (Phase 3a) or all
   * connected radios (Phase 3b once that lands).
   */
  async refreshNodeDb(radioId?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const url = radioId
        ? `${API_BASE}/api/mesh/refresh?radio_id=${encodeURIComponent(radioId)}`
        : `${API_BASE}/api/mesh/refresh`;
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'request failed' };
    }
  }

  // -------------------------------------------------------------------
  // v2.0 multi-radio
  // -------------------------------------------------------------------

  async listRadios(): Promise<{ radios: any[]; defaultRadioId: string | null; palette: string[] } | null> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/radios`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async addRadio(input: {
    radio_id: string;
    long_name: string;
    transport: 'serial' | 'tcp' | 'ble';
    target: string;
    color_hex?: string;
    network_label?: string;
  }): Promise<{ ok: boolean; row?: any; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/radios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true, row: body };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'request failed' };
    }
  }

  async updateRadio(radioId: string, patch: Partial<{
    long_name: string;
    target: string;
    color_hex: string | null;
    network_label: string | null;
    enabled: boolean;
  }>): Promise<{ ok: boolean; row?: any; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/radios/${encodeURIComponent(radioId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true, row: body };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'request failed' };
    }
  }

  async deleteRadio(radioId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/radios/${encodeURIComponent(radioId)}`, {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'request failed' };
    }
  }

  async setDefaultRadio(radioId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/radios/${encodeURIComponent(radioId)}/default`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'request failed' };
    }
  }

  async getRadioLora(radioId: string): Promise<{ radio: any; live: any | null } | null> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/radios/${encodeURIComponent(radioId)}/lora`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async refreshRadioLora(radioId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/radios/${encodeURIComponent(radioId)}/lora/refresh`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'request failed' };
    }
  }

  async setRadioLora(radioId: string, patch: Partial<{
    region: number;
    modemPreset: number;
    usePreset: boolean;
    frequencySlot: number;
    hopLimit: number;
    txEnabled: boolean;
  }>): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/radios/${encodeURIComponent(radioId)}/lora`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'request failed' };
    }
  }

  // -------------------------------------------------------------------
  // v2.0 Phase 3 GPU clustering for map pins.
  // -------------------------------------------------------------------

  async clusterMapPoints(input: {
    points: Array<{ lat: number; lng: number; radio_id?: string | null; node_id?: string | null }>;
    eps_meters: number;
    min_samples?: number;
  }): Promise<{
    labels: number[];
    clusters: Array<{ id: number; count: number; lat: number; lng: number; node_ids: string[]; radio_ids: string[] }>;
    backend: 'cuml' | 'cpu' | 'cpu_ts' | 'noop';
  } | null> {
    try {
      const res = await fetch(`${API_BASE}/api/gpu/cluster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
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

  /** Fetch the persisted telemetry history for one node (server returns newest-first). */
  async fetchTelemetryHistory(nodeId: string, limit: number = 200): Promise<Array<{
    timestamp: number;
    battery?: number; voltage?: number;
    chUtil?: number; airUtilTx?: number;
    snr?: number; rssi?: number;
    temperature?: number; humidity?: number; pressure?: number;
  }>> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/nodes/${encodeURIComponent(nodeId)}/telemetry?limit=${limit}`);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
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

  /** Ask the radio to re-send its current Range Test module config. Local admin only. */
  async refreshRangeTestConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/range-test/refresh`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Start a timed Range Test sender survey. Restores the previous config after `durationMinutes`. */
  async startRangeTestSurvey(opts: { durationMinutes: number; senderIntervalSecs: number }): Promise<{ ok: boolean; expiresAt?: number; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/range-test/survey`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true, expiresAt: body.expiresAt };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  async cancelRangeTestSurvey(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/range-test/survey`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Start a timed NeighborInfo survey (faster cadence) to accelerate topology discovery. */
  async startNeighborInfoSurvey(opts: { durationMinutes: number; intervalSecs: number }): Promise<{ ok: boolean; expiresAt?: number; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/neighbor-info/survey`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true, expiresAt: body.expiresAt };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  async cancelNeighborInfoSurvey(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/neighbor-info/survey`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Configure the Range Test sender on the connected radio. senderIntervalSecs=0 = receive-only. */
  async setRangeTestConfig(opts: { enabled: boolean; senderIntervalSecs?: number; save?: boolean }): Promise<{ ok: boolean; senderIntervalSecs?: number; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/range-test`, {
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

  /** Ask the radio to re-send its current Telemetry module config. Local admin only. */
  async refreshTelemetryConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/telemetry/refresh`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Configure the Telemetry module on the connected radio. */
  async setTelemetryConfig(opts: {
    deviceUpdateIntervalSecs?: number;
    environmentEnabled?: boolean;
    environmentUpdateIntervalSecs?: number;
    powerEnabled?: boolean;
    powerUpdateIntervalSecs?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/telemetry`, {
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

  /** Ask the radio to re-send its current Store & Forward module config. Local admin only. */
  async refreshStoreForwardConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/store-forward/refresh`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Fetch aggregated Range Test coverage observations from the server. */
  async getRangeTestCoverage(windowMs = 0, limit = 5000): Promise<{
    windowMs: number;
    total: number;
    aggregates: Array<{
      senderId: string;
      count: number;
      avgSnr: number | null;
      bestSnr: number | null;
      worstSnr: number | null;
      avgRssi: number | null;
      bestRssi: number | null;
      worstRssi: number | null;
      lastSeen: number;
      lastLat: number | null;
      lastLng: number | null;
    }>;
    observations: Array<{
      id: number;
      senderId: string;
      senderLat: number | null;
      senderLng: number | null;
      seq: number | null;
      snr: number | null;
      rssi: number | null;
      text: string | null;
      timestamp: number;
    }>;
  } | { error: string }> {
    try {
      const url = `${API_BASE}/api/mesh/range-test/coverage?windowMs=${windowMs}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { error: body.error || `HTTP ${res.status}` };
      }
      return await res.json();
    } catch (err: any) {
      return { error: err.message || 'Network error' };
    }
  }

  /** Ask the radio to re-send its current Detection Sensor module config. Local admin only. */
  async refreshDetectionSensorConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/detection-sensor/refresh`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Configure the Detection Sensor module on the connected radio. */
  async setDetectionSensorConfig(cfg: {
    enabled: boolean;
    minimumBroadcastSecs: number;
    stateBroadcastSecs: number;
    sendBell: boolean;
    name: string;
    monitorPin: number;
    detectionTriggeredHigh: boolean;
    usePullup: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/detection-sensor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
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

  /** Ask the radio to re-send its current Audio module config. Local admin only. */
  async refreshAudioConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/audio/refresh`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Configure the Audio module on the connected radio. */
  async setAudioConfig(cfg: {
    codec2Enabled: boolean;
    pttPin: number;
    bitrate: number;
    i2sWs: number;
    i2sSd: number;
    i2sDin: number;
    i2sSck: number;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
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

  /** Ask the radio to re-send its current MQTT module config. Local admin only. */
  async refreshMqttConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/mqtt/refresh`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Configure the MQTT module on the connected radio. */
  async setMqttConfig(cfg: {
    enabled: boolean;
    address: string;
    username: string;
    password: string;
    encryptionEnabled: boolean;
    jsonEnabled: boolean;
    tlsEnabled: boolean;
    root: string;
    proxyToClientEnabled: boolean;
    mapReportingEnabled: boolean;
    mapReportSettingsRaw: string | null;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/mqtt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
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

  /** Ask the radio to re-send its current External Notification module config. Local admin only. */
  async refreshExternalNotificationConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/external-notification/refresh`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  /** Configure the External Notification module. All fields are required so board-specific GPIO assignments are preserved. */
  async setExternalNotificationConfig(cfg: {
    enabled: boolean;
    outputMs: number;
    output: number;
    active: boolean;
    alertMessage: boolean;
    alertBell: boolean;
    usePwm: boolean;
    outputVibra: number;
    outputBuzzer: number;
    alertMessageVibra: boolean;
    alertMessageBuzzer: boolean;
    alertBellVibra: boolean;
    alertBellBuzzer: boolean;
    nagTimeout: number;
    useI2sAsBuzzer: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/external-notification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
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

  /** Configure the Store & Forward module on the connected radio. */
  async setStoreForwardConfig(opts: {
    enabled: boolean;
    isServer?: boolean;
    heartbeat?: boolean;
    records?: number;
    historyReturnMax?: number;
    historyReturnWindow?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/modules/store-forward`, {
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

  // ---- Node groups ----

  /** Subscribe to the current groups list (replays the last known list immediately). */
  onGroups(callback: (groups: Group[]) => void) {
    this.groupListeners.push(callback);
    callback(this.lastGroups);
    return () => { this.groupListeners = this.groupListeners.filter(l => l !== callback); };
  }

  /** Subscribe to the blocked-node-id list (replays the last known list immediately). */
  onBlocked(callback: (blocked: string[]) => void) {
    this.blockedListeners.push(callback);
    callback(this.lastBlocked);
    return () => { this.blockedListeners = this.blockedListeners.filter(l => l !== callback); };
  }

  /** Add a node to the server-side block list. */
  async blockNode(nodeId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/blocked`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId }),
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

  /** Remove a node from the server-side block list. */
  async unblockNode(nodeId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/blocked/${encodeURIComponent(nodeId)}`, {
        method: 'DELETE',
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

  getGroups(): Group[] {
    return [...this.lastGroups];
  }

  async createGroup(name: string, color: string): Promise<{ ok: boolean; group?: Group; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      const body = await res.json();
      await this.poll();
      return { ok: true, group: body.group };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  async updateGroup(id: string, patch: { name?: string; color?: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/groups/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
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

  async deleteGroup(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

  /** Assign a node to a group, or pass null to unassign. */
  async setNodeGroup(nodeId: string, groupId: string | null): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/api/mesh/nodes/${encodeURIComponent(nodeId)}/group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
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

      if (data.groups) {
        this.lastGroups = data.groups;
        this.groupListeners.forEach(l => l(data.groups!));
      }

      if (Array.isArray(data.blocked)) {
        this.lastBlocked = data.blocked;
        this.blockedListeners.forEach(l => l(data.blocked!));
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
