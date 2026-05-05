/**
 * Meshtastic Serial Bridge
 * 
 * Connects to a real Meshtastic LoRa radio over USB serial and translates
 * protobuf packets into the app's Node / Message / RadioEvent data model.
 */
import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';
import { meshDb, type MeshDatabase } from './database.js';

// ---- App data types (mirrored from src/types.ts for server use) ----

export interface MeshNode {
  id: string;
  name: string;
  shortName: string;
  lastSeen: number;
  online: boolean;
  favorite: boolean;
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
const PORT_TELEMETRY = 67;

const CHANNEL_ROLE_NUM: Record<ChannelRole, number> = { DISABLED: 0, PRIMARY: 1, SECONDARY: 2 };
const CHANNEL_ROLE_NAME: ChannelRole[] = ['DISABLED', 'PRIMARY', 'SECONDARY'];

function nodeIdToHex(num: number): string {
  return `!${num.toString(16).padStart(8, '0')}`;
}

function randomId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

export class MeshtasticSerialBridge extends EventEmitter {
  private port: SerialPort | null = null;
  private portPath: string | null = null;
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
  private db: MeshDatabase = meshDb();

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

  getMessages(): MeshMessage[] {
    return [...this.messages];
  }

  getEvents(): MeshEvent[] {
    return [...this.events];
  }

  getChannels(): MeshChannel[] {
    return Array.from(this.channels.values()).sort((a, b) => a.index - b.index);
  }

  /** Connect to a serial port */
  async connect(portPath: string): Promise<void> {
    if (this.port) {
      await this.disconnect();
    }

    this.portPath = portPath;
    console.log(`[MeshtasticSerial] Connecting to ${portPath}...`);

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

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
    if (this.port?.isOpen) {
      return new Promise((resolve) => {
        this.port!.close(() => {
          this._connected = false;
          this.port = null;
          this.localNodeId = null;
          this.localNodeNum = 0;
          this.channels.clear();
          resolve();
        });
      });
    }
    this._connected = false;
    this.port = null;
    this.localNodeId = null;
    this.localNodeNum = 0;
    this.channels.clear();
  }

  /** Resolve the channel name for a sent message so it lands in the right chat pane */
  private resolveChannelName(channelIndex: number, to: string): string {
    if (to !== '!ffffffff') return 'Private';
    const ch = this.channels.get(channelIndex);
    if (!ch) return channelIndex === 0 ? 'LongFast' : `Channel ${channelIndex}`;
    if (ch.role === 'PRIMARY') return ch.name || 'LongFast';
    return ch.name || `Channel ${channelIndex}`;
  }

  /** Send a text message through the radio. Returns the local message ID. */
  async sendMessage(text: string, to: string = '!ffffffff', channel = 0): Promise<string> {
    if (!this.port?.isOpen) {
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
    };
    this.messages.push(msg);
    if (this.messages.length > 500) this.messages = this.messages.slice(-500);

    // 30-second timeout → mark as error if no ACK arrives
    const timer = setTimeout(() => {
      this.pendingAcks.delete(packetId);
      const m = this.messages.find(m => m.id === localId);
      if (m && (m.status === 'sending' || m.status === 'sent')) {
        m.status = 'error';
        m.errorCode = -1; // timeout
        this.emit('ackUpdate', localId, 'error', -1);
        console.log(`[MeshtasticSerial] ACK timeout for msg ${localId}`);
      }
    }, 30_000);
    this.pendingAcks.set(packetId, { msgId: localId, timer });

    try {
      const packet = this.buildTextPacket(text, to, channel, packetId);
      this.sendToRadio(packet); // must go through sendToRadio to get the 0x94 0xC3 framing header
      msg.status = 'sent';
      this.emit('ackUpdate', localId, 'sent', 0);
      console.log(`[MeshtasticSerial] Sent message: "${text}" to ${to} (id=${packetId})`);
    } catch (err) {
      clearTimeout(timer);
      this.pendingAcks.delete(packetId);
      msg.status = 'error';
      msg.errorCode = -2;
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
      if (this.portPath) {
        try {
          await this.connect(this.portPath);
        } catch {
          // connect() will schedule another retry
        }
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
          // User submessage — extract names
          const user = this.parseUser(subBuf);
          longName = user.longName;
          shortName = user.shortName;
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
      };
      node.lastSeen = Date.now();
      node.online = true;

      const isNew = !this.nodes.has(nodeId);
      this.upsertNode(node);

      if (isNew) {
        this.addEvent('NODE_JOINED', nodeId, `${node.name} discovered on mesh`);
      }

      this.emit('nodeUpdate', node);
    }
  }

