/**
 * Meshtastic Serial Bridge
 * 
 * Connects to a real Meshtastic LoRa radio over USB serial and translates
 * protobuf packets into the app's Node / Message / RadioEvent data model.
 */
import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';
import * as net from 'net';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { meshDb, type MeshDatabase } from './database.js';
import { type BbsService } from './bbs.js';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
/**
 * On-disk cache of the local radio's module config snapshot. Lets us preserve
 * the operator's configured values across container rebuilds even when the
 * firmware doesn't reply to the post-boot admin readback (some firmware
 * versions silently ignore self-admin reads). The actual radio config in flash
 * is always authoritative — this file is best-effort.
 */
const LOCAL_MODULE_CONFIG_PATH = join(__dirname_local, '..', 'data', 'local-module-config.json');

// ---- App data types (mirrored from src/types.ts for server use) ----

export interface MeshNode {
  id: string;
  name: string;
  shortName: string;
  /** Epoch ms of the very first packet we observed from this node. Populated
   *  once on initial discovery and preserved across all subsequent upserts. */
  firstSeen?: number;
  lastSeen: number;
  online: boolean;
  favorite: boolean;
  /** Base64-encoded Curve25519 public key, if the node advertised one (PKC support, fw 2.5+). */
  publicKey?: string;
  /** Whether the last reported position came from a hard-coded fix or live GPS (fw 'location_source' enum). */
  positionSource?: 'manual' | 'gps';
  /** Channel-imposed precision_bits, if the node's last Position carried it (32 = full precision). */
  positionPrecisionBits?: number;
  /** User.role enum (Meshtastic config.proto Role) — CLIENT, ROUTER, TAK, etc. */
  role?: number;
  /** User.is_licensed — set when the operator has identified as licensed. */
  isLicensed?: boolean;
  /** User.hw_model — Meshtastic HardwareModel enum (TBEAM, HELTEC_V3, RAK4631, etc.). */
  hwModel?: number;
  /**
   * Mesh distance to this node, in hops, as last reported by the local radio's
   * NodeInfo (mesh.proto NodeInfo.hops_away, field 9). Undefined when the
   * firmware hasn't yet computed/sent it (very-far nodes or fresh discovery).
   * Used by sendMessage to size MeshPacket.hopLimit so DMs to far peers don't
   * get dropped by the default-3-hop ceiling.
   */
  hopsAway?: number;
  /** Last-observed inbound transport for this node ('lora' = direct over RF, 'mqtt' = bridged). */
  lastVia?: 'lora' | 'mqtt';
  /** Group id this node belongs to (operator-assigned). null/undefined = unassigned. */
  groupId?: string;
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
  status?: 'sending' | 'sent' | 'queued' | 'acked' | 'error';
  errorCode?: number;
  isOwn?: boolean;
  /** The radio's MeshPacket.id (uint32). Used for cross-referencing replies and reactions. */
  packetId?: number;
  /** If set, this message is a reply or reaction to the message whose packetId === replyTo. */
  replyTo?: number;
  /** True if this message is a tapback/reaction (Data.emoji != 0). The text holds the emoji. */
  isReaction?: boolean;
  /**
   * Wall-clock latency between the operator's send and the radio's ACK
   * (in ms). Captured at the moment we receive the ROUTING ACK or QueueStatus
   * success for a message we sent. Undefined for messages where we never
   * observed an ACK or for inbound messages.
   */
  deliveryMs?: number;
}

/** Context retained per outbound message so the auto-retry path can rebuild
 *  an identical packet under a fresh packetId. */
interface ResendContext {
  text: string;
  to: string;
  channel: number;
  replyTo?: number;
  isReaction?: boolean;
  hopLimit?: number;
  destPublicKey?: string;
}

export interface MeshEvent {
  id: string;
  type: 'NODE_JOINED' | 'NODE_LOST' | 'MESSAGE' | 'TELEMETRY' | 'POSITION_UPDATE' | 'WEATHER_ALERT';
  nodeId: string;
  timestamp: number;
  details: string;
}

export interface MeshGroup {
  id: string;
  name: string;
  color: string;        // hex like '#10b981'
  createdAt: number;    // epoch ms
}

export type ChannelRole = 'DISABLED' | 'PRIMARY' | 'SECONDARY';

