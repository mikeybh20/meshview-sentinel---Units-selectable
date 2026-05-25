/**
 * Human-readable labels for selected Meshtastic protobuf enums.
 *
 * Source of truth: the Meshtastic mesh.proto HardwareModel enum and the
 * config.proto Role enum (https://github.com/meshtastic/protobufs).
 *
 * Values here mirror what the firmware advertises; we map to display labels
 * for the UI. Unknown values fall through to "HW #N" / "Role #N" so a future
 * firmware enum addition won't crash the UI — it'll just show the number.
 */

/** Meshtastic Role enum (config.proto). */
export const ROLE_LABELS: Record<number, string> = {
  0:  'Client',
  1:  'Client Mute',
  2:  'Router',
  3:  'Router (Client)',  // ROUTER_CLIENT, deprecated
  4:  'Repeater',
  5:  'Tracker',
  6:  'Sensor',
  7:  'TAK',
  8:  'Client (Hidden)',
  9:  'Lost & Found',
  10: 'TAK Tracker',
  11: 'Router Late',
};

/** Short, mono-text-friendly version for tight UI spots (e.g. badges). */
export const ROLE_SHORT: Record<number, string> = {
  0:  'CLIENT',
  1:  'MUTE',
  2:  'ROUTER',
  3:  'ROUTER',
  4:  'REPEATER',
  5:  'TRACKER',
  6:  'SENSOR',
  7:  'TAK',
  8:  'HIDDEN',
  9:  'LOST/FOUND',
  10: 'TAK-TRK',
  11: 'ROUTER-LATE',
};

export function roleLabel(role: number | undefined, short = false): string | null {
  if (role === undefined) return null;
  const map = short ? ROLE_SHORT : ROLE_LABELS;
  return map[role] ?? `Role ${role}`;
}

/**
 * iOS surfaces a "Monitored" / "Unmonitored" badge derived from role.
 * CLIENT_MUTE (role 1) is the explicit "won't actively participate in
 * messaging" signal; everything else is treated as an active messaging
 * participant. CLIENT_HIDDEN (8) deserves the same treatment.
 */
export function messagingStatus(role: number | undefined): 'Monitored' | 'Unmonitored' {
  if (role === 1 || role === 8) return 'Unmonitored';
  return 'Monitored';
}

/**
 * Meshtastic HardwareModel enum (mesh.proto). The firmware team adds new
 * board variants every few months — anything past the highest value here
 * gets a "HW #N" fallback rather than a wrong name.
 *
 * Reconciled against the canonical proto as of late 2025: HELTEC_V3 is 43,
 * SEEED_SOLAR_NODE is 95, etc. The earlier in-repo table had several
 * mid-range values shifted (Heltec v3 was at 32, for instance) which is
 * why many recent boards showed the wrong model name.
 */