  private parseUser(buf: Buffer): { longName: string; shortName: string } {
    let longName = '';
    let shortName = '';
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const str = buf.subarray(offset, offset + len).toString('utf-8');
        offset += len;

        if (fieldNumber === 2) longName = str;
        else if (fieldNumber === 3) shortName = str;
      } else if (wireType === 0) {
        const { bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
      } else {
        break;
      }
    }

    return { longName, shortName };
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
        this.handleTextMessage(fromId, toId, hopLimit, channelIndex, payloadBuf, incomingPacketId);
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
    }

    this.emit('data');
  }

  private parseDataSubmessage(buf: Buffer): { portNum: number; payload: Buffer | null; requestId: number } {
    let portNum = 0;
    let payload: Buffer | null = null;
    let requestId = 0;
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
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 2) payload = buf.subarray(offset, offset + len); // payload
        offset += len;
      } else {
        break;
      }
    }

    if (portNum === PORT_ROUTING || requestId) {
      console.log(`[MeshtasticSerial] Data: portNum=${portNum} requestId=${requestId} payloadLen=${payload?.length ?? 0}`);
    }

    return { portNum, payload, requestId };
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
        if (msg) { msg.status = 'error'; msg.errorCode = res; }
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
      if (msg) { msg.status = 'acked'; }
      this.emit('ackUpdate', pending.msgId, 'acked', 0);
      console.log(`[MeshtasticSerial] QueueStatus ACK for ${pending.msgId} (pktId=${meshPacketId})`);
    }
  }

  private handleTextMessage(fromId: string, toId: string, hopLimit: number, channelIndex: number, payload: Buffer, incomingPacketId = 0) {
    const text = payload.toString('utf-8');
    console.log(`[MeshtasticSerial] TEXT from=${fromId} to=${toId} ch=${channelIndex} pktId=${incomingPacketId} local=${this.localNodeId} text="${text.substring(0, 40)}"`);

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
    // Position protobuf: field 1 = latitude_i (sfixed32), field 2 = longitude_i (sfixed32), field 3 = altitude (int32)
    let lat = 0;
    let lng = 0;
    let alt = 0;
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
        node.lastSeen = Date.now();
        this.upsertNode(node);
        this.addEvent('POSITION_UPDATE', nodeId, `${node.name} position: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
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
    if (!this.port?.isOpen) return;

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
    if (!this.port?.isOpen) return;

    const frame = Buffer.alloc(HEADER_SIZE + payload.length);
    frame[0] = START_BYTE_1;
    frame[1] = START_BYTE_2;
    frame[2] = (payload.length >> 8) & 0xff;
    frame[3] = payload.length & 0xff;
    payload.copy(frame, HEADER_SIZE);

    this.port.write(frame);
  }

  /** Encode a fixed32 field (wire type 5) */
  private encodeTagFixed32(field: number, value: number): Buffer {
    const buf = Buffer.alloc(5);
    buf[0] = (field << 3) | 5;
    buf.writeUInt32LE(value >>> 0, 1);
    return buf;
  }

  private buildTextPacket(text: string, to: string, channel: number, packetId: number): Buffer {
    // Builds a ToRadio { packet: MeshPacket } frame using current Meshtastic protobuf field numbers.
    // Field layout (mesh.proto):
    //   MeshPacket: to=2(fixed32), channel=3(varint), decoded=4(submsg), id=6(fixed32), want_ack=10(bool)
    //   Data:       portnum=1(varint), payload=2(bytes)
    const textBuf = Buffer.from(text, 'utf-8');

    // Data submessage: portnum=1 (TEXT_MESSAGE_APP), payload=text
    const dataMsg = Buffer.concat([
      this.encodeTagVarint(1, PORT_TEXT_MESSAGE),
      Buffer.from([(2 << 3) | 2, ...this.encodeVarint(textBuf.length)]),
      textBuf,
    ]);

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

  /** Wrap an AdminMessage payload into Data → MeshPacket → ToRadio and send it. */
  private sendAdminMessage(adminPayload: Buffer) {
    if (!this.port?.isOpen) {
      console.warn('[MeshtasticSerial] Cannot send admin message — port not open');
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
}

export const meshBridge = new MeshtasticSerialBridge();
