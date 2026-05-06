/**
 * Meshtastic Serial Bridge
 * 
 * Connects to a real Meshtastic LoRa radio over USB serial and translates
 * protobuf packets into the app's Node / Message / RadioEvent data model.
 */
import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';
import * as net from 'net';
import { meshDb, type MeshDatabase } from './database.js';

// ---- App data types (mirrored from src/types.ts for server use) ----

export interface MeshNode {
  id: string;
  name: string;
  shortName: string;
  lastSeen: number;
  online: boolean;
  favorite: boolean;
  /** Base64-encoded Curve25519 public key, if the node advertised one (PKC support, fw 2.5+). */
  publicKey?: string;
  /** Whether the last reported position came from a hard-coded fix or live GPS (fw 'location_source' enum). */
  positionSource?: 'manual' | 'gps';
  /** Channel-imposed precision_bits, if the node's last Position carried it (32 = full precision). */
  positionPrecisionBits?: number;
  position?: { lat: number; lng: number; alt: number };
  telemetry?: {
    battery: number;
    voltage: number;
    channelUtilization: number;
    airUtilTx: number;
    snr: number;
    rssi: number;
    distance?: number;
  };
  sensors?: {
    temperature?: number;
    humidity?: number;
    pressure?: number;
    iaq?: number;
  };
  settings?: {
    longName: string;
    shortName: string;
    hopLimit: number;
    broadcastInterval: number;
    channelName: string;
    modemPreset: string;
  };
}

export interface MeshMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: number;
  channel: string;
  hopLimit: number;
  hops: string[];
  status?: 'sending' | 'sent' | 'acked' | 'error';
  errorCode?: number;
  isOwn?: boolean;
  /** The radio's MeshPacket.id (uint32). Used for cross-referencing replies and reactions. */
  packetId?: number;
  /** If set, this message is a reply or reaction to the message whose packetId === replyTo. */
  replyTo?: number;
  /** True if this message is a tapback/reaction (Data.emoji != 0). The text holds the emoji. */
  isReaction?: boolean;
}

export interface MeshEvent {
  id: string;
  type: 'NODE_JOINED' | 'NODE_LOST' | 'MESSAGE' | 'TELEMETRY' | 'POSITION_UPDATE';
  nodeId: string;
  timestamp: number;
  details: string;
}

export type ChannelRole = 'DISABLED' | 'PRIMARY' | 'SECONDARY';

export interface MeshChannel {
  index: number;            // 0-7
  name: string;
  role: ChannelRole;
  pskBase64: string;        // raw PSK bytes encoded as base64
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
}

export interface MeshWaypoint {
  id: number;               // u32, stable across edits/deletes
  lat: number;
  lng: number;
  name: string;
  description: string;
  icon: number;             // u32 emoji codepoint (0 = none)
  expire: number;           // epoch seconds; 0 = never; past = deletion sentinel
  lockedTo: number;         // node num that may edit; 0 = anyone
  createdBy: string;        // !hex of placer (server-side bookkeeping)
  lastSeen: number;         // epoch ms last time we saw/updated this
}

export interface TraceHop {
  nodeId: string;           // !hex
  snr?: number;             // dB (already divided by 4)
}

export interface NeighborObservation {
  /** !hex of the neighbor this node directly hears. */
  nodeId: string;
  /** SNR in dB as reported by the originating node's last RX from this neighbor. */
  snr: number;
  /** Neighbor's own broadcast interval in seconds (0 if unknown). */
  intervalSecs?: number;
}

export interface NeighborInfoSnapshot {
  /** !hex of the node that sent the NeighborInfo packet. */
  fromNodeId: string;
  /** Originator's broadcast interval (how often it sends NeighborInfo). */
  intervalSecs: number;
  /** Direct neighbors this node currently observes. */
  neighbors: NeighborObservation[];
  /** Epoch ms when we last received a NeighborInfo from this node. */
  lastSeen: number;
}

export interface StoreForwardStats {
  messagesTotal?: number;
  messagesSaved?: number;
  messagesMax?: number;
  upTimeSecs?: number;
  requests?: number;
  requestsHistory?: number;
  heartbeatActive?: boolean;
  returnMax?: number;
  returnWindowMins?: number;
}

export interface MeshStoreForwardRouter {
  /** !hex of the node running the S&F module. */
  nodeId: string;
  /** Heartbeat period in seconds (how often the router announces itself). */
  periodSecs: number;
  /** True for secondary routers; false (or 0) for primary on the channel. */
  isSecondary: boolean;
  /** Epoch ms of the most recent heartbeat we observed from this router. */
  lastHeartbeat: number;
  /** Most recent stats snapshot the router shared. */
  stats?: StoreForwardStats;
}

export interface MeshTraceResult {
  id: string;               // requestId we hand back to the client
  targetId: string;         // node we asked about
  startedAt: number;        // epoch ms
  completedAt?: number;     // epoch ms when response arrived (undefined while in flight)
  status: 'pending' | 'response' | 'timeout' | 'error';
  /** Outbound path: relays observed on the way to the target (may be empty if direct). */
  route: TraceHop[];
  /** Return path: relays the response took back to us. */
  routeBack: TraceHop[];
  errorMessage?: string;
}

// ---- Meshtastic serial protocol constants ----
const START_BYTE_1 = 0x94;
const START_BYTE_2 = 0xc3;
const HEADER_SIZE = 4; // 2 start bytes + 2 byte MSB length

// Meshtastic protobuf port numbers
const PORT_TEXT_MESSAGE = 1;
const PORT_ROUTING = 5;
const PORT_POSITION = 3;
const PORT_NODEINFO = 4;
const PORT_ADMIN_APP = 6;
const PORT_WAYPOINT_APP = 8;
const PORT_STORE_FORWARD_APP = 65;
const PORT_RANGE_TEST_APP = 66;
const PORT_TELEMETRY = 67;
const PORT_TRACEROUTE_APP = 70;
const PORT_NEIGHBORINFO_APP = 71;

const CHANNEL_ROLE_NUM: Record<ChannelRole, number> = { DISABLED: 0, PRIMARY: 1, SECONDARY: 2 };
const CHANNEL_ROLE_NAME: ChannelRole[] = ['DISABLED', 'PRIMARY', 'SECONDARY'];

function nodeIdToHex(num: number): string {
  return `!${num.toString(16).padStart(8, '0')}`;
}

function randomId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

export type TransportMode = 'serial' | 'tcp';

export interface TcpEndpoint {
  host: string;
  port: number;
}

export class MeshtasticSerialBridge extends EventEmitter {
  private port: SerialPort | null = null;
  private portPath: string | null = null;
  private tcpSocket: net.Socket | null = null;
  private tcpEndpoint: TcpEndpoint | null = null;
  private transportMode: TransportMode | null = null;
  private nodes = new Map<string, MeshNode>();
  private messages: MeshMessage[] = [];
  private events: MeshEvent[] = [];
  private rxBuffer = Buffer.alloc(0);
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private localNodeId: string | null = null;
  private localNodeNum: number = 0;
  private channels = new Map<number, MeshChannel>();
  private waypoints = new Map<number, MeshWaypoint>();
  private traces = new Map<string, MeshTraceResult>();
  /** packetId → traceRequest. Used to match the response back to the client. */
  private pendingTraces = new Map<number, { requestId: string; timer: ReturnType<typeof setTimeout> }>();
  /** Latest NeighborInfo report keyed by originator node id. */
  private neighborInfo = new Map<string, NeighborInfoSnapshot>();
  /** Known Store & Forward routers, keyed by node id. */
  private storeForwardRouters = new Map<string, MeshStoreForwardRouter>();
  /** Hours to keep events around. Set via setEventRetention(). */
  private eventRetentionHours: number = 24;
  private retentionPruneTimer: ReturnType<typeof setInterval> | null = null;
  private db: MeshDatabase = meshDb();

  /** True iff EITHER transport (serial or TCP) is open and writable. */
  private isLinkOpen(): boolean {
    if (this.port?.isOpen) return true;
    if (this.tcpSocket && !this.tcpSocket.destroyed && this.tcpSocket.writable) return true;
    return false;
  }

  /** Write a fully-framed buffer to whichever transport is active. */
  private writeLink(buf: Buffer): boolean {
    if (this.port?.isOpen) { this.port.write(buf); return true; }
    if (this.tcpSocket && !this.tcpSocket.destroyed && this.tcpSocket.writable) {
      this.tcpSocket.write(buf); return true;
    }
    return false;
  }

  // ACK tracking: maps packetId → { msgId, timer }
  private pendingAcks = new Map<number, { msgId: string; timer: ReturnType<typeof setTimeout> }>();
  private nextPacketId = (Math.floor(Math.random() * 0xfffe) + 1);

  constructor() {
    super();
    this.hydrateFromDatabase();
  }

  /** Load persisted state into the in-memory caches on boot. */
  private hydrateFromDatabase() {
    try {
      const persistedNodes = this.db.loadNodes();
      for (const n of persistedNodes) {
        // Mark everything offline initially — they'll come back online as the
        // radio reports them again.
        n.online = false;
        this.nodes.set(n.id, n);
      }

      const persistedMessages = this.db.loadMessages();
      this.messages = persistedMessages;

      const persistedEvents = this.db.loadEvents();
      this.events = persistedEvents;

      const persistedChannels = this.db.loadChannels();
      for (const c of persistedChannels) this.channels.set(c.index, c);

      const persistedWaypoints = this.db.loadWaypoints();
      for (const w of persistedWaypoints) this.waypoints.set(w.id, w);

      const persistedNeighbors = this.db.loadNeighborInfo();
      for (const n of persistedNeighbors) this.neighborInfo.set(n.fromNodeId, n);

      const persistedSfRouters = this.db.loadStoreForwardRouters();
      for (const r of persistedSfRouters) this.storeForwardRouters.set(r.nodeId, r);

      const s = this.db.stats();
      console.log(
        `[MeshtasticSerial] Hydrated from DB — nodes:${s.nodes} messages:${s.messages} events:${s.events} channels:${s.channels} telemetry:${s.telemetry}`
      );
    } catch (err: any) {
      console.error('[MeshtasticSerial] DB hydration failed:', err.message);
    }
  }

  // How long before marking a node offline (ms)
  private staleThresholdMs = 15 * 60 * 1000; // 15 minutes

