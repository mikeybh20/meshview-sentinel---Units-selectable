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

export interface Message {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: number;
  channel: string;
  hopLimit: number;
  hops: string[]; // List of node IDs it hopped through
}

export interface RadioEvent {
  id: string;
  type: 'NODE_JOINED' | 'NODE_LOST' | 'MESSAGE' | 'TELEMETRY' | 'POSITION_UPDATE';
  nodeId: string;
  timestamp: number;
  details: string;
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
