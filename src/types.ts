export type UnitSystem = 'METRIC' | 'IMPERIAL';

export interface WidgetConfig {
  id: string;
  /**
   * Dashboard widget kinds. MESSAGES and SENSOR_DATA were retired from the
   * default layout — Messages have their own dedicated nav item (with full
   * thread management) and sensor data surfaces inline on the Node Details
   * panel for the currently-selected node.
   */
  type: 'STATS' | 'NODE_LIST' | 'NODE_DETAILS' | 'MAP';
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
  /**
   * Per-channel position precision (ChannelSettings.module_settings.position_precision).
   * 0 = position broadcasts disabled on this channel, 32 = full precision.
   * `undefined` = not yet read; the firmware default (32) applies.
   */
  positionPrecision?: number;
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
  /** Epoch ms of the first packet we ever observed from this node. */
  firstSeen?: number;
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
  /** Mesh distance in hops as last reported by the local radio's NodeInfo. */
  hopsAway?: number;
  /** Last-observed inbound transport ('lora' = direct over RF, 'mqtt' = bridged). */
  lastVia?: 'lora' | 'mqtt';
  /**
   * v2.0 multi-radio: radio_ids (4-char short names) that have heard this
   * node, ordered most-recent-first. Powers the "Heard by" badges + map pin
   * border color.
   */
  heardByRadios?: string[];
  /** v2.0 multi-radio: epoch ms of the most recent observation per radio. */
  lastHeardAtPerRadio?: Record<string, number>;
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

/**
 * Outbound-message lifecycle:
 *   sending — we've created the optimistic bubble; haven't yet written to radio
 *   sent    — bytes successfully delivered to the radio over USB/TCP
 *   queued  — local radio confirmed packet sat in its TX queue (QueueStatus res=0).
 *             For broadcasts this is the terminal positive state (broadcasts get
 *             no over-the-air ACK by design). For DMs it's an intermediate step;
 *             the destination's routing ACK will upgrade us to 'acked'.
 *   acked   — destination peer (or relay) sent a real routing-reply ACK.
 *             DMs only — broadcasts can never legitimately reach this state.
 *   error   — TX-queue error, ACK timeout (DM only), or sync write failure.
 */
export type MessageStatus = 'sending' | 'sent' | 'queued' | 'acked' | 'error';

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
  /**
   * Round-trip latency from send-time to ACK in milliseconds. Captured at the
   * moment we receive the firmware ACK or QueueStatus success for messages we
   * sent (and synthesized by the simulator). Undefined for inbound messages
   * and messages where no ACK was ever observed.
   */
  deliveryMs?: number;
  /**
   * v2.0 multi-radio: the 4-char short_name of the radio that received (or
   * sent) this message. Used to badge each message with its source mesh and
   * to route replies back through the originating bridge instead of
   * defaulting to the primary.
   */
  radioId?: string | null;
}