export interface MeshChannel {
  index: number;            // 0-7
  name: string;
  role: ChannelRole;
  pskBase64: string;        // raw PSK bytes encoded as base64
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  /**
   * Per-channel position precision (ChannelSettings.module_settings.position_precision).
   * Number of high-order coordinate bits the firmware will share when broadcasting positions
   * on this channel. 0 = position sharing disabled on this channel; 32 = full precision;
   * intermediate values fuzz to a coarser grid (each bit ≈ doubles the uncertainty radius).
   * `undefined` = not yet read from the radio (treat as firmware default = 32).
   */
  positionPrecision?: number;
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

export interface NeighborInfoModuleConfig {
  /** True if the firmware is configured to broadcast NeighborInfo packets. */
  enabled: boolean;
  /** Broadcast interval in seconds (firmware default: 14400 = 4 hours). */
  updateIntervalSecs: number;
  /** Whether to transmit observations over LoRa (vs MQTT-only). */
  transmitOverLora: boolean;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface RangeTestModuleConfig {
  /** True if the Range Test module is enabled at all (sender or receiver). */
  enabled: boolean;
  /** Send interval in seconds. 0 = receive-only mode. Firmware default: 0. */
  senderIntervalSecs: number;
  /** Persist results to flash (the radio's CSV log). */
  save: boolean;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface TelemetryModuleConfig {
  /** Device metrics (battery, voltage, ch util) broadcast interval (s). 0 = firmware default. */
  deviceUpdateIntervalSecs: number;
  /** True if the radio publishes environment-sensor telemetry (BME280, etc.). */
  environmentEnabled: boolean;
  /** Environment-sensor broadcast interval (s). 0 = firmware default. */
  environmentUpdateIntervalSecs: number;
  /** True if the radio publishes power-monitor telemetry (INA219/INA260). */
  powerEnabled: boolean;
  /** Power-monitor broadcast interval (s). 0 = firmware default. */
  powerUpdateIntervalSecs: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface DetectionSensorModuleConfig {
  /** True if the Detection Sensor module is enabled. */
  enabled: boolean;
  /** Minimum seconds between broadcasts even if state changes (rate limit). */
  minimumBroadcastSecs: number;
  /** Periodic state broadcast interval in seconds (0 = no periodic broadcast). */
  stateBroadcastSecs: number;
  /** Send the bell character (^G) so it triggers external-notification alerts. */
  sendBell: boolean;
  /** Operator-friendly sensor name shown in broadcast messages. */
  name: string;
  /** GPIO pin being monitored for state changes. */
  monitorPin: number;
  /** True = detection triggers when pin reads HIGH; false = LOW (active-low). */
  detectionTriggeredHigh: boolean;
  /** Enable the MCU's internal pull-up resistor on the monitor pin. */
  usePullup: boolean;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface AudioModuleConfig {
  /** Codec2 voice over LoRa enabled. */
  codec2Enabled: boolean;
  /** PTT (push-to-talk) GPIO pin. */
  pttPin: number;
  /** Codec2 mode/bitrate variant (uint32 enum). */
  bitrate: number;
  /** I2S word-select GPIO pin. */
  i2sWs: number;
  /** I2S serial-data GPIO pin. */
  i2sSd: number;
  /** I2S DOUT GPIO pin. */
  i2sDin: number;
  /** I2S serial-clock GPIO pin. */
  i2sSck: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface MqttModuleConfig {
  /** Master enable for the MQTT module on the local radio. */
  enabled: boolean;
  /** Broker hostname/IP, e.g. "mqtt.meshtastic.org" or "192.168.1.10". Empty = use firmware default. */
  address: string;
  /** Broker username (blank = anonymous). */
  username: string;
  /** Broker password (blank = anonymous). */
  password: string;
  /** Encrypt MQTT payloads with the per-channel PSK before publish (recommended). */
  encryptionEnabled: boolean;
  /** Publish unencrypted JSON for IoT-bridge consumers (mutually exclusive with encryption in practice). */
  jsonEnabled: boolean;
  /** Use TLS to the broker. */
  tlsEnabled: boolean;
  /** Topic prefix, e.g. "msh/US/2/e/". Empty = firmware default. */
  root: string;
  /** Radio uses the connected client (this app's bridge or a phone) to reach MQTT, instead of its own WiFi. */
  proxyToClientEnabled: boolean;
  /** Publish positions to the public Meshtastic map. */
  mapReportingEnabled: boolean;
  /** Opaque MapReportSettings submessage — captured raw from readback so we can echo it on save without dropping bits we don't model. */
  mapReportSettingsRaw: string | null;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface ExternalNotificationModuleConfig {
  /** True if the External Notification module is enabled. */
  enabled: boolean;
  /** Alert duration in milliseconds (how long the buzzer / LED stays on per alert). */
  outputMs: number;
  /** Generic alert GPIO pin (firmware default; board-specific). */
  output: number;
  /** Whether the alert pin is active-high (true) or active-low (false). */
  active: boolean;
  /** Alert on any text message. */
  alertMessage: boolean;
  /** Alert only on the bell character (^G) inside text messages. */
  alertBell: boolean;
  /** Use PWM output instead of digital high/low. */
  usePwm: boolean;
  /** Vibration motor GPIO pin. */
  outputVibra: number;
  /** Buzzer GPIO pin (separate from generic output). */
  outputBuzzer: number;
  /** Vibrate on text message. */
  alertMessageVibra: boolean;
  /** Buzzer on text message. */
  alertMessageBuzzer: boolean;
  /** Vibrate on bell character. */
  alertBellVibra: boolean;
  /** Buzzer on bell character. */
  alertBellBuzzer: boolean;
  /** Keep nagging for this many seconds until the user dismisses on the radio. */
  nagTimeout: number;
  /** Drive an I2S amplifier as the buzzer (advanced hardware option). */
  useI2sAsBuzzer: boolean;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface StoreForwardLocalConfig {
  /** True if the Store & Forward module is enabled (as client or server). */
  enabled: boolean;
  /** True if this radio acts as an S&F router/server (buffers traffic + replays on request). */
  isServer: boolean;
  /** Emit periodic heartbeat announcing as router. Only meaningful when isServer=true. */
  heartbeat: boolean;
  /** Max records to retain in the buffer (router only). 0 = firmware default. */
  records: number;
  /** Max records replayed per CLIENT_HISTORY request (router only). 0 = firmware default. */
  historyReturnMax: number;
  /** Time window in minutes a CLIENT_HISTORY request may ask for (router only). 0 = firmware default. */
  historyReturnWindow: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface LocalModuleConfigSnapshot {
  /** Authoritative NeighborInfo config read from the radio via admin readback. */
  neighborInfo?: NeighborInfoModuleConfig;
  /** Authoritative Range Test config read from the radio via admin readback. */
  rangeTest?: RangeTestModuleConfig;
  /** Authoritative Telemetry-module config read from the radio via admin readback. */
  telemetry?: TelemetryModuleConfig;
  /** Authoritative Store & Forward module config (local radio's S&F role / params). */
  storeForward?: StoreForwardLocalConfig;
  /** Authoritative External Notification module config (buzzer / LED / vibra alerts). */
  externalNotification?: ExternalNotificationModuleConfig;
  /** Authoritative MQTT module config (broker URL / auth / encryption / topic). */
  mqtt?: MqttModuleConfig;
  /** Authoritative Detection Sensor module config (GPIO state broadcasts). */
  detectionSensor?: DetectionSensorModuleConfig;
  /** Authoritative Audio module config (Codec2 voice over LoRa). */
  audio?: AudioModuleConfig;
  /**
   * Active timed surveys: epoch-ms restore deadlines for any module currently
   * running an accelerated cadence. `null` for any module that's not in survey mode.
   */
  activeSurveys?: {
    rangeTestExpiresAt: number | null;
    neighborInfoExpiresAt: number | null;
  };
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
  /** BBS-Mail handler. Wired up from api.ts after the bridge is constructed
   *  to avoid an import cycle (bbs.ts type-imports MeshtasticSerialBridge). */
  private bbs: BbsService | null = null;
  setBbs(bbs: BbsService): void { this.bbs = bbs; }

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
  /**
   * Firmware version string the radio reports about itself, e.g. "2.5.13.55c2c5b".
   * Sourced from MyNodeInfo.firmware_version (older firmware) or
   * FromRadio.metadata.firmware_version (newer firmware via DeviceMetadata).
   */
  private localFirmwareVersion: string | null = null;
  private localRebootCount: number | null = null;
  private channels = new Map<number, MeshChannel>();
  private waypoints = new Map<number, MeshWaypoint>();
  private traces = new Map<string, MeshTraceResult>();
  /** packetId → traceRequest. Used to match the response back to the client. */
  private pendingTraces = new Map<number, { requestId: string; timer: ReturnType<typeof setTimeout> }>();
  /** Latest NeighborInfo report keyed by originator node id. */
  private neighborInfo = new Map<string, NeighborInfoSnapshot>();
  /** Known Store & Forward routers, keyed by node id. */
  private storeForwardRouters = new Map<string, MeshStoreForwardRouter>();
  /** Authoritative module config read from the local radio via admin readback. */
  private localModuleConfig: LocalModuleConfigSnapshot = {};
  /** Operator-defined node groups (for organizing the mesh into Field Team / Logistics / etc.). */
  private groups = new Map<string, MeshGroup>();
  // ---- Timed module surveys ----
  // A "survey" temporarily reconfigures a module to a faster cadence to
  // accelerate coverage / topology discovery, then restores the previous
  // config after a fixed duration. State is in-memory only — if the server
  // restarts mid-survey, the radio keeps the survey config until the operator
  // explicitly reverts via Save.
  private rangeTestSurveyTimer: ReturnType<typeof setTimeout> | null = null;
  private rangeTestSurveyExpiresAt: number | null = null;
  private rangeTestSurveyOriginal: Omit<RangeTestModuleConfig, 'lastReadAt'> | null = null;
  private neighborInfoSurveyTimer: ReturnType<typeof setTimeout> | null = null;
  private neighborInfoSurveyExpiresAt: number | null = null;
  private neighborInfoSurveyOriginal: Omit<NeighborInfoModuleConfig, 'lastReadAt'> | null = null;

  /** Hours to keep events around. Set via setEventRetention(). */
  private eventRetentionHours: number = 24;
  /** Hours to keep messages around (parallel to events). 0 = keep all (count-cap only). */
  private messageRetentionHours: number = 0;
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

  // ACK tracking: maps packetId → { msgId, timer, retryCount, context? }
  // context only populated for DMs (broadcasts are never retried — they can't
  // fail in a way retry would help).
  private pendingAcks = new Map<number, {
    msgId: string;
    timer: ReturnType<typeof setTimeout>;
    retryCount: number;
    context?: ResendContext;
  }>();

  /** Maximum auto-retransmits before surfacing the error to the UI. iOS retries
   *  once on MAX_RETRANSMIT / TIMEOUT before showing the user. */
  private static readonly MAX_AUTO_RETRIES = 1;

  /**
   * Fresh MeshPacket.id for outbound packets. Matches the official iOS app's
   * strategy of a random uint32 in [256, 2^31) — random IDs dodge the
   * post-restart-collision risk an incrementing counter has, and the lower
   * bound avoids the firmware's reserved-low-id range.
   */
  private newPacketId(): number {
    return Math.floor(Math.random() * (0x7FFFFFFE - 256)) + 256;
  }

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

      const persistedGroups = this.db.loadGroups();
      for (const g of persistedGroups) this.groups.set(g.id, g);

      const persistedTraces = this.db.loadTraceResults();
      for (const t of persistedTraces) this.traces.set(t.id, t);

      // Boot-time session cleanup: any sessions still flagged "open" are
      // orphans from a previous bridge process that crashed or was restarted
      // mid-session. Close them at "now minus stale threshold" so the
      // computed uptime reflects roughly when the node would have actually
      // gone stale, not how long the bridge was down. New observations after
      // this point start fresh sessions.
      this.db.closeOrphanedSessions(Date.now() - this.staleThresholdMs);

      // Hydrate the local-radio module config snapshot from disk. This is
      // best-effort: when the radio replies to the post-boot admin readback,
      // those authoritative values overwrite whatever we restored here. When
      // the radio doesn't reply (some firmware versions don't), the operator
      // still sees their last-known configuration in the UI rather than
      // a blank "Reading…" state.
      const persistedModuleConfig = this.loadLocalModuleConfigFromDisk();
      if (persistedModuleConfig) {
        this.localModuleConfig = persistedModuleConfig;
        const keys = Object.keys(persistedModuleConfig).filter(k => k !== 'activeSurveys').join(', ') || 'none';
        console.log(`[MeshtasticSerial] Hydrated local module config from disk (${keys})`);
      }

      const s = this.db.stats();
      console.log(
        `[MeshtasticSerial] Hydrated from DB — nodes:${s.nodes} messages:${s.messages} events:${s.events} channels:${s.channels} telemetry:${s.telemetry}`
      );
    } catch (err: any) {
      console.error('[MeshtasticSerial] DB hydration failed:', err.message);
    }
  }

  /**
   * Read the local-module-config snapshot from disk, if it exists. Returns
   * `null` on first boot, parse error, or file-system error — the caller
   * starts with an empty snapshot and the first admin readback (or operator
   * save) repopulates it.
   */
  private loadLocalModuleConfigFromDisk(): LocalModuleConfigSnapshot | null {
    try {
      if (!existsSync(LOCAL_MODULE_CONFIG_PATH)) return null;
      const raw = readFileSync(LOCAL_MODULE_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        // Strip the ephemeral `activeSurveys` block — surveys are timer-driven
        // and don't carry over a server restart (the radio keeps the survey
        // config in flash; our timer-based restore doesn't).
        const { activeSurveys: _drop, ...rest } = parsed as LocalModuleConfigSnapshot;
        void _drop;
        return rest as LocalModuleConfigSnapshot;
      }
    } catch (err: any) {
      console.warn('[MeshtasticSerial] Failed to load local module config from disk:', err.message);
    }
    return null;
  }

  /**
   * Persist the operator-modeled module config to disk. Emits the SSE update
   * event in the same call so callers don't have to remember both. The
   * `activeSurveys` field is excluded — its values are server-process-local.
   */
  private updateLocalModuleConfig() {
    try {
      const dir = dirname(LOCAL_MODULE_CONFIG_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Don't persist the ephemeral surveys block.
      const { activeSurveys: _drop, ...persistable } = this.localModuleConfig;
      void _drop;
      writeFileSync(LOCAL_MODULE_CONFIG_PATH, JSON.stringify(persistable, null, 2), 'utf-8');
    } catch (err: any) {
      console.error('[MeshtasticSerial] localModuleConfig persist failed:', err.message);
    }
    this.emit('localModuleConfigUpdate', this.localModuleConfig);
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

  // ---- Node groups ----

  getGroups(): MeshGroup[] {
    return Array.from(this.groups.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Create a new group. Returns the created group. */
  createGroup(name: string, color: string): MeshGroup {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Group name cannot be empty');
    const id = `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const group: MeshGroup = { id, name: trimmed, color, createdAt: Date.now() };
    this.groups.set(id, group);
    try { this.db.upsertGroup(group); }
    catch (err: any) { console.error('[MeshtasticSerial] group persist failed:', err.message); }
    return group;
  }

  /** Update name and/or color of an existing group. */
  updateGroup(id: string, patch: { name?: string; color?: string }): MeshGroup | null {
    const existing = this.groups.get(id);
    if (!existing) return null;
    const next: MeshGroup = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      color: patch.color !== undefined ? patch.color : existing.color,
    };
    if (!next.name) throw new Error('Group name cannot be empty');
    this.groups.set(id, next);
    try { this.db.upsertGroup(next); }
    catch (err: any) { console.error('[MeshtasticSerial] group update persist failed:', err.message); }
    return next;
  }

  /** Delete a group and unassign every node currently in it. */
  deleteGroup(id: string): boolean {
    if (!this.groups.has(id)) return false;
    this.groups.delete(id);
    try { this.db.deleteGroup(id); }
    catch (err: any) { console.error('[MeshtasticSerial] group delete persist failed:', err.message); }

    // Unassign every node that pointed at this group
    let cleared = 0;
    for (const node of this.nodes.values()) {
      if (node.groupId === id) {
        node.groupId = undefined;
        this.upsertNode(node);
        cleared++;
      }
    }
    if (cleared > 0) console.log(`[MeshtasticSerial] Group ${id} deleted; ${cleared} node(s) unassigned`);
    return true;
  }

  /** Assign a node to a group, or pass null/undefined to unassign. */
  setNodeGroup(nodeId: string, groupId: string | null): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    if (groupId && !this.groups.has(groupId)) return false;
    node.groupId = groupId || undefined;
    this.upsertNode(node); // raw_json round-trip persists groupId
    this.emit('nodeUpdate', node);
    return true;
  }

  /**
   * Mark a node as favorite (or unfavorite). Updates the in-memory cache and
   * persists via upsertNode so the change survives a restart.
   *
   * Important: we MUST call upsertNode here (not just setFavorite on the DB)
   * because loadNodes hydrates from the `raw_json` blob — the favorite column
   * alone is invisible to the load path. The previous setFavorite-only write
   * was silently dropped on every container restart.
   */
  setFavorite(nodeId: string, favorite: boolean): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.favorite = !!favorite;
    this.upsertNode(node); // rewrites raw_json with the new favorite state
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

  /** Authoritative module config last read from the local radio via admin readback. */
  getLocalModuleConfig(): LocalModuleConfigSnapshot {
    return {
      ...this.localModuleConfig,
      activeSurveys: {
        rangeTestExpiresAt: this.rangeTestSurveyExpiresAt,
        neighborInfoExpiresAt: this.neighborInfoSurveyExpiresAt,
      },
    };
  }

  /** Local node hex id (e.g. "!aabbccdd") if known, null otherwise. */
  getLocalNodeId(): string | null {
    return this.localNodeId;
  }

  getLocalNodeNum(): number {
    return this.localNodeNum;
  }

  /** Firmware version string the radio has reported about itself, if any. */
  getLocalFirmwareVersion(): string | null {
    return this.localFirmwareVersion;
  }

  /** Reboot count from MyNodeInfo (uptime / stability hint), if reported. */
  getLocalRebootCount(): number | null {
    return this.localRebootCount;
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

    // Sanity-check the channel index against our cached set so a stale UI →
    // unknown-channel send doesn't silently time out 30 s later. If the radio
    // reports no channel at this index we still attempt the send (firmware may
    // know about a channel we haven't been told about yet), but we surface a
    // clear log line so the operator can correlate it with a timeout.
    const cachedCh = this.channels.get(channel);
    if (!cachedCh) {
      console.warn(`[MeshtasticSerial] sendMessage on channel idx=${channel} which is NOT in our cached channel set [${[...this.channels.keys()].sort((a,b)=>a-b).join(',')}]. Possible stale UI — try POST /api/mesh/refresh.`);
    } else {
      const hasPsk = !!cachedCh.pskBase64 && cachedCh.pskBase64.length > 0;
      console.log(`[MeshtasticSerial] sendMessage ch=${channel} name="${cachedCh.name}" role=${cachedCh.role} uplink=${cachedCh.uplinkEnabled} downlink=${cachedCh.downlinkEnabled} psk=${hasPsk ? 'set' : 'EMPTY'}`);
      if (cachedCh.uplinkEnabled === false) {
        console.warn(`[MeshtasticSerial] Channel idx=${channel} has uplink_enabled=false — firmware will refuse to TX on this channel. Enable uplink in Settings → Channels.`);
      }
    }

    const localId = randomId();
    const packetId = this.newPacketId();

    // Size MeshPacket.hopLimit for the destination. The mesh default is 3 (good
    // for most direct/2-hop traffic); broadcasts use that. For DMs we know the
    // destination's distance via NodeInfo.hops_away — if the peer is farther
    // than 3, bump the limit so relays don't drop the packet. Mesh ceiling is
    // 7; never exceed that or firmware rejects.
    const DEFAULT_HOP_LIMIT = 3;
    const MAX_HOP_LIMIT = 7;
    let hopLimit = DEFAULT_HOP_LIMIT;
    if (to !== '!ffffffff') {
      const destNode = this.nodes.get(to);
      if (destNode?.hopsAway !== undefined && destNode.hopsAway >= DEFAULT_HOP_LIMIT) {
        hopLimit = Math.min(MAX_HOP_LIMIT, destNode.hopsAway + 1);
        console.log(`[MeshtasticSerial] DM destination ${to} is ${destNode.hopsAway} hops away — raising hopLimit to ${hopLimit}`);
      }
    }

    // Add an optimistic outbound message immediately so the UI shows it right away
    const localNode = this.localNodeId || '!local';
    const msg: MeshMessage = {
      id: localId,
      from: localNode,
      to,
      text,
      timestamp: Date.now(),
      channel: this.resolveChannelName(channel, to),
      hopLimit,
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

    // PKI encryption is opt-in via `opts.usePki`. We previously auto-enabled
    // it for any DM whose recipient had a known public key, but that breaks
    // in practice: the official iOS app does its own client-side ECDH+AES
    // encryption before handing the packet to the firmware, whereas we just
    // set the pki_encrypted flag and trust the firmware to do it. Firmware
    // behavior here varies by version — some encrypt for us, some don't,
    // some rewrite the packet id mid-flight. The visible symptom is that
    // PKI-flagged DMs reach the recipient at the LoRa layer (we even get a
    // routing ACK) but the recipient's app can't decrypt the payload and
    // shows nothing.
    //
    // Until we implement proper client-side ECDH encryption, leave this off
    // by default. Channel-PSK encryption (which the firmware does for us)
    // works reliably between any two peers sharing the channel.
    const destPublicKey = (opts as any).usePki && to !== '!ffffffff'
      ? this.nodes.get(to)?.publicKey
      : undefined;

    // Build a send-context that's good enough to retransmit under a fresh
    // packetId without re-walking sendMessage. Used by retrySend below.
    const sendContext = {
      text, to, channel,
      replyTo: opts.replyTo,
      isReaction: opts.isReaction,
      hopLimit: hopLimit > DEFAULT_HOP_LIMIT ? hopLimit : undefined,
      destPublicKey,
    };

    // 30-second timeout. For DMs (`to !== '!ffffffff'`) the absence of an ACK
    // genuinely means the destination didn't acknowledge — but we auto-retry
    // once before surfacing the failure to the user (matches iOS behavior on
    // MAX_RETRANSMIT/TIMEOUT). Broadcasts never get over-the-air ACKs, so
    // their timeout is silent — see comment in the body.
    const isBroadcast = to === '!ffffffff';
    const timer = setTimeout(() => {
      const pending = this.pendingAcks.get(packetId);
      this.pendingAcks.delete(packetId);
      const m = this.messages.find(m => m.id === localId);
      // If the message already reached 'queued' (broadcast happy path) or
      // 'acked' (DM happy path), there's nothing to do here. We only care
      // about packets that never got past 'sending'/'sent'.
      if (!m || (m.status !== 'sending' && m.status !== 'sent')) return;

      const chCtx = cachedCh
        ? `ch=${channel}/"${cachedCh.name}" role=${cachedCh.role}`
        : `ch=${channel} (UNKNOWN)`;

      if (isBroadcast) {
        console.log(`[MeshtasticSerial] No QueueStatus for broadcast ${localId} pktId=${packetId} ${chCtx} after 30s — leaving as 'sent' (firmware did not confirm, but no delivery proof is expected for broadcasts).`);
        return;
      }

      // DM timeout — try once more before surfacing the error.
      const retryCount = pending?.retryCount ?? 0;
      if (retryCount < MeshtasticSerialBridge.MAX_AUTO_RETRIES && pending?.context) {
        console.log(`[MeshtasticSerial] DM timeout for ${localId} pktId=${packetId} ${chCtx} — scheduling auto-retry #${retryCount + 1} in 2s`);
        setTimeout(() => this.retrySend(localId, pending.context!, retryCount + 1), 2_000);
        return;
      }

      m.status = 'error';
      m.errorCode = -1; // timeout
      this.persistMessage(m);
      this.emit('ackUpdate', localId, 'error', -1);
      console.warn(`[MeshtasticSerial] DM timeout for msg ${localId} pktId=${packetId} ${chCtx} to=${to}. No ROUTING reply observed in 30s (${retryCount} retries already attempted).`);
    }, 30_000);
    this.pendingAcks.set(packetId, { msgId: localId, timer, retryCount: 0, context: sendContext });

    try {
      const packet = this.buildTextPacket(text, to, channel, packetId, {
        replyTo: opts.replyTo,
        isReaction: opts.isReaction,
        // Only override firmware's default hop_limit when we computed an
        // escalation for a far DM — otherwise omit so the radio uses its
        // operator-configured lora_config.hop_limit.
        hopLimit: hopLimit > DEFAULT_HOP_LIMIT ? hopLimit : undefined,
        destPublicKey,
      });
      this.sendToRadio(packet); // must go through sendToRadio to get the 0x94 0xC3 framing header
      msg.status = 'sent';
      this.persistMessage(msg);
      this.emit('ackUpdate', localId, 'sent', 0);
      const enc = destPublicKey ? 'pki' : (to === '!ffffffff' ? 'channel-psk' : 'channel-psk(no-pki-key)');
      console.log(`[MeshtasticSerial] Sent message: "${text}" to ${to} (id=${packetId}) reaction=${!!opts.isReaction} replyTo=${opts.replyTo ?? 0} enc=${enc}`);

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

  /**
   * Resend an existing message with a fresh packetId. Used by the auto-retry
   * path on DM timeout / routing TIMEOUT / MAX_RETRANSMIT. The user-facing
   * bubble is reused (same msgId) — only its packetId, status, and timer flip.
   */
  private retrySend(
    localId: string,
    ctx: ResendContext,
    retryCount: number,
  ): void {
    const msg = this.messages.find(m => m.id === localId);
    if (!msg) return;
    // If something else has already concluded this message (manual retry,
    // late-arriving ACK), don't pile on with another packet.
    if (msg.status !== 'sending' && msg.status !== 'sent' && msg.status !== 'error') return;
    if (!this.isLinkOpen()) {
      console.warn(`[MeshtasticSerial] retrySend skipped — link not open (msg=${localId})`);
      return;
    }

    const newPacketId = this.newPacketId();
    console.log(`[MeshtasticSerial] Auto-retry #${retryCount} for msg=${localId} → new pktId=${newPacketId}`);

    const isBroadcast = ctx.to === '!ffffffff';
    const timer = setTimeout(() => {
      const pending = this.pendingAcks.get(newPacketId);
      this.pendingAcks.delete(newPacketId);
      const m = this.messages.find(m => m.id === localId);
      if (!m || (m.status !== 'sending' && m.status !== 'sent')) return;
      if (isBroadcast) return; // broadcast retries don't surface

      const prior = pending?.retryCount ?? retryCount;
      if (prior < MeshtasticSerialBridge.MAX_AUTO_RETRIES && pending?.context) {
        setTimeout(() => this.retrySend(localId, pending.context!, prior + 1), 2_000);
        return;
      }
      m.status = 'error';
      m.errorCode = -1;
      this.persistMessage(m);
      this.emit('ackUpdate', localId, 'error', -1);
      console.warn(`[MeshtasticSerial] DM retry timeout for msg ${localId} pktId=${newPacketId} — giving up after ${prior} retries`);
    }, 30_000);

    this.pendingAcks.set(newPacketId, {
      msgId: localId,
      timer,
      retryCount,
      context: ctx,
    });

    try {
      const packet = this.buildTextPacket(ctx.text, ctx.to, ctx.channel, newPacketId, {
        replyTo: ctx.replyTo,
        isReaction: ctx.isReaction,
        hopLimit: ctx.hopLimit,
        destPublicKey: ctx.destPublicKey,
      });
      this.sendToRadio(packet);
      msg.packetId = newPacketId;
      msg.status = 'sent';
      msg.timestamp = Date.now(); // reset for accurate deliveryMs on retry success
      this.persistMessage(msg);
      this.emit('ackUpdate', localId, 'sent', 0);
    } catch (err: any) {
      clearTimeout(timer);
      this.pendingAcks.delete(newPacketId);
      msg.status = 'error';
      msg.errorCode = -2;
      this.persistMessage(msg);
      this.emit('ackUpdate', localId, 'error', -2);
      console.error(`[MeshtasticSerial] retrySend write failed for ${localId}:`, err?.message);
    }
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
        //   8 = metadata (DeviceMetadata, newer firmware),
        //   10 = channel (Channel), 11 = queue_status (QueueStatus)
        if (fieldNumber === 2) {
          this.handleMeshPacket(subBuf);
        } else if (fieldNumber === 3) {
          this.handleMyInfo(subBuf);
        } else if (fieldNumber === 4) {
          this.handleNodeInfo(subBuf);
        } else if (fieldNumber === 8) {
          this.handleDeviceMetadata(subBuf);
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

  /**
   * Parse a MyNodeInfo submessage. We capture:
   *  - my_node_num   (field 1, varint)         — sets localNodeId / localNodeNum
   *  - firmware_version (field 4, string)      — older firmware reports it here
   *  - reboot_count  (field 8, varint)         — uptime / stability hint
   * Newer firmware moves firmware_version into FromRadio.metadata (DeviceMetadata);
   * we handle that elsewhere. Whichever path arrives first wins.
   */
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
        if (fieldNumber === 1 && value > 0) {
          const id = nodeIdToHex(value);
          if (this.localNodeId !== id) {
            this.localNodeId = id;
            this.localNodeNum = value;
            console.log(`[MeshtasticSerial] Local node identified as ${id}`);

            // Read the local module configs once we know the local node id.
            setTimeout(() => {
              this.requestNeighborInfoConfig().catch(() => { /* best-effort */ });
              this.requestRangeTestConfig().catch(() => { /* best-effort */ });
              this.requestTelemetryConfig().catch(() => { /* best-effort */ });
              this.requestStoreForwardConfig().catch(() => { /* best-effort */ });
              this.requestExternalNotificationConfig().catch(() => { /* best-effort */ });
              this.requestMqttConfig().catch(() => { /* best-effort */ });
              this.requestDetectionSensorConfig().catch(() => { /* best-effort */ });
              this.requestAudioConfig().catch(() => { /* best-effort */ });
            }, 500);
          }
        } else if (fieldNumber === 8) {
          this.localRebootCount = value;
        }
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const slice = buf.subarray(offset, offset + len);
        offset += len;
        if (fieldNumber === 4) {
          // MyNodeInfo.firmware_version (older firmware path)
          const fw = slice.toString('utf-8').trim();
          if (fw && this.localFirmwareVersion !== fw) {
            this.localFirmwareVersion = fw;
            console.log(`[MeshtasticSerial] Firmware version: ${fw}`);
          }
        }
      } else {
        break;
      }
    }
  }

  /**
   * Parse a DeviceMetadata submessage. Fields per mesh.proto:
   *   1 = firmware_version (string)
   *   2 = device_state_version (uint32)
   *   3 = canShutdown (bool)
   *   4 = role (Role enum)
   *   5 = position_flags (uint32)
   *   6 = hw_model (HardwareModel enum)
   *   7 = has_remote_hardware (bool)
   * Newer firmware advertises this via FromRadio.metadata (field 8).
   */
  private handleDeviceMetadata(buf: Buffer) {
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const slice = buf.subarray(offset, offset + len);
        offset += len;
        if (fieldNumber === 1) {
          const fw = slice.toString('utf-8').trim();
          if (fw && this.localFirmwareVersion !== fw) {
            this.localFirmwareVersion = fw;
            console.log(`[MeshtasticSerial] Firmware version (DeviceMetadata): ${fw}`);
          }
        }
      } else if (wireType === 0) {
        const { bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
      } else if (wireType === 5) {
        offset += 4;
      } else { break; }
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
    let positionPrecision: number | undefined;

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
          else if (fn === 7) {
            // ModuleSettings sub-message — currently we only read position_precision (field 1).
            let mo = 0;
            while (mo < sub.length) {
              const mTag = sub[mo++];
              const mFn = mTag >> 3;
              const mWt = mTag & 0x07;
              if (mWt === 0) {
                const { value: mVal, bytesRead: mBR } = this.readVarint(sub, mo);
                mo += mBR;
                if (mFn === 1) positionPrecision = mVal;
              } else if (mWt === 2) {
                const { value: mLen, bytesRead: mBR } = this.readVarint(sub, mo);
                mo += mBR + mLen;
              } else if (mWt === 5) {
                mo += 4;
              } else { break; }
            }
          }
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
      positionPrecision,
    };
    this.channels.set(index, ch);
    try { this.db.upsertChannel(ch); } catch (e: any) {
      console.error('[MeshtasticSerial] channel persist failed:', e.message);
    }
    this.emit('channelUpdate', ch);
  }

  /** Parse a NodeInfo submessage */
  private handleNodeInfo(buf: Buffer) {
    // NodeInfo (mesh.proto):
    //   1 num (varint)             — node number
    //   2 user (submessage)        — User { long_name, short_name, public_key, hw_model, ... }
    //   3 position (submessage)
    //   4 snr (float)
    //   5 last_heard (fixed32)
    //   6 device_metrics (submessage)
    //   7 channel (varint)
    //   8 via_mqtt (bool)
    //   9 hops_away (varint, optional uint32) — distance in hops
    //  10 is_favorite (bool)
    let nodeNum = 0;
    let longName = '';
    let shortName = '';
    let publicKey: string | undefined;
    let hwModel: number | undefined;
    let isLicensed: boolean | undefined;
    let role: number | undefined;
    let hopsAway: number | undefined;
    let positionBuf: Buffer | null = null;
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
        else if (fieldNumber === 9) hopsAway = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const subBuf = buf.subarray(offset, offset + len);
        offset += len;

        if (fieldNumber === 2) {
          // User submessage — extract names, public key, role, hardware, licensed
          const user = this.parseUser(subBuf);
          longName = user.longName;
          shortName = user.shortName;
          publicKey = user.publicKey;
          hwModel = user.hwModel;
          isLicensed = user.isLicensed;
          role = user.role;
        } else if (fieldNumber === 3) {
          // Position submessage — captured here, applied AFTER upsertNode below
          // so the node exists when applyPositionToNode looks it up.
          positionBuf = subBuf;
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
        // Same logic for the new identity fields — only overwrite when present.
        ...(hwModel !== undefined ? { hwModel } : {}),
        ...(isLicensed !== undefined ? { isLicensed } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(hopsAway !== undefined ? { hopsAway } : {}),
      };
      node.lastSeen = Date.now();
      const wasOnline = !!existing?.online;
      node.online = true;

      const isNew = !this.nodes.has(nodeId);
      const hadKey = !!existing?.publicKey;
      this.upsertNode(node);

      // Position submessage handling. We capture this from NodeInfo as well as
      // from standalone POSITION_APP packets — without it, the map would only
      // populate when nodes happen to broadcast a fresh Position packet, which
      // many firmware variants do infrequently. NodeInfo arrives reliably on
      // every want_config_id (e.g. after a container restart), so picking
      // position up here means the map repopulates within seconds of reconnect
      // instead of waiting for the next per-node position broadcast.
      if (positionBuf) {
        const pos = this.parsePositionSubmessage(positionBuf);
        if (pos) this.applyPositionToNode(nodeId, pos, 'nodeinfo');
      }

      // Record online transition for uptime tracking. Skip for the local node
      // (it's always online by definition while the serial port is open).
      // openNodeSession is a no-op if a session is already open for this node,
      // so duplicate NodeInfo arrivals during a continuous online window are safe.
      if (nodeId !== this.localNodeId && (!wasOnline || isNew)) {
        try { this.db.openNodeSession(nodeId, Date.now()); }
        catch (e: any) { console.error('[MeshtasticSerial] openNodeSession failed:', e.message); }
      }

      if (isNew) {
        this.addEvent('NODE_JOINED', nodeId, `${node.name} discovered on mesh`);
      }
      if (publicKey && !hadKey) {
        console.log(`[MeshtasticSerial] PKC public key learned for ${nodeId} (${node.name})`);
      }

      this.emit('nodeUpdate', node);
    }
  }

  private parseUser(buf: Buffer): {
    longName: string;
    shortName: string;
    publicKey?: string;
    hwModel?: number;
    isLicensed?: boolean;
    role?: number;
  } {
    let longName = '';
    let shortName = '';
    let publicKey: string | undefined;
    let hwModel: number | undefined;
    let isLicensed: boolean | undefined;
    let role: number | undefined;
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
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 5) hwModel = value;          // HardwareModel enum
        else if (fieldNumber === 6) isLicensed = value !== 0;
        else if (fieldNumber === 7) role = value;        // Role enum
      } else {
        break;
      }
    }

    return { longName, shortName, publicKey, hwModel, isLicensed, role };
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
    let viaMqtt = false;
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
        else if (fieldNumber === 14) viaMqtt = value !== 0; // MeshPacket.via_mqtt — MQTT-bridged packet
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
      const now = Date.now();
      this.upsertNode({
        id: fromId,
        name: fromId,
        shortName: fromId.slice(-4),
        firstSeen: now,
        lastSeen: now,
        online: true,
        favorite: false,
      });
      this.addEvent('NODE_JOINED', fromId, `New node ${fromId} seen on mesh`);
    }

    // Update sender's lastSeen + SNR/RSSI + transport observation.
    const senderNode = this.nodes.get(fromId);
    if (senderNode) {
      senderNode.lastSeen = Date.now();
      senderNode.online = true;
      senderNode.lastVia = viaMqtt ? 'mqtt' : 'lora';
      // MQTT-bridged packets don't carry meaningful RX SNR/RSSI — they were
      // received over IP, not LoRa. Don't overwrite a previous LoRa observation
      // with synthetic zeros from an MQTT relay.
      if (!viaMqtt && (rxSnr || rxRssi)) {
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
        // Real peer/relay ACKs carry the original packet id in Data.request_id.
        // Local self-ACK frames the firmware emits for our own broadcasts have
        // request_id=0 and a fresh MeshPacket.id of their own — those can't be
        // correlated to a pending send and should be ignored (don't fall back
        // to incomingPacketId, which only spams "no match" lines).
        if (requestId) {
          // iOS treats packet.to != packet.from as the marker for a "real" peer
          // ACK vs. a self-ACK the firmware echoes for our own transmissions.
          // We pass both so the handler can log accordingly.
          const isRealAck = fromId !== toId;
          this.handleRoutingPacket(requestId, payloadBuf, isRealAck, fromId);
        }
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
      case PORT_ADMIN_APP:
        // Local admin replies (e.g. get_module_config_response) — populate
        // the authoritative module-config snapshot so the UI can display it
        // instead of relying on inferred state.
        this.handleAdminResponse(fromId, payloadBuf);
        break;
      case PORT_RANGE_TEST_APP: {
        // RangeTest packets are typically text payloads ("seq 12345") used to
        // probe coverage. Log as an event for the live stream AND persist a
        // coverage observation (sender + their last-known position + RX signal).
        const text = payloadBuf.toString('utf-8').slice(0, 60);
        const seqMatch = /seq\s+(\d+)/i.exec(text);
        const seq = seqMatch ? Number(seqMatch[1]) : null;
        const snrDb = rxSnr ? rxSnr / 4 : null;
        const rssiDbm = rxRssi ? -rxRssi : null;
        const rxLabel = rssiDbm != null || snrDb != null
          ? ` (snr=${(snrDb ?? 0).toFixed(1)}dB rssi=${rssiDbm ?? '?'}dBm)`
          : '';
        this.addEvent('TELEMETRY', fromId, `Range test ${text}${rxLabel}`);

        const senderNode = this.nodes.get(fromId);
        try {
          this.db.insertRangeTestObservation({
            senderId: fromId,
            senderLat: senderNode?.position?.lat ?? null,
            senderLng: senderNode?.position?.lng ?? null,
            seq,
            snr: snrDb,
            rssi: rssiDbm,
            text,
            timestamp: Date.now(),
          });
        } catch (e: any) {
          console.error('[MeshtasticSerial] range test obs persist failed:', e.message);
        }
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
      const packetId = this.newPacketId();
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
      const packetId = this.newPacketId();
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
    const packetId = this.newPacketId();

    const trace: MeshTraceResult = {
      id: requestId,
      targetId,
      startedAt: Date.now(),
      status: 'pending',
      route: [],
      routeBack: [],
    };
    this.traces.set(requestId, trace);
    this.persistTrace(trace);

    const timer = setTimeout(() => {
      const t = this.traces.get(requestId);
      if (!t || t.status !== 'pending') return;
      t.status = 'timeout';
      t.completedAt = Date.now();
      t.errorMessage = `No response within ${Math.round(timeoutMs / 1000)}s`;
      this.pendingTraces.delete(packetId);
      console.log(`[MeshtasticSerial] TRACE timeout for ${targetId} (req=${requestId})`);
      this.persistTrace(t);
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
      this.persistTrace(trace);
      this.emit('traceUpdate', { ...trace });
      throw err;
    }
  }

  /** Persist a trace result to SQLite so traces survive server restart. */
  private persistTrace(trace: MeshTraceResult) {
    try { this.db.upsertTraceResult(trace); }
    catch (err: any) { console.error('[MeshtasticSerial] persistTrace failed:', err.message); }
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
    this.persistTrace(trace);
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
        const now = Date.now();
        this.upsertNode({
          id,
          name: id,
          shortName: id.slice(-4),
          firstSeen: now,
          lastSeen: now,
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
    const packetId = this.newPacketId();

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
    bitfield: number;
  } {
    let portNum = 0;
    let payload: Buffer | null = null;
    let requestId = 0;
    let replyId = 0;
    let emoji = 0;
    let bitfield = 0;
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
        // Older firmware emitted request_id / emoji as varints. The canonical
        // mesh.proto declares both as fixed32 (handled in the wireType===5
        // branch below). Accept either form so we work across firmware ages.
        else if (fieldNumber === 6) requestId = value;
        else if (fieldNumber === 8) emoji = value;
        // Data.bitfield (field 9, optional uint32) — bit 0 is `ok_to_mqtt`,
        // the operator's "yes please bridge this to the public MQTT broker"
        // marker. Newer firmware uses this to enforce per-message MQTT opt-in
        // independent of the channel's downlink setting. We surface it
        // unparsed for now; specific bit interpretation lives at the call site.
        else if (fieldNumber === 9) bitfield = value;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 2) payload = buf.subarray(offset, offset + len); // payload
        offset += len;
      } else if (wireType === 5) {
        // fixed32 — current proto: request_id=6, reply_id=7, emoji=8.
        // Until this branch existed for field 6, real peer ACKs (which carry
        // request_id as fixed32) were silently dropped and every DM timed out.
        if (offset + 4 > buf.length) break;
        const v = buf.readUInt32LE(offset);
        offset += 4;
        if (fieldNumber === 6) requestId = v;
        else if (fieldNumber === 7) replyId = v;
        else if (fieldNumber === 8) emoji = v;
      } else {
        break;
      }
    }

    if (portNum === PORT_ROUTING || requestId || replyId || emoji || bitfield) {
      const okToMqtt = (bitfield & 0x1) !== 0;
      console.log(`[MeshtasticSerial] Data: portNum=${portNum} requestId=${requestId} replyId=${replyId} emoji=${emoji} bitfield=${bitfield}${okToMqtt ? ' (ok_to_mqtt)' : ''} payloadLen=${payload?.length ?? 0}`);
    }

    return { portNum, payload, requestId, replyId, emoji, bitfield };
  }

  /**
   * Handle a ROUTING_APP packet — these carry ACK/NAK for messages sent with want_ack=true.
   *
   * @param isRealAck  iOS's heuristic: when packet.to != packet.from, the ACK
   *                   came from a remote peer/relay rather than the local
   *                   firmware echoing its own queue confirmation. Useful in
   *                   logs and analytics to distinguish "the mesh actually
   *                   delivered this" from "our local radio accepted it".
   * @param fromId     The hex id of the node that sent the ACK (the local node
   *                   for self-ACKs, the remote peer for real ACKs).
   */
  private handleRoutingPacket(requestId: number, payload: Buffer | null, isRealAck = false, fromId = '') {
    console.log(`[MeshtasticSerial] ROUTING pkt requestId=${requestId} from=${fromId || '?'} realAck=${isRealAck} pendingKeys=[${[...this.pendingAcks.keys()].join(',')}]`);
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

    // Errors 3 (TIMEOUT) and 5 (MAX_RETRANSMIT) are transient — the firmware
    // already gave up internally, but the mesh might just have been busy. iOS
    // retransmits one more time before surfacing the failure.
    //
    // Error 38 (RATE_LIMIT_EXCEEDED) is the local firmware's anti-flooding
    // gate — too many sends to the same destination in a short window. The
    // limit clears in seconds, so retrying with a longer backoff usually
    // works. Particularly important for chatty BBS exchanges where multiple
    // replies fire to the same peer within a single conversation.
    //
    // Skip the retry path if we've already burned our one retry.
    const isTransientRouting = errorCode === 3 || errorCode === 5;
    const isRateLimited = errorCode === 38;
    const isRetryable = isTransientRouting || isRateLimited;
    if (isRetryable && pending.retryCount < MeshtasticSerialBridge.MAX_AUTO_RETRIES && pending.context) {
      // Rate-limit windows are typically 5-15s; back off longer than for
      // routing errors so the retry doesn't just trip the limiter again.
      const backoffMs = isRateLimited ? 10_000 : 2_000;
      console.log(`[MeshtasticSerial] Routing error ${errorCode} for msg=${pending.msgId} — auto-retrying in ${backoffMs / 1000}s (attempt ${pending.retryCount + 1}/${MeshtasticSerialBridge.MAX_AUTO_RETRIES})`);
      const ctx = pending.context;
      const nextRetry = pending.retryCount + 1;
      setTimeout(() => this.retrySend(pending.msgId, ctx, nextRetry), backoffMs);
      return;
    }

    const status: MeshMessage['status'] = errorCode === 0 ? 'acked' : 'error';
    const msg = this.messages.find(m => m.id === pending.msgId);
    if (msg) {
      msg.status = status;
      msg.errorCode = errorCode;
      // Only stamp deliveryMs on success — failed messages don't represent
      // a meaningful round-trip latency.
      if (status === 'acked') msg.deliveryMs = Math.max(0, Date.now() - msg.timestamp);
      this.persistMessage(msg);
    }
    this.emit('ackUpdate', pending.msgId, status, errorCode);
    console.log(`[MeshtasticSerial] ACK resolved: msg=${pending.msgId} status=${status} err=${errorCode} ${isRealAck ? '(REAL peer ACK from ' + fromId + ')' : '(self-ACK from local radio)'}${isRetryable && pending.retryCount > 0 ? ' [after ' + pending.retryCount + ' retries]' : ''}`);
  }

  /**
   * FromRadio.queue_status (field 11) — QueueStatus { res=1, free=2, maxlen=3, mesh_packet_id=4 }
   * The firmware sends this when it accepts a packet into the TX queue.
   *   res=0 + matching mesh_packet_id  → message marked 'queued'
   *   res!=0                           → message marked 'error' (e.g. queue full)
   *
   * Important: 'queued' is NOT a delivery confirmation. The Meshtastic-Apple
   * app explicitly treats QueueStatus as a heartbeat, not an ACK. We keep it
   * as a positive intermediate state because broadcasts never reach 'acked'
   * (no over-the-air ACKs by design), so for broadcasts 'queued' is the
   * terminal happy path. For DMs we still wait for a real peer routing reply
   * (`Routing.error_reason=NONE`) to graduate to 'acked'.
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

    // res=0 → radio accepted the packet for TX.
    //
    // For DMs we keep the pending-acks timer running so a real peer routing
    // reply can still graduate the message to 'acked' (or a NAK can flip it
    // to 'error'). For broadcasts there's no further signal coming, so we
    // can clear the timer here.
    const pending = this.pendingAcks.get(meshPacketId);
    if (pending) {
      const msg = this.messages.find(m => m.id === pending.msgId);
      const isBroadcast = msg?.to === '!ffffffff';

      if (msg) {
        msg.status = 'queued';
        msg.deliveryMs = Math.max(0, Date.now() - msg.timestamp);
        this.persistMessage(msg);
      }
      this.emit('ackUpdate', pending.msgId, 'queued', 0);

      if (isBroadcast) {
        // Broadcasts never get a real ACK — clear the timer now so we don't
        // log a spurious "no QueueStatus for broadcast" line at the 30s mark.
        clearTimeout(pending.timer);
        this.pendingAcks.delete(meshPacketId);
      }
      console.log(`[MeshtasticSerial] QueueStatus queued ${pending.msgId} (pktId=${meshPacketId})${isBroadcast ? ' [broadcast — terminal]' : ' [DM — waiting for peer ACK]'}`);
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
          existing.deliveryMs = Math.max(0, Date.now() - existing.timestamp);
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
          existing.deliveryMs = Math.max(0, Date.now() - existing.timestamp);
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

    // BBS-Mail interception. Direct messages to our local node that either
    // start with the ":mail" trigger OR continue an active state machine are
    // consumed by the BBS module and NOT persisted as normal chat traffic.
    // We pass the inbound channelIndex through so the reply rides the same
    // channel (and therefore the same PSK) — required for the recipient to
    // be able to decrypt our response. Reactions ride through unchanged;
    // broadcasts are never BBS.
    if (
      !isReaction &&
      toId === this.localNodeId &&
      this.bbs &&
      this.bbs.isCommand(text, fromId)
    ) {
      console.log(`[MeshtasticSerial] BBS intercept: from=${fromId} ch=${channelIndex} text="${text.substring(0, 40)}"`);
      this.bbs.handleInboundDm(fromId, text, channelIndex).catch(err =>
        console.error('[MeshtasticSerial] BBS handler failed:', err?.message)
      );
      return;
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

  /**
   * Parse a Position submessage (mesh.proto):
   *   1  latitude_i      (sfixed32, scale 1e-7)
   *   2  longitude_i     (sfixed32, scale 1e-7)
   *   3  altitude        (int32 metres)
   *   14 location_source (varint enum: 0=UNSET, 1=MANUAL, 2=INTERNAL/GPS, 3=EXTERNAL)
   *   16 precision_bits  (uint32) — channel-imposed location precision
   *
   * Used from two places: the POSITION_APP port handler AND the NodeInfo
   * dispatcher, since NodeInfo embeds the node's last-known position as
   * field 3 (a Position submessage). Parsing position from NodeInfo is
   * critical for keeping the map populated across container restarts —
   * radios re-emit their NodeDB via want_config_id on connect, but they
   * generally do NOT re-emit a fresh POSITION_APP packet for every node.
   *
   * Returns null when no usable lat/lng was found.
   */
  private parsePositionSubmessage(payload: Buffer): {
    lat: number; lng: number; alt: number;
    locationSource: number; precisionBits: number;
  } | null {
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

    if (lat === 0 && lng === 0) return null;
    return { lat, lng, alt, locationSource, precisionBits };
  }

  /** Apply a parsed position to an existing node (in-memory + DB). Centralized
   *  so POSITION_APP and NodeInfo paths set the same fields the same way. */
  private applyPositionToNode(
    nodeId: string,
    pos: { lat: number; lng: number; alt: number; locationSource: number; precisionBits: number },
    eventSource: 'position-packet' | 'nodeinfo',
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.position = { lat: pos.lat, lng: pos.lng, alt: pos.alt };
    if (pos.locationSource === 1) node.positionSource = 'manual';
    else if (pos.locationSource === 2 || pos.locationSource === 3) node.positionSource = 'gps';
    if (pos.precisionBits > 0) node.positionPrecisionBits = pos.precisionBits;
    node.lastSeen = Date.now();
    this.upsertNode(node);

    // Append to per-node position history so the iOS-style Position Log can
    // show a track over time. We dedupe lightly: if the new lat/lng match the
    // most recent stored row exactly, skip (NodeInfo re-emits otherwise spam
    // the table with no-change rows on every want_config_id).
    try {
      const lastTwo = this.db.loadPositionHistory(nodeId, 1);
      const prev = lastTwo[0];
      const unchanged = prev
        && Math.abs(prev.lat - pos.lat) < 1e-6
        && Math.abs(prev.lng - pos.lng) < 1e-6;
      if (!unchanged) {
        this.db.insertPositionHistory({
          nodeId,
          timestamp: Date.now(),
          lat: pos.lat,
          lng: pos.lng,
          alt: pos.alt || null,
          source: node.positionSource ?? null,
          precisionBits: pos.precisionBits || null,
        });
      }
    } catch (err: any) {
      console.error('[MeshtasticSerial] position history insert failed:', err.message);
    }

    if (eventSource === 'position-packet') {
      const sourceLabel = node.positionSource === 'manual'
        ? ' [fixed]'
        : node.positionSource === 'gps' ? ' [gps]' : '';
      this.addEvent('POSITION_UPDATE', nodeId, `${node.name} position: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}${sourceLabel}`);
    }
    // NodeInfo-embedded position arrivals are silent in the event log — they
    // fire on every NodeDB re-emit and would flood it — but they DO populate
    // the position_history table so the per-node log captures them.
  }

  private handlePosition(nodeId: string, payload: Buffer) {
    const pos = this.parsePositionSubmessage(payload);
    if (pos) this.applyPositionToNode(nodeId, pos, 'position-packet');
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
        // Close the session for uptime tracking. Use lastSeen as the close
        // time — it's a more accurate "when did the node actually go away"
        // than `now` (which is up to staleThresholdMs late).
        try { this.db.closeNodeSession(id, node.lastSeen); }
        catch (e: any) { console.error('[MeshtasticSerial] closeNodeSession failed:', e.message); }
      }
    }
  }

  /**
   * Public re-issue of `want_config_id`. Triggers the radio to re-emit its
   * full node DB, channel set, and module configs. Use when a phone/BLE client
   * has changed config out-of-band and the UI is showing stale node liveness
   * or channel indices.
   */
  refreshNodeDb(): void {
    if (!this.isLinkOpen()) {
      throw new Error('Radio not connected');
    }
    console.log('[MeshtasticSerial] Manual refreshNodeDb requested');
    this.requestConfig();
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
    opts: {
      replyTo?: number;
      isReaction?: boolean;
      hopLimit?: number;
      /** Base64-encoded recipient public key (32 bytes Curve25519). When set on
       *  a DM, the firmware encrypts the payload per-recipient via PKI instead
       *  of the channel PSK. Ignored for broadcasts. */
      destPublicKey?: string;
    } = {},
  ): Buffer {
    // Builds a ToRadio { packet: MeshPacket } frame using current Meshtastic protobuf field numbers.
    // Field layout (mesh.proto):
    //   MeshPacket: from=1(varint, optional), to=2(fixed32), channel=3(varint),
    //               decoded=4(submsg), id=6(fixed32), hop_limit=9(varint),
    //               want_ack=10(bool), pki_encrypted=16(bool), public_key=17(bytes)
    //   Data:       portnum=1(varint), payload=2(bytes), request_id=6(fixed32),
    //               reply_id=7(fixed32), emoji=8(fixed32), bitfield=9(varint)
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

    // PKI encryption is only meaningful for unicast DMs where we have the
    // recipient's published Curve25519 public key (from their NodeInfo.User).
    // For broadcasts the firmware always uses the channel PSK regardless.
    const isBroadcast = toNum === 0xffffffff;
    const pkiKeyBuf = (!isBroadcast && opts.destPublicKey)
      ? Buffer.from(opts.destPublicKey, 'base64')
      : null;
    const usePki = pkiKeyBuf !== null && pkiKeyBuf.length === 32;

    const meshPacketParts: Buffer[] = [];
    // MeshPacket.from (field 1, fixed32). Optional when talking to the
    // firmware over USB/TCP — the radio fills in the local node id if absent.
    // Setting it explicitly matches iOS behavior and is forward-compatible
    // with a future BLE transport where we'd be talking directly to a phone
    // peer rather than a radio that knows who we are.
    if (this.localNodeNum) {
      meshPacketParts.push(this.encodeTagFixed32(1, this.localNodeNum));
    }
    meshPacketParts.push(
      this.encodeTagFixed32(2, toNum),                                     // field 2 = to
      this.encodeTagVarint(3, channel),                                    // field 3 = channel index
      Buffer.from([(4 << 3) | 2, ...this.encodeVarint(dataMsg.length)]),   // field 4 = decoded (len-delim)
      dataMsg,
      this.encodeTagFixed32(6, packetId),                                  // field 6 = id
    );
    // Only emit hop_limit when the caller provided a non-default value. The
    // firmware fills in its operator-configured default (lora_config.hop_limit)
    // when this field is absent, which is what we want for routine sends —
    // emitting an explicit value here lets us escalate when a DM destination's
    // hops_away exceeds the mesh default.
    if (typeof opts.hopLimit === 'number' && opts.hopLimit > 0) {
      meshPacketParts.push(this.encodeTagVarint(9, Math.min(7, opts.hopLimit)));
    }
    meshPacketParts.push(this.encodeTagBool(10, true));                    // field 10 = want_ack

    if (usePki && pkiKeyBuf) {
      meshPacketParts.push(this.encodeTagBool(16, true));                  // field 16 = pki_encrypted
      meshPacketParts.push(this.encodeTagLen(17, pkiKeyBuf));               // field 17 = public_key
    }

    const meshPacket = Buffer.concat(meshPacketParts);

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
    // Only emit ModuleSettings (field 7) when the operator has set a precision —
    // sending an empty submessage would clobber any unmodelled fields the firmware
    // already has set (e.g. is_client_muted).
    if (typeof ch.positionPrecision === 'number') {
      const moduleSettings = this.encodeTagVarint(1, Math.max(0, Math.min(32, Math.floor(ch.positionPrecision))));
      settingsParts.push(this.encodeTagLen(7, moduleSettings));  // module_settings
    }
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

    // Optimistic local update: assume the radio accepted what we just sent.
    // This gives the UI a baseline immediately so subsequent dirty checks work
    // even if the firmware doesn't reply with a readback (some firmware
    // versions ignore admin readbacks unless session-pass-key is configured).
    // The actual readback (if it arrives) will overwrite this with authoritative state.
    this.localModuleConfig.neighborInfo = {
      enabled: opts.enabled,
      updateIntervalSecs: intervalSecs,
      transmitOverLora,
      lastReadAt: Date.now(),
    };
    this.updateLocalModuleConfig();

    // Still try to read the config back. If the firmware does respond, the
    // optimistic state above gets overwritten with the real values.
    setTimeout(() => { this.requestNeighborInfoConfig().catch(() => { /* best-effort */ }); }, 250);
  }

  // ---- Module config readback (admin → local radio, no LoRa cost) -------

  /** ModuleConfigType enum value for NeighborInfo (mesh.proto). */
  private static readonly MODULE_CFG_NEIGHBORINFO = 9;
  /** ModuleConfigType enum value for Range Test (mesh.proto). */
  private static readonly MODULE_CFG_RANGE_TEST = 4;
  /** ModuleConfigType enum value for Telemetry (mesh.proto). */
  private static readonly MODULE_CFG_TELEMETRY = 5;
  /** ModuleConfigType enum value for Store & Forward (mesh.proto). */
  private static readonly MODULE_CFG_STORE_FORWARD = 3;
  /** ModuleConfigType enum value for External Notification (mesh.proto). */
  private static readonly MODULE_CFG_EXTERNAL_NOTIFICATION = 2;
  /** ModuleConfigType enum value for MQTT (mesh.proto). */
  private static readonly MODULE_CFG_MQTT = 0;
  /** ModuleConfigType enum value for Detection Sensor (mesh.proto). */
  private static readonly MODULE_CFG_DETECTION_SENSOR = 11;
  /** ModuleConfigType enum value for Audio (mesh.proto). */
  private static readonly MODULE_CFG_AUDIO = 7;

  /**
   * Ask the local radio for its current NeighborInfo module config. The reply
   * arrives asynchronously as a PORT_ADMIN_APP packet and populates
   * `localModuleConfig.neighborInfo`. Local admin only — does NOT touch the mesh.
   */
  async requestNeighborInfoConfig(): Promise<void> {
    if (!this.isLinkOpen()) return;
    if (!this.localNodeNum) return;

    // AdminMessage { get_module_config_request: ModuleConfigType (varint, field 3) }
    const adminPayload = this.encodeTagVarint(3, MeshtasticSerialBridge.MODULE_CFG_NEIGHBORINFO);
    this.sendAdminMessage(adminPayload);
    console.log('[MeshtasticSerial] Requested NeighborInfo module config readback');
  }

  // ---- Range Test module --------------------------------------------------

  /**
   * Build AdminMessage { set_module_config: ModuleConfig { range_test: ... } }.
   * Field numbers per mesh.proto:
   *   ModuleConfig.range_test = 5 (length-delim RangeTestConfig)
   *   RangeTestConfig: 1=enabled (bool), 2=sender (uint32 secs), 3=save (bool)
   * sender=0 with enabled=true = receive-only; sender>0 = transmit at that cadence.
   */
  private buildAdminSetRangeTestConfig(opts: {
    enabled: boolean;
    senderIntervalSecs: number;
    save: boolean;
  }): Buffer {
    const rtCfg = Buffer.concat([
      this.encodeTagBool(1, opts.enabled),
      this.encodeTagVarint(2, Math.max(0, Math.floor(opts.senderIntervalSecs))),
      this.encodeTagBool(3, opts.save),
    ]);
    const moduleConfig = this.encodeTagLen(5, rtCfg);    // ModuleConfig.range_test
    return this.encodeTagLen(34, moduleConfig);          // AdminMessage.set_module_config
  }

  /**
   * Public: configure the Range Test module on the local radio. The Range Test
   * sender broadcasts numbered "seq N" packets every `senderIntervalSecs`, and
   * other meshmates log them — the SNR/RSSI of those receptions is how operators
   * map mesh coverage. Receive-only mode (senderIntervalSecs=0) is the polite
   * default; configure a positive interval only when actively running a test.
   */
  async setRangeTestConfig(opts: {
    enabled: boolean;
    senderIntervalSecs?: number;
    save?: boolean;
  }): Promise<void> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified — try again in a moment');

    const senderIntervalSecs = opts.senderIntervalSecs ?? 0;
    const save = opts.save ?? false;

    this.sendAdminMessage(this.buildAdminSetRangeTestConfig({
      enabled: opts.enabled,
      senderIntervalSecs,
      save,
    }));
    await new Promise(r => setTimeout(r, 80));
    this.sendAdminMessage(this.buildAdminCommit());

    const senderText = senderIntervalSecs > 0 ? `every ${senderIntervalSecs}s` : 'receive-only';
    console.log(`[MeshtasticSerial] Range Test module ${opts.enabled ? 'ENABLED' : 'DISABLED'} (${senderText}, save=${save})`);
    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `Range Test module ${opts.enabled ? `enabled (${senderText})` : 'disabled'}`);

    // Optimistic local update — same pattern as NeighborInfo. Some firmware
    // builds don't reply to the readback, so this guarantees the UI has a
    // baseline; the actual readback (if any) overwrites with authoritative state.
    this.localModuleConfig.rangeTest = {
      enabled: opts.enabled,
      senderIntervalSecs,
      save,
      lastReadAt: Date.now(),
    };
    this.updateLocalModuleConfig();

    setTimeout(() => { this.requestRangeTestConfig().catch(() => { /* best-effort */ }); }, 250);
  }

  async requestRangeTestConfig(): Promise<void> {
    if (!this.isLinkOpen()) return;
    if (!this.localNodeNum) return;
    const adminPayload = this.encodeTagVarint(3, MeshtasticSerialBridge.MODULE_CFG_RANGE_TEST);
    this.sendAdminMessage(adminPayload);
    console.log('[MeshtasticSerial] Requested Range Test module config readback');
  }

  /**
   * Start a timed Range Test sender survey. Captures the current Range Test
   * config (so we can restore it cleanly), then enables the sender at the
   * requested interval for `durationMinutes` minutes. When the timer fires
   * the original config is re-applied. Returns the epoch ms at which the
   * survey will auto-restore.
   *
   * If a survey is already running we cancel it first; the new survey overrides.
   */
  async startRangeTestSurvey(opts: { durationMinutes: number; senderIntervalSecs: number }): Promise<{ expiresAt: number }> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified');
    const dur = Math.max(1, Math.min(120, Math.floor(opts.durationMinutes)));
    const sender = Math.max(15, Math.min(3600, Math.floor(opts.senderIntervalSecs)));

    if (this.rangeTestSurveyTimer) {
      clearTimeout(this.rangeTestSurveyTimer);
      this.rangeTestSurveyTimer = null;
    }
    // Capture the current config (or sane defaults if we don't have a readback)
    const current = this.localModuleConfig.rangeTest;
    if (current && !this.rangeTestSurveyOriginal) {
      // Only capture once per active survey — re-arming shouldn't overwrite the
      // captured baseline with the survey-fast config.
      this.rangeTestSurveyOriginal = {
        enabled: current.enabled,
        senderIntervalSecs: current.senderIntervalSecs,
        save: current.save,
      };
    } else if (!current && !this.rangeTestSurveyOriginal) {
      this.rangeTestSurveyOriginal = { enabled: false, senderIntervalSecs: 0, save: false };
    }

    await this.setRangeTestConfig({ enabled: true, senderIntervalSecs: sender, save: current?.save ?? false });

    const expiresAt = Date.now() + dur * 60_000;
    this.rangeTestSurveyExpiresAt = expiresAt;

    this.rangeTestSurveyTimer = setTimeout(() => {
      void (async () => {
        try {
          const restore = this.rangeTestSurveyOriginal;
          if (restore) {
            await this.setRangeTestConfig(restore);
          }
          console.log('[MeshtasticSerial] Range Test survey ended — restored prior config');
        } catch (err: any) {
          console.error('[MeshtasticSerial] Range Test survey restore failed:', err.message);
        } finally {
          this.rangeTestSurveyTimer = null;
          this.rangeTestSurveyExpiresAt = null;
          this.rangeTestSurveyOriginal = null;
          this.updateLocalModuleConfig();
        }
      })();
    }, dur * 60_000);

    console.log(`[MeshtasticSerial] Range Test survey started — sender every ${sender}s for ${dur}min, restores at ${new Date(expiresAt).toISOString()}`);
    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `Range Test survey: ${sender}s cadence for ${dur}min`);
    this.updateLocalModuleConfig();
    return { expiresAt };
  }

