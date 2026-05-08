export type UnitSystem = 'METRIC' | 'IMPERIAL';

export interface WidgetConfig {
  id: string;
  type: 'STATS' | 'NODE_LIST' | 'NODE_DETAILS' | 'MESSAGES' | 'MAP' | 'SENSOR_DATA';
  visible: boolean;
  order: number;
  width: 'full' | 'large' | 'medium' | 'small'; // mapping to grid spans
}

export interface NodeSettings {
  longName: string;
  shortName: string;
  isOwner?: boolean;
  hopLimit: number;
  broadcastInterval: number; // in seconds
  channelName: string;
  modemPreset: 'LONG_FAST' | 'LONG_SLOW' | 'MEDIUM_FAST' | 'SHORT_FAST';
}

export type ChannelRole = 'DISABLED' | 'PRIMARY' | 'SECONDARY';

export interface Channel {
  index: number;            // 0-7
  name: string;             // empty for default LongFast on primary
  role: ChannelRole;
  pskBase64: string;        // raw PSK as base64 ('' = none, 'AQ==' single-byte = default)
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
}

export interface SensorData {
  temperature?: number;
  humidity?: number;
  pressure?: number;
  iaq?: number; // Indoor Air Quality index
  bridge?: {
    type: 'RASPBERRY_PI' | 'PC' | 'ESP32_SECONDARY';
    connected: boolean;
    uptime: number; // in seconds
    cpuTemp?: number;
    ramUsage?: number;
  };
}

export interface Node {
  id: string;
  name: string;
  shortName: string;
  lastSeen: number;
  online: boolean;
  favorite: boolean;
  groupId?: string; // ID of the group the node belongs to
  /** Base64 Curve25519 public key. Presence implies the node supports PKC-encrypted DMs (fw 2.5+). */
  publicKey?: string;
  /** Whether the last reported position came from a hard-coded fix or live GPS. */
  positionSource?: 'manual' | 'gps';
  /** Channel-imposed precision_bits the node sent its position with (T3.15). */
  positionPrecisionBits?: number;
  /** Meshtastic Role enum (0=CLIENT, 2=ROUTER, 4=REPEATER, 5=TRACKER, 6=SENSOR, 7=TAK, etc.). */
  role?: number;
  /** Whether this user has identified as a licensed amateur radio operator. */
  isLicensed?: boolean;
  /** Meshtastic HardwareModel enum (TBEAM, HELTEC_V3, RAK4631, etc.). */
  hwModel?: number;
  /** Last-observed inbound transport ('lora' = direct over RF, 'mqtt' = bridged). */
  lastVia?: 'lora' | 'mqtt';
  settings?: NodeSettings;
  position?: {
    lat: number;
    lng: number;
    alt: number;
  };
  telemetry?: {
    battery: number;
    voltage: number;
    channelUtilization: number;
    airUtilTx: number;
    snr: number;
    rssi: number;
    distance?: number;
  };
  sensors?: SensorData;
}

export interface Group {
  id: string;
  name: string;
  color: string;
}

export type MessageStatus = 'sending' | 'sent' | 'acked' | 'error';

export interface Message {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: number;
  channel: string;
  hopLimit: number;
  hops: string[]; // List of node IDs it hopped through
  status?: MessageStatus;
  errorCode?: number; // Meshtastic routing error code (0 = none)
  isOwn?: boolean;   // true when sent by the local radio
  /** The radio's MeshPacket.id (uint32). Used to resolve replies/reactions. */
  packetId?: number;
  /** If set, this is a reply or reaction to the message whose packetId === replyTo. */
  replyTo?: number;
  /** True if this is a reaction (Data.emoji != 0). The text holds the emoji. */
  isReaction?: boolean;
}

export interface RadioEvent {
  id: string;
  type: 'NODE_JOINED' | 'NODE_LOST' | 'MESSAGE' | 'TELEMETRY' | 'POSITION_UPDATE';
  nodeId: string;
  timestamp: number;
  details: string;
}

export interface Waypoint {
  id: number;
  lat: number;
  lng: number;
  name: string;
  description: string;
  icon: number;          // emoji codepoint (0 = none)
  expire: number;        // epoch seconds; 0 = never
  lockedTo: number;      // node num that may edit; 0 = anyone
  createdBy: string;     // !hex of placer
  lastSeen: number;      // epoch ms
}

export interface TraceHop {
  nodeId: string;        // !hex
  snr?: number;          // dB (already divided by 4)
}

export interface TraceResult {
  id: string;            // requestId
  targetId: string;
  startedAt: number;
  completedAt?: number;
  status: 'pending' | 'response' | 'timeout' | 'error';
  route: TraceHop[];
  routeBack: TraceHop[];
  errorMessage?: string;
}

export interface NeighborObservation {
  nodeId: string;
  snr: number;
  intervalSecs?: number;
}

export interface NeighborInfoSnapshot {
  fromNodeId: string;
  intervalSecs: number;
  neighbors: NeighborObservation[];
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

export interface NeighborInfoModuleConfig {
  enabled: boolean;
  updateIntervalSecs: number;
  transmitOverLora: boolean;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface LocalModuleConfigSnapshot {
  /** Authoritative NeighborInfo config; undefined until the first readback completes. */
  neighborInfo?: NeighborInfoModuleConfig;
}

export interface StoreForwardRouter {
  nodeId: string;
  periodSecs: number;
  isSecondary: boolean;
  lastHeartbeat: number;
  stats?: StoreForwardStats;
}

export interface UptimeRecord {
  nodeId: string;
  onlineAt: number;
  offlineAt: number | null; // null = still online
}

export interface RouteRecord {
  from: string;
  to: string;
  hops: string[];       // ordered relay node IDs (excludes source & destination)
  timestamp: number;
  deliveryMs: number;    // simulated delivery latency
  success: boolean;
}