export interface RadioEvent {
  id: string;
  /** v2.1: WEATHER_DELIVERY tracks each weather-alert send end-to-end
   *  (SENT → ACK / NO ACK → optional fallback mail-notice outcome). */
  type: 'NODE_JOINED' | 'NODE_LOST' | 'MESSAGE' | 'TELEMETRY' | 'POSITION_UPDATE' | 'WEATHER_ALERT' | 'WEATHER_DELIVERY' | 'STORM_REPORT' | 'OUTAGE';
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

// --- Beta 2: traceroute route-stability analysis (from /api/gpu/route-stability) ---
export interface RouteStabilityVariant {
  nodes: string[];
  count: number;
  last_seen: number | null;
}

export interface RouteStabilityPair {
  target: string;
  origin: string | null;
  total: number;
  distinct_paths: number;
  dominant_path: string[];
  dominant_count: number;
  /** dominant_count / total, in [0,1]. 1 = the route never changed. */
  stability: number;
  avg_hops: number;
  first_seen: number | null;
  last_seen: number | null;
  variants: RouteStabilityVariant[];
}

export interface RouteStabilitySegment {
  a: string;
  b: string;
  count: number;
  targets: string[];
}

export interface RouteStabilityResponse {
  pairs: RouteStabilityPair[];
  segments: RouteStabilitySegment[];
  backend: 'cugraph' | 'cpu' | 'cpu_ts';
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

export interface RangeTestModuleConfig {
  enabled: boolean;
  /** Sender broadcast interval (seconds). 0 = receive-only mode. */
  senderIntervalSecs: number;
  /** Persist results to flash on the radio (CSV log). */
  save: boolean;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface TelemetryModuleConfig {
  /** Device metrics broadcast interval (seconds). 0 = firmware default. */
  deviceUpdateIntervalSecs: number;
  /** Whether environment-sensor telemetry (BME280 etc.) is enabled. */
  environmentEnabled: boolean;
  /** Environment-sensor broadcast interval (seconds). 0 = firmware default. */
  environmentUpdateIntervalSecs: number;
  /** Whether power-monitor telemetry (INA219/INA260) is enabled. */
  powerEnabled: boolean;
  /** Power-monitor broadcast interval (seconds). 0 = firmware default. */
  powerUpdateIntervalSecs: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface DetectionSensorModuleConfig {
  enabled: boolean;
  minimumBroadcastSecs: number;
  stateBroadcastSecs: number;
  sendBell: boolean;
  name: string;
  monitorPin: number;
  detectionTriggeredHigh: boolean;
  usePullup: boolean;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface AudioModuleConfig {
  codec2Enabled: boolean;
  pttPin: number;
  bitrate: number;
  i2sWs: number;
  i2sSd: number;
  i2sDin: number;
  i2sSck: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface SerialModuleConfig {
  enabled: boolean;
  echo: boolean;
  rxd: number;
  txd: number;
  /** Serial_Baud enum value. */
  baud: number;
  timeout: number;
  /** Serial_Mode enum value. */
  mode: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface AmbientLightingModuleConfig {
  ledState: boolean;
  current: number;
  red: number;
  green: number;
  blue: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface PaxcounterModuleConfig {
  enabled: boolean;
  updateIntervalSecs: number;
  wifiThreshold: number;
  bleThreshold: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface RemoteHardwarePin {
  gpioPin: number;
  name: string;
  /** RemoteHardwarePinType enum: UNKNOWN=0, DIGITAL_READ=1, DIGITAL_WRITE=2. */
  type: number;
}

export interface RemoteHardwareModuleConfig {
  enabled: boolean;
  allowUndefinedPinAccess: boolean;
  availablePins: RemoteHardwarePin[];
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface MqttModuleConfig {
  enabled: boolean;
  address: string;
  username: string;
  password: string;
  encryptionEnabled: boolean;
  jsonEnabled: boolean;
  tlsEnabled: boolean;
  /** MQTT topic root, e.g. "msh/US/2/e/". */
  root: string;
  /** Use the connected client (this app) as the MQTT proxy instead of the radio's own WiFi. */
  proxyToClientEnabled: boolean;
  /** Publish positions to the public Meshtastic map. */
  mapReportingEnabled: boolean;
  /** Opaque MapReportSettings sub-message base64'd. Echoed verbatim on save. */
  mapReportSettingsRaw: string | null;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface ExternalNotificationModuleConfig {
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
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface StoreForwardLocalConfig {
  enabled: boolean;
  /** When true, the local radio acts as an S&F router/server. */
  isServer: boolean;
  heartbeat: boolean;
  /** Max records to retain (router only). 0 = firmware default. */
  records: number;
  /** Max records replayed per CLIENT_HISTORY request (router only). 0 = firmware default. */
  historyReturnMax: number;
  /** Time window in minutes a CLIENT_HISTORY request may ask for (router only). 0 = firmware default. */
  historyReturnWindow: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface LocalModuleConfigSnapshot {
  /** Authoritative NeighborInfo config; undefined until the first readback completes. */
  neighborInfo?: NeighborInfoModuleConfig;
  /** Authoritative Range Test config; undefined until the first readback completes. */
  rangeTest?: RangeTestModuleConfig;
  /** Authoritative Telemetry-module config; undefined until the first readback completes. */
  telemetry?: TelemetryModuleConfig;
  /** Authoritative Store & Forward module config (local radio's S&F role / params). */
  storeForward?: StoreForwardLocalConfig;
  /** Authoritative External Notification module config (buzzer / LED / vibra alerts). */
  externalNotification?: ExternalNotificationModuleConfig;
  /** Authoritative MQTT module config (broker / auth / encryption / topic). */
  mqtt?: MqttModuleConfig;
  /** Authoritative Detection Sensor module config (GPIO state broadcasts). */
  detectionSensor?: DetectionSensorModuleConfig;
  /** Authoritative Audio module config (Codec2 voice over LoRa). */
  audio?: AudioModuleConfig;
  /** Authoritative Serial module config (UART passthrough to external devices). */
  serial?: SerialModuleConfig;
  /** Authoritative Ambient Lighting module config (RGB LED control). */
  ambientLighting?: AmbientLightingModuleConfig;
  /** Authoritative Paxcounter module config (WiFi/BLE device counting). */
  paxcounter?: PaxcounterModuleConfig;
  /** Authoritative Remote Hardware module config (GPIO remote control). */
  remoteHardware?: RemoteHardwareModuleConfig;
  /** Live state of timed surveys (Range Test sender / NeighborInfo cadence). */
  activeSurveys?: {
    rangeTestExpiresAt: number | null;
    neighborInfoExpiresAt: number | null;
  };
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

// v2.0 multi-radio — mirrors the `radios` table in [../server/database.ts](../server/database.ts).
export type RadioTransport = 'serial' | 'tcp' | 'ble';

export interface RadioRow {
  radio_id: string;
  long_name: string;
  transport: RadioTransport;
  target: string;
  region: string | null;
  modem_preset: string | null;
  frequency_slot: number | null;
  primary_channel: string | null;
  num_hops: number | null;
  enabled: number;
  color_hex: string | null;
  network_label: string | null;
  is_default: number;
  /** v2.0 Beta 4: when 1, this radio auto-replies to non-BBS DMs with the
   *  command index. Lets an operator dedicate one radio to BBS while
   *  others stay general chat nodes. */
  bbs_only: number;
  /** v2.0 Beta 5 Workspaces: which workspace this radio belongs to.
   *  Null only for very brief windows between auto-register and the
   *  bootstrap migration assigning it to Household. */
  workspace_id?: number | null;
  /** v2.0 Beta 5 Workspaces (response annotation): human-readable
   *  workspace name, surfaced by /api/mesh/radios for UI display. Not
   *  stored on the row itself. */
  workspace_name?: string | null;
  /** v2.0 Beta 5 (per-workspace primary): true when this radio is the
   *  explicit primary for its workspace. Surfaced by /api/mesh/radios. */
  is_workspace_primary?: boolean;
  created_at: number;
  updated_at: number;
}

// Live LoRa config readback from the firmware (raw enum values, not labels).
export interface LoRaConfigLive {
  usePreset: boolean;
  modemPreset: number;
  region: number;
  hopLimit: number;
  txEnabled: boolean;
  frequencySlot: number;
  lastReadAt: number;
}