  async cancelRangeTestSurvey(): Promise<void> {
    if (!this.rangeTestSurveyTimer) return;
    clearTimeout(this.rangeTestSurveyTimer);
    this.rangeTestSurveyTimer = null;
    const restore = this.rangeTestSurveyOriginal;
    this.rangeTestSurveyExpiresAt = null;
    this.rangeTestSurveyOriginal = null;
    if (restore) {
      try {
        await this.setRangeTestConfig(restore);
        console.log('[MeshtasticSerial] Range Test survey cancelled — restored prior config');
      } catch (err: any) {
        console.error('[MeshtasticSerial] Range Test survey cancel-restore failed:', err.message);
      }
    }
    this.updateLocalModuleConfig();
  }

  getRangeTestSurveyExpiresAt(): number | null {
    return this.rangeTestSurveyExpiresAt;
  }

  /**
   * NeighborInfo equivalent — shorten the broadcast interval for `durationMinutes`
   * to map topology faster during a deployment, then restore. Same capture +
   * restore semantics as the Range Test survey.
   */
  async startNeighborInfoSurvey(opts: { durationMinutes: number; intervalSecs: number }): Promise<{ expiresAt: number }> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified');
    const dur = Math.max(1, Math.min(120, Math.floor(opts.durationMinutes)));
    const interval = Math.max(60, Math.min(14400, Math.floor(opts.intervalSecs)));

