/**
 * v2.1 — type definitions used by the Meshtastic bridge.
 *
 * Extracted from server/meshtasticSerial.ts (which used to define them
 * inline alongside the 6800-LOC bridge class). The class file
 * re-exports everything here so existing imports of these types from
 * './meshtasticSerial.js' keep working — no consumer churn.
 *
 * All interfaces here describe domain shapes: nodes, messages,
 * channels, module configs, etc. Behavior (parse / send / admin
 * writes) stays in the bridge.
 */

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
  /**
   * v2.0 multi-radio: list of radio_ids (4-char short names) that have heard
   * this node, ordered most-recent-first. Surfaced as "Heard by" badges in
   * the node list and as the map-pin border color. In Phase 3a there is only
   * ever the default radio in this list; Phase 3b populates it from secondary
   * bridges as they come online.
   */
  heardByRadios?: string[];
  /** Epoch ms of the most recent observation per radio. Keyed by radio_id. */
  lastHeardAtPerRadio?: Record<string, number>;
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
  /**
   * v2.0 multi-radio: the radio that received (or sent) this message —
   * the 4-char short_name of the bridge whose physical channel this lived
   * on. Lets the UI badge each message with its source mesh and route
   * replies back through the same bridge instead of cross-mesh defaulting
   * to the primary.
   */
  radioId?: string | null;
}

