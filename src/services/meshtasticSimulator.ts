import { Node, Message, RadioEvent, UptimeRecord, RouteRecord, Waypoint } from '../types';

/**
 * Generate a unique-enough id for a simulator-only message or event.
 *
 * We deliberately do NOT use `crypto.randomUUID()` here: that API throws on a
 * non-secure context (any HTTP origin that isn't localhost), and the simulator
 * is constructed eagerly at module load — so a single throw cascades into a
 * black-screen crash for every component that imports it. The simulator's ids
 * don't need to be cryptographically random, just collision-free for an
 * in-browser session, which `Date.now()` plus randomness easily achieves.
 */
function simId(): string {
  return `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const INITIAL_NODES: Node[] = [
  {
    id: '!abcdef01',
    name: 'Home Base',
    shortName: 'HB',
    lastSeen: Date.now(),
    online: true,
    favorite: true,
    position: { lat: 45.523062, lng: -122.676482, alt: 52 },
    telemetry: { battery: 98, voltage: 4.15, channelUtilization: 2.5, airUtilTx: 1.2, snr: 8.5, rssi: -45 },
    sensors: {
      temperature: 21.5,
      humidity: 42,
      pressure: 1012.4,
      iaq: 18,
      bridge: {
        type: 'RASPBERRY_PI',
        connected: true,
        uptime: 15420,
        cpuTemp: 42.1,
        ramUsage: 18.4
      }
    },
    settings: {
      longName: 'Home Base',
      shortName: 'HB',
      isOwner: true,
      hopLimit: 3,
      broadcastInterval: 300,
      channelName: 'Default',
      modemPreset: 'LONG_FAST'
    }
  },
  {
    id: '!abcdef02',
    name: 'Mountain Peak',
    shortName: 'MP',
    lastSeen: Date.now() - 5000,
    online: true,
    favorite: true,
    position: { lat: 45.542062, lng: -122.656482, alt: 450 },
    telemetry: { battery: 72, voltage: 3.82, channelUtilization: 5.1, airUtilTx: 0.8, snr: 12.0, rssi: -82, distance: 3.2 },
    sensors: {
      temperature: 4.2,
      humidity: 85,
      pressure: 985.1,
      iaq: 12
    },
    settings: {
      longName: 'Mountain Peak',
      shortName: 'MP',
      hopLimit: 3,
      broadcastInterval: 300,
      channelName: 'Default',
      modemPreset: 'LONG_FAST'
    }
  },
  {
    id: '!abcdef03',
    name: 'River Station',
    shortName: 'RS',
    lastSeen: Date.now() - 120000,
    online: false,
    favorite: false,
    position: { lat: 45.513062, lng: -122.696482, alt: 12 },
    telemetry: { battery: 12, voltage: 3.45, channelUtilization: 1.2, airUtilTx: 0.1, snr: -2.5, rssi: -105, distance: 1.5 },
    settings: {
      longName: 'River Station',
      shortName: 'RS',
      hopLimit: 3,
      broadcastInterval: 600,
      channelName: 'Default',
      modemPreset: 'LONG_SLOW'
    }
  },
  {
    id: '!abcdef04',
    name: 'North Router',
    shortName: 'NR',
    lastSeen: Date.now() - 3000,
    online: true,
    favorite: false,
    position: { lat: 45.563062, lng: -122.676482, alt: 85 },
    telemetry: { battery: 85, voltage: 3.95, channelUtilization: 3.8, airUtilTx: 2.1, snr: 4.2, rssi: -92, distance: 4.5 },
    settings: {
      longName: 'North Router',
      shortName: 'NR',
      hopLimit: 5,
      broadcastInterval: 300,
      channelName: 'Default',
      modemPreset: 'LONG_FAST'
    }
  }
];

export class MeshtasticSimulator {
  private nodes: Node[] = [...INITIAL_NODES];
  private messages: Message[] = [];
  private events: RadioEvent[] = [];
  private uptimeHistory: UptimeRecord[] = [];
  private routeHistory: RouteRecord[] = [];
  private waypoints: Waypoint[] = [];
  private listeners: ((nodes: Node[], messages: Message[], events: RadioEvent[]) => void)[] = [];
  private waypointListeners: ((waypoints: Waypoint[]) => void)[] = [];

  constructor() {
    // Seed initial uptime records for nodes that start online
    this.nodes.forEach(n => {
      if (n.online) {
        this.uptimeHistory.push({ nodeId: n.id, onlineAt: Date.now() - 60000, offlineAt: null });
      }
    });
    // Defensive: if the demo seed throws for any reason (browser API quirk,
    // unexpected node shape, etc.), log it but don't take down the whole app.
    // The simulator is constructed eagerly at module load; a thrown error here
    // would cascade to break every component that imports the simulator
    // (including AIAssistant, MapView, DashboardView, etc.) and produce a
    // black screen on dashboard load.
    try {
      this.seedDemoHistory();
    } catch (err) {
      console.error('[Simulator] seedDemoHistory failed; continuing without seeded demo data:', err);
    }
    this.startSimulation();
  }

  /**
   * Pre-populate ~24 h of demo data so the Comm Matrix, NodeUptimeWidget, and
   * other analytics views have something interesting to show the moment the
   * operator switches to simulator mode.
   *
   * Generates:
   *  - ~120 messages spread evenly across the last 24 h between random pairs
   *    of online nodes, with realistic hops, status, errorCode, deliveryMs.
   *  - ~3-5 historical online↔offline sessions per node so peak-hours histos
   *    have data and the per-node uptime widget shows variation.
   */
  private seedDemoHistory() {
    const now = Date.now();
    const DAY = 24 * 3600_000;
    const onlineNodes = this.nodes.filter(n => n.online);
    if (onlineNodes.length < 2) return;

    // ---- Messages ----
    const SAMPLE_BODIES = [
      'Check in', 'Position update', 'Signals are clear', 'Moving to position B',
      'Weather looks good', "How's the relay?", 'Status update', 'Requesting telemetry',
      'ACK received', 'Range test seq 42', 'Battery at 85%', 'Heading north',
      'Standing by', 'Comms check, all good', 'Repeater online', 'Drop point reached',
    ];
    const N_MESSAGES = 120;
    for (let i = 0; i < N_MESSAGES; i++) {
      const from = onlineNodes[Math.floor(Math.random() * onlineNodes.length)];
      let to = onlineNodes[Math.floor(Math.random() * onlineNodes.length)];
      // Avoid self-loops; bias toward repeating pairs so the matrix has hot cells
      // rather than uniform sprinkle.
      if (to.id === from.id) to = onlineNodes[(onlineNodes.indexOf(to) + 1) % onlineNodes.length];
      if (to.id === from.id) continue;

      const hops = this.computeRoute(from.id, to.id);
      const relayHops = hops.slice(1, -1);
      const allRelaysOnline = relayHops.every(h => this.nodes.find(n => n.id === h)?.online);
      // Per-pair lossiness so the success column has variation. Hash from+to to
      // a stable failure rate so the same pair is consistently good/bad.
      const pairHash = Array.from(from.id + to.id).reduce((s, c) => s + c.charCodeAt(0), 0);
      const baseSuccessRate = 0.55 + ((pairHash % 40) / 100); // 55%-94%
      const succeeded = allRelaysOnline && to.online && Math.random() < baseSuccessRate;
      const deliveryMs = hops.length * (200 + Math.random() * 800);
      // Spread timestamps over the last 24 h, weighted slightly toward "recent"
      const ageMs = Math.floor(Math.random() * Math.random() * DAY);
      const ts = now - ageMs;

      this.messages.push({
        id: simId(),
        from: from.id,
        to: to.id,
        text: SAMPLE_BODIES[Math.floor(Math.random() * SAMPLE_BODIES.length)],
        timestamp: ts,
        channel: 'Private',
        hopLimit: 3,
        hops,
        status: succeeded ? 'acked' : 'error',
        errorCode: succeeded ? undefined : -1,
        deliveryMs: succeeded ? Math.round(deliveryMs) : undefined,
      });
    }
    this.messages.sort((a, b) => a.timestamp - b.timestamp);

    // ---- Uptime sessions ----
    // Replace the "online for the last minute" stub with a richer per-node
    // history so the peak-hours histogram has variation.
    this.uptimeHistory = [];
    for (const n of this.nodes) {
      if (!n.online) continue;
      // Each node gets 3-5 sessions in the last 24 h.
      const sessions = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < sessions; i++) {
        const startOffset = Math.floor(Math.random() * DAY);
        const dur = 30 * 60_000 + Math.floor(Math.random() * 4 * 3600_000); // 30 min – 4 h 30 min
        const onlineAt = now - startOffset - dur;
        const offlineAt = onlineAt + dur;
        this.uptimeHistory.push({ nodeId: n.id, onlineAt, offlineAt });
      }
      // Plus a still-open session for "currently online".
      this.uptimeHistory.push({
        nodeId: n.id,
        onlineAt: now - Math.floor(Math.random() * 30 * 60_000),
        offlineAt: null,
      });
    }
  }

  public getUptimeHistory(): UptimeRecord[] {
    return [...this.uptimeHistory];
  }

  public getRouteHistory(): RouteRecord[] {
    return [...this.routeHistory];
  }

  public setFavorite(nodeId: string, favorite: boolean) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return;
    node.favorite = !!favorite;
    this.notify();
  }

  public updateNode(nodeId: string, updates: Partial<Node>) {
    this.nodes = this.nodes.map(n => {
      if (n.id === nodeId) {
        const updatedNode = { ...n, ...updates };
        if (updates.settings) {
          updatedNode.name = updates.settings.longName;
          updatedNode.shortName = updates.settings.shortName;
        }
        return updatedNode;
      }
      return n;
    });
    this.addEvent('TELEMETRY', nodeId, `Configuration updated for ${nodeId}`);
    this.notify();
  }

  private intervalId: ReturnType<typeof setInterval> | null = null;

  private startSimulation() {
    this.intervalId = setInterval(() => {
      // Randomly update a node's telemetry or status
      const nodeIndex = Math.floor(Math.random() * this.nodes.length);
      const node = this.nodes[nodeIndex];
      
      const updateType = Math.random();
      
      if (updateType < 0.4) {
        // Telemetry update
        if (node.telemetry) {
          const updated = { ...node, lastSeen: Date.now(), online: true };
          updated.telemetry = {
            ...node.telemetry,
            battery: Math.max(0, Math.min(100, node.telemetry.battery + (Math.random() - 0.5) * 5)),
            snr: node.telemetry.snr + (Math.random() - 0.5),
            rssi: node.telemetry.rssi + (Math.random() - 0.5) * 2,
          };
          
          // Also update sensors if present
          if (node.sensors) {
            updated.sensors = {
              ...node.sensors,
              temperature: node.sensors.temperature !== undefined ? node.sensors.temperature + (Math.random() - 0.5) * 0.2 : undefined,
              humidity: node.sensors.humidity !== undefined ? Math.max(0, Math.min(100, node.sensors.humidity + (Math.random() - 0.5) * 1)) : undefined,
              pressure: node.sensors.pressure !== undefined ? node.sensors.pressure + (Math.random() - 0.5) * 0.5 : undefined,
            };
            
            if (node.sensors.bridge) {
              updated.sensors.bridge = {
                ...node.sensors.bridge,
                uptime: node.sensors.bridge.uptime + 5,
                cpuTemp: node.sensors.bridge.cpuTemp !== undefined ? node.sensors.bridge.cpuTemp + (Math.random() - 0.5) * 0.5 : undefined,
                ramUsage: node.sensors.bridge.ramUsage !== undefined ? Math.max(0, Math.min(100, node.sensors.bridge.ramUsage + (Math.random() - 0.5) * 0.1)) : undefined,
              };
            }
          }

          this.nodes[nodeIndex] = updated;
          this.addEvent('TELEMETRY', updated.id, `Received telemetry/sensor pulse from ${updated.name}`);
        }
      } else if (updateType < 0.55) {
        // Message simulation with realistic routing
        const toNode = this.nodes[Math.floor(Math.random() * this.nodes.length)];
        if (toNode.id !== node.id && node.online) {
          const hops = this.computeRoute(node.id, toNode.id);
          const relayHops = hops.slice(1, -1); // exclude src & dst
          const allRelaysOnline = relayHops.every(h => this.nodes.find(n => n.id === h)?.online);
          const deliveryMs = hops.length * (200 + Math.random() * 800);

          // Stamp status + deliveryMs directly on the Message so the Comm Matrix
          // drill-down (which reads from `messages` prop) has full data in
          // simulator mode without hitting the server.
          const msg: Message = {
            id: simId(),
            from: node.id,
            to: toNode.id,
            text: ["Check in", "Signals are clear", "Moving to position B", "Weather looks good", "How's the relay?", "Status update", "Requesting telemetry", "ACK received"][Math.floor(Math.random() * 8)],
            timestamp: Date.now(),
            channel: 'Private',
            hopLimit: 3,
            hops,
            status: (allRelaysOnline && toNode.online) ? 'acked' : 'error',
            errorCode: (allRelaysOnline && toNode.online) ? undefined : -1,
            deliveryMs: (allRelaysOnline && toNode.online) ? Math.round(deliveryMs) : undefined,
          };
          this.messages = [...this.messages, msg];

          this.routeHistory.push({
            from: node.id,
            to: toNode.id,
            hops: relayHops,
            timestamp: Date.now(),
            deliveryMs,
            success: allRelaysOnline && toNode.online,
          });
          // Cap route history at 500 entries
          if (this.routeHistory.length > 500) {
            this.routeHistory = this.routeHistory.slice(-500);
          }

          this.addEvent('MESSAGE', node.id, `${node.name} → ${toNode.name} via ${hops.length - 2} relay(s)`);
        }
      } else if (updateType < 0.65) {
        // Toggle node online/offline to generate uptime data
        if (node.id !== '!abcdef01') { // Home Base stays online
          const wasOnline = node.online;
          const goOnline = !wasOnline;
          const updated = { ...node, online: goOnline, lastSeen: Date.now() };
          this.nodes[nodeIndex] = updated;

          if (goOnline) {
            this.uptimeHistory.push({ nodeId: node.id, onlineAt: Date.now(), offlineAt: null });
            this.addEvent('NODE_JOINED', node.id, `${node.name} came online`);
          } else {
            // Close the most recent open record
            let openIdx = -1;
            for (let i = this.uptimeHistory.length - 1; i >= 0; i--) {
              if (this.uptimeHistory[i].nodeId === node.id && this.uptimeHistory[i].offlineAt === null) { openIdx = i; break; }
            }
            if (openIdx >= 0) {
              this.uptimeHistory[openIdx] = { ...this.uptimeHistory[openIdx], offlineAt: Date.now() };
            }
            this.addEvent('NODE_LOST', node.id, `${node.name} went offline`);
          }
        }
      } else if (updateType < 0.7) {
        // Position shift (subtle)
        if (node.position) {
          const updated = {
            ...node,
            lastSeen: Date.now(),
            position: {
              ...node.position,
              lat: node.position.lat + (Math.random() - 0.5) * 0.001,
              lng: node.position.lng + (Math.random() - 0.5) * 0.001,
            },
          };
          this.nodes[nodeIndex] = updated;
          this.addEvent('POSITION_UPDATE', updated.id, `${updated.name} updated position`);
        }
      }

      this.notify();
    }, 5000);
  }

  private computeRoute(fromId: string, toId: string): string[] {
    // Build a route based on simulated proximity / RSSI
    const from = this.nodes.find(n => n.id === fromId);
    const to = this.nodes.find(n => n.id === toId);
    if (!from || !to) return [fromId, toId];

    // Potential relay nodes (online, not src/dst)
    const relays = this.nodes.filter(n => n.online && n.id !== fromId && n.id !== toId);

    if (relays.length === 0) return [fromId, toId];

    // Deterministically prefer nodes with better RSSI as relays
    // Sort by signal strength descending
    const ranked = relays
      .filter(n => n.telemetry)
      .sort((a, b) => (b.telemetry!.rssi) - (a.telemetry!.rssi));

    // 60% chance of 1 relay, 30% chance of 2 relays, 10% direct
    const roll = Math.random();
    if (roll < 0.1 || ranked.length === 0) {
      return [fromId, toId];
    } else if (roll < 0.7 || ranked.length < 2) {
      return [fromId, ranked[0].id, toId];
    } else {
      return [fromId, ranked[0].id, ranked[1].id, toId];
    }
  }

  public destroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  public addEvent(type: RadioEvent['type'], nodeId: string, details: string) {
    const event: RadioEvent = {
      id: simId(),
      type,
      nodeId,
      timestamp: Date.now(),
      details
    };
    this.events = [event, ...this.events.slice(0, 49)];
  }

  public subscribe(callback: (nodes: Node[], messages: Message[], events: RadioEvent[]) => void) {
    this.listeners.push(callback);
    callback(this.nodes, this.messages, this.events);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  private notify() {
    this.listeners.forEach(l => l([...this.nodes], [...this.messages], [...this.events]));
  }

  // ---- Waypoints (in-memory only; lost on reload) ----

  public getWaypoints(): Waypoint[] {
    const nowSec = Math.floor(Date.now() / 1000);
    return this.waypoints.filter(w => w.expire === 0 || w.expire > nowSec);
  }

  public onWaypoints(cb: (waypoints: Waypoint[]) => void) {
    this.waypointListeners.push(cb);
    cb(this.getWaypoints());
    return () => {
      this.waypointListeners = this.waypointListeners.filter(l => l !== cb);
    };
  }

  public saveWaypoint(input: {
    id?: number;
    lat: number;
    lng: number;
    name?: string;
    description?: string;
    icon?: number;
    expire?: number;
    lockedToSelf?: boolean;
  }): Waypoint {
    const localId = '!abcdef01';
    const id = input.id && input.id > 0 ? input.id : (Math.floor(Math.random() * 0x7fffffff) | 0) >>> 0;
    const wp: Waypoint = {
      id,
      lat: input.lat,
      lng: input.lng,
      name: input.name ?? '',
      description: input.description ?? '',
      icon: input.icon ?? 0,
      expire: input.expire ?? 0,
      lockedTo: input.lockedToSelf ? 0xabcdef01 : 0,
      createdBy: localId,
      lastSeen: Date.now(),
    };
    const idx = this.waypoints.findIndex(w => w.id === id);
    if (idx >= 0) this.waypoints[idx] = wp;
    else this.waypoints.push(wp);
    this.notifyWaypoints();
    return wp;
  }

  public deleteWaypoint(id: number): boolean {
    const before = this.waypoints.length;
    this.waypoints = this.waypoints.filter(w => w.id !== id);
    if (this.waypoints.length === before) return false;
    this.notifyWaypoints();
    return true;
  }

  public getLocalNodeId(): string {
    return '!abcdef01';
  }

  private notifyWaypoints() {
    const cur = this.getWaypoints();
    this.waypointListeners.forEach(l => l([...cur]));
  }
}

export const simulator = new MeshtasticSimulator();
