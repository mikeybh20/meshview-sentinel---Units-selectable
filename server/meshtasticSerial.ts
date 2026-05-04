/**
 * Meshtastic Serial Bridge
 * 
 * Connects to a real Meshtastic LoRa radio over USB serial and translates
 * protobuf packets into the app's Node / Message / RadioEvent data model.
 */
import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';

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
}

export interface MeshEvent {
  id: string;
  type: 'NODE_JOINED' | 'NODE_LOST' | 'MESSAGE' | 'TELEMETRY' | 'POSITION_UPDATE';
  nodeId: string;
  timestamp: number;
  details: string;
}

// ---- Meshtastic serial protocol constants ----
const START_BYTE_1 = 0x94;
const START_BYTE_2 = 0xc3;
const HEADER_SIZE = 4; // 2 start bytes + 2 byte MSB length

// Meshtastic protobuf port numbers
const PORT_TEXT_MESSAGE = 1;
const PORT_POSITION = 3;
const PORT_NODEINFO = 4;
const PORT_TELEMETRY = 67;

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

  // How long before marking a node offline (ms)
  private staleThresholdMs = 15 * 60 * 1000; // 15 minutes

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
          resolve();
        });
      });
    }
    this._connected = false;
    this.port = null;
  }

  /** Send a text message through the radio */
  async sendMessage(text: string, to: string = '!ffffffff', channel = 0): Promise<void> {
    if (!this.port?.isOpen) {
      throw new Error('Radio not connected');
    }

    // Build a ToRadio protobuf with a text message
    // For simplicity, we use the raw serial protocol frame format
    const packet = this.buildTextPacket(text, to, channel);
    this.port.write(packet);
    console.log(`[MeshtasticSerial] Sent message: "${text}" to ${to}`);
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

        // FromRadio field numbers:
        // 2 = my_info, 3 = node_info, 7 = packet (MeshPacket), 8 = config
        if (fieldNumber === 3) {
          this.handleNodeInfo(subBuf);
        } else if (fieldNumber === 7) {
          this.handleMeshPacket(subBuf);
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
      this.nodes.set(nodeId, node);

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

  /** Parse a MeshPacket submessage for text, position, and telemetry */
  private handleMeshPacket(buf: Buffer) {
    let fromNum = 0;
    let toNum = 0;
    let hopLimit = 0;
    let rxSnr = 0;
    let rxRssi = 0;
    let portNum = 0;
    let payloadBuf: Buffer | null = null;
    let offset = 0;

    // First pass: get top-level fields
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
        else if (fieldNumber === 10) hopLimit = value;
        else if (fieldNumber === 12) rxSnr = value;
        else if (fieldNumber === 13) rxRssi = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const subBuf = buf.subarray(offset, offset + len);
        offset += len;

        // Field 3 = decoded (Data submessage)
        if (fieldNumber === 3) {
          // Parse Data submessage to get portnum + payload
          const decoded = this.parseDataSubmessage(subBuf);
          portNum = decoded.portNum;
          payloadBuf = decoded.payload;
        }
      } else if (wireType === 5) {
        // fixed32 — skip 4 bytes
        offset += 4;
      } else {
        break;
      }
    }

    const fromId = nodeIdToHex(fromNum);
    const toId = nodeIdToHex(toNum);

    // Ensure the sender node exists
    if (fromNum > 0 && !this.nodes.has(fromId)) {
      this.nodes.set(fromId, {
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
          snr: rxSnr / 4, // Meshtastic encodes SNR * 4
          rssi: rxRssi === 0 ? (senderNode.telemetry?.rssi || 0) : -rxRssi,
        };
      }
      this.nodes.set(fromId, senderNode);
    }

    if (!payloadBuf) return;

    // Dispatch based on port number
    switch (portNum) {
      case PORT_TEXT_MESSAGE:
        this.handleTextMessage(fromId, toId, hopLimit, payloadBuf);
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

  private parseDataSubmessage(buf: Buffer): { portNum: number; payload: Buffer | null } {
    let portNum = 0;
    let payload: Buffer | null = null;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) portNum = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 2) {
          payload = buf.subarray(offset, offset + len);
        }
        offset += len;
      } else {
        break;
      }
    }

    return { portNum, payload };
  }

  private handleTextMessage(fromId: string, toId: string, hopLimit: number, payload: Buffer) {
    const text = payload.toString('utf-8');
    const msg: MeshMessage = {
      id: randomId(),
      from: fromId,
      to: toId,
      text,
      timestamp: Date.now(),
      channel: toId === '!ffffffff' ? 'Broadcast' : 'Private',
      hopLimit,
      hops: [fromId, toId],
    };
    this.messages.push(msg);
    if (this.messages.length > 500) {
      this.messages = this.messages.slice(-500);
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
        this.nodes.set(nodeId, node);
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
    this.nodes.set(nodeId, node);

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
      if (node.online && (now - node.lastSeen) > this.staleThresholdMs) {
        node.online = false;
        this.nodes.set(id, node);
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

  private buildTextPacket(text: string, to: string, channel: number): Buffer {
    // This builds a minimal ToRadio { packet { ... } } frame
    // For a proper implementation, use the @meshtastic/js library
    const textBuf = Buffer.from(text, 'utf-8');

    // Data submessage: portnum=1, payload=text
    const dataMsg = Buffer.concat([
      Buffer.from([(1 << 3) | 0, PORT_TEXT_MESSAGE]), // field 1 = portnum
      Buffer.from([(2 << 3) | 2, textBuf.length]),     // field 2 = payload (len-delimited)
      textBuf,
    ]);

    // MeshPacket: to=broadcast, decoded=dataMsg, channel
    const toNum = to === '!ffffffff' ? 0xffffffff : parseInt(to.replace('!', ''), 16);
    const toBytes = Buffer.alloc(4);
    toBytes.writeUInt32LE(toNum);

    const meshPacket = Buffer.concat([
      // field 2 = to (fixed32, wire type 5)
      Buffer.from([(2 << 3) | 5]),
      toBytes,
      // field 3 = decoded (len-delimited, wire type 2)
      Buffer.from([(3 << 3) | 2, dataMsg.length]),
      dataMsg,
    ]);

    // ToRadio: field 1 = packet (len-delimited)
    const toRadio = Buffer.concat([
      Buffer.from([(1 << 3) | 2, meshPacket.length]),
      meshPacket,
    ]);

    return toRadio;
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
    this.emit('event', event);
  }
}

export const meshBridge = new MeshtasticSerialBridge();
