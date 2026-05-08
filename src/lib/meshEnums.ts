/**
 * Human-readable labels for selected Meshtastic protobuf enums.
 *
 * Source of truth: the Meshtastic mesh.proto / config.proto. Values here are
 * what the firmware advertises; we map to short labels for the UI. Unknown
 * values fall through to "Unknown (N)" so a future firmware enum addition
 * doesn't crash the UI.
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
};

export function roleLabel(role: number | undefined, short = false): string | null {
  if (role === undefined) return null;
  const map = short ? ROLE_SHORT : ROLE_LABELS;
  return map[role] ?? `Role ${role}`;
}

/**
 * Most common Meshtastic HardwareModel enum values. The full enum has 70+
 * entries; we surface the common ones and fall back to "HW #N" for the rest.
 */
export const HARDWARE_LABELS: Record<number, string> = {
  0:  'Unset',
  1:  'TLORA v2',
  2:  'TLORA v1',
  3:  'TLORA v2.1 1.6',
  4:  'TBEAM',
  5:  'Heltec v2.0',
  6:  'TBEAM v0.7',
  7:  'T-Echo',
  8:  'TLORA v1.1.3',
  9:  'RAK4631',
  10: 'Heltec v2.1',
  11: 'Heltec v1',
  12: 'LilyGO TBeam S3 Core',
  13: 'RAK11200',
  14: 'NANO_G1',
  15: 'TLORA v2.1 1.8',
  16: 'TLORA T3 S3',
  17: 'NANO_G1_EXPLORER',
  18: 'NANO_G2_ULTRA',
  19: 'LORA_TYPE',
  25: 'STATION_G1',
  31: 'M5STACK',
  32: 'Heltec v3',
  33: 'Heltec WSL v3',
  34: 'BETAFPV 2400 TX',
  35: 'BETAFPV 900 NANO TX',
  36: 'RPI Pico',
  37: 'Heltec Wireless Tracker',
  38: 'Heltec Wireless Paper',
  39: 'T-Deck',
  40: 'T-Watch S3',
  41: 'PicoMputer S3',
  42: 'Heltec HT62',
  43: 'EBYTE ESP32 S3',
  44: 'ESP32 S3 PICO',
  45: 'CHATTER 2',
  46: 'Heltec Wireless Mini',
  47: 'Heltec MeshNode T114',
  48: 'Sense X1',
  49: 'RPI Pico 2',
  50: 'Heltec Mesh Pocket',
  51: 'Seeed Sense Cap Indicator',
  52: 'Tracker T1000-E',
  53: 'RAK3172',
  54: 'WIO-E5',
  55: 'RADIOMASTER 900 BANDIT NANO',
  56: 'ME25LS01',
  57: 'RP2040 LORA',
  58: 'STATION_G2',
  59: 'LORA_RELAY_V1',
  60: 'NRF52840DK',
  61: 'PPR',
  62: 'GENIEBLOCKS',
  63: 'NRF52_UNKNOWN',
  64: 'PORTDUINO',
  65: 'ANDROID_SIM',
  66: 'DIY_V1',
  67: 'NRF52840_PCA10059',
  68: 'DR_DEV',
  69: 'M5STACK_COREINK',
  70: 'HW_RAK11310',
  255: 'Private HW',
};

export function hardwareLabel(hwModel: number | undefined): string | null {
  if (hwModel === undefined) return null;
  return HARDWARE_LABELS[hwModel] ?? `HW #${hwModel}`;
}