    if (this.neighborInfoSurveyTimer) {
      clearTimeout(this.neighborInfoSurveyTimer);
      this.neighborInfoSurveyTimer = null;
    }

    const current = this.localModuleConfig.neighborInfo;
    if (current && !this.neighborInfoSurveyOriginal) {
      this.neighborInfoSurveyOriginal = {
        enabled: current.enabled,
        updateIntervalSecs: current.updateIntervalSecs,
        transmitOverLora: current.transmitOverLora,
      };
    } else if (!current && !this.neighborInfoSurveyOriginal) {
      this.neighborInfoSurveyOriginal = { enabled: false, updateIntervalSecs: 14400, transmitOverLora: true };
    }

    await this.setNeighborInfoConfig({
      enabled: true,
      intervalSecs: interval,
      transmitOverLora: current?.transmitOverLora ?? true,
    });

    const expiresAt = Date.now() + dur * 60_000;
    this.neighborInfoSurveyExpiresAt = expiresAt;

    this.neighborInfoSurveyTimer = setTimeout(() => {
      void (async () => {
        try {
          const restore = this.neighborInfoSurveyOriginal;
          if (restore) {
            await this.setNeighborInfoConfig({
              enabled: restore.enabled,
              intervalSecs: restore.updateIntervalSecs,
              transmitOverLora: restore.transmitOverLora,
            });
          }
          console.log('[MeshtasticSerial] NeighborInfo survey ended — restored prior config');
        } catch (err: any) {
          console.error('[MeshtasticSerial] NeighborInfo survey restore failed:', err.message);
        } finally {
          this.neighborInfoSurveyTimer = null;
          this.neighborInfoSurveyExpiresAt = null;
          this.neighborInfoSurveyOriginal = null;
          this.updateLocalModuleConfig();
        }
      })();
    }, dur * 60_000);

