/**
 * Mesh persistence layer (SQLite via better-sqlite3).
 *
 * The bridge keeps in-memory caches for fast reads but writes through to
 * disk on every state change so nodes/messages/events/channels survive
 * restarts. On boot, the bridge calls `loadAll()` to rehydrate caches.
 */
import Database, { type Database as Db } from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type {
  MeshNode,
  MeshMessage,
  MeshEvent,
  MeshChannel,
  ChannelRole,
} from './meshtasticSerial.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_DB_PATH = join(__dirname, '..', 'data', 'mesh.sqlite');

// Hard caps to keep the DB bounded.
const MAX_MESSAGES = 5000;
const MAX_EVENTS = 1000;
const MAX_TELEMETRY_PER_NODE = 500;

// How many of each table to load into memory on boot.
const LOAD_MESSAGES = 1000;
const LOAD_EVENTS = 200;

export class MeshDatabase {
  private db: Db;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.runMigrations();
    console.log(`[MeshDB] Opened ${dbPath}`);
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------
  private runMigrations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id            TEXT PRIMARY KEY,
        num           INTEGER,
        name          TEXT,
        short_name    TEXT,
        first_seen    INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL,
        online        INTEGER NOT NULL DEFAULT 0,
        favorite      INTEGER NOT NULL DEFAULT 0,
        is_local      INTEGER NOT NULL DEFAULT 0,

        lat REAL, lng REAL, alt REAL,
        battery REAL, voltage REAL,
        ch_util REAL, air_util_tx REAL,
        snr REAL, rssi REAL, distance REAL,
        temperature REAL, humidity REAL, pressure REAL, iaq REAL,

        hops_away INTEGER,
        raw_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT PRIMARY KEY,
        from_id       TEXT NOT NULL,
        to_id         TEXT NOT NULL,
        channel       TEXT,
        text          TEXT NOT NULL,
        timestamp     INTEGER NOT NULL,
        hop_limit     INTEGER,
        rx_snr        REAL,
        rx_rssi       REAL,
        hops_json     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_from      ON messages(from_id);
      CREATE INDEX IF NOT EXISTS idx_messages_channel   ON messages(channel);

      CREATE TABLE IF NOT EXISTS events (
        id        TEXT PRIMARY KEY,
        type      TEXT NOT NULL,
        node_id   TEXT,
        timestamp INTEGER NOT NULL,
        details   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);