export interface MeshEvent {
  id: string;
  /** v2.1: WEATHER_DELIVERY tracks every weather-alert send attempt
   *  end-to-end — the initial SENT log, the ACKed / NoACK outcome,
   *  and the fallback mail-notice attempt. Lets the operator grep
   *  the Event Log for "did the alert actually reach 7fba?" instead
   *  of having to dig in docker logs. */
  type: 'NODE_JOINED' | 'NODE_LOST' | 'MESSAGE' | 'TELEMETRY' | 'POSITION_UPDATE' | 'WEATHER_ALERT' | 'WEATHER_DELIVERY' | 'STORM_REPORT' | 'OUTAGE';
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

export interface SerialModuleConfig {
  /** Master enable for the Serial module (UART passthrough to an external device). */
  enabled: boolean;
  /** Echo received serial bytes back out the port (loopback debug aid). */
  echo: boolean;
  /** UART RX GPIO pin (0 = firmware/board default). */
  rxd: number;
  /** UART TX GPIO pin (0 = firmware/board default). */
  txd: number;
  /** Serial_Baud enum value (0=default, ... see SERIAL_BAUD_OPTIONS). */
  baud: number;
  /** Idle timeout in ms before a partial line is flushed (0 = firmware default). */
  timeout: number;
  /** Serial_Mode enum value (0=default, 1=simple, 2=proto, 3=textmsg, 4=nmea, 5=caltopo, 6=ws85, 7=ve_direct). */
  mode: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface AmbientLightingModuleConfig {
  /** True = the RGB LED is driven; false = LED off. */
  ledState: boolean;
  /** LED current register value (board-specific; 0 = default). */
  current: number;
  /** Red channel intensity (0-255). */
  red: number;
  /** Green channel intensity (0-255). */
  green: number;
  /** Blue channel intensity (0-255). */
  blue: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

export interface PaxcounterModuleConfig {
  /** Master enable for the Paxcounter module (counts nearby WiFi/BLE devices). */
  enabled: boolean;
  /** Seconds between paxcounter broadcasts (0 = firmware default). */
  updateIntervalSecs: number;
  /** RSSI threshold for counting a WiFi device (0 = firmware default). */
  wifiThreshold: number;
  /** RSSI threshold for counting a BLE device (0 = firmware default). */
  bleThreshold: number;
  /** Epoch ms when this config was last read from the radio. */
  lastReadAt: number;
}

/**
 * Single GPIO pin exposed by the Remote Hardware module. Each pin advertises
 * its access mode (read, write, or both) to other nodes on the mesh.
 */
export interface RemoteHardwarePin {
  /** Arduino-style GPIO pin number on this board. */
  gpioPin: number;
  /** Human-readable name shown on the mesh (e.g. "Mailbox", "Gate"). */
  name: string;
  /** RemoteHardwarePinType enum: UNKNOWN=0, DIGITAL_READ=1, DIGITAL_WRITE=2. */
  type: number;
}

export interface RemoteHardwareModuleConfig {
  /** Master enable for the Remote Hardware module. */
  enabled: boolean;
  /** Allow mesh peers to read/write GPIO pins NOT in availablePins (dangerous). */
  allowUndefinedPinAccess: boolean;
  /** Whitelist of exposed pins. */
  availablePins: RemoteHardwarePin[];
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

/**
 * v2.0 Beta 2: subset of Meshtastic's NetworkConfig (Config.network, field 4).
 * Surfaced read-only in the Radios view as a "Network: WiFi on (SSID)" line +
 * a "captive UI" link when the radio is on the LAN.
 *
 * Field numbers (config.proto NetworkConfig):
 *   1=wifi_enabled, 3=wifi_ssid, 4=wifi_psk, 5=ntp_server, 6=eth_enabled,
 *   ... (ipv4_config and friends are skipped — they're rarely set by hobbyists)
 */
export interface NetworkConfigSnapshot {
  wifiEnabled: boolean;
  wifiSsid: string;
  ethEnabled: boolean;
  ntpServer: string;
  lastReadAt: number;
}

/**
 * v2.0 Beta 2: subset of Meshtastic's PowerConfig (Config.power, field 3).
 * Critical for field deployments — controls how aggressively the radio
 * goes to sleep between LoRa wakeups.
 *
 * Field numbers (config.proto PowerConfig):
 *   1=is_power_saving, 2=on_battery_shutdown_after_secs, 3=adc_multiplier_override,
 *   4=wait_bluetooth_secs, 5=sds_secs (super deep sleep),
 *   6=ls_secs (light sleep), 7=min_wake_secs, 8=device_battery_ina_address
 */
export interface PowerConfigSnapshot {
  isPowerSaving: boolean;
  onBatteryShutdownAfterSecs: number;
  waitBluetoothSecs: number;
  sdsSecs: number;
  lsSecs: number;
  minWakeSecs: number;
  lastReadAt: number;
}

/**
 * v2.0 Beta 3: subset of Meshtastic's DeviceConfig (Config.device, field 1).
 * Operator-meaningful fields only — deprecated fields (serial_enabled=2,
 * is_managed=9) and board-specific GPIO overrides (button_gpio=4,
 * buzzer_gpio=5) are omitted; firmware preserves them on round-trip.
 *
 * Field numbers (config.proto DeviceConfig):
 *   1=role, 6=rebroadcast_mode, 7=node_info_broadcast_secs,
 *   8=double_tap_as_button_press, 10=disable_triple_click, 11=tzdef,
 *   12=led_heartbeat_disabled, 13=buzzer_mode
 */
export interface DeviceConfigSnapshot {
  /** Role enum: CLIENT=0, CLIENT_MUTE=1, ROUTER=2, TRACKER=5, SENSOR=6, TAK=7,
   *  CLIENT_HIDDEN=8, LOST_AND_FOUND=9, TAK_TRACKER=10, ROUTER_LATE=11, CLIENT_BASE=12 */
  role: number;
  /** RebroadcastMode enum: ALL=0, ALL_SKIP_DECODING=1, LOCAL_ONLY=2, KNOWN_ONLY=3, NONE=4, CORE_PORTNUMS_ONLY=5 */
  rebroadcastMode: number;
  /** Seconds between NodeInfo broadcasts (0 = firmware default of 900s). */
  nodeInfoBroadcastSecs: number;
  doubleTapAsButtonPress: boolean;
  disableTripleClick: boolean;
  /** POSIX timezone string (e.g. "EST5EDT,M3.2.0,M11.1.0"). Empty = unset. */
  tzdef: string;
  ledHeartbeatDisabled: boolean;
  /** BuzzerMode enum: ALL_ENABLED=0, DISABLED=1, NOTIFICATIONS_ONLY=2, SYSTEM_ONLY=3, DIRECT_MSG_ONLY=4 */
  buzzerMode: number;
  lastReadAt: number;
}

/**
 * v2.0 Beta 3: subset of Meshtastic's PositionConfig (Config.position, field 2).
 * Operator-meaningful fields only — deprecated fields (gps_enabled=4,
 * gps_attempt_time=6) and GPIO overrides (rx_gpio=8, tx_gpio=9, gps_en_gpio=12)
 * are preserved opaquely on round-trip.
 *
 * Field numbers (config.proto PositionConfig):
 *   1=position_broadcast_secs, 2=position_broadcast_smart_enabled,
 *   3=fixed_position, 5=gps_update_interval, 7=position_flags,
 *   10=broadcast_smart_minimum_distance, 11=broadcast_smart_minimum_interval_secs,
 *   13=gps_mode
 */
export interface PositionConfigSnapshot {
  positionBroadcastSecs: number;
  smartEnabled: boolean;
  fixedPosition: boolean;
  gpsUpdateIntervalSecs: number;
  /** Bitmask of PositionFlags: ALTITUDE=0x01, ALTITUDE_MSL=0x02, GEOIDAL_SEPARATION=0x04,
   *  DOP=0x08, HVDOP=0x10, SATINVIEW=0x20, SEQ_NO=0x40, TIMESTAMP=0x80, HEADING=0x100, SPEED=0x200 */
  positionFlags: number;
  smartMinimumDistanceMeters: number;
  smartMinimumIntervalSecs: number;
  /** GpsMode enum: DISABLED=0, ENABLED=1, NOT_PRESENT=2 */
  gpsMode: number;
  lastReadAt: number;
}

/**
 * v2.0 Beta 3: subset of Meshtastic's DisplayConfig (Config.display, field 5).
 * Operator-meaningful fields only — deprecated fields (gps_format=2,
 * compass_north_top=4) are skipped.
 *
 * Field numbers (config.proto DisplayConfig):
 *   1=screen_on_secs, 3=auto_screen_carousel_secs, 5=flip_screen, 6=units,
 *   7=oled, 8=displaymode, 9=heading_bold, 10=wake_on_tap_or_motion,
 *   11=compass_orientation, 12=use_12h_clock, 13=use_long_node_name,
 *   14=enable_message_bubbles
 */
export interface DisplayConfigSnapshot {
  screenOnSecs: number;
  autoScreenCarouselSecs: number;
  flipScreen: boolean;
  /** DisplayUnits enum: METRIC=0, IMPERIAL=1 */
  units: number;
  /** OledType enum: AUTO=0, SSD1306=1, SH1106=2, SH1107=3, SH1107_128_128=4, SH1107_ROTATED=5 */
  oled: number;
  /** DisplayMode enum: DEFAULT=0, TWOCOLOR=1, INVERTED=2, COLOR=3 */
  displayMode: number;
  headingBold: boolean;
  wakeOnTapOrMotion: boolean;
  /** CompassOrientation enum: DEGREES_0=0..DEGREES_270_INVERTED=7 */
  compassOrientation: number;
  use12hClock: boolean;
  useLongNodeName: boolean;
  enableMessageBubbles: boolean;
  lastReadAt: number;
}

/**
 * v2.0 Beta 3: Meshtastic's BluetoothConfig (Config.bluetooth, field 7).
 *
 * Field numbers (config.proto BluetoothConfig):
 *   1=enabled, 2=mode (PairingMode), 3=fixed_pin (uint32)
 */
export interface BluetoothConfigSnapshot {
  enabled: boolean;
  /** PairingMode enum: RANDOM_PIN=0, FIXED_PIN=1, NO_PIN=2 */
  mode: number;
  /** 6-digit fixed PIN when mode=FIXED_PIN; ignored otherwise. */
  fixedPin: number;
  lastReadAt: number;
}

/**
 * v2.0: subset of Meshtastic's LoRaConfig that we surface in the Settings →
 * Radios editor. Other LoRaConfig fields (bandwidth, spread_factor, etc.) are
 * preserved opaquely on readback so save round-trips don't lose them.
 *
 * Field numbers (config.proto LoRaConfig):
 *   1=use_preset, 2=modem_preset, 7=region, 8=hop_limit, 9=tx_enabled, 11=channel_num
 */
export interface LoRaConfigSnapshot {
  usePreset: boolean;
  /** ModemPreset enum value (0=LONG_FAST, 1=LONG_SLOW, ..., 8=SHORT_TURBO). */
  modemPreset: number;
  /** RegionCode enum value (1=US, 2=EU_433, 3=EU_868, ...). */
  region: number;
  hopLimit: number;
  txEnabled: boolean;
  /** config.lora.channel_num — the Frequency Slot. 0 = auto-derive from primary channel name. */
  frequencySlot: number;
  /** Epoch ms of last successful readback. */
  lastReadAt: number;
  /** Opaque copy of the inbound buffer so we can echo unmodified fields on save. */
  rawBuf?: Buffer;
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
  /** Authoritative Serial module config (UART passthrough to external devices). */
  serial?: SerialModuleConfig;
  /** Authoritative Ambient Lighting module config (RGB LED control). */
  ambientLighting?: AmbientLightingModuleConfig;
  /** Authoritative Paxcounter module config (WiFi/BLE device counting). */
  paxcounter?: PaxcounterModuleConfig;
  /** Authoritative Remote Hardware module config (GPIO remote control). */
  remoteHardware?: RemoteHardwareModuleConfig;
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

export type TransportMode = 'serial' | 'tcp';

export interface TcpEndpoint {
  host: string;
  port: number;
}