    console.log(`[MeshtasticSerial] NeighborInfo survey started — every ${interval}s for ${dur}min, restores at ${new Date(expiresAt).toISOString()}`);
    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `NeighborInfo survey: ${interval}s cadence for ${dur}min`);
    this.updateLocalModuleConfig();
    return { expiresAt };
  }

  async cancelNeighborInfoSurvey(): Promise<void> {
    if (!this.neighborInfoSurveyTimer) return;
    clearTimeout(this.neighborInfoSurveyTimer);
    this.neighborInfoSurveyTimer = null;
    const restore = this.neighborInfoSurveyOriginal;
    this.neighborInfoSurveyExpiresAt = null;
    this.neighborInfoSurveyOriginal = null;
    if (restore) {
      try {
        await this.setNeighborInfoConfig({
          enabled: restore.enabled,
          intervalSecs: restore.updateIntervalSecs,
          transmitOverLora: restore.transmitOverLora,
        });
      } catch (err: any) {
        console.error('[MeshtasticSerial] NeighborInfo survey cancel-restore failed:', err.message);
      }
    }
    this.updateLocalModuleConfig();
  }

  getNeighborInfoSurveyExpiresAt(): number | null {
    return this.neighborInfoSurveyExpiresAt;
  }

  // ---- Telemetry module ---------------------------------------------------

  /**
   * Build AdminMessage { set_module_config: ModuleConfig { telemetry: ... } }.
   * Field numbers per mesh.proto:
   *   ModuleConfig.telemetry = 6 (length-delim TelemetryConfig)
   *   TelemetryConfig: 1=device_update_interval, 2=environment_measurement_enabled,
   *     3=environment_update_interval, 6=air_quality_enabled, 7=air_quality_interval,
   *     8=power_measurement_enabled, 9=power_update_interval. Skipping screen flags.
   */
  private buildAdminSetTelemetryConfig(opts: {
    deviceUpdateIntervalSecs: number;
    environmentEnabled: boolean;
    environmentUpdateIntervalSecs: number;
    powerEnabled: boolean;
    powerUpdateIntervalSecs: number;
  }): Buffer {
    const tCfg = Buffer.concat([
      this.encodeTagVarint(1, Math.max(0, Math.floor(opts.deviceUpdateIntervalSecs))),
      this.encodeTagBool(2, opts.environmentEnabled),
      this.encodeTagVarint(3, Math.max(0, Math.floor(opts.environmentUpdateIntervalSecs))),
      this.encodeTagBool(8, opts.powerEnabled),
      this.encodeTagVarint(9, Math.max(0, Math.floor(opts.powerUpdateIntervalSecs))),
    ]);
    const moduleConfig = this.encodeTagLen(6, tCfg);     // ModuleConfig.telemetry
    return this.encodeTagLen(34, moduleConfig);          // AdminMessage.set_module_config
  }

  /**
   * Public: configure the Telemetry module on the local radio. Sets the
   * broadcast intervals for device metrics (battery, voltage), environment
   * sensors (BME280 etc.), and power monitors (INA219/INA260).
   */
  async setTelemetryConfig(opts: {
    deviceUpdateIntervalSecs?: number;
    environmentEnabled?: boolean;
    environmentUpdateIntervalSecs?: number;
    powerEnabled?: boolean;
    powerUpdateIntervalSecs?: number;
  }): Promise<void> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified — try again in a moment');

    const merged = {
      deviceUpdateIntervalSecs: opts.deviceUpdateIntervalSecs ?? 0,
      environmentEnabled: opts.environmentEnabled ?? false,
      environmentUpdateIntervalSecs: opts.environmentUpdateIntervalSecs ?? 0,
      powerEnabled: opts.powerEnabled ?? false,
      powerUpdateIntervalSecs: opts.powerUpdateIntervalSecs ?? 0,
    };

    this.sendAdminMessage(this.buildAdminSetTelemetryConfig(merged));
    await new Promise(r => setTimeout(r, 80));
    this.sendAdminMessage(this.buildAdminCommit());

    console.log(`[MeshtasticSerial] Telemetry module configured (device=${merged.deviceUpdateIntervalSecs}s, env=${merged.environmentEnabled}/${merged.environmentUpdateIntervalSecs}s, power=${merged.powerEnabled}/${merged.powerUpdateIntervalSecs}s)`);
    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `Telemetry module configured (device every ${merged.deviceUpdateIntervalSecs || 'default'}s)`);

    this.localModuleConfig.telemetry = { ...merged, lastReadAt: Date.now() };
    this.updateLocalModuleConfig();

    setTimeout(() => { this.requestTelemetryConfig().catch(() => { /* best-effort */ }); }, 250);
  }

  async requestTelemetryConfig(): Promise<void> {
    if (!this.isLinkOpen()) return;
    if (!this.localNodeNum) return;
    const adminPayload = this.encodeTagVarint(3, MeshtasticSerialBridge.MODULE_CFG_TELEMETRY);
    this.sendAdminMessage(adminPayload);
    console.log('[MeshtasticSerial] Requested Telemetry module config readback');
  }

  // ---- Store & Forward module --------------------------------------------

  /**
   * Build AdminMessage { set_module_config: ModuleConfig { store_forward: ... } }.
   * Field numbers per mesh.proto:
   *   ModuleConfig.store_forward = 4 (length-delim StoreForwardConfig)
   *   StoreForwardConfig: 1=enabled (bool), 2=heartbeat (bool), 3=records (uint32),
   *     4=history_return_max (uint32), 5=history_return_window (uint32), 6=is_server (bool)
   */
  private buildAdminSetStoreForwardConfig(opts: {
    enabled: boolean;
    isServer: boolean;
    heartbeat: boolean;
    records: number;
    historyReturnMax: number;
    historyReturnWindow: number;
  }): Buffer {
    const sfCfg = Buffer.concat([
      this.encodeTagBool(1, opts.enabled),
      this.encodeTagBool(2, opts.heartbeat),
      this.encodeTagVarint(3, Math.max(0, Math.floor(opts.records))),
      this.encodeTagVarint(4, Math.max(0, Math.floor(opts.historyReturnMax))),
      this.encodeTagVarint(5, Math.max(0, Math.floor(opts.historyReturnWindow))),
      this.encodeTagBool(6, opts.isServer),
    ]);
    const moduleConfig = this.encodeTagLen(4, sfCfg);    // ModuleConfig.store_forward
    return this.encodeTagLen(34, moduleConfig);          // AdminMessage.set_module_config
  }

  /**
   * Public: configure the Store & Forward module on the local radio. When
   * isServer is true, this radio acts as an S&F router (buffers traffic and
   * replays it on `CLIENT_HISTORY` requests from peers). When false, the radio
   * runs the module as a client only (the existing replay-request feature).
   * Power requirement is real: routers should be on stable power, not battery.
   */
  async setStoreForwardConfig(opts: {
    enabled: boolean;
    isServer?: boolean;
    heartbeat?: boolean;
    records?: number;
    historyReturnMax?: number;
    historyReturnWindow?: number;
  }): Promise<void> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified — try again in a moment');

    const merged = {
      enabled: opts.enabled,
      isServer: opts.isServer ?? false,
      heartbeat: opts.heartbeat ?? false,
      records: opts.records ?? 0,
      historyReturnMax: opts.historyReturnMax ?? 0,
      historyReturnWindow: opts.historyReturnWindow ?? 0,
    };

    this.sendAdminMessage(this.buildAdminSetStoreForwardConfig(merged));
    await new Promise(r => setTimeout(r, 80));
    this.sendAdminMessage(this.buildAdminCommit());

    const role = merged.enabled ? (merged.isServer ? 'router/server' : 'client') : 'disabled';
    console.log(`[MeshtasticSerial] Store & Forward module ${role} (heartbeat=${merged.heartbeat}, records=${merged.records}, returnMax=${merged.historyReturnMax}, windowMin=${merged.historyReturnWindow})`);
    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `Store & Forward module ${role}`);

    this.localModuleConfig.storeForward = { ...merged, lastReadAt: Date.now() };
    this.updateLocalModuleConfig();

    setTimeout(() => { this.requestStoreForwardConfig().catch(() => { /* best-effort */ }); }, 250);
  }

  async requestStoreForwardConfig(): Promise<void> {
    if (!this.isLinkOpen()) return;
    if (!this.localNodeNum) return;
    const adminPayload = this.encodeTagVarint(3, MeshtasticSerialBridge.MODULE_CFG_STORE_FORWARD);
    this.sendAdminMessage(adminPayload);
    console.log('[MeshtasticSerial] Requested Store & Forward module config readback');
  }

  // ---- External Notification module --------------------------------------

  /**
   * Build AdminMessage { set_module_config: ModuleConfig { external_notification: ... } }.
   * Field numbers per mesh.proto:
   *   ModuleConfig.external_notification = 3 (length-delim ExternalNotificationConfig)
   *   ExternalNotificationConfig: 1=enabled, 2=output_ms, 3=output, 4=active,
   *     5=alert_message, 6=alert_bell, 7=use_pwm, 8=output_vibra, 9=output_buzzer,
   *     10=alert_message_vibra, 11=alert_message_buzzer, 12=alert_bell_vibra,
   *     13=alert_bell_buzzer, 14=nag_timeout, 15=use_i2s_as_buzzer
   * The whole config is replaced on each write — we always send all fields so
   * board-specific GPIO pin assignments survive an operator edit of the
   * higher-level toggles.
   */
  private buildAdminSetExternalNotificationConfig(
    cfg: Omit<ExternalNotificationModuleConfig, 'lastReadAt'>,
  ): Buffer {
    const enCfg = Buffer.concat([
      this.encodeTagBool(1, cfg.enabled),
      this.encodeTagVarint(2, Math.max(0, Math.floor(cfg.outputMs))),
      this.encodeTagVarint(3, Math.max(0, Math.floor(cfg.output))),
      this.encodeTagBool(4, cfg.active),
      this.encodeTagBool(5, cfg.alertMessage),
      this.encodeTagBool(6, cfg.alertBell),
      this.encodeTagBool(7, cfg.usePwm),
      this.encodeTagVarint(8, Math.max(0, Math.floor(cfg.outputVibra))),
      this.encodeTagVarint(9, Math.max(0, Math.floor(cfg.outputBuzzer))),
      this.encodeTagBool(10, cfg.alertMessageVibra),
      this.encodeTagBool(11, cfg.alertMessageBuzzer),
      this.encodeTagBool(12, cfg.alertBellVibra),
      this.encodeTagBool(13, cfg.alertBellBuzzer),
      this.encodeTagVarint(14, Math.max(0, Math.floor(cfg.nagTimeout))),
      this.encodeTagBool(15, cfg.useI2sAsBuzzer),
    ]);
    const moduleConfig = this.encodeTagLen(3, enCfg);    // ModuleConfig.external_notification
    return this.encodeTagLen(34, moduleConfig);          // AdminMessage.set_module_config
  }

  /**
   * Public: configure the External Notification module on the local radio.
   * Operator-facing knobs (the UI exposes these): enabled, alertMessage,
   * alertBell, outputMs, nagTimeout. The remaining fields (GPIO pin
   * assignments, PWM, I2S, vibra/buzzer routing) are passthrough — the caller
   * is expected to merge new toggles with the previous readback so board
   * configuration isn't reset.
   */
  async setExternalNotificationConfig(
    cfg: Omit<ExternalNotificationModuleConfig, 'lastReadAt'>,
  ): Promise<void> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified — try again in a moment');

    this.sendAdminMessage(this.buildAdminSetExternalNotificationConfig(cfg));
    await new Promise(r => setTimeout(r, 80));
    this.sendAdminMessage(this.buildAdminCommit());

    console.log(`[MeshtasticSerial] External Notification ${cfg.enabled ? 'ENABLED' : 'DISABLED'} (msg=${cfg.alertMessage} bell=${cfg.alertBell} ms=${cfg.outputMs} nag=${cfg.nagTimeout}s)`);
    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `External Notification module ${cfg.enabled ? 'enabled' : 'disabled'}`);

    this.localModuleConfig.externalNotification = { ...cfg, lastReadAt: Date.now() };
    this.updateLocalModuleConfig();

    setTimeout(() => { this.requestExternalNotificationConfig().catch(() => { /* best-effort */ }); }, 250);
  }

  async requestExternalNotificationConfig(): Promise<void> {
    if (!this.isLinkOpen()) return;
    if (!this.localNodeNum) return;
    const adminPayload = this.encodeTagVarint(3, MeshtasticSerialBridge.MODULE_CFG_EXTERNAL_NOTIFICATION);
    this.sendAdminMessage(adminPayload);
    console.log('[MeshtasticSerial] Requested External Notification module config readback');
  }

  // ---- MQTT module --------------------------------------------------------

  /**
   * Build AdminMessage { set_module_config: ModuleConfig { mqtt: ... } }.
   * Field numbers per mesh.proto:
   *   ModuleConfig.mqtt = 1 (length-delim MQTTConfig)
   *   MQTTConfig: 1=enabled (bool), 2=address (string), 3=username (string),
   *     4=password (string), 5=encryption_enabled (bool), 6=json_enabled (bool),
   *     7=tls_enabled (bool), 8=root (string),
   *     9=proxy_to_client_enabled (bool), 10=map_reporting_enabled (bool),
   *     11=map_report_settings (sub-message). MapReportSettings is opaque to us;
   *     we capture its raw bytes on readback and echo them on write so any
   *     fields we don't model survive a round-trip.
   */
  private buildAdminSetMqttConfig(cfg: Omit<MqttModuleConfig, 'lastReadAt'>): Buffer {
    const parts: Buffer[] = [
      this.encodeTagBool(1, cfg.enabled),
      this.encodeTagLen(2, Buffer.from(cfg.address || '', 'utf-8')),
      this.encodeTagLen(3, Buffer.from(cfg.username || '', 'utf-8')),
      this.encodeTagLen(4, Buffer.from(cfg.password || '', 'utf-8')),
      this.encodeTagBool(5, cfg.encryptionEnabled),
      this.encodeTagBool(6, cfg.jsonEnabled),
      this.encodeTagBool(7, cfg.tlsEnabled),
      this.encodeTagLen(8, Buffer.from(cfg.root || '', 'utf-8')),
      this.encodeTagBool(9, cfg.proxyToClientEnabled),
      this.encodeTagBool(10, cfg.mapReportingEnabled),
    ];
    if (cfg.mapReportSettingsRaw) {
      // Round-trip the captured MapReportSettings sub-message verbatim.
      parts.push(this.encodeTagLen(11, Buffer.from(cfg.mapReportSettingsRaw, 'base64')));
    }
    const mqttCfg = Buffer.concat(parts);
    const moduleConfig = this.encodeTagLen(1, mqttCfg);   // ModuleConfig.mqtt
    return this.encodeTagLen(34, moduleConfig);            // AdminMessage.set_module_config
  }

  /**
   * Public: configure the MQTT module on the local radio. The radio's MQTT
   * module bridges per-channel traffic (when each channel's uplink/downlink
   * flag is set) to/from the configured broker. Setting is local-admin only;
   * we don't run an MQTT client ourselves.
   */
  async setMqttConfig(cfg: Omit<MqttModuleConfig, 'lastReadAt'>): Promise<void> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified — try again in a moment');

    this.sendAdminMessage(this.buildAdminSetMqttConfig(cfg));
    await new Promise(r => setTimeout(r, 80));
    this.sendAdminMessage(this.buildAdminCommit());

    console.log(`[MeshtasticSerial] MQTT module ${cfg.enabled ? 'ENABLED' : 'DISABLED'} (broker=${cfg.address || 'default'} tls=${cfg.tlsEnabled} proxy=${cfg.proxyToClientEnabled} encryption=${cfg.encryptionEnabled} json=${cfg.jsonEnabled})`);
    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `MQTT module ${cfg.enabled ? 'enabled' : 'disabled'}${cfg.address ? ` (${cfg.address})` : ''}`);

    this.localModuleConfig.mqtt = { ...cfg, lastReadAt: Date.now() };
    this.updateLocalModuleConfig();

    setTimeout(() => { this.requestMqttConfig().catch(() => { /* best-effort */ }); }, 250);
  }

  async requestMqttConfig(): Promise<void> {
    if (!this.isLinkOpen()) return;
    if (!this.localNodeNum) return;
    const adminPayload = this.encodeTagVarint(3, MeshtasticSerialBridge.MODULE_CFG_MQTT);
    this.sendAdminMessage(adminPayload);
    console.log('[MeshtasticSerial] Requested MQTT module config readback');
  }

  // ---- Detection Sensor module --------------------------------------------

  /**
   * Build AdminMessage { set_module_config: ModuleConfig { detection_sensor: ... } }.
   * Field numbers per mesh.proto:
   *   ModuleConfig.detection_sensor = 12 (length-delim DetectionSensorConfig)
   *   DetectionSensorConfig: 1=enabled, 2=minimum_broadcast_secs, 3=state_broadcast_secs,
   *     4=send_bell, 5=name, 6=monitor_pin, 7=detection_triggered_high, 8=use_pullup
   */
  private buildAdminSetDetectionSensorConfig(cfg: Omit<DetectionSensorModuleConfig, 'lastReadAt'>): Buffer {
    const dsCfg = Buffer.concat([
      this.encodeTagBool(1, cfg.enabled),
      this.encodeTagVarint(2, Math.max(0, Math.floor(cfg.minimumBroadcastSecs))),
      this.encodeTagVarint(3, Math.max(0, Math.floor(cfg.stateBroadcastSecs))),
      this.encodeTagBool(4, cfg.sendBell),
      this.encodeTagLen(5, Buffer.from(cfg.name || '', 'utf-8')),
      this.encodeTagVarint(6, Math.max(0, Math.floor(cfg.monitorPin))),
      this.encodeTagBool(7, cfg.detectionTriggeredHigh),
      this.encodeTagBool(8, cfg.usePullup),
    ]);
    const moduleConfig = this.encodeTagLen(12, dsCfg);   // ModuleConfig.detection_sensor
    return this.encodeTagLen(34, moduleConfig);           // AdminMessage.set_module_config
  }

  async setDetectionSensorConfig(cfg: Omit<DetectionSensorModuleConfig, 'lastReadAt'>): Promise<void> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified — try again in a moment');

    this.sendAdminMessage(this.buildAdminSetDetectionSensorConfig(cfg));
    await new Promise(r => setTimeout(r, 80));
    this.sendAdminMessage(this.buildAdminCommit());

    console.log(`[MeshtasticSerial] Detection Sensor module ${cfg.enabled ? 'ENABLED' : 'DISABLED'} (pin=${cfg.monitorPin} active-${cfg.detectionTriggeredHigh ? 'high' : 'low'} pullup=${cfg.usePullup} name="${cfg.name}")`);
    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `Detection Sensor module ${cfg.enabled ? 'enabled' : 'disabled'}${cfg.name ? ` ("${cfg.name}")` : ''}`);

    this.localModuleConfig.detectionSensor = { ...cfg, lastReadAt: Date.now() };
    this.updateLocalModuleConfig();

    setTimeout(() => { this.requestDetectionSensorConfig().catch(() => { /* best-effort */ }); }, 250);
  }

  async requestDetectionSensorConfig(): Promise<void> {
    if (!this.isLinkOpen()) return;
    if (!this.localNodeNum) return;
    const adminPayload = this.encodeTagVarint(3, MeshtasticSerialBridge.MODULE_CFG_DETECTION_SENSOR);
    this.sendAdminMessage(adminPayload);
    console.log('[MeshtasticSerial] Requested Detection Sensor module config readback');
  }

  // ---- Audio module -------------------------------------------------------

  /**
   * Build AdminMessage { set_module_config: ModuleConfig { audio: ... } }.
   * Field numbers per mesh.proto:
   *   ModuleConfig.audio = 8 (length-delim AudioConfig)
   *   AudioConfig: 1=codec2_enabled, 2=ptt_pin, 3=bitrate (Audio_Baud enum),
   *     4=i2s_ws, 5=i2s_sd, 6=i2s_din, 7=i2s_sck
   */
  private buildAdminSetAudioConfig(cfg: Omit<AudioModuleConfig, 'lastReadAt'>): Buffer {
    const aCfg = Buffer.concat([
      this.encodeTagBool(1, cfg.codec2Enabled),
      this.encodeTagVarint(2, Math.max(0, Math.floor(cfg.pttPin))),
      this.encodeTagVarint(3, Math.max(0, Math.floor(cfg.bitrate))),
      this.encodeTagVarint(4, Math.max(0, Math.floor(cfg.i2sWs))),
      this.encodeTagVarint(5, Math.max(0, Math.floor(cfg.i2sSd))),
      this.encodeTagVarint(6, Math.max(0, Math.floor(cfg.i2sDin))),
      this.encodeTagVarint(7, Math.max(0, Math.floor(cfg.i2sSck))),
    ]);
    const moduleConfig = this.encodeTagLen(8, aCfg);     // ModuleConfig.audio
    return this.encodeTagLen(34, moduleConfig);           // AdminMessage.set_module_config
  }

  async setAudioConfig(cfg: Omit<AudioModuleConfig, 'lastReadAt'>): Promise<void> {
    if (!this.isLinkOpen()) throw new Error('Radio not connected');
    if (!this.localNodeNum) throw new Error('Local node not yet identified — try again in a moment');

    this.sendAdminMessage(this.buildAdminSetAudioConfig(cfg));
    await new Promise(r => setTimeout(r, 80));
    this.sendAdminMessage(this.buildAdminCommit());

    console.log(`[MeshtasticSerial] Audio module codec2=${cfg.codec2Enabled} ptt=${cfg.pttPin} bitrate=${cfg.bitrate}`);
    this.addEvent('TELEMETRY', this.localNodeId || '!local',
      `Audio module ${cfg.codec2Enabled ? 'enabled (Codec2)' : 'disabled'}`);

    this.localModuleConfig.audio = { ...cfg, lastReadAt: Date.now() };
    this.updateLocalModuleConfig();

    setTimeout(() => { this.requestAudioConfig().catch(() => { /* best-effort */ }); }, 250);
  }

  async requestAudioConfig(): Promise<void> {
    if (!this.isLinkOpen()) return;
    if (!this.localNodeNum) return;
    const adminPayload = this.encodeTagVarint(3, MeshtasticSerialBridge.MODULE_CFG_AUDIO);
    this.sendAdminMessage(adminPayload);
    console.log('[MeshtasticSerial] Requested Audio module config readback');
  }

  /**
   * Parse an inbound PORT_ADMIN_APP packet. We're looking for
   * `get_module_config_response` (AdminMessage field 4) which contains a
   * ModuleConfig — when its `neighbor_info` variant (field 10) is populated,
   * we capture the authoritative state.
   */
  private handleAdminResponse(fromId: string, buf: Buffer | null) {
    if (!buf) return;
    // Only honour replies from the local node; other admin traffic isn't ours
    if (this.localNodeId && fromId !== this.localNodeId && fromId !== '!00000000') return;

    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 0) {
        const { bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (offset + len > buf.length) break;
        const sub = buf.subarray(offset, offset + len);
        offset += len;
        if (fieldNumber === 4) {
          // get_module_config_response — parse the ModuleConfig oneof
          this.parseModuleConfigResponse(sub);
        }
      } else if (wireType === 5) {
        offset += 4;
      } else {
        break;
      }
    }
  }

  /** Parse a ModuleConfig submessage and update local state for any variants we care about. */
  private parseModuleConfigResponse(buf: Buffer) {
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (offset + len > buf.length) break;
        const sub = buf.subarray(offset, offset + len);
        offset += len;
        if (fieldNumber === 10) {
          // ModuleConfig.neighbor_info (NeighborInfoConfig)
          const cfg = this.parseNeighborInfoConfigSub(sub);
          this.localModuleConfig.neighborInfo = { ...cfg, lastReadAt: Date.now() };
          console.log(`[MeshtasticSerial] NeighborInfo config readback: enabled=${cfg.enabled} interval=${cfg.updateIntervalSecs}s lora=${cfg.transmitOverLora}`);
          this.updateLocalModuleConfig();
        } else if (fieldNumber === 5) {
          // ModuleConfig.range_test (RangeTestConfig)
          const cfg = this.parseRangeTestConfigSub(sub);
          this.localModuleConfig.rangeTest = { ...cfg, lastReadAt: Date.now() };
          console.log(`[MeshtasticSerial] Range Test config readback: enabled=${cfg.enabled} sender=${cfg.senderIntervalSecs}s save=${cfg.save}`);
          this.updateLocalModuleConfig();
        } else if (fieldNumber === 6) {
          // ModuleConfig.telemetry (TelemetryConfig)
          const cfg = this.parseTelemetryConfigSub(sub);
          this.localModuleConfig.telemetry = { ...cfg, lastReadAt: Date.now() };
          console.log(`[MeshtasticSerial] Telemetry config readback: device=${cfg.deviceUpdateIntervalSecs}s env=${cfg.environmentEnabled}/${cfg.environmentUpdateIntervalSecs}s power=${cfg.powerEnabled}/${cfg.powerUpdateIntervalSecs}s`);
          this.updateLocalModuleConfig();
        } else if (fieldNumber === 4) {
          // ModuleConfig.store_forward (StoreForwardConfig)
          const cfg = this.parseStoreForwardConfigSub(sub);
          this.localModuleConfig.storeForward = { ...cfg, lastReadAt: Date.now() };
          console.log(`[MeshtasticSerial] Store & Forward config readback: enabled=${cfg.enabled} server=${cfg.isServer} heartbeat=${cfg.heartbeat} records=${cfg.records} returnMax=${cfg.historyReturnMax} windowMin=${cfg.historyReturnWindow}`);
          this.updateLocalModuleConfig();
        } else if (fieldNumber === 3) {
          // ModuleConfig.external_notification (ExternalNotificationConfig)
          const cfg = this.parseExternalNotificationConfigSub(sub);
          this.localModuleConfig.externalNotification = { ...cfg, lastReadAt: Date.now() };
          console.log(`[MeshtasticSerial] External Notification readback: enabled=${cfg.enabled} msg=${cfg.alertMessage} bell=${cfg.alertBell} ms=${cfg.outputMs} nag=${cfg.nagTimeout}s pin=${cfg.output}`);
          this.updateLocalModuleConfig();
        } else if (fieldNumber === 1) {
          // ModuleConfig.mqtt (MQTTConfig)
          const cfg = this.parseMqttConfigSub(sub);
          this.localModuleConfig.mqtt = { ...cfg, lastReadAt: Date.now() };
          console.log(`[MeshtasticSerial] MQTT config readback: enabled=${cfg.enabled} broker="${cfg.address || 'default'}" tls=${cfg.tlsEnabled} proxy=${cfg.proxyToClientEnabled} encryption=${cfg.encryptionEnabled} json=${cfg.jsonEnabled} root="${cfg.root || 'default'}" map=${cfg.mapReportingEnabled}`);
          this.updateLocalModuleConfig();
        } else if (fieldNumber === 12) {
          // ModuleConfig.detection_sensor (DetectionSensorConfig)
          const cfg = this.parseDetectionSensorConfigSub(sub);
          this.localModuleConfig.detectionSensor = { ...cfg, lastReadAt: Date.now() };
          console.log(`[MeshtasticSerial] Detection Sensor readback: enabled=${cfg.enabled} pin=${cfg.monitorPin} name="${cfg.name}" min=${cfg.minimumBroadcastSecs}s state=${cfg.stateBroadcastSecs}s bell=${cfg.sendBell}`);
          this.updateLocalModuleConfig();
        } else if (fieldNumber === 8) {
          // ModuleConfig.audio (AudioConfig)
          const cfg = this.parseAudioConfigSub(sub);
          this.localModuleConfig.audio = { ...cfg, lastReadAt: Date.now() };
          console.log(`[MeshtasticSerial] Audio readback: codec2=${cfg.codec2Enabled} ptt=${cfg.pttPin} bitrate=${cfg.bitrate}`);
          this.updateLocalModuleConfig();
        }
      } else if (wireType === 0) {
        const { bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
      } else if (wireType === 5) {
        offset += 4;
      } else {
        break;
      }
    }
  }

  /** Parse a NeighborInfoConfig submessage. */
  private parseNeighborInfoConfigSub(buf: Buffer): Omit<NeighborInfoModuleConfig, 'lastReadAt'> {
    let enabled = false;
    let updateIntervalSecs = 0;
    let transmitOverLora = false;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) enabled = value !== 0;
        else if (fieldNumber === 2) updateIntervalSecs = value;
        else if (fieldNumber === 3) transmitOverLora = value !== 0;
      } else { break; }
    }
    return { enabled, updateIntervalSecs, transmitOverLora };
  }

  private parseRangeTestConfigSub(buf: Buffer): Omit<RangeTestModuleConfig, 'lastReadAt'> {
    let enabled = false;
    let senderIntervalSecs = 0;
    let save = false;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) enabled = value !== 0;
        else if (fieldNumber === 2) senderIntervalSecs = value;
        else if (fieldNumber === 3) save = value !== 0;
      } else { break; }
    }
    return { enabled, senderIntervalSecs, save };
  }

  private parseDetectionSensorConfigSub(buf: Buffer): Omit<DetectionSensorModuleConfig, 'lastReadAt'> {
    let enabled = false;
    let minimumBroadcastSecs = 0;
    let stateBroadcastSecs = 0;
    let sendBell = false;
    let name = '';
    let monitorPin = 0;
    let detectionTriggeredHigh = false;
    let usePullup = false;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) enabled = value !== 0;
        else if (fieldNumber === 2) minimumBroadcastSecs = value;
        else if (fieldNumber === 3) stateBroadcastSecs = value;
        else if (fieldNumber === 4) sendBell = value !== 0;
        else if (fieldNumber === 6) monitorPin = value;
        else if (fieldNumber === 7) detectionTriggeredHigh = value !== 0;
        else if (fieldNumber === 8) usePullup = value !== 0;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (offset + len > buf.length) break;
        const slice = buf.subarray(offset, offset + len);
        offset += len;
        if (fieldNumber === 5) name = slice.toString('utf-8');
      } else { break; }
    }
    return {
      enabled, minimumBroadcastSecs, stateBroadcastSecs, sendBell,
      name, monitorPin, detectionTriggeredHigh, usePullup,
    };
  }

  private parseAudioConfigSub(buf: Buffer): Omit<AudioModuleConfig, 'lastReadAt'> {
    let codec2Enabled = false;
    let pttPin = 0;
    let bitrate = 0;
    let i2sWs = 0;
    let i2sSd = 0;
    let i2sDin = 0;
    let i2sSck = 0;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) codec2Enabled = value !== 0;
        else if (fieldNumber === 2) pttPin = value;
        else if (fieldNumber === 3) bitrate = value;
        else if (fieldNumber === 4) i2sWs = value;
        else if (fieldNumber === 5) i2sSd = value;
        else if (fieldNumber === 6) i2sDin = value;
        else if (fieldNumber === 7) i2sSck = value;
      } else { break; }
    }
    return { codec2Enabled, pttPin, bitrate, i2sWs, i2sSd, i2sDin, i2sSck };
  }

  private parseMqttConfigSub(buf: Buffer): Omit<MqttModuleConfig, 'lastReadAt'> {
    let enabled = false;
    let address = '';
    let username = '';
    let password = '';
    let encryptionEnabled = false;
    let jsonEnabled = false;
    let tlsEnabled = false;
    let root = '';
    let proxyToClientEnabled = false;
    let mapReportingEnabled = false;
    let mapReportSettingsRaw: string | null = null;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) enabled = value !== 0;
        else if (fieldNumber === 5) encryptionEnabled = value !== 0;
        else if (fieldNumber === 6) jsonEnabled = value !== 0;
        else if (fieldNumber === 7) tlsEnabled = value !== 0;
        else if (fieldNumber === 9) proxyToClientEnabled = value !== 0;
        else if (fieldNumber === 10) mapReportingEnabled = value !== 0;
      } else if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (offset + len > buf.length) break;
        const slice = buf.subarray(offset, offset + len);
        offset += len;
        if (fieldNumber === 2) address = slice.toString('utf-8');
        else if (fieldNumber === 3) username = slice.toString('utf-8');
        else if (fieldNumber === 4) password = slice.toString('utf-8');
        else if (fieldNumber === 8) root = slice.toString('utf-8');
        else if (fieldNumber === 11) mapReportSettingsRaw = slice.toString('base64');
      } else { break; }
    }
    return {
      enabled, address, username, password,
      encryptionEnabled, jsonEnabled, tlsEnabled, root,
      proxyToClientEnabled, mapReportingEnabled, mapReportSettingsRaw,
    };
  }

  private parseExternalNotificationConfigSub(buf: Buffer): Omit<ExternalNotificationModuleConfig, 'lastReadAt'> {
    let enabled = false;
    let outputMs = 0;
    let output = 0;
    let active = false;
    let alertMessage = false;
    let alertBell = false;
    let usePwm = false;
    let outputVibra = 0;
    let outputBuzzer = 0;
    let alertMessageVibra = false;
    let alertMessageBuzzer = false;
    let alertBellVibra = false;
    let alertBellBuzzer = false;
    let nagTimeout = 0;
    let useI2sAsBuzzer = false;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) enabled = value !== 0;
        else if (fieldNumber === 2) outputMs = value;
        else if (fieldNumber === 3) output = value;
        else if (fieldNumber === 4) active = value !== 0;
        else if (fieldNumber === 5) alertMessage = value !== 0;
        else if (fieldNumber === 6) alertBell = value !== 0;
        else if (fieldNumber === 7) usePwm = value !== 0;
        else if (fieldNumber === 8) outputVibra = value;
        else if (fieldNumber === 9) outputBuzzer = value;
        else if (fieldNumber === 10) alertMessageVibra = value !== 0;
        else if (fieldNumber === 11) alertMessageBuzzer = value !== 0;
        else if (fieldNumber === 12) alertBellVibra = value !== 0;
        else if (fieldNumber === 13) alertBellBuzzer = value !== 0;
        else if (fieldNumber === 14) nagTimeout = value;
        else if (fieldNumber === 15) useI2sAsBuzzer = value !== 0;
      } else { break; }
    }
    return {
      enabled, outputMs, output, active, alertMessage, alertBell, usePwm,
      outputVibra, outputBuzzer, alertMessageVibra, alertMessageBuzzer,
      alertBellVibra, alertBellBuzzer, nagTimeout, useI2sAsBuzzer,
    };
  }

  private parseStoreForwardConfigSub(buf: Buffer): Omit<StoreForwardLocalConfig, 'lastReadAt'> {
    let enabled = false;
    let heartbeat = false;
    let records = 0;
    let historyReturnMax = 0;
    let historyReturnWindow = 0;
    let isServer = false;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) enabled = value !== 0;
        else if (fieldNumber === 2) heartbeat = value !== 0;
        else if (fieldNumber === 3) records = value;
        else if (fieldNumber === 4) historyReturnMax = value;
        else if (fieldNumber === 5) historyReturnWindow = value;
        else if (fieldNumber === 6) isServer = value !== 0;
      } else { break; }
    }
    return { enabled, isServer, heartbeat, records, historyReturnMax, historyReturnWindow };
  }

  private parseTelemetryConfigSub(buf: Buffer): Omit<TelemetryModuleConfig, 'lastReadAt'> {
    let deviceUpdateIntervalSecs = 0;
    let environmentEnabled = false;
    let environmentUpdateIntervalSecs = 0;
    let powerEnabled = false;
    let powerUpdateIntervalSecs = 0;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 1) deviceUpdateIntervalSecs = value;
        else if (fieldNumber === 2) environmentEnabled = value !== 0;
        else if (fieldNumber === 3) environmentUpdateIntervalSecs = value;
        else if (fieldNumber === 8) powerEnabled = value !== 0;
        else if (fieldNumber === 9) powerUpdateIntervalSecs = value;
        // Other fields (4, 5, 6, 7, 10) are screen / air-quality flags we don't surface.
      } else if (wireType === 2) {
        // Skip any unexpected length-delim fields.
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead + len;
      } else { break; }
    }
    return {
      deviceUpdateIntervalSecs,
      environmentEnabled,
      environmentUpdateIntervalSecs,
      powerEnabled,
      powerUpdateIntervalSecs,
    };
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
    this.recordEvent({
      id: randomId(),
      type,
      nodeId,
      timestamp: Date.now(),
      details,
    });
  }

  /**
   * Persist an event from an external source (e.g. the weather alert poller).
   * Caller controls the id so they can dedupe across restarts — passing the
   * same id twice silently no-ops on the DB insert (handled by ON CONFLICT
   * in insertEvent) but still fans out SSE so late subscribers see it.
   */
  recordEvent(event: MeshEvent): void {
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

  /**
   * Configure how long to keep messages (in hours). 0 disables time-based prune
   * (the per-table count cap of 5000 still applies). Runs an immediate prune.
   */
  setMessageRetention(hours: number) {
    if (!Number.isFinite(hours) || hours < 0) {
      throw new Error('retention hours must be a non-negative number');
    }
    this.messageRetentionHours = hours;
    this.runRetentionPrune();
    this.startRetentionPruner();
  }

  getMessageRetention(): number {
    return this.messageRetentionHours;
  }

  private startRetentionPruner() {
    if (this.retentionPruneTimer) clearInterval(this.retentionPruneTimer);
    // Run every 5 minutes — frequent enough to feel responsive, cheap enough to be invisible.
    this.retentionPruneTimer = setInterval(() => this.runRetentionPrune(), 5 * 60_000);
  }

  /** Drop events and messages older than retentionHours from memory caches and SQLite. */
  private runRetentionPrune() {
    // Events
    const eventCutoff = Date.now() - this.eventRetentionHours * 3600_000;
    const eventsBefore = this.events.length;
    this.events = this.events.filter(e => e.timestamp >= eventCutoff);
    let eventsDbRemoved = 0;
    try { eventsDbRemoved = this.db.pruneEventsOlderThan(eventCutoff); }
    catch (e: any) { console.error('[MeshtasticSerial] event retention prune failed:', e.message); }
    if (eventsBefore - this.events.length > 0 || eventsDbRemoved > 0) {
      console.log(`[MeshtasticSerial] event retention prune: -${eventsBefore - this.events.length} memory / -${eventsDbRemoved} db (cutoff=${this.eventRetentionHours}h)`);
    }

    // Messages — only prune when a positive retention window is configured.
    if (this.messageRetentionHours > 0) {
      const msgCutoff = Date.now() - this.messageRetentionHours * 3600_000;
      const msgBefore = this.messages.length;
      this.messages = this.messages.filter(m => m.timestamp >= msgCutoff);
      let msgDbRemoved = 0;
      try { msgDbRemoved = this.db.pruneMessagesOlderThan(msgCutoff); }
      catch (e: any) { console.error('[MeshtasticSerial] message retention prune failed:', e.message); }
      if (msgBefore - this.messages.length > 0 || msgDbRemoved > 0) {
        console.log(`[MeshtasticSerial] message retention prune: -${msgBefore - this.messages.length} memory / -${msgDbRemoved} db (cutoff=${this.messageRetentionHours}h)`);
      }
    }

    // BBS mail — hard 30-day retention regardless of read state (per the
    // feature design; not operator-configurable). Adjust the constant here
    // if we ever expose this in Settings.
    const mailCutoff = Date.now() - 30 * 24 * 3600_000;
    let mailDbRemoved = 0;
    try { mailDbRemoved = this.db.pruneMailOlderThan(mailCutoff); }
    catch (e: any) { console.error('[MeshtasticSerial] mail retention prune failed:', e.message); }
    if (mailDbRemoved > 0) {
      console.log(`[MeshtasticSerial] BBS mail retention prune: -${mailDbRemoved} db (cutoff=30d)`);
    }

    // Position history — 30-day retention matching BBS mail. Per-node Position
    // Log keeps recent samples; older points are dropped to keep the table
    // bounded on chatty meshes (a 100-node mesh broadcasting position every
    // 15 min generates ~3.5 million rows/year without this prune).
    const posCutoff = Date.now() - 30 * 24 * 3600_000;
    let posDbRemoved = 0;
    try { posDbRemoved = this.db.prunePositionHistoryOlderThan(posCutoff); }
    catch (e: any) { console.error('[MeshtasticSerial] position history prune failed:', e.message); }
    if (posDbRemoved > 0) {
      console.log(`[MeshtasticSerial] Position history retention prune: -${posDbRemoved} db (cutoff=30d)`);
    }

    // Node sessions — bound at 100k rows. Helper existed but was never wired
    // into the periodic prune; left unattended it would grow ~one row per
    // online/offline transition per node forever. 100k is plenty for analytics
    // (months to years of online/offline transitions on a mesh of any size).
    try { this.db.pruneNodeSessions(100_000); }
    catch (e: any) { console.error('[MeshtasticSerial] node_sessions prune failed:', e.message); }
  }
}

export const meshBridge = new MeshtasticSerialBridge();