  /** Upsert into the in-memory cache AND persist. Use this everywhere
   *  instead of `this.nodes.set(id, node)`. */
  private upsertNode(node: MeshNode) {
    this.nodes.set(node.id, node);
    try {
      this.db.upsertNode(node);
    } catch (err: any) {
      console.error('[MeshtasticSerial] upsertNode persist failed:', err.message);
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  getNodes(): MeshNode[] {
    return Array.from(this.nodes.values());
  }

  /** Mark a node as favorite (or unfavorite). Updates the in-memory cache and persists. */
  setFavorite(nodeId: string, favorite: boolean): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.favorite = !!favorite;
    try { this.db.setFavorite(nodeId, node.favorite); }
    catch (err: any) { console.error('[MeshtasticSerial] setFavorite persist failed:', err.message); }
    this.emit('nodeUpdate', node);
    return true;
  }

  getMessages(): MeshMessage[] {
    return [...this.messages];
  }

  getEvents(): MeshEvent[] {
    return [...this.events];
  }

  getChannels(): MeshChannel[] {
    return Array.from(this.channels.values()).sort((a, b) => a.index - b.index);
  }

  getWaypoints(): MeshWaypoint[] {
    const nowSec = Math.floor(Date.now() / 1000);
    return Array.from(this.waypoints.values())
      .filter(w => w.expire === 0 || w.expire > nowSec)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** All recent traceroute results. */
  getTraces(): MeshTraceResult[] {
    return Array.from(this.traces.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Most recent NeighborInfo broadcasts, one per originating node. */
  getNeighborInfo(): NeighborInfoSnapshot[] {
    return Array.from(this.neighborInfo.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** All known Store & Forward routers (most-recently-heard first). */
  getStoreForwardRouters(): MeshStoreForwardRouter[] {
    return Array.from(this.storeForwardRouters.values()).sort((a, b) => b.lastHeartbeat - a.lastHeartbeat);
  }

  /** Local node hex id (e.g. "!aabbccdd") if known, null otherwise. */
  getLocalNodeId(): string | null {
    return this.localNodeId;
  }

  getLocalNodeNum(): number {
    return this.localNodeNum;
  }

  /** Connect to a serial port */
  async connect(portPath: string): Promise<void> {
    if (this.port || this.tcpSocket) {
      await this.disconnect();
    }

    this.portPath = portPath;
    this.tcpEndpoint = null;
    this.transportMode = 'serial';
    console.log(`[MeshtasticSerial] Connecting to serial ${portPath}...`);

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: portPath,
        baudRate: 115200,
        autoOpen: false,
      });

      this.port.on('data', (chunk: Buffer) => this.onData(chunk));
      this.port.on('error', (err) => this.onError(err));
      this.port.on('close', () => this.onClose());

      this.port.open((err) => {
        if (err) {
          console.error(`[MeshtasticSerial] Failed to open ${portPath}:`, err.message);
          this.scheduleReconnect();
          reject(err);
          return;
        }
        this._connected = true;
        console.log(`[MeshtasticSerial] Connected to ${portPath}`);
        this.addEvent('NODE_JOINED', 'local', `Serial connected to ${portPath}`);
        this.emit('connected', portPath);

        // Request node list from the radio
        this.requestConfig();

        // Start stale node checker
        this.staleCheckTimer = setInterval(() => this.markStaleNodesOffline(), 60_000);

        resolve();
      });
    });
  }

  /**
   * Connect to a Meshtastic radio over TCP. The wire format is the same
   * 0x94 0xC3 framed protobuf stream as serial — only the transport differs.
   * Default firmware port is 4403.
   */
  async connectTcp(host: string, port: number = 4403): Promise<void> {
    if (this.port || this.tcpSocket) {
      await this.disconnect();
    }

    this.tcpEndpoint = { host, port };
    this.portPath = null;
    this.transportMode = 'tcp';
    console.log(`[MeshtasticSerial] Connecting to tcp://${host}:${port}...`);

    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      this.tcpSocket = sock;
      sock.setNoDelay(true);
      // Heartbeat so a silently-dropped link surfaces.
      sock.setKeepAlive(true, 30_000);

      let resolved = false;

      sock.on('data', (chunk: Buffer) => this.onData(chunk));
      sock.on('error', (err) => {
        this.onError(err);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
      sock.on('close', () => this.onClose());

      sock.connect(port, host, () => {
        resolved = true;
        this._connected = true;
        console.log(`[MeshtasticSerial] Connected to tcp://${host}:${port}`);
        this.addEvent('NODE_JOINED', 'local', `TCP connected to ${host}:${port}`);
        this.emit('connected', `${host}:${port}`);

        this.requestConfig();
        this.staleCheckTimer = setInterval(() => this.markStaleNodesOffline(), 60_000);
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }

    const closeSerial = (): Promise<void> => new Promise(resolve => {
      if (this.port?.isOpen) {
        this.port.close(() => resolve());
      } else {
        resolve();
      }
    });

    const closeTcp = (): Promise<void> => new Promise(resolve => {
      const s = this.tcpSocket;
      if (s && !s.destroyed) {
        s.once('close', () => resolve());
        s.end();
        // Hard-close after a short grace period
        setTimeout(() => { try { s.destroy(); } catch { /* ignore */ } }, 1000);
      } else {
        resolve();
      }
    });

    await Promise.all([closeSerial(), closeTcp()]);

    this._connected = false;
    this.port = null;
    this.tcpSocket = null;
    this.transportMode = null;
    this.portPath = null;
    this.tcpEndpoint = null;
    this.localNodeId = null;
    this.localNodeNum = 0;
    this.channels.clear();

    // Clear any pending reconnect that the close event may have scheduled.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Public: introspect the active transport. */
  getTransport(): { mode: TransportMode | null; serial?: { port: string }; tcp?: TcpEndpoint } {
    if (this.transportMode === 'serial' && this.portPath) {
      return { mode: 'serial', serial: { port: this.portPath } };
    }
    if (this.transportMode === 'tcp' && this.tcpEndpoint) {
      return { mode: 'tcp', tcp: this.tcpEndpoint };
    }
    return { mode: null };
  }

  /** Resolve the channel name for a sent message so it lands in the right chat pane */
  private resolveChannelName(channelIndex: number, to: string): string {
    if (to !== '!ffffffff') return 'Private';
    const ch = this.channels.get(channelIndex);
    if (!ch) return channelIndex === 0 ? 'LongFast' : `Channel ${channelIndex}`;
    if (ch.role === 'PRIMARY') return ch.name || 'LongFast';
    return ch.name || `Channel ${channelIndex}`;
  }

  /** Persist a single message row (insert-or-replace on the same id). */
  private persistMessage(msg: MeshMessage) {
    try {
      this.db.insertMessage(msg);
    } catch (err: any) {
      console.error('[MeshtasticSerial] insertMessage persist failed:', err.message);
    }
  }

  /** Send a text message through the radio. Returns the local message ID. */
  async sendMessage(
    text: string,
    to: string = '!ffffffff',
    channel = 0,
    opts: { replyTo?: number; isReaction?: boolean } = {},
  ): Promise<string> {
    if (!this.isLinkOpen()) {
      throw new Error('Radio not connected');
    }

    const localId = randomId();
    const packetId = (++this.nextPacketId) & 0x7fffffff; // keep positive

    // Add an optimistic outbound message immediately so the UI shows it right away
    const localNode = this.localNodeId || '!local';
    const msg: MeshMessage = {
      id: localId,
      from: localNode,
      to,
      text,
      timestamp: Date.now(),
      channel: this.resolveChannelName(channel, to),
      hopLimit: 3,
      hops: [localNode, to],
      status: 'sending',
      isOwn: true,
      packetId,
      replyTo: opts.replyTo || undefined,
      isReaction: opts.isReaction || undefined,
    };
    this.messages.push(msg);
    if (this.messages.length > 500) this.messages = this.messages.slice(-500);
    this.persistMessage(msg); // persist immediately so DMs survive a restart

    // 30-second timeout → mark as error if no ACK arrives
    const timer = setTimeout(() => {
      this.pendingAcks.delete(packetId);
      const m = this.messages.find(m => m.id === localId);
      if (m && (m.status === 'sending' || m.status === 'sent')) {
        m.status = 'error';
        m.errorCode = -1; // timeout
        this.persistMessage(m);
        this.emit('ackUpdate', localId, 'error', -1);
        console.log(`[MeshtasticSerial] ACK timeout for msg ${localId}`);
      }
    }, 30_000);
    this.pendingAcks.set(packetId, { msgId: localId, timer });

    try {
      const packet = this.buildTextPacket(text, to, channel, packetId, {
        replyTo: opts.replyTo,
        isReaction: opts.isReaction,
      });
      this.sendToRadio(packet); // must go through sendToRadio to get the 0x94 0xC3 framing header
      msg.status = 'sent';
      this.persistMessage(msg);
      this.emit('ackUpdate', localId, 'sent', 0);
      console.log(`[MeshtasticSerial] Sent message: "${text}" to ${to} (id=${packetId}) reaction=${!!opts.isReaction} replyTo=${opts.replyTo ?? 0}`);

      // Mirror to event log so outbound traffic shows up in LogsView alongside inbound.
      // Suppress for reactions (they'd flood the log with single-emoji entries).
      if (!opts.isReaction) {
        const recipient = this.nodes.get(to);
        const recipientLabel = to === '!ffffffff'
          ? msg.channel
          : (recipient?.name || recipient?.shortName || to);
        const preview = text.length > 60 ? `${text.substring(0, 60)}...` : text;
        const arrow = opts.replyTo ? '↩' : '→';
        this.addEvent('MESSAGE', localNode, `${arrow} ${recipientLabel}: "${preview}"`);
      }
    } catch (err) {
      clearTimeout(timer);
      this.pendingAcks.delete(packetId);
      msg.status = 'error';
      msg.errorCode = -2;
      this.persistMessage(msg);
      this.emit('ackUpdate', localId, 'error', -2);
      throw err;
    }

    return localId;
  }

  // ---- Internal serial data handling ----

  private onData(chunk: Buffer) {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    this.processBuffer();
  }

  private onError(err: Error) {
    console.error(`[MeshtasticSerial] Serial error:`, err.message);
    this.addEvent('NODE_LOST', 'local', `Serial error: ${err.message}`);
  }

  private onClose() {
    console.log(`[MeshtasticSerial] Port closed`);
    this._connected = false;
    this.emit('disconnected');
    this.addEvent('NODE_LOST', 'local', 'Serial port closed');
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    console.log(`[MeshtasticSerial] Will retry in 5s...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        if (this.transportMode === 'tcp' && this.tcpEndpoint) {
          await this.connectTcp(this.tcpEndpoint.host, this.tcpEndpoint.port);
        } else if (this.portPath) {
          await this.connect(this.portPath);
        }
      } catch {
        // connect/connectTcp will schedule another retry on failure
      }
    }, 5000);
  }

  /**
   * Process the receive buffer looking for Meshtastic serial frames.
   * Frame format: [0x94] [0xc3] [MSB len] [LSB len] [protobuf payload...]
   */
  private processBuffer() {
    while (this.rxBuffer.length >= HEADER_SIZE) {
      // Scan for start bytes
      const startIdx = this.findStartBytes();
      if (startIdx === -1) {
        // No valid start found — discard
        this.rxBuffer = Buffer.alloc(0);
        return;
      }
      if (startIdx > 0) {
        this.rxBuffer = this.rxBuffer.subarray(startIdx);
      }

      if (this.rxBuffer.length < HEADER_SIZE) return;

      const payloadLen = (this.rxBuffer[2] << 8) | this.rxBuffer[3];
      const frameLen = HEADER_SIZE + payloadLen;

      if (this.rxBuffer.length < frameLen) return; // wait for more data

      const payload = this.rxBuffer.subarray(HEADER_SIZE, frameLen);
      this.rxBuffer = this.rxBuffer.subarray(frameLen);

      this.handlePacket(payload);
    }
  }

  private findStartBytes(): number {
    for (let i = 0; i < this.rxBuffer.length - 1; i++) {
      if (this.rxBuffer[i] === START_BYTE_1 && this.rxBuffer[i + 1] === START_BYTE_2) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Handle a decoded protobuf payload from the radio.
   * 
   * The Meshtastic serial API sends FromRadio protobuf messages.
   * We do lightweight manual parsing of the most important fields
   * to avoid pulling the full protobuf toolchain at runtime.
   * 
   * In production you'd use @meshtastic/js's IMeshDevice, but that
   * requires a more involved setup. This manual approach works well
   * for a home lab bridge.
   */
  private handlePacket(payload: Buffer) {
    try {
      // Attempt to decode as a simple JSON-encoded debug packet first
      // (some firmware versions support this)
      const str = payload.toString('utf-8');

      // Try to parse as protobuf-style fields
      // Field 1 (varint) = packet type
      // We'll use a simplified approach: look for known patterns
      this.parseFromRadio(payload);
    } catch (err) {
      // Malformed packet — skip
      console.debug('[MeshtasticSerial] Skipped malformed packet');
    }
  }

  /**
   * Minimal protobuf-like parser for FromRadio messages.
   * Extracts node info, telemetry, positions, and text messages
   * using wire-format field scanning.
   */
  private parseFromRadio(buf: Buffer) {
    let offset = 0;

    while (offset < buf.length) {
      if (offset + 1 >= buf.length) break;

      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 0) {
        // Varint — read and skip
        while (offset < buf.length && buf[offset] & 0x80) offset++;
        offset++;
      } else if (wireType === 2) {
        // Length-delimited (submessage or string)
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;

        if (offset + len > buf.length) break;

        const subBuf = buf.subarray(offset, offset + len);
        offset += len;

        // FromRadio field numbers (meshtastic mesh.proto):
        //   2 = packet (MeshPacket), 3 = my_info (MyNodeInfo),
        //   4 = node_info (NodeInfo), 7 = config_complete_id,
        //   10 = channel (Channel), 11 = queue_status (QueueStatus)
        if (fieldNumber === 2) {
          this.handleMeshPacket(subBuf);
        } else if (fieldNumber === 3) {
          this.handleMyInfo(subBuf);
        } else if (fieldNumber === 4) {
          this.handleNodeInfo(subBuf);
        } else if (fieldNumber === 10) {
          this.handleChannel(subBuf);
        } else if (fieldNumber === 11) {
          this.handleQueueStatus(subBuf);
        }
      } else {
        // Unknown wire type — can't safely skip
        break;
      }
    }
  }

  private readVarint(buf: Buffer, offset: number): { value: number; bytesRead: number } {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;
    while (offset < buf.length) {
      const byte = buf[offset++];
      bytesRead++;
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    return { value, bytesRead };
  }

  /** Parse a MyNodeInfo submessage to learn the local radio's node number */
  private handleMyInfo(buf: Buffer) {
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        // MyNodeInfo field 1 = my_node_num
        if (fieldNumber === 1 && value > 0) {
          const id = nodeIdToHex(value);
          if (this.localNodeId !== id) {
            this.localNodeId = id;
            this.localNodeNum = value;
            console.log(`[MeshtasticSerial] Local node identified as ${id}`);
          }
        }
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        offset += len;
      } else {
        break;
      }
    }
  }

  /**
   * Parse a Channel submessage from FromRadio.
   * Channel { index:1 varint, settings:2 ChannelSettings, role:3 enum }
   * ChannelSettings { channel_num:1, psk:2 bytes, name:3 string,
   *                   id:4 fixed32, uplink_enabled:5 bool, downlink_enabled:6 bool }
   */
  private handleChannel(buf: Buffer) {
    let index = 0;
    let role = 0;
    let settingsBuf: Buffer | null = null;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) index = value;
        else if (fieldNumber === 3) role = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const sub = buf.subarray(offset, offset + len);
        offset += len;
        if (fieldNumber === 2) settingsBuf = sub;
      } else {
        break;
      }
    }

    let name = '';
    let pskBase64 = '';
    let uplink = false;
    let downlink = false;

    if (settingsBuf) {
      let so = 0;
      while (so < settingsBuf.length) {
        const tag = settingsBuf[so];
        const fn = tag >> 3;
        const wt = tag & 0x07;
        so++;

        if (wt === 0) {
          const { value, bytesRead } = this.readVarint(settingsBuf, so);
          so += bytesRead;
          if (fn === 5) uplink = !!value;
          else if (fn === 6) downlink = !!value;
        } else if (wt === 2) {
          const { value: len, bytesRead } = this.readVarint(settingsBuf, so);
          so += bytesRead;
          const sub = settingsBuf.subarray(so, so + len);
          so += len;
          if (fn === 2) pskBase64 = sub.toString('base64');
          else if (fn === 3) name = sub.toString('utf-8');
        } else if (wt === 5) {
          so += 4;
        } else {
          break;
        }
      }
    }

    const ch: MeshChannel = {
      index,
      name,
      role: CHANNEL_ROLE_NAME[role] ?? 'DISABLED',
      pskBase64,
      uplinkEnabled: uplink,
      downlinkEnabled: downlink,
    };
    this.channels.set(index, ch);
    try { this.db.upsertChannel(ch); } catch (e: any) {
      console.error('[MeshtasticSerial] channel persist failed:', e.message);
    }
    this.emit('channelUpdate', ch);
  }

  /** Parse a NodeInfo submessage */
  private handleNodeInfo(buf: Buffer) {
    // NodeInfo has: num (varint field 1), user (submessage field 2), position (field 3)
    // We extract what we can and upsert the node
    let nodeNum = 0;
    let longName = '';
    let shortName = '';
    let publicKey: string | undefined;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) nodeNum = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const subBuf = buf.subarray(offset, offset + len);
        offset += len;

        if (fieldNumber === 2) {
          // User submessage — extract names + public key
          const user = this.parseUser(subBuf);
          longName = user.longName;
          shortName = user.shortName;
          publicKey = user.publicKey;
        }
      } else {
        break;
      }
    }

    if (nodeNum > 0) {
      const nodeId = nodeIdToHex(nodeNum);
      const existing = this.nodes.get(nodeId);
      const node: MeshNode = {
        id: nodeId,
        name: longName || existing?.name || nodeId,
        shortName: shortName || existing?.shortName || nodeId.slice(-4),
        lastSeen: Date.now(),
        online: true,
        favorite: false,
        ...existing,
        // Overwrite these specifically
        ...(longName ? { name: longName } : {}),
        ...(shortName ? { shortName } : {}),
        // Only update publicKey if we got a non-empty one this packet (don't
        // erase a previously-known key just because the latest NodeInfo omitted it).
        ...(publicKey ? { publicKey } : {}),
      };
      node.lastSeen = Date.now();
      node.online = true;

      const isNew = !this.nodes.has(nodeId);
      const hadKey = !!existing?.publicKey;
      this.upsertNode(node);

      if (isNew) {
        this.addEvent('NODE_JOINED', nodeId, `${node.name} discovered on mesh`);
      }
      if (publicKey && !hadKey) {
        console.log(`[MeshtasticSerial] PKC public key learned for ${nodeId} (${node.name})`);
      }

      this.emit('nodeUpdate', node);
    }
  }

  private parseUser(buf: Buffer): { longName: string; shortName: string; publicKey?: string } {
    let longName = '';
    let shortName = '';
    let publicKey: string | undefined;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const slice = buf.subarray(offset, offset + len);
        offset += len;

        if (fieldNumber === 2) longName = slice.toString('utf-8');
        else if (fieldNumber === 3) shortName = slice.toString('utf-8');
        else if (fieldNumber === 8 && len > 0) {
          // public_key (Curve25519, 32 bytes). Store base64 for portability.
          publicKey = slice.toString('base64');
        }
      } else if (wireType === 0) {
        const { bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
      } else {
        break;
      }
    }

    return { longName, shortName, publicKey };
  }

  /** Parse a MeshPacket submessage for text, position, telemetry, and ACKs */
  private handleMeshPacket(buf: Buffer) {
    let fromNum = 0;
    let toNum = 0;
    let channelIndex = 0;
    let hopLimit = 0;
    let rxSnr = 0;
    let rxRssi = 0;
    let portNum = 0;
    let payloadBuf: Buffer | null = null;
    let requestId = 0;
    let replyId = 0;
    let emoji = 0;
    let incomingPacketId = 0;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) fromNum = value;
        else if (fieldNumber === 2) toNum = value;
        else if (fieldNumber === 3) channelIndex = value; // channel index (current proto, varint)
        else if (fieldNumber === 10) hopLimit = value;
        else if (fieldNumber === 12) rxSnr = value;
        else if (fieldNumber === 13) rxRssi = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const subBuf = buf.subarray(offset, offset + len);
        offset += len;

        // Field 3 (len-delim) = decoded in older firmware; field 4 = decoded in current proto.
        // When wireType is 2 at field 3 it's the Data submessage, not channelIndex (which is varint).
        if (fieldNumber === 3 || fieldNumber === 4) {
          const decoded = this.parseDataSubmessage(subBuf);
          if (fieldNumber === 4 || portNum === 0) {
            portNum = decoded.portNum;
            payloadBuf = decoded.payload;
            if (decoded.requestId) requestId = decoded.requestId;
            if (decoded.replyId) replyId = decoded.replyId;
            if (decoded.emoji) emoji = decoded.emoji;
          }
        }
      } else if (wireType === 5) {
        // fixed32 — field 1=from, 2=to, 6=id are fixed32 in current proto
        if (offset + 4 > buf.length) break;
        const val = buf.readUInt32LE(offset);
        offset += 4;
        if (fieldNumber === 1 && fromNum === 0) fromNum = val;
        else if (fieldNumber === 2 && toNum === 0) toNum = val;
        else if (fieldNumber === 6) incomingPacketId = val;
      } else {
        break;
      }
    }

    // Log every packet so we can trace what the firmware actually sends
    console.log(`[MeshtasticSerial] pkt from=${nodeIdToHex(fromNum)} to=${nodeIdToHex(toNum)} port=${portNum} ch=${channelIndex} id=${incomingPacketId} reqId=${requestId}`);

    const fromId = nodeIdToHex(fromNum);
    const toId = nodeIdToHex(toNum);

    // Ensure the sender node exists
    if (fromNum > 0 && !this.nodes.has(fromId)) {
      this.upsertNode({
        id: fromId,
        name: fromId,
        shortName: fromId.slice(-4),
        lastSeen: Date.now(),
        online: true,
        favorite: false,
      });
      this.addEvent('NODE_JOINED', fromId, `New node ${fromId} seen on mesh`);
    }

    // Update sender's lastSeen + SNR/RSSI
    const senderNode = this.nodes.get(fromId);
    if (senderNode) {
      senderNode.lastSeen = Date.now();
      senderNode.online = true;
      if (rxSnr || rxRssi) {
        senderNode.telemetry = {
          ...senderNode.telemetry || { battery: 0, voltage: 0, channelUtilization: 0, airUtilTx: 0, snr: 0, rssi: 0 },
          snr: rxSnr / 4,
          rssi: rxRssi === 0 ? (senderNode.telemetry?.rssi || 0) : -rxRssi,
        };
      }
      this.upsertNode(senderNode);
    }

    if (!payloadBuf) return;

    // Dispatch based on port number
    switch (portNum) {
      case PORT_TEXT_MESSAGE:
        this.handleTextMessage(fromId, toId, hopLimit, channelIndex, payloadBuf, incomingPacketId, replyId, emoji);
        break;
      case PORT_ROUTING:
        // The ACK's request_id may come from Data.request_id (field 6 varint)
        // or the incoming packet's own id (incomingPacketId fixed32). Try both.
        this.handleRoutingPacket(requestId || incomingPacketId, payloadBuf);
        break;
      case PORT_POSITION:
        this.handlePosition(fromId, payloadBuf);
        break;
      case PORT_NODEINFO:
        this.handleNodeInfo(payloadBuf);
        break;
      case PORT_TELEMETRY:
        this.handleTelemetry(fromId, payloadBuf);
        break;
      case PORT_WAYPOINT_APP:
        this.handleWaypoint(fromId, payloadBuf);
        break;
      case PORT_TRACEROUTE_APP:
        this.handleTraceroute(fromId, requestId || incomingPacketId, payloadBuf);
        break;
      case PORT_NEIGHBORINFO_APP:
        this.handleNeighborInfo(fromId, payloadBuf);
        break;
      case PORT_RANGE_TEST_APP: {
        // RangeTest packets are typically text payloads ("seq 12345") used to
        // probe coverage. Log as an event with RX signal so the user can
        // correlate distance with reception quality in the event log.
        const text = payloadBuf.toString('utf-8').slice(0, 60);
        const rxLabel = rxRssi || rxSnr
          ? ` (snr=${(rxSnr / 4).toFixed(1)}dB rssi=${rxRssi ? -rxRssi : '?'}dBm)`
          : '';
        this.addEvent('TELEMETRY', fromId, `Range test ${text}${rxLabel}`);
        break;
      }
      case PORT_STORE_FORWARD_APP:
        this.handleStoreForward(fromId, payloadBuf);
        break;
    }

    this.emit('data');
  }

  /** Parse an inbound Waypoint protobuf and upsert/delete locally. */
  private handleWaypoint(fromId: string, payload: Buffer) {
    const wp = this.parseWaypoint(payload);
    if (!wp) return;
    if (!wp.id) {
      console.warn('[MeshtasticSerial] WAYPOINT_APP with id=0, ignoring');
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const isDelete = wp.expire > 0 && wp.expire <= nowSec;

    if (isDelete) {
      this.waypoints.delete(wp.id);
      try { this.db.deleteWaypoint(wp.id); } catch (e: any) {
        console.error('[MeshtasticSerial] deleteWaypoint persist failed:', e.message);
      }
      console.log(`[MeshtasticSerial] WAYPOINT delete id=${wp.id} from ${fromId}`);
      this.emit('waypointsChanged');
      return;
    }

    const merged: MeshWaypoint = {
      id: wp.id,
      lat: wp.lat,
      lng: wp.lng,
      name: wp.name,
      description: wp.description,
      icon: wp.icon,
      expire: wp.expire,
      lockedTo: wp.lockedTo,
      createdBy: this.waypoints.get(wp.id)?.createdBy || fromId,
      lastSeen: Date.now(),
    };
    this.waypoints.set(wp.id, merged);
    try { this.db.upsertWaypoint(merged); } catch (e: any) {
      console.error('[MeshtasticSerial] upsertWaypoint persist failed:', e.message);
    }
    console.log(`[MeshtasticSerial] WAYPOINT upsert id=${wp.id} "${wp.name}" from ${fromId}`);
    this.emit('waypointsChanged');
  }

  /** Decode a Waypoint protobuf payload. */
  private parseWaypoint(buf: Buffer): MeshWaypoint | null {
    let id = 0, latI = 0, lngI = 0, expire = 0, lockedTo = 0, icon = 0;
    let name = '', description = '';
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 0) { // varint
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) id = value >>> 0;
        else if (fieldNumber === 4) expire = value >>> 0;
        else if (fieldNumber === 5) lockedTo = value >>> 0;
      } else if (wireType === 5) { // fixed32 / sfixed32 (4 bytes LE)
        if (offset + 4 > buf.length) break;
        if (fieldNumber === 2) latI = buf.readInt32LE(offset);     // sfixed32
        else if (fieldNumber === 3) lngI = buf.readInt32LE(offset); // sfixed32
        else if (fieldNumber === 8) icon = buf.readUInt32LE(offset); // fixed32
        offset += 4;
      } else if (wireType === 2) { // length-delimited (string)
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (offset + len > buf.length) break;
        const slice = buf.subarray(offset, offset + len);
        if (fieldNumber === 6) name = slice.toString('utf-8');
        else if (fieldNumber === 7) description = slice.toString('utf-8');
        offset += len;
      } else {
        break; // unsupported wire type
      }
    }

    if (id === 0 && latI === 0 && lngI === 0) return null;

    return {
      id,
      lat: latI / 1e7,
      lng: lngI / 1e7,
      name,
      description,
      icon,
      expire,
      lockedTo,
      createdBy: '',
      lastSeen: Date.now(),
    };
  }

  /** Encode a Waypoint protobuf payload. */
  private buildWaypointPayload(w: MeshWaypoint): Buffer {
    const parts: Buffer[] = [];
    parts.push(this.encodeTagVarint(1, w.id));

    // sfixed32 lat/lng (wire type 5)
    const latBuf = Buffer.alloc(5);
    latBuf[0] = (2 << 3) | 5;
    latBuf.writeInt32LE(Math.round(w.lat * 1e7), 1);
    parts.push(latBuf);

    const lngBuf = Buffer.alloc(5);
    lngBuf[0] = (3 << 3) | 5;
    lngBuf.writeInt32LE(Math.round(w.lng * 1e7), 1);
    parts.push(lngBuf);

    if (w.expire) parts.push(this.encodeTagVarint(4, w.expire));
    if (w.lockedTo) parts.push(this.encodeTagVarint(5, w.lockedTo));
    if (w.name) parts.push(this.encodeTagLen(6, Buffer.from(w.name, 'utf-8')));
    if (w.description) parts.push(this.encodeTagLen(7, Buffer.from(w.description, 'utf-8')));
    if (w.icon) parts.push(this.encodeTagFixed32(8, w.icon));

    return Buffer.concat(parts);
  }

  /** Wrap a Waypoint payload as a broadcast MeshPacket → ToRadio frame. */
  private buildWaypointPacket(w: MeshWaypoint, channel: number, packetId: number): Buffer {
    const wpPayload = this.buildWaypointPayload(w);

    // Data { portnum=8 WAYPOINT_APP, payload=wpPayload }
    const dataMsg = Buffer.concat([
      this.encodeTagVarint(1, PORT_WAYPOINT_APP),
      this.encodeTagLen(2, wpPayload),
    ]);

    // Broadcast destination (0xffffffff)
    const meshPacket = Buffer.concat([
      this.encodeTagFixed32(2, 0xffffffff),                                 // to
      this.encodeTagVarint(3, channel),                                     // channel index
      Buffer.from([(4 << 3) | 2, ...this.encodeVarint(dataMsg.length)]),    // decoded
      dataMsg,
      this.encodeTagFixed32(6, packetId),                                   // id
    ]);

    return Buffer.concat([
      Buffer.from([(1 << 3) | 2, ...this.encodeVarint(meshPacket.length)]),
      meshPacket,
    ]);
  }

  /**
   * Public: create or edit a waypoint and broadcast it to the mesh.
   * Returns the canonical waypoint stored locally.
   */
  sendWaypoint(input: {
    id?: number;
    lat: number;
    lng: number;
    name?: string;
    description?: string;
    icon?: number;
    expire?: number;
    lockedToSelf?: boolean;
  }, channel: number = 0): MeshWaypoint {
    const id = input.id && input.id > 0 ? input.id : ((Math.floor(Math.random() * 0x7fffffff) | 0) >>> 0);
    const wp: MeshWaypoint = {
      id,
      lat: input.lat,
      lng: input.lng,
      name: input.name ?? '',
      description: input.description ?? '',
      icon: input.icon ?? 0,
      expire: input.expire ?? 0,
      lockedTo: input.lockedToSelf ? this.localNodeNum : 0,
      createdBy: this.localNodeId ?? '',
      lastSeen: Date.now(),
    };

    this.waypoints.set(wp.id, wp);
    try { this.db.upsertWaypoint(wp); } catch (e: any) {
      console.error('[MeshtasticSerial] upsertWaypoint persist failed:', e.message);
    }

    if (this.isLinkOpen()) {
      const packetId = this.nextPacketId++;
      if (this.nextPacketId > 0xfffe) this.nextPacketId = 1;
      const frame = this.buildWaypointPacket(wp, channel, packetId);
      this.sendToRadio(frame);
      console.log(`[MeshtasticSerial] WAYPOINT tx id=${wp.id} "${wp.name}" packetId=${packetId}`);
    } else {
      console.warn('[MeshtasticSerial] sendWaypoint: radio not open, stored locally only');
    }

    this.emit('waypointsChanged');
    return wp;
  }

  /**
   * Public: delete a waypoint by broadcasting the same waypoint with an
   * already-elapsed `expire` (Meshtastic's deletion sentinel).
   */
  deleteWaypoint(id: number, channel: number = 0): boolean {
    const existing = this.waypoints.get(id);
    if (!existing) return false;

    const tombstone: MeshWaypoint = {
      ...existing,
      expire: Math.floor(Date.now() / 1000) - 1,
      lastSeen: Date.now(),
    };

    this.waypoints.delete(id);
    try { this.db.deleteWaypoint(id); } catch (e: any) {
      console.error('[MeshtasticSerial] deleteWaypoint persist failed:', e.message);
    }

    if (this.isLinkOpen()) {
      const packetId = this.nextPacketId++;
      if (this.nextPacketId > 0xfffe) this.nextPacketId = 1;
      const frame = this.buildWaypointPacket(tombstone, channel, packetId);
      this.sendToRadio(frame);
      console.log(`[MeshtasticSerial] WAYPOINT delete id=${id} packetId=${packetId}`);
    }

    this.emit('waypointsChanged');
    return true;
  }

  // ---- Traceroute (PORT_TRACEROUTE_APP = 70) ---------------------------

  /**
   * Initiate a traceroute to a specific node. The radio will send a
   * RouteDiscovery request with want_response=true; intermediate relays append
   * themselves to the route as it propagates, and the destination flips it
   * around for the return trip. Resolves with the requestId we hand back to
   * the client so it can correlate the eventual response.
   */
  async sendTraceroute(targetId: string, channel: number = 0, timeoutMs: number = 60_000): Promise<{ requestId: string }> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!targetId || targetId === '!ffffffff') throw new Error('Traceroute requires a specific target');

    const requestId = randomId();
    const packetId = this.nextPacketId++;
    if (this.nextPacketId > 0xfffe) this.nextPacketId = 1;

    const trace: MeshTraceResult = {
      id: requestId,
      targetId,
      startedAt: Date.now(),
      status: 'pending',
      route: [],
      routeBack: [],
    };
    this.traces.set(requestId, trace);

    const timer = setTimeout(() => {
      const t = this.traces.get(requestId);
      if (!t || t.status !== 'pending') return;
      t.status = 'timeout';
      t.completedAt = Date.now();
      t.errorMessage = `No response within ${Math.round(timeoutMs / 1000)}s`;
      this.pendingTraces.delete(packetId);
      console.log(`[MeshtasticSerial] TRACE timeout for ${targetId} (req=${requestId})`);
      this.emit('traceUpdate', { ...t });
    }, timeoutMs);
    this.pendingTraces.set(packetId, { requestId, timer });

    try {
      const frame = this.buildTraceroutePacket(targetId, channel, packetId);
      this.sendToRadio(frame);
      console.log(`[MeshtasticSerial] TRACE request to ${targetId} packetId=${packetId} req=${requestId}`);
      this.emit('traceUpdate', { ...trace });
      return { requestId };
    } catch (err) {
      clearTimeout(timer);
      this.pendingTraces.delete(packetId);
      trace.status = 'error';
      trace.completedAt = Date.now();
      trace.errorMessage = err instanceof Error ? err.message : String(err);
      this.emit('traceUpdate', { ...trace });
      throw err;
    }
  }

  /** Build a TRACEROUTE_APP request packet with want_response=true. */
  private buildTraceroutePacket(targetId: string, channel: number, packetId: number): Buffer {
    // RouteDiscovery payload is empty for the request — the firmware fills it in.
    const emptyPayload = Buffer.alloc(0);

    // Data { portnum=70, payload=empty, want_response=true }
    const dataMsg = Buffer.concat([
      this.encodeTagVarint(1, PORT_TRACEROUTE_APP),
      this.encodeTagLen(2, emptyPayload),
      this.encodeTagBool(3, true), // want_response
    ]);

    const toNum = parseInt(targetId.replace('!', ''), 16) >>> 0;

    const meshPacket = Buffer.concat([
      this.encodeTagFixed32(2, toNum),                                     // to
      this.encodeTagVarint(3, channel),                                    // channel
      Buffer.from([(4 << 3) | 2, ...this.encodeVarint(dataMsg.length)]),   // decoded
      dataMsg,
      this.encodeTagFixed32(6, packetId),                                  // id
      this.encodeTagBool(10, true),                                        // want_ack
    ]);

    return Buffer.concat([
      Buffer.from([(1 << 3) | 2, ...this.encodeVarint(meshPacket.length)]),
      meshPacket,
    ]);
  }

  /** Handle an inbound TRACEROUTE_APP packet (the response to one of our requests). */
  private handleTraceroute(fromId: string, requestId: number, payload: Buffer | null) {
    if (!requestId) {
      console.log(`[MeshtasticSerial] TRACE inbound from ${fromId} with no requestId — ignoring`);
      return;
    }
    const pending = this.pendingTraces.get(requestId);
    if (!pending) {
      console.log(`[MeshtasticSerial] TRACE inbound from ${fromId} but no pending request for id=${requestId}`);
      return;
    }
    const trace = this.traces.get(pending.requestId);
    if (!trace) return;

    clearTimeout(pending.timer);
    this.pendingTraces.delete(requestId);

    const parsed = payload ? this.parseRouteDiscovery(payload) : { route: [], snrTowards: [], routeBack: [], snrBack: [] };

    // Build hop arrays. The route field is the list of relay node nums; SNR
    // arrays line up index-for-index. Some firmware builds emit one extra SNR
    // value (for the destination's own observation) — tolerate any mismatch.
    const buildHops = (nums: number[], snrs: number[]): TraceHop[] => nums.map((num, i) => ({
      nodeId: nodeIdToHex(num),
      snr: typeof snrs[i] === 'number' ? snrs[i] / 4 : undefined,
    }));

    trace.route = buildHops(parsed.route, parsed.snrTowards);
    trace.routeBack = buildHops(parsed.routeBack, parsed.snrBack);
    trace.status = 'response';
    trace.completedAt = Date.now();

    console.log(
      `[MeshtasticSerial] TRACE response for ${trace.targetId}: ` +
      `out=[${trace.route.map(h => h.nodeId).join('→') || 'direct'}] ` +
      `back=[${trace.routeBack.map(h => h.nodeId).join('→') || 'direct'}]`
    );
    this.emit('traceUpdate', { ...trace });
  }

  /**
   * Parse a RouteDiscovery protobuf:
   *   route        = field 1, repeated fixed32
   *   snr_towards  = field 2, repeated int32
   *   route_back   = field 3, repeated fixed32
   *   snr_back     = field 4, repeated int32
   * Each repeated field can be packed (wire type 2) or unpacked (wire types 5
   * for fixed32, 0 for int32). Handle both.
   */
  private parseRouteDiscovery(buf: Buffer): { route: number[]; snrTowards: number[]; routeBack: number[]; snrBack: number[] } {
    const out = { route: [] as number[], snrTowards: [] as number[], routeBack: [] as number[], snrBack: [] as number[] };
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 5) {
        // Unpacked fixed32
        if (offset + 4 > buf.length) break;
        const v = buf.readUInt32LE(offset);
        offset += 4;
        if (fieldNumber === 1) out.route.push(v);
        else if (fieldNumber === 3) out.routeBack.push(v);
      } else if (wireType === 0) {
        // Unpacked varint (int32 — could be sign-extended to 10 bytes for negatives)
        const { value, bytesRead } = this.readSignedVarint32(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 2) out.snrTowards.push(value);
        else if (fieldNumber === 4) out.snrBack.push(value);
      } else if (wireType === 2) {
        // Length-delimited (packed repeated)
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (offset + len > buf.length) break;
        const end = offset + len;

        if (fieldNumber === 1 || fieldNumber === 3) {
          // Packed fixed32: each value is 4 LE bytes
          while (offset + 4 <= end) {
            const v = buf.readUInt32LE(offset);
            offset += 4;
            (fieldNumber === 1 ? out.route : out.routeBack).push(v);
          }
          offset = end;
        } else if (fieldNumber === 2 || fieldNumber === 4) {
          // Packed varints
          while (offset < end) {
            const { value, bytesRead: br } = this.readSignedVarint32(buf, offset);
            offset += br;
            (fieldNumber === 2 ? out.snrTowards : out.snrBack).push(value);
          }
          offset = end;
        } else {
          offset = end; // skip unknown
        }
      } else {
        break; // unsupported wire type
      }
    }
    return out;
  }

  /**
   * Read a varint encoded as int32 (sign-extended to 10 bytes for negatives).
   * The standard readVarint can't handle 10-byte varints because of JS 32-bit
   * shift quirks. We accumulate as BigInt and truncate to signed int32.
   */
  private readSignedVarint32(buf: Buffer, offset: number): { value: number; bytesRead: number } {
    let acc = 0n;
    let shift = 0n;
    let bytesRead = 0;
    while (offset + bytesRead < buf.length && bytesRead < 10) {
      const byte = buf[offset + bytesRead];
      acc |= BigInt(byte & 0x7f) << shift;
      bytesRead++;
      if (!(byte & 0x80)) break;
      shift += 7n;
    }
    let truncated = Number(acc & 0xffffffffn);
    if (truncated >= 0x80000000) truncated -= 0x100000000;
    return { value: truncated, bytesRead };
  }

  // ---- NeighborInfo (PORT_NEIGHBORINFO_APP = 71) -----------------------

  /**
   * Parse an inbound NeighborInfo packet describing the originator's directly-
   * heard neighbors. We use this to build a real topology graph from observed
   * RX events instead of inferring from message hop history.
   */
  private handleNeighborInfo(fromId: string, payload: Buffer | null) {
    if (!payload) return;
    const parsed = this.parseNeighborInfo(payload);
    if (!parsed) return;

    // Resolve neighbor node nums to !hex ids; ensure each neighbor exists in
    // our node map so it's visible elsewhere in the UI.
    const neighbors: NeighborObservation[] = parsed.neighbors.map(n => {
      const id = nodeIdToHex(n.nodeNum);
      if (!this.nodes.has(id)) {
        this.upsertNode({
          id,
          name: id,
          shortName: id.slice(-4),
          lastSeen: Date.now(),
          online: true,
          favorite: false,
        });
      }
      return { nodeId: id, snr: n.snr, intervalSecs: n.intervalSecs };
    });

    const snapshot: NeighborInfoSnapshot = {
      fromNodeId: fromId,
      intervalSecs: parsed.intervalSecs,
      neighbors,
      lastSeen: Date.now(),
    };
    this.neighborInfo.set(fromId, snapshot);

    try { this.db.upsertNeighborInfo(snapshot); }
    catch (err: any) { console.error('[MeshtasticSerial] neighborInfo persist failed:', err.message); }

    console.log(`[MeshtasticSerial] NEIGHBORINFO from ${fromId}: ${neighbors.length} neighbors [${neighbors.map(n => `${n.nodeId.slice(-4)}@${n.snr.toFixed(1)}dB`).join(',')}]`);
    this.emit('neighborInfoUpdate', snapshot);
  }

  /**
   * Decode a NeighborInfo protobuf:
   *   1=node_id (varint, originator — we ignore in favor of from-field)
   *   2=last_sent_by_id (varint, ignored)
   *   3=node_broadcast_interval_secs (varint)
   *   4=neighbors (repeated submessage Neighbor)
   *
   * Neighbor:
   *   1=node_id (varint)
   *   2=snr (float, wire type 5, 4 bytes LE)
   *   3=last_rx_time (varint, deprecated — ignored)
   *   4=node_broadcast_interval_secs (varint)
   */
  private parseNeighborInfo(buf: Buffer): { intervalSecs: number; neighbors: Array<{ nodeNum: number; snr: number; intervalSecs?: number }> } | null {
    let intervalSecs = 0;
    const neighbors: Array<{ nodeNum: number; snr: number; intervalSecs?: number }> = [];
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 3) intervalSecs = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (offset + len > buf.length) break;
        const sub = buf.subarray(offset, offset + len);
        offset += len;
        if (fieldNumber === 4) {
          const n = this.parseNeighbor(sub);
          if (n) neighbors.push(n);
        }
      } else if (wireType === 5) {
        offset += 4; // skip unknown fixed32
      } else {
        break;
      }
    }

    return { intervalSecs, neighbors };
  }

  private parseNeighbor(buf: Buffer): { nodeNum: number; snr: number; intervalSecs?: number } | null {
    let nodeNum = 0;
    let snr = 0;
    let intervalSecs: number | undefined;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) nodeNum = value >>> 0;
        else if (fieldNumber === 4) intervalSecs = value;
      } else if (wireType === 5) {
        if (offset + 4 > buf.length) break;
        if (fieldNumber === 2) snr = buf.readFloatLE(offset);
        offset += 4;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead + len; // skip unknown len-delim
      } else {
        break;
      }
    }

    if (!nodeNum) return null;
    return { nodeNum, snr, intervalSecs };
  }

  // ---- Store & Forward (PORT_STORE_FORWARD_APP = 65) -------------------
  //
  // The S&F module on a router lets clients catch up on missed messages.
  // We track three things from inbound S&F packets:
  //   1. Heartbeats — "I am a router, I beat every X seconds" (rr=2)
  //   2. Stats — router's saved-message counters (rr=7)
  //   3. History responses — count of messages being replayed (rr=6)
  // The actual replayed messages flow back as ordinary TEXT_MESSAGE_APP
  // packets, so they ride through handleTextMessage like anything else.

  // RequestResponse enum values (from mesh.proto)
  private static readonly SF_RR = {
    UNSET: 0,
    ROUTER_ERROR: 1,
    ROUTER_HEARTBEAT: 2,
    ROUTER_PING: 3,
    ROUTER_PONG: 4,
    ROUTER_BUSY: 5,
    ROUTER_HISTORY: 6,
    ROUTER_STATS: 7,
    ROUTER_TEXT_BROADCAST: 8,
    ROUTER_TEXT_DIRECT: 9,
    CLIENT_ERROR: 64,
    CLIENT_HISTORY: 65,
    CLIENT_STATS: 66,
    CLIENT_PING: 67,
    CLIENT_PONG: 68,
    CLIENT_ABORT: 106,
  } as const;

  private handleStoreForward(fromId: string, payload: Buffer | null) {
    if (!payload) return;
    const parsed = this.parseStoreAndForward(payload);
    if (!parsed) return;

    const { rr, heartbeat, stats, history } = parsed;
    const SF = MeshtasticSerialBridge.SF_RR;

    if (rr === SF.ROUTER_HEARTBEAT && heartbeat) {
      // This node is a router — record/refresh.
      const existing = this.storeForwardRouters.get(fromId);
      const router: MeshStoreForwardRouter = {
        nodeId: fromId,
        periodSecs: heartbeat.period,
        isSecondary: !!heartbeat.secondary,
        lastHeartbeat: Date.now(),
        stats: existing?.stats,
      };
      this.storeForwardRouters.set(fromId, router);
      try { this.db.upsertStoreForwardRouter(router); }
      catch (err: any) { console.error('[MeshtasticSerial] S&F router persist failed:', err.message); }

      if (!existing) {
        this.addEvent('NODE_JOINED', fromId, `S&F router announced (period=${heartbeat.period}s${heartbeat.secondary ? ', secondary' : ''})`);
        console.log(`[MeshtasticSerial] S&F router discovered: ${fromId} period=${heartbeat.period}s secondary=${heartbeat.secondary}`);
      }
      this.emit('storeForwardUpdate', router);
      return;
    }

    if (rr === SF.ROUTER_STATS && stats) {
      const router = this.storeForwardRouters.get(fromId) ?? {
        nodeId: fromId,
        periodSecs: 0,
        isSecondary: false,
        lastHeartbeat: Date.now(),
      };
      router.stats = stats;
      router.lastHeartbeat = Date.now();
      this.storeForwardRouters.set(fromId, router);
      try { this.db.upsertStoreForwardRouter(router); }
      catch (err: any) { console.error('[MeshtasticSerial] S&F stats persist failed:', err.message); }
      this.addEvent('TELEMETRY', fromId,
        `S&F stats: saved=${stats.messagesSaved ?? 0}/${stats.messagesMax ?? 0} uptime=${stats.upTimeSecs ?? 0}s`);
      this.emit('storeForwardUpdate', router);
      return;
    }

    if (rr === SF.ROUTER_HISTORY && history) {
      this.addEvent('TELEMETRY', fromId,
        `S&F replaying ${history.historyMessages ?? 0} messages from last ${(history.window ?? 0)}min`);
      console.log(`[MeshtasticSerial] S&F history reply from ${fromId}: ${history.historyMessages} msgs over ${history.window}min window`);
      return;
    }

    if (rr === SF.ROUTER_BUSY) {
      this.addEvent('NODE_LOST', fromId, 'S&F router reports BUSY');
      return;
    }

    if (rr === SF.ROUTER_ERROR) {
      this.addEvent('NODE_LOST', fromId, 'S&F router reports ERROR');
      return;
    }

    // Other variants we don't surface specifically (PING/PONG, CLIENT_*).
    console.log(`[MeshtasticSerial] S&F packet from ${fromId} rr=${rr} (no action)`);
  }

  /**
   * Decode a StoreAndForward protobuf:
   *   1=rr (varint enum)   2=heartbeat (submsg)   3=stats (submsg)
   *   4=history (submsg)   5=text (bytes — replayed message body)
   */
  private parseStoreAndForward(buf: Buffer): {
    rr: number;
    heartbeat?: { period: number; secondary: number };
    stats?: StoreForwardStats;
    history?: { historyMessages?: number; window?: number; lastRequest?: number };
  } | null {
    let rr = 0;
    let heartbeat: { period: number; secondary: number } | undefined;
    let stats: StoreForwardStats | undefined;
    let history: { historyMessages?: number; window?: number; lastRequest?: number } | undefined;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) rr = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (offset + len > buf.length) break;
        const sub = buf.subarray(offset, offset + len);
        offset += len;
        if (fieldNumber === 2) heartbeat = this.parseSfHeartbeat(sub);
        else if (fieldNumber === 3) stats = this.parseSfStats(sub);
        else if (fieldNumber === 4) history = this.parseSfHistory(sub);
        // field 5 = replayed text bytes — handled by handleTextMessage instead
      } else {
        break;
      }
    }
    return { rr, heartbeat, stats, history };
  }

  private parseSfHeartbeat(buf: Buffer): { period: number; secondary: number } {
    let period = 0, secondary = 0, offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) period = value;
        else if (fieldNumber === 2) secondary = value;
      } else { break; }
    }
    return { period, secondary };
  }

  private parseSfStats(buf: Buffer): StoreForwardStats {
    const out: StoreForwardStats = {};
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) out.messagesTotal = value;
        else if (fieldNumber === 2) out.messagesSaved = value;
        else if (fieldNumber === 3) out.messagesMax = value;
        else if (fieldNumber === 4) out.upTimeSecs = value;
        else if (fieldNumber === 5) out.requests = value;
        else if (fieldNumber === 6) out.requestsHistory = value;
        else if (fieldNumber === 7) out.heartbeatActive = value !== 0;
        else if (fieldNumber === 8) out.returnMax = value;
        else if (fieldNumber === 9) out.returnWindowMins = value;
      } else { break; }
    }
    return out;
  }

  private parseSfHistory(buf: Buffer): { historyMessages?: number; window?: number; lastRequest?: number } {
    const out: { historyMessages?: number; window?: number; lastRequest?: number } = {};
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) out.historyMessages = value;
        else if (fieldNumber === 2) out.window = value;
        else if (fieldNumber === 3) out.lastRequest = value;
      } else { break; }
    }
    return out;
  }

  /**
   * Build a CLIENT_HISTORY StoreAndForward packet asking the named router to
   * replay the last `windowMinutes` of traffic. Replayed messages then arrive
   * as ordinary TEXT_MESSAGE_APP packets through the existing pipeline.
   */
  async requestStoreForwardHistory(routerId: string, windowMinutes: number = 60, channel: number = 0): Promise<void> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!routerId.startsWith('!')) throw new Error('routerId must be a !hex node id');
    const window = Math.max(1, Math.min(1440, Math.floor(windowMinutes)));

    // History submsg: window=2 (varint, minutes)
    const historyMsg = this.encodeTagVarint(2, window);
    // StoreAndForward { rr=1 CLIENT_HISTORY=65, history=4 (length-delim) }
    const sfPayload = Buffer.concat([
      this.encodeTagVarint(1, MeshtasticSerialBridge.SF_RR.CLIENT_HISTORY),
      this.encodeTagLen(4, historyMsg),
    ]);

    // Wrap in Data { portnum=PORT_STORE_FORWARD_APP, payload=sfPayload, want_response=true }
    const dataMsg = Buffer.concat([
      this.encodeTagVarint(1, PORT_STORE_FORWARD_APP),
      this.encodeTagLen(2, sfPayload),
      this.encodeTagBool(3, true),
    ]);

    const toNum = parseInt(routerId.replace('!', ''), 16) >>> 0;
    const packetId = this.nextPacketId++;
    if (this.nextPacketId > 0xfffe) this.nextPacketId = 1;

    // MeshPacket { to: fixed32, channel: varint, decoded: Data, id: fixed32, want_ack: bool }
    const meshPacket = Buffer.concat([
      this.encodeTagFixed32(2, toNum),
      this.encodeTagVarint(3, channel),
      Buffer.from([(4 << 3) | 2, ...this.encodeVarint(dataMsg.length)]),
      dataMsg,
      this.encodeTagFixed32(6, packetId),
      this.encodeTagBool(10, true),
    ]);

    const toRadio = Buffer.concat([
      Buffer.from([(1 << 3) | 2, ...this.encodeVarint(meshPacket.length)]),
      meshPacket,
    ]);
    this.sendToRadio(toRadio);

    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `Requested S&F history from ${routerId}: last ${window}min`);
    console.log(`[MeshtasticSerial] S&F CLIENT_HISTORY → ${routerId} window=${window}min packetId=${packetId}`);
  }

  private parseDataSubmessage(buf: Buffer): {
    portNum: number;
    payload: Buffer | null;
    requestId: number;
    replyId: number;
    emoji: number;
  } {
    let portNum = 0;
    let payload: Buffer | null = null;
    let requestId = 0;
    let replyId = 0;
    let emoji = 0;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) portNum = value;        // portnum
        else if (fieldNumber === 6) requestId = value; // request_id (ACK reply-to)
        else if (fieldNumber === 8) emoji = value;     // emoji flag (uint32; non-zero = reaction)
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 2) payload = buf.subarray(offset, offset + len); // payload
        offset += len;
      } else if (wireType === 5) {
        // fixed32: reply_id is field 7 (the only one we care about here)
        if (offset + 4 > buf.length) break;
        const v = buf.readUInt32LE(offset);
        offset += 4;
        if (fieldNumber === 7) replyId = v;
      } else {
        break;
      }
    }

    if (portNum === PORT_ROUTING || requestId || replyId || emoji) {
      console.log(`[MeshtasticSerial] Data: portNum=${portNum} requestId=${requestId} replyId=${replyId} emoji=${emoji} payloadLen=${payload?.length ?? 0}`);
    }

    return { portNum, payload, requestId, replyId, emoji };
  }

  /** Handle a ROUTING_APP packet — these carry ACK/NAK for messages sent with want_ack=true */
  private handleRoutingPacket(requestId: number, payload: Buffer | null) {
    console.log(`[MeshtasticSerial] ROUTING pkt requestId=${requestId} pendingKeys=[${[...this.pendingAcks.keys()].join(',')}]`);
    if (!requestId) return;

    const pending = this.pendingAcks.get(requestId);
    if (!pending) {
      // requestId didn't match — dump pending keys to help diagnose mismatches
      console.log(`[MeshtasticSerial] ROUTING no match for requestId=${requestId}`);
      return;
    }

    // Parse Routing message: field 3 = error_reason (varint, 0 = success)
    let errorCode = 0;
    if (payload) {
      let o = 0;
      while (o < payload.length) {
        const tag = payload[o++];
        const fn = tag >> 3;
        const wt = tag & 0x07;
        if (wt === 0) {
          const { value, bytesRead } = this.readVarint(payload, o);
          o += bytesRead;
          if (fn === 3) errorCode = value;
        } else break;
      }
    }

    clearTimeout(pending.timer);
    this.pendingAcks.delete(requestId);

    const status: MeshMessage['status'] = errorCode === 0 ? 'acked' : 'error';
    const msg = this.messages.find(m => m.id === pending.msgId);
    if (msg) {
      msg.status = status;
      msg.errorCode = errorCode;
      this.persistMessage(msg);
    }
    this.emit('ackUpdate', pending.msgId, status, errorCode);
    console.log(`[MeshtasticSerial] ACK for ${pending.msgId}: ${status} (err=${errorCode})`);
  }

  /**
   * FromRadio.queue_status (field 11) — QueueStatus { res=1, free=2, maxlen=3, mesh_packet_id=4 }
   * The firmware sends this when it accepts a packet into the TX queue.
   * res=0 means SUCCESS; mesh_packet_id matches our sent packetId.
   * This is the primary ACK path for broadcast channel messages since no remote node sends ROUTING ACKs.
   */
  private handleQueueStatus(buf: Buffer) {
    let res = 0;
    let meshPacketId = 0;
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) res = value;
        else if (fieldNumber === 4) meshPacketId = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead + len;
      } else if (wireType === 5) {
        offset += 4;
      } else break;
    }
    console.log(`[MeshtasticSerial] QueueStatus res=${res} meshPacketId=${meshPacketId} pendingKeys=[${[...this.pendingAcks.keys()].join(',')}]`);

    if (res !== 0) {
      // Non-zero res = TX queue error (e.g. queue full)
      const pending = this.pendingAcks.get(meshPacketId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAcks.delete(meshPacketId);
        const msg = this.messages.find(m => m.id === pending.msgId);
        if (msg) {
          msg.status = 'error';
          msg.errorCode = res;
          this.persistMessage(msg);
        }
        this.emit('ackUpdate', pending.msgId, 'error', res);
        console.log(`[MeshtasticSerial] QueueStatus ERROR for ${pending.msgId}: res=${res}`);
      }
      return;
    }

    // res=0 → radio accepted the packet for TX; treat as acknowledged for broadcast messages
    const pending = this.pendingAcks.get(meshPacketId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAcks.delete(meshPacketId);
      const msg = this.messages.find(m => m.id === pending.msgId);
      if (msg) {
        msg.status = 'acked';
        this.persistMessage(msg);
      }
      this.emit('ackUpdate', pending.msgId, 'acked', 0);
      console.log(`[MeshtasticSerial] QueueStatus ACK for ${pending.msgId} (pktId=${meshPacketId})`);
    }
  }

  private handleTextMessage(
    fromId: string,
    toId: string,
    hopLimit: number,
    channelIndex: number,
    payload: Buffer,
    incomingPacketId = 0,
    replyId = 0,
    emojiFlag = 0,
  ) {
    const text = payload.toString('utf-8');
    const isReaction = emojiFlag !== 0;
    console.log(`[MeshtasticSerial] TEXT from=${fromId} to=${toId} ch=${channelIndex} pktId=${incomingPacketId} replyTo=${replyId} reaction=${isReaction} local=${this.localNodeId} text="${text.substring(0, 40)}"`);

    // The radio echoes our own transmitted packets back over serial.
    // The echo may have from=localNodeId or from=!00000000 (firmware omits the field).
    // Match first by packet ID (most reliable), then fall back to text content.
    const isOwnEcho = fromId === this.localNodeId || fromId === '!00000000';
    if (isOwnEcho) {
      // Primary match: by packetId (the firmware preserves the id field on the echo)
      if (incomingPacketId && this.pendingAcks.has(incomingPacketId)) {
        const pending = this.pendingAcks.get(incomingPacketId)!;
        const existing = this.messages.find(m => m.id === pending.msgId);
        if (existing) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(incomingPacketId);
          existing.status = 'acked';
          this.persistMessage(existing);
          this.emit('ackUpdate', existing.id, 'acked', 0);
          console.log(`[MeshtasticSerial] Echo ACK (by id=${incomingPacketId}) → ${existing.id}`);
          return;
        }
      }

      // Fallback match: by message text (covers cases where id differs)
      for (const [packetId, pending] of this.pendingAcks) {
        const existing = this.messages.find(m => m.id === pending.msgId && m.text === text);
        if (existing) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(packetId);
          existing.status = 'acked';
          this.persistMessage(existing);
          this.emit('ackUpdate', existing.id, 'acked', 0);
          console.log(`[MeshtasticSerial] Echo ACK (by text) for "${text.substring(0, 30)}" → ${existing.id}`);
          return; // already stored as the optimistic entry — don't add a duplicate
        }
      }
      // Echo for a message we're not tracking — discard it
      if (fromId === '!00000000') {
        console.log(`[MeshtasticSerial] Unmatched echo (no pending ACK): "${text.substring(0, 40)}"`);
        return;
      }
    }

    // Resolve the channel name so incoming messages appear in the right chat pane.
    // Fall back progressively: channel map → channel index string → primary default.
    const channelName = this.resolveChannelName(channelIndex, toId);
    console.log(`[MeshtasticSerial] Resolved channel: idx=${channelIndex} → "${channelName}"`);


    const msg: MeshMessage = {
      id: randomId(),
      from: fromId,
      to: toId,
      text,
      timestamp: Date.now(),
      channel: channelName,
      hopLimit,
      hops: [fromId, toId],
      status: 'acked',
      packetId: incomingPacketId || undefined,
      replyTo: replyId || undefined,
      isReaction: isReaction || undefined,
    };
    this.messages.push(msg);
    if (this.messages.length > 500) {
      this.messages = this.messages.slice(-500);
    }
    try { this.db.insertMessage(msg); } catch (e: any) {
      console.error('[MeshtasticSerial] message persist failed:', e.message);
    }

    const senderName = this.nodes.get(fromId)?.name || fromId;
    this.addEvent('MESSAGE', fromId, `${senderName}: "${text.substring(0, 60)}"`);
    this.emit('message', msg);
  }

  private handlePosition(nodeId: string, payload: Buffer) {
    // Position protobuf:
    //   1=latitude_i (sfixed32)   2=longitude_i (sfixed32)   3=altitude (int32)
    //   14=location_source (varint enum: 0=UNSET, 1=MANUAL, 2=INTERNAL/GPS, 3=EXTERNAL)
    //   16=precision_bits (uint32) — channel-imposed location precision
    let lat = 0;
    let lng = 0;
    let alt = 0;
    let locationSource = 0;
    let precisionBits = 0;
    let offset = 0;

    while (offset < payload.length) {
      const tag = payload[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 5) {
        // sfixed32
        if (offset + 4 > payload.length) break;
        const val = payload.readInt32LE(offset);
        offset += 4;
        if (fieldNumber === 1) lat = val * 1e-7;
        else if (fieldNumber === 2) lng = val * 1e-7;
      } else if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(payload, offset);
        offset += bytesRead;
        if (fieldNumber === 3) alt = value;
        else if (fieldNumber === 14) locationSource = value;
        else if (fieldNumber === 16) precisionBits = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(payload, offset);
        offset += bytesRead + len;
      } else {
        break;
      }
    }

    if (lat !== 0 || lng !== 0) {
      const node = this.nodes.get(nodeId);
      if (node) {
        node.position = { lat, lng, alt };
        // 1=MANUAL → fixed; 2=INTERNAL/3=EXTERNAL → live GPS; 0=UNSET → leave previous value alone
        if (locationSource === 1) node.positionSource = 'manual';
        else if (locationSource === 2 || locationSource === 3) node.positionSource = 'gps';
        if (precisionBits > 0) node.positionPrecisionBits = precisionBits;
        node.lastSeen = Date.now();
        this.upsertNode(node);
        const sourceLabel = node.positionSource === 'manual' ? ' [fixed]' : node.positionSource === 'gps' ? ' [gps]' : '';
        this.addEvent('POSITION_UPDATE', nodeId, `${node.name} position: ${lat.toFixed(5)}, ${lng.toFixed(5)}${sourceLabel}`);
      }
    }
  }

  private handleTelemetry(nodeId: string, payload: Buffer) {
    // DeviceMetrics protobuf (nested within Telemetry)
    // We look for common fields: battery_level, voltage, channel_utilization, air_util_tx
    const node = this.nodes.get(nodeId);
    if (!node) return;

    let battery = node.telemetry?.battery || 0;
    let voltage = node.telemetry?.voltage || 0;
    let chanUtil = node.telemetry?.channelUtilization || 0;
    let airUtil = node.telemetry?.airUtilTx || 0;
    let temperature: number | undefined;
    let humidity: number | undefined;
    let pressure: number | undefined;

    let offset = 0;
    while (offset < payload.length) {
      if (offset >= payload.length) break;
      const tag = payload[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(payload, offset);
        offset += bytesRead;
        // DeviceMetrics: field 1 = battery_level, field 4 = channel_utilization (but encoded as float)
        if (fieldNumber === 1) battery = value;
      } else if (wireType === 5) {
        // fixed32 / float
        if (offset + 4 > payload.length) break;
        const floatVal = payload.readFloatLE(offset);
        offset += 4;
        if (fieldNumber === 2) voltage = floatVal;
        else if (fieldNumber === 3) chanUtil = floatVal;
        else if (fieldNumber === 4) airUtil = floatVal;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(payload, offset);
        offset += bytesRead;

        // Field 2 in Telemetry = device_metrics submessage
        // Field 3 = environment_metrics submessage
        if (fieldNumber === 3) {
          // Parse env metrics
          const envBuf = payload.subarray(offset, offset + len);
          const env = this.parseEnvMetrics(envBuf);
          temperature = env.temperature;
          humidity = env.humidity;
          pressure = env.pressure;
        } else if (fieldNumber === 2) {
          // Parse device metrics from submessage (recursive)
          // Re-parse this submessage for battery/voltage/etc
          const devBuf = payload.subarray(offset, offset + len);
          const dev = this.parseDeviceMetrics(devBuf);
          if (dev.battery) battery = dev.battery;
          if (dev.voltage) voltage = dev.voltage;
          if (dev.chanUtil) chanUtil = dev.chanUtil;
          if (dev.airUtil) airUtil = dev.airUtil;
        }

        offset += len;
      } else {
        break;
      }
    }

    node.telemetry = {
      ...node.telemetry || { snr: 0, rssi: 0 },
      battery,
      voltage,
      channelUtilization: chanUtil,
      airUtilTx: airUtil,
      snr: node.telemetry?.snr || 0,
      rssi: node.telemetry?.rssi || 0,
    };

    if (temperature !== undefined || humidity !== undefined || pressure !== undefined) {
      node.sensors = {
        ...node.sensors,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(humidity !== undefined ? { humidity } : {}),
        ...(pressure !== undefined ? { pressure } : {}),
      };
    }

    node.lastSeen = Date.now();
    this.upsertNode(node);
    this.db.insertTelemetrySnapshot(nodeId, {
      battery,
      voltage,
      chUtil: chanUtil,
      airUtilTx: airUtil,
    });

    this.addEvent('TELEMETRY', nodeId, `${node.name}: bat=${battery}% v=${voltage.toFixed(2)}V`);
  }

  private parseDeviceMetrics(buf: Buffer): { battery?: number; voltage?: number; chanUtil?: number; airUtil?: number } {
    const result: { battery?: number; voltage?: number; chanUtil?: number; airUtil?: number } = {};
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) result.battery = value;
      } else if (wireType === 5) {
        if (offset + 4 > buf.length) break;
        const floatVal = buf.readFloatLE(offset);
        offset += 4;
        if (fieldNumber === 2) result.voltage = floatVal;
        else if (fieldNumber === 3) result.chanUtil = floatVal;
        else if (fieldNumber === 4) result.airUtil = floatVal;
      } else {
        break;
      }
    }

    return result;
  }

  private parseEnvMetrics(buf: Buffer): { temperature?: number; humidity?: number; pressure?: number } {
    const result: { temperature?: number; humidity?: number; pressure?: number } = {};
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 5) {
        if (offset + 4 > buf.length) break;
        const floatVal = buf.readFloatLE(offset);
        offset += 4;
        if (fieldNumber === 1) result.temperature = floatVal;
        else if (fieldNumber === 2) result.humidity = floatVal;
        else if (fieldNumber === 3) result.pressure = floatVal;
      } else if (wireType === 0) {
        const { bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead + len;
      } else {
        break;
      }
    }

    return result;
  }

  /** Mark nodes as offline if they haven't been seen recently */
  private markStaleNodesOffline() {
    const now = Date.now();
    for (const [id, node] of this.nodes) {
      // Never mark the locally-attached radio as stale — it is reachable as
      // long as the serial port is open, even if it isn't transmitting.
      if (id === this.localNodeId) {
        if (this._connected) {
          node.lastSeen = now;
          node.online = true;
          this.upsertNode(node);
        }
        continue;
      }
      if (node.online && (now - node.lastSeen) > this.staleThresholdMs) {
        node.online = false;
        this.upsertNode(node);
        this.addEvent('NODE_LOST', id, `${node.name} went offline (stale)`);
      }
    }
  }

  /** Request the radio to send its full config/node list */
  private requestConfig() {
    if (!this.isLinkOpen()) return;

    // Send a "want_config" ToRadio packet (field 3, config_complete_id = 0)
    // ToRadio { want_config_id: <random> }
    const configId = Math.floor(Math.random() * 0xffffffff);
    // Protobuf: field 3 (varint) = configId
    const body = Buffer.from([
      (3 << 3) | 0, // field 3, wire type 0 (varint)
      ...this.encodeVarint(configId),
    ]);

    this.sendToRadio(body);
    console.log(`[MeshtasticSerial] Requested config (id=${configId})`);
  }

  private encodeVarint(value: number): number[] {
    const bytes: number[] = [];
    value = value >>> 0; // ensure unsigned
    while (value > 0x7f) {
      bytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return bytes;
  }

  /** Frame and send a ToRadio protobuf payload */
  private sendToRadio(payload: Buffer) {
    if (!this.isLinkOpen()) return;

    const frame = Buffer.alloc(HEADER_SIZE + payload.length);
    frame[0] = START_BYTE_1;
    frame[1] = START_BYTE_2;
    frame[2] = (payload.length >> 8) & 0xff;
    frame[3] = payload.length & 0xff;
    payload.copy(frame, HEADER_SIZE);

    this.writeLink(frame);
  }

  /** Encode a fixed32 field (wire type 5) */
  private encodeTagFixed32(field: number, value: number): Buffer {
    const buf = Buffer.alloc(5);
    buf[0] = (field << 3) | 5;
    buf.writeUInt32LE(value >>> 0, 1);
    return buf;
  }

  private buildTextPacket(
    text: string,
    to: string,
    channel: number,
    packetId: number,
    opts: { replyTo?: number; isReaction?: boolean } = {},
  ): Buffer {
    // Builds a ToRadio { packet: MeshPacket } frame using current Meshtastic protobuf field numbers.
    // Field layout (mesh.proto):
    //   MeshPacket: to=2(fixed32), channel=3(varint), decoded=4(submsg), id=6(fixed32), want_ack=10(bool)
    //   Data:       portnum=1(varint), payload=2(bytes), reply_id=7(fixed32), emoji=8(uint32)
    const textBuf = Buffer.from(text, 'utf-8');

    const dataParts: Buffer[] = [
      this.encodeTagVarint(1, PORT_TEXT_MESSAGE),
      Buffer.from([(2 << 3) | 2, ...this.encodeVarint(textBuf.length)]),
      textBuf,
    ];
    if (opts.replyTo) {
      dataParts.push(this.encodeTagFixed32(7, opts.replyTo));     // reply_id
    }
    if (opts.isReaction) {
      dataParts.push(this.encodeTagVarint(8, 1));                 // emoji=1 → tapback flag
    }
    const dataMsg = Buffer.concat(dataParts);

    const toNum = to === '!ffffffff' ? 0xffffffff : parseInt(to.replace('!', ''), 16);

    const meshPacket = Buffer.concat([
      this.encodeTagFixed32(2, toNum),                                     // field 2 = to
      this.encodeTagVarint(3, channel),                                    // field 3 = channel index
      Buffer.from([(4 << 3) | 2, ...this.encodeVarint(dataMsg.length)]),   // field 4 = decoded (len-delim)
      dataMsg,
      this.encodeTagFixed32(6, packetId),                                  // field 6 = id
      this.encodeTagBool(10, true),                                        // field 10 = want_ack
    ]);

    // ToRadio: field 1 = packet (len-delimited)
    return Buffer.concat([
      Buffer.from([(1 << 3) | 2, ...this.encodeVarint(meshPacket.length)]),
      meshPacket,
    ]);
  }

  // ---- Admin / channel write helpers ----

  private encodeTagVarint(field: number, value: number): Buffer {
    return Buffer.from([(field << 3) | 0, ...this.encodeVarint(value)]);
  }

  private encodeTagLen(field: number, payload: Buffer): Buffer {
    return Buffer.concat([
      Buffer.from([(field << 3) | 2, ...this.encodeVarint(payload.length)]),
      payload,
    ]);
  }

  private encodeTagBool(field: number, value: boolean): Buffer {
    return Buffer.from([(field << 3) | 0, value ? 1 : 0]);
  }

  /** Build a Channel proto ready to wrap inside AdminMessage.set_channel. */
  private buildChannelProto(ch: MeshChannel): Buffer {
    // ChannelSettings
    const settingsParts: Buffer[] = [];
    if (ch.pskBase64) {
      const psk = Buffer.from(ch.pskBase64, 'base64');
      settingsParts.push(this.encodeTagLen(2, psk));            // psk
    }
    if (ch.name) {
      settingsParts.push(this.encodeTagLen(3, Buffer.from(ch.name, 'utf-8'))); // name
    }
    settingsParts.push(this.encodeTagBool(5, ch.uplinkEnabled));
    settingsParts.push(this.encodeTagBool(6, ch.downlinkEnabled));
    const settings = Buffer.concat(settingsParts);

    // Channel { index:1, settings:2, role:3 }
    return Buffer.concat([
      this.encodeTagVarint(1, ch.index),
      this.encodeTagLen(2, settings),
      this.encodeTagVarint(3, CHANNEL_ROLE_NUM[ch.role] ?? 0),
    ]);
  }

  /** AdminMessage.set_channel = field 32 (length-delim Channel) */
  private buildAdminSetChannel(ch: MeshChannel): Buffer {
    return this.encodeTagLen(32, this.buildChannelProto(ch));
  }

  /** AdminMessage.commit_edit_settings = field 64 (bool true) */
  private buildAdminCommit(): Buffer {
    return this.encodeTagBool(64, true);
  }

  /**
   * Build AdminMessage { set_module_config: ModuleConfig { neighbor_info: ... } }.
   * Field numbers per mesh.proto:
   *   AdminMessage.set_module_config = 34 (length-delim ModuleConfig)
   *   ModuleConfig.neighbor_info = 10 (length-delim NeighborInfoConfig)
   *   NeighborInfoConfig: 1=enabled (bool), 2=update_interval (uint32 secs),
   *                      3=transmit_over_lora (bool)
   */
  private buildAdminSetNeighborInfoConfig(opts: {
    enabled: boolean;
    intervalSecs: number;
    transmitOverLora: boolean;
  }): Buffer {
    const niCfg = Buffer.concat([
      this.encodeTagBool(1, opts.enabled),
      this.encodeTagVarint(2, Math.max(0, Math.floor(opts.intervalSecs))),
      this.encodeTagBool(3, opts.transmitOverLora),
    ]);
    const moduleConfig = this.encodeTagLen(10, niCfg);   // ModuleConfig.neighbor_info
    return this.encodeTagLen(34, moduleConfig);          // AdminMessage.set_module_config
  }

  /**
   * Public: enable (or disable) the NeighborInfo module on the local radio.
   * The radio will start broadcasting NeighborInfo packets at `intervalSecs`
   * and accept them from peers — populating our topology graph with real
   * direct-link observations within a few minutes.
   *
   * Default interval (14400s = 4hrs) matches firmware default. The mesh
   * accepts faster intervals (down to 60s) but they consume airtime.
   */
  async setNeighborInfoConfig(opts: {
    enabled: boolean;
    intervalSecs?: number;
    transmitOverLora?: boolean;
  }): Promise<void> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified — try again in a moment');

    const intervalSecs = opts.intervalSecs ?? 14400;
    const transmitOverLora = opts.transmitOverLora ?? true;

    // Send the set + commit, with a small gap so the firmware can persist them in order.
    this.sendAdminMessage(this.buildAdminSetNeighborInfoConfig({
      enabled: opts.enabled,
      intervalSecs,
      transmitOverLora,
    }));
    await new Promise(r => setTimeout(r, 80));
    this.sendAdminMessage(this.buildAdminCommit());

    console.log(`[MeshtasticSerial] NeighborInfo module ${opts.enabled ? 'ENABLED' : 'DISABLED'} (interval=${intervalSecs}s, lora=${transmitOverLora})`);
    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `NeighborInfo module ${opts.enabled ? 'enabled' : 'disabled'} (every ${intervalSecs}s)`);
  }

  /** Wrap an AdminMessage payload into Data → MeshPacket → ToRadio and send it. */
  private sendAdminMessage(adminPayload: Buffer) {
    if (!this.isLinkOpen()) {
      console.warn('[MeshtasticSerial] Cannot send admin message — link not open');
      return;
    }
    if (!this.localNodeNum) {
      console.warn('[MeshtasticSerial] Cannot send admin message — local node not yet identified');
      return;
    }

    // Data { portnum:1=ADMIN_APP, payload:2=adminPayload, want_response:3=true }
    const data = Buffer.concat([
      this.encodeTagVarint(1, PORT_ADMIN_APP),
      this.encodeTagLen(2, adminPayload),
      this.encodeTagBool(3, true),
    ]);

    // MeshPacket { to:2 fixed32, decoded:3 Data, want_ack:6 bool }
    const toBytes = Buffer.alloc(4);
    toBytes.writeUInt32LE(this.localNodeNum >>> 0);
    const meshPacket = Buffer.concat([
      Buffer.from([(2 << 3) | 5]), toBytes,    // to (fixed32)
      this.encodeTagLen(3, data),               // decoded
      this.encodeTagBool(6, true),              // want_ack
    ]);

    // ToRadio { packet:1 MeshPacket }
    const toRadio = this.encodeTagLen(1, meshPacket);
    this.sendToRadio(toRadio);
  }

  /** Public: write a single channel slot to the radio (no commit). */
  setChannel(ch: MeshChannel) {
    if (ch.index < 0 || ch.index > 7) {
      throw new Error(`Channel index out of range: ${ch.index}`);
    }
    this.sendAdminMessage(this.buildAdminSetChannel(ch));
    console.log(`[MeshtasticSerial] set_channel idx=${ch.index} name="${ch.name}" role=${ch.role}`);
  }

  /**
   * Public: write a list of channels and commit. Slots not present in the list
   * are written as DISABLED so that removing a channel actually clears it.
   */
  async setChannels(channels: MeshChannel[]): Promise<void> {
    if (!this._connected) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified — try again in a moment');

    const byIndex = new Map<number, MeshChannel>();
    for (const ch of channels) byIndex.set(ch.index, ch);

    for (let i = 0; i < 8; i++) {
      const ch = byIndex.get(i) ?? {
        index: i,
        name: '',
        role: 'DISABLED' as const,
        pskBase64: '',
        uplinkEnabled: false,
        downlinkEnabled: false,
      };
      this.setChannel(ch);
      // Tiny gap so the radio can process each frame in order
      await new Promise(r => setTimeout(r, 50));
    }

    // Commit so the firmware persists the edits
    this.sendAdminMessage(this.buildAdminCommit());
    console.log('[MeshtasticSerial] commit_edit_settings sent');

    // Refresh local view from the radio
    setTimeout(() => this.requestConfig(), 250);
  }

  private addEvent(type: MeshEvent['type'], nodeId: string, details: string) {
    const event: MeshEvent = {
      id: randomId(),
      type,
      nodeId,
      timestamp: Date.now(),
      details,
    };
    this.events.unshift(event);
    if (this.events.length > 100) {
      this.events = this.events.slice(0, 100);
    }
    try { this.db.insertEvent(event); } catch (e: any) {
      console.error('[MeshtasticSerial] event persist failed:', e.message);
    }
    this.emit('event', event);
  }

  /**
   * Configure how long to keep event-log entries (in hours). Runs an immediate
   * prune and (re)starts the periodic pruner. Hours must be a positive number.
   */
  setEventRetention(hours: number) {
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error('retention hours must be a positive number');
    }
    this.eventRetentionHours = hours;
    this.runRetentionPrune();
    this.startRetentionPruner();
  }

  getEventRetention(): number {
    return this.eventRetentionHours;
  }

  private startRetentionPruner() {
    if (this.retentionPruneTimer) clearInterval(this.retentionPruneTimer);
    // Run every 5 minutes — frequent enough to feel responsive, cheap enough to be invisible.
    this.retentionPruneTimer = setInterval(() => this.runRetentionPrune(), 5 * 60_000);
  }

  /** Drop events older than retentionHours from both the in-memory cache and SQLite. */
  private runRetentionPrune() {
    const cutoff = Date.now() - this.eventRetentionHours * 3600_000;
    const before = this.events.length;
    this.events = this.events.filter(e => e.timestamp >= cutoff);
    let dbRemoved = 0;
    try { dbRemoved = this.db.pruneEventsOlderThan(cutoff); }
    catch (e: any) { console.error('[MeshtasticSerial] retention prune failed:', e.message); }
    if (before - this.events.length > 0 || dbRemoved > 0) {
      console.log(`[MeshtasticSerial] retention prune: -${before - this.events.length} memory / -${dbRemoved} db (cutoff=${this.eventRetentionHours}h)`);
    }
  }
}

export const meshBridge = new MeshtasticSerialBridge();