export const HARDWARE_LABELS: Record<number, string> = {
  0:  'Unset',
  1:  'TLoRa V2',
  2:  'TLoRa V1',
  3:  'TLoRa V2.1-1.6',
  4:  'T-Beam',
  5:  'Heltec V2.0',
  6:  'T-Beam V0.7',
  7:  'T-Echo',
  8:  'TLoRa V1.1-1.3',
  9:  'RAK4631',
  10: 'Heltec V2.1',
  11: 'Heltec V1',
  12: 'LilyGo T-Beam S3 Core',
  13: 'RAK11200',
  14: 'Nano G1',
  15: 'TLoRa V2.1-1.8',
  16: 'TLoRa T3 S3',
  17: 'Nano G1 Explorer',
  18: 'Nano G2 Ultra',
  19: 'LoRa Type',
  20: 'WiPhone',
  21: 'Wio WM1110',
  22: 'RAK2560',
  23: 'Heltec HRU-3601',
  25: 'Station G1',
  26: 'RAK11310',
  27: 'SenseLoRa RP2040',
  28: 'SenseLoRa S3',
  29: 'Canary One',
  30: 'RP2040 LoRa',
  31: 'Station G2',
  32: 'LoRa Relay V1',
  33: 'NRF52840 DK',
  34: 'PPR',
  35: 'GenieBlocks',
  36: 'NRF52 Unknown',
  37: 'Portduino',
  38: 'Android Sim',
  39: 'DIY V1',
  40: 'NRF52840 PCA10059',
  41: 'DR Dev',
  42: 'M5Stack',
  43: 'Heltec V3',
  44: 'Heltec WSL V3',
  45: 'BetaFPV 2400 TX',
  46: 'BetaFPV 900 Nano TX',
  47: 'RPI Pico',
  48: 'Heltec Wireless Tracker',
  49: 'Heltec Wireless Paper',
  50: 'T-Deck',
  51: 'T-Watch S3',
  52: 'PicoComputer S3',
  53: 'Heltec HT62',
  54: 'Ebyte ESP32 S3',
  55: 'ESP32 S3 Pico',
  56: 'Chatter 2',
  57: 'Heltec Wireless Paper V1.0',
  58: 'Heltec Wireless Tracker V1.0',
  59: 'Unphone',
  60: 'TD LoRaC',
  61: 'CDEByte EORA S3',
  62: 'TWC Mesh V4',
  63: 'NRF52 Promicro DIY',
  64: 'Radiomaster 900 Bandit Nano',
  65: 'Heltec Capsule Sensor V3',
  66: 'Heltec Vision Master T190',
  67: 'Heltec Vision Master E213',
  68: 'Heltec Vision Master E290',
  69: 'Heltec Mesh Node T114',
  70: 'SenseCAP Indicator',
  71: 'Tracker T1000-E',
  72: 'RAK3172',
  73: 'Wio E5',
  74: 'Radiomaster 900 Bandit',
  75: 'ME25LS01 4Y10TD',
  76: 'RP2040 Feather RFM95',
  77: 'M5Stack Core Basic',
  78: 'M5Stack Core2',
  79: 'RPI Pico2',
  80: 'M5Stack Cores3',
  81: 'Seeed XIAO S3',
  82: 'MS24SF1',
  83: 'TLoRa C6',
  84: 'WisMesh Tap',
  85: 'Routastic',
  86: 'Mesh Tab',
  87: 'MeshLink',
  88: 'XIAO NRF52 Kit',
  89: 'ThinkNode M1',
  90: 'ThinkNode M2',
  91: 'T-Eth Elite',
  92: 'Heltec Sensor Hub',
  94: 'Heltec Mesh Pocket',
  95: 'Seeed SenseCAP Solar Node',
  96: 'Nomadstar Meteor Pro',
  97: 'CrowPanel',
  255: 'Private HW',
};

export function hardwareLabel(hwModel: number | undefined): string | null {
  if (hwModel === undefined) return null;
  return HARDWARE_LABELS[hwModel] ?? `HW #${hwModel}`;
}

/**
 * Derive the decimal node number from the !hex form Meshtastic uses for
 * addressing. The firmware uses uint32 node nums internally; we store the
 * hex form for display (`!02eb3bec`). iOS shows the decimal form (e.g.
 * "520471100") so we surface both.
 */
export function hexToNodeNum(hexId: string | null | undefined): number | null {
  if (!hexId) return null;
  const m = hexId.match(/^!([0-9a-f]{8})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return Number.isFinite(n) ? n : null;
}

/**
 * "2 hours ago" / "4 weeks ago" / "never" style relative-time labels —
 * matches the iOS app's First Heard / Last Heard rows.
 */
export function relativeTimeLong(ts: number | undefined): string {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  if (s < 30 * 86_400) {
    const d = Math.floor(s / 86_400);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }
  if (s < 365 * 86_400) {
    const w = Math.floor(s / (7 * 86_400));
    return `${w} week${w === 1 ? '' : 's'} ago`;
  }
  const y = Math.floor(s / (365 * 86_400));
  return `${y} year${y === 1 ? '' : 's'} ago`;
}