      CREATE TABLE IF NOT EXISTS channels (
        idx          INTEGER PRIMARY KEY,
        name         TEXT NOT NULL,
        role         TEXT NOT NULL,
        psk_b64      TEXT NOT NULL,
        uplink       INTEGER NOT NULL DEFAULT 0,
        downlink     INTEGER NOT NULL DEFAULT 0,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id       TEXT NOT NULL,
        timestamp     INTEGER NOT NULL,
        battery       REAL,
        voltage       REAL,
        ch_util       REAL,
        air_util_tx   REAL,
        snr           REAL,
        rssi          REAL,
        temperature   REAL,
        humidity      REAL,
        pressure      REAL
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_node_time
        ON telemetry(node_id, timestamp DESC);
    `);
  }

  // ---------------------------------------------------------------------
  // Nodes
  // ---------------------------------------------------------------------
  upsertNode(node: MeshNode) {
    const tel = node.telemetry;
    const sen = node.sensors;
    const pos = node.position;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO nodes (
        id, num, name, short_name, first_seen, last_seen, online, favorite, is_local,
        lat, lng, alt,
        battery, voltage, ch_util, air_util_tx, snr, rssi, distance,
        temperature, humidity, pressure, iaq,
        hops_away, raw_json
      ) VALUES (
        @id, @num, @name, @short_name, @first_seen, @last_seen, @online, @favorite, @is_local,
        @lat, @lng, @alt,
        @battery, @voltage, @ch_util, @air_util_tx, @snr, @rssi, @distance,
        @temperature, @humidity, @pressure, @iaq,
        @hops_away, @raw_json
      )
      ON CONFLICT(id) DO UPDATE SET
        num         = COALESCE(excluded.num,         nodes.num),
        name        = COALESCE(excluded.name,        nodes.name),
        short_name  = COALESCE(excluded.short_name,  nodes.short_name),
        last_seen   = MAX(excluded.last_seen, nodes.last_seen),
        online      = excluded.online,
        favorite    = excluded.favorite,
        is_local    = MAX(excluded.is_local, nodes.is_local),
        lat         = COALESCE(excluded.lat,         nodes.lat),
        lng         = COALESCE(excluded.lng,         nodes.lng),
        alt         = COALESCE(excluded.alt,         nodes.alt),
        battery     = COALESCE(excluded.battery,     nodes.battery),
        voltage     = COALESCE(excluded.voltage,     nodes.voltage),
        ch_util     = COALESCE(excluded.ch_util,     nodes.ch_util),
        air_util_tx = COALESCE(excluded.air_util_tx, nodes.air_util_tx),
        snr         = COALESCE(excluded.snr,         nodes.snr),
        rssi        = COALESCE(excluded.rssi,        nodes.rssi),
        distance    = COALESCE(excluded.distance,    nodes.distance),
        temperature = COALESCE(excluded.temperature, nodes.temperature),
        humidity    = COALESCE(excluded.humidity,    nodes.humidity),
        pressure    = COALESCE(excluded.pressure,    nodes.pressure),
        iaq         = COALESCE(excluded.iaq,         nodes.iaq),
        hops_away   = COALESCE(excluded.hops_away,   nodes.hops_away),
        raw_json    = excluded.raw_json
    `).run({
      id: node.id,
      num: anyNum(node, 'num'),
      name: node.name ?? null,
      short_name: node.shortName ?? null,
      first_seen: node.lastSeen ?? now,
      last_seen: node.lastSeen ?? now,
      online: node.online ? 1 : 0,
      favorite: node.favorite ? 1 : 0,
      is_local: anyNum(node, 'isLocal') ?? 0,
      lat: pos?.lat ?? null,
      lng: pos?.lng ?? null,
      alt: pos?.alt ?? null,
      battery: tel?.battery ?? null,
      voltage: tel?.voltage ?? null,
      ch_util: tel?.channelUtilization ?? null,
      air_util_tx: tel?.airUtilTx ?? null,
      snr: tel?.snr ?? null,
      rssi: tel?.rssi ?? null,
      distance: tel?.distance ?? null,
      temperature: sen?.temperature ?? null,
      humidity: sen?.humidity ?? null,
      pressure: sen?.pressure ?? null,
      iaq: sen?.iaq ?? null,
      hops_away: anyNum(node, 'hopsAway') ?? null,
      raw_json: JSON.stringify(node),
    });
  }

  loadNodes(): MeshNode[] {
    const rows = this.db.prepare(`SELECT raw_json FROM nodes`).all() as { raw_json: string }[];
    const out: MeshNode[] = [];
    for (const r of rows) {
      try { out.push(JSON.parse(r.raw_json)); } catch { /* skip corrupt row */ }
    }
    return out;
  }

  setFavorite(nodeId: string, favorite: boolean) {
    this.db.prepare(`UPDATE nodes SET favorite = ? WHERE id = ?`)
      .run(favorite ? 1 : 0, nodeId);
  }

  // ---------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------
  insertMessage(msg: MeshMessage) {
    this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, from_id, to_id, channel, text, timestamp, hop_limit, rx_snr, rx_rssi, hops_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.from,
      msg.to,
      msg.channel ?? null,
      msg.text,
      msg.timestamp,
      anyNum(msg, 'hopLimit') ?? null,
      anyNum(msg, 'rxSnr') ?? null,
      anyNum(msg, 'rxRssi') ?? null,
      msg.hops ? JSON.stringify(msg.hops) : null,
    );
    this.pruneMessages();
  }

  loadMessages(limit = LOAD_MESSAGES): MeshMessage[] {
    const rows = this.db.prepare(`
      SELECT id, from_id, to_id, channel, text, timestamp, hop_limit, rx_snr, rx_rssi, hops_json
      FROM messages
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string; from_id: string; to_id: string; channel: string | null;
      text: string; timestamp: number; hop_limit: number | null;
      rx_snr: number | null; rx_rssi: number | null; hops_json: string | null;
    }>;

    return rows.reverse().map(r => ({
      id: r.id,
      from: r.from_id,
      to: r.to_id,
      channel: r.channel ?? '',
      text: r.text,
      timestamp: r.timestamp,
      hopLimit: r.hop_limit ?? undefined,
      rxSnr: r.rx_snr ?? undefined,
      rxRssi: r.rx_rssi ?? undefined,
      hops: r.hops_json ? safeParse<string[]>(r.hops_json) ?? [] : [],
    }) as MeshMessage);
  }

  private pruneMessages() {
    this.db.prepare(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM messages ORDER BY timestamp DESC LIMIT -1 OFFSET ?
      )
    `).run(MAX_MESSAGES);
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------
  insertEvent(ev: MeshEvent) {
    this.db.prepare(`
      INSERT OR REPLACE INTO events (id, type, node_id, timestamp, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(ev.id, ev.type, ev.nodeId ?? null, ev.timestamp, ev.details);
    this.pruneEvents();
  }

  loadEvents(limit = LOAD_EVENTS): MeshEvent[] {
    const rows = this.db.prepare(`
      SELECT id, type, node_id, timestamp, details
      FROM events
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string; type: string; node_id: string | null;
      timestamp: number; details: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      type: r.type as MeshEvent['type'],
      nodeId: r.node_id ?? '',
      timestamp: r.timestamp,
      details: r.details,
    }));
  }

  private pruneEvents() {
    this.db.prepare(`
      DELETE FROM events WHERE id IN (
        SELECT id FROM events ORDER BY timestamp DESC LIMIT -1 OFFSET ?
      )
    `).run(MAX_EVENTS);
  }

  // ---------------------------------------------------------------------
  // Channels
  // ---------------------------------------------------------------------
  upsertChannel(ch: MeshChannel) {
    this.db.prepare(`
      INSERT INTO channels (idx, name, role, psk_b64, uplink, downlink, updated_at)
      VALUES (@idx, @name, @role, @psk_b64, @uplink, @downlink, @updated_at)
      ON CONFLICT(idx) DO UPDATE SET
        name       = excluded.name,
        role       = excluded.role,
        psk_b64    = excluded.psk_b64,
        uplink     = excluded.uplink,
        downlink   = excluded.downlink,
        updated_at = excluded.updated_at
    `).run({
      idx: ch.index,
      name: ch.name,
      role: ch.role,
      psk_b64: ch.pskBase64,
      uplink: ch.uplinkEnabled ? 1 : 0,
      downlink: ch.downlinkEnabled ? 1 : 0,
      updated_at: Date.now(),
    });
  }

  loadChannels(): MeshChannel[] {
    const rows = this.db.prepare(`SELECT * FROM channels ORDER BY idx`).all() as Array<{
      idx: number; name: string; role: string;
      psk_b64: string; uplink: number; downlink: number;
    }>;
    return rows.map(r => ({
      index: r.idx,
      name: r.name,
      role: r.role as ChannelRole,
      pskBase64: r.psk_b64,
      uplinkEnabled: !!r.uplink,
      downlinkEnabled: !!r.downlink,
    }));
  }

  // ---------------------------------------------------------------------
  // Telemetry history
  // ---------------------------------------------------------------------
  insertTelemetrySnapshot(nodeId: string, t: {
    battery?: number; voltage?: number;
    chUtil?: number; airUtilTx?: number;
    snr?: number; rssi?: number;
    temperature?: number; humidity?: number; pressure?: number;
  }) {
    this.db.prepare(`
      INSERT INTO telemetry
        (node_id, timestamp, battery, voltage, ch_util, air_util_tx,
         snr, rssi, temperature, humidity, pressure)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nodeId, Date.now(),
      t.battery ?? null, t.voltage ?? null,
      t.chUtil ?? null, t.airUtilTx ?? null,
      t.snr ?? null, t.rssi ?? null,
      t.temperature ?? null, t.humidity ?? null, t.pressure ?? null,
    );

    // Keep only the most recent N rows per node.
    this.db.prepare(`
      DELETE FROM telemetry WHERE id IN (
        SELECT id FROM telemetry WHERE node_id = ?
        ORDER BY timestamp DESC LIMIT -1 OFFSET ?
      )
    `).run(nodeId, MAX_TELEMETRY_PER_NODE);
  }

  getTelemetryHistory(nodeId: string, limit = 200) {
    return this.db.prepare(`
      SELECT timestamp, battery, voltage, ch_util AS chUtil,
             air_util_tx AS airUtilTx, snr, rssi,
             temperature, humidity, pressure
      FROM telemetry
      WHERE node_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(nodeId, limit);
  }

  // ---------------------------------------------------------------------
  // Stats / introspection
  // ---------------------------------------------------------------------
  stats() {
    const get = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      nodes:     get(`SELECT COUNT(*) AS c FROM nodes`),
      messages:  get(`SELECT COUNT(*) AS c FROM messages`),
      events:    get(`SELECT COUNT(*) AS c FROM events`),
      telemetry: get(`SELECT COUNT(*) AS c FROM telemetry`),
      channels:  get(`SELECT COUNT(*) AS c FROM channels`),
    };
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function anyNum(obj: any, key: string): number | undefined {
  const v = obj?.[key];
  return typeof v === 'number' ? v : undefined;
}

function safeParse<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

// Singleton — created lazily so tests can construct their own.
let _instance: MeshDatabase | null = null;
export function meshDb(): MeshDatabase {
  if (!_instance) _instance = new MeshDatabase();
  return _instance;
}
