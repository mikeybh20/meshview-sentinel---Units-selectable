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
  MeshWaypoint,
  MeshGroup,
  MeshTraceResult,
  NeighborInfoSnapshot,
  MeshStoreForwardRouter,
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
        hops_json     TEXT,
        status        TEXT,
        error_code    INTEGER,
        is_own        INTEGER NOT NULL DEFAULT 0
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

      CREATE TABLE IF NOT EXISTS waypoints (
        id            INTEGER PRIMARY KEY,
        lat           REAL NOT NULL,
        lng           REAL NOT NULL,
        name          TEXT,
        description   TEXT,
        icon          INTEGER,
        expire        INTEGER NOT NULL DEFAULT 0,
        locked_to     INTEGER NOT NULL DEFAULT 0,
        created_by    TEXT,
        last_seen     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_waypoints_last_seen ON waypoints(last_seen DESC);

      CREATE TABLE IF NOT EXISTS neighbor_info (
        from_id        TEXT PRIMARY KEY,
        interval_secs  INTEGER NOT NULL DEFAULT 0,
        neighbors_json TEXT NOT NULL,
        last_seen      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_neighbor_info_last_seen ON neighbor_info(last_seen DESC);

      CREATE TABLE IF NOT EXISTS store_forward_routers (
        node_id        TEXT PRIMARY KEY,
        period_secs    INTEGER NOT NULL DEFAULT 0,
        is_secondary   INTEGER NOT NULL DEFAULT 0,
        last_heartbeat INTEGER NOT NULL,
        stats_json     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sf_routers_last_heartbeat ON store_forward_routers(last_heartbeat DESC);

      CREATE TABLE IF NOT EXISTS groups (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trace_results (
        id            TEXT PRIMARY KEY,
        target_id     TEXT NOT NULL,
        started_at    INTEGER NOT NULL,
        completed_at  INTEGER,
        status        TEXT NOT NULL,
        route_json    TEXT NOT NULL,
        route_back_json TEXT NOT NULL,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_trace_results_started_at ON trace_results(started_at DESC);

      CREATE TABLE IF NOT EXISTS range_test_observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id   TEXT NOT NULL,
        sender_lat  REAL,
        sender_lng  REAL,
        seq         INTEGER,
        snr         REAL,
        rssi        REAL,
        text        TEXT,
        timestamp   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rtobs_timestamp ON range_test_observations(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_rtobs_sender ON range_test_observations(sender_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS blocked_nodes (
        node_id    TEXT PRIMARY KEY,
        blocked_at INTEGER NOT NULL
      );

      -- Per-node online/offline session history. One row per online window:
      -- online_at fires when we observe traffic from a previously-stale node;
      -- offline_at fires when the staleness check trips. Used to compute uptime
      -- %, average session length, and peak-hours-online for relay scheduling
      -- (Route Intel) and for the Dashboard's per-node uptime widget.
      CREATE TABLE IF NOT EXISTS node_sessions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id     TEXT NOT NULL,
        online_at   INTEGER NOT NULL,
        offline_at  INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_node_sessions_node_id ON node_sessions(node_id, online_at DESC);
      CREATE INDEX IF NOT EXISTS idx_node_sessions_open ON node_sessions(node_id) WHERE offline_at IS NULL;
    `);

    // Additive migrations for older DBs. SQLite throws if the column already
    // exists; that's expected and ignored.
    const addColumnIfMissing = (table: string, ddl: string) => {
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); }
      catch (err: any) {
        if (!String(err.message).includes('duplicate column')) {
          console.warn(`[MeshDB] migration on ${table}: ${err.message}`);
        }
      }
    };
    addColumnIfMissing('messages', 'status TEXT');
    addColumnIfMissing('messages', 'error_code INTEGER');
    addColumnIfMissing('messages', 'is_own INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('messages', 'packet_id INTEGER');
    addColumnIfMissing('messages', 'reply_to INTEGER');
    addColumnIfMissing('messages', 'is_reaction INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('messages', 'delivery_ms INTEGER');
    addColumnIfMissing('channels', 'position_precision INTEGER');

    // FTS5 full-text search index over messages.text. We use external content
    // (the `messages` table is the canonical source) and triggers to keep them
    // in sync. content_rowid is the messages table's implicit rowid.
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          text,
          content='messages',
          content_rowid='rowid',
          tokenize='porter unicode61 remove_diacritics 1'
        );

        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
          INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
      `);

      // Backfill FTS from any existing rows that pre-date the index.
      const ftsCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM messages_fts`).get() as { c: number }).c;
      const msgCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM messages`).get() as { c: number }).c;
      if (ftsCount < msgCount) {
        const inserted = this.db.prepare(`
          INSERT INTO messages_fts(rowid, text)
          SELECT rowid, text FROM messages
          WHERE rowid NOT IN (SELECT rowid FROM messages_fts)
        `).run();
        console.log(`[MeshDB] FTS backfill: +${(inserted as any).changes ?? 0} rows`);
      }
    } catch (err: any) {
      console.warn('[MeshDB] FTS5 setup failed (search will be unavailable):', err.message);
    }
  }

  /** Full-text search over messages. Returns most-recent matches first. */
  searchMessages(query: string, limit = 50): MeshMessage[] {
    if (!query || !query.trim()) return [];
    // Sanitize: FTS5 syntax — wrap in double quotes to treat as a phrase and
    // escape any embedded double quotes by doubling them.
    const escaped = query.trim().replace(/"/g, '""');
    const ftsQuery = `"${escaped}"`;

    try {
      const rows = this.db.prepare(`
        SELECT m.id, m.from_id, m.to_id, m.channel, m.text, m.timestamp, m.hop_limit,
               m.rx_snr, m.rx_rssi, m.hops_json, m.status, m.error_code, m.is_own,
               m.packet_id, m.reply_to, m.is_reaction
        FROM messages_fts fts
        JOIN messages m ON m.rowid = fts.rowid
        WHERE messages_fts MATCH ?
        ORDER BY m.timestamp DESC
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{
        id: string; from_id: string; to_id: string; channel: string | null;
        text: string; timestamp: number; hop_limit: number | null;
        rx_snr: number | null; rx_rssi: number | null; hops_json: string | null;
        status: string | null; error_code: number | null; is_own: number;
        packet_id: number | null; reply_to: number | null; is_reaction: number;
      }>;

      return rows.map(r => ({
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
        status: (r.status as MeshMessage['status']) ?? undefined,
        errorCode: r.error_code ?? undefined,
        isOwn: !!r.is_own,
        packetId: r.packet_id ?? undefined,
        replyTo: r.reply_to ?? undefined,
        isReaction: r.is_reaction ? true : undefined,
      }) as MeshMessage);
    } catch (err: any) {
      console.error('[MeshDB] FTS search failed:', err.message);
      return [];
    }
  }

  // ---------------------------------------------------------------------
  // Waypoints
  // ---------------------------------------------------------------------
  upsertWaypoint(w: MeshWaypoint) {
    this.db.prepare(`
      INSERT INTO waypoints
        (id, lat, lng, name, description, icon, expire, locked_to, created_by, last_seen)
      VALUES
        (@id, @lat, @lng, @name, @description, @icon, @expire, @locked_to, @created_by, @last_seen)
      ON CONFLICT(id) DO UPDATE SET
        lat         = excluded.lat,
        lng         = excluded.lng,
        name        = excluded.name,
        description = excluded.description,
        icon        = excluded.icon,
        expire      = excluded.expire,
        locked_to   = excluded.locked_to,
        created_by  = COALESCE(nullif(excluded.created_by,''), waypoints.created_by),
        last_seen   = MAX(excluded.last_seen, waypoints.last_seen)
    `).run({
      id: w.id,
      lat: w.lat,
      lng: w.lng,
      name: w.name ?? null,
      description: w.description ?? null,
      icon: w.icon ?? null,
      expire: w.expire ?? 0,
      locked_to: w.lockedTo ?? 0,
      created_by: w.createdBy ?? '',
      last_seen: w.lastSeen ?? Date.now(),
    });
  }

  deleteWaypoint(id: number) {
    this.db.prepare(`DELETE FROM waypoints WHERE id = ?`).run(id);
  }

  // ---------------------------------------------------------------------
  // NeighborInfo
  // ---------------------------------------------------------------------
  upsertNeighborInfo(snap: NeighborInfoSnapshot) {
    this.db.prepare(`
      INSERT INTO neighbor_info (from_id, interval_secs, neighbors_json, last_seen)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(from_id) DO UPDATE SET
        interval_secs  = excluded.interval_secs,
        neighbors_json = excluded.neighbors_json,
        last_seen      = excluded.last_seen
    `).run(
      snap.fromNodeId,
      snap.intervalSecs,
      JSON.stringify(snap.neighbors),
      snap.lastSeen,
    );
  }

  loadNeighborInfo(): NeighborInfoSnapshot[] {
    const rows = this.db.prepare(`
      SELECT from_id, interval_secs, neighbors_json, last_seen
      FROM neighbor_info
      ORDER BY last_seen DESC
    `).all() as Array<{
      from_id: string; interval_secs: number; neighbors_json: string; last_seen: number;
    }>;

    return rows.map(r => ({
      fromNodeId: r.from_id,
      intervalSecs: r.interval_secs,
      neighbors: safeParse<NeighborInfoSnapshot['neighbors']>(r.neighbors_json) ?? [],
      lastSeen: r.last_seen,
    }));
  }

  // ---------------------------------------------------------------------
  // Groups (operator-defined node tags)
  // ---------------------------------------------------------------------
  upsertGroup(g: MeshGroup) {
    this.db.prepare(`
      INSERT INTO groups (id, name, color, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name  = excluded.name,
        color = excluded.color
    `).run(g.id, g.name, g.color, g.createdAt);
  }

  deleteGroup(id: string) {
    this.db.prepare(`DELETE FROM groups WHERE id = ?`).run(id);
  }

  loadGroups(): MeshGroup[] {
    const rows = this.db.prepare(`
      SELECT id, name, color, created_at FROM groups ORDER BY created_at ASC
    `).all() as Array<{ id: string; name: string; color: string; created_at: number }>;
    return rows.map(r => ({ id: r.id, name: r.name, color: r.color, createdAt: r.created_at }));
  }

  // ---------------------------------------------------------------------
  // Traceroute results (history survives restart)
  // ---------------------------------------------------------------------
  upsertTraceResult(t: MeshTraceResult) {
    this.db.prepare(`
      INSERT INTO trace_results (id, target_id, started_at, completed_at, status, route_json, route_back_json, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        completed_at    = excluded.completed_at,
        status          = excluded.status,
        route_json      = excluded.route_json,
        route_back_json = excluded.route_back_json,
        error_message   = excluded.error_message
    `).run(
      t.id,
      t.targetId,
      t.startedAt,
      t.completedAt ?? null,
      t.status,
      JSON.stringify(t.route),
      JSON.stringify(t.routeBack),
      t.errorMessage ?? null,
    );
    this.pruneTraceResults();
  }

  loadTraceResults(limit = 200): MeshTraceResult[] {
    const rows = this.db.prepare(`
      SELECT id, target_id, started_at, completed_at, status, route_json, route_back_json, error_message
      FROM trace_results
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string; target_id: string; started_at: number; completed_at: number | null;
      status: string; route_json: string; route_back_json: string; error_message: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      targetId: r.target_id,
      startedAt: r.started_at,
      completedAt: r.completed_at ?? undefined,
      status: r.status as MeshTraceResult['status'],
      route: safeParse<MeshTraceResult['route']>(r.route_json) ?? [],
      routeBack: safeParse<MeshTraceResult['routeBack']>(r.route_back_json) ?? [],
      errorMessage: r.error_message ?? undefined,
    }));
  }

  /** Keep at most the most recent 500 traces to bound the table. */
  private pruneTraceResults() {
    this.db.exec(`
      DELETE FROM trace_results
      WHERE id IN (
        SELECT id FROM trace_results
        ORDER BY started_at DESC
        LIMIT -1 OFFSET 500
      )
    `);
  }

  // ---------------------------------------------------------------------
  // Range Test observations (coverage map data)
  // ---------------------------------------------------------------------
  insertRangeTestObservation(obs: {
    senderId: string;
    senderLat?: number | null;
    senderLng?: number | null;
    seq?: number | null;
    snr?: number | null;
    rssi?: number | null;
    text?: string | null;
    timestamp: number;
  }) {
    this.db.prepare(`
      INSERT INTO range_test_observations
        (sender_id, sender_lat, sender_lng, seq, snr, rssi, text, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      obs.senderId,
      obs.senderLat ?? null,
      obs.senderLng ?? null,
      obs.seq ?? null,
      obs.snr ?? null,
      obs.rssi ?? null,
      obs.text ?? null,
      obs.timestamp,
    );
    this.pruneRangeTestObservations();
  }

  /** Return raw observations from the most recent `windowMs` window. */
  getRangeTestObservations(windowMs?: number, limit = 5000): Array<{
    id: number;
    senderId: string;
    senderLat: number | null;
    senderLng: number | null;
    seq: number | null;
    snr: number | null;
    rssi: number | null;
    text: string | null;
    timestamp: number;
  }> {
    const sql = windowMs && windowMs > 0
      ? `SELECT * FROM range_test_observations WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?`
      : `SELECT * FROM range_test_observations ORDER BY timestamp DESC LIMIT ?`;
    const params: any[] = windowMs && windowMs > 0
      ? [Date.now() - windowMs, limit]
      : [limit];
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number; sender_id: string; sender_lat: number | null; sender_lng: number | null;
      seq: number | null; snr: number | null; rssi: number | null; text: string | null;
      timestamp: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      senderId: r.sender_id,
      senderLat: r.sender_lat,
      senderLng: r.sender_lng,
      seq: r.seq,
      snr: r.snr,
      rssi: r.rssi,
      text: r.text,
      timestamp: r.timestamp,
    }));
  }

  /** Bound the table to the most recent 5000 observations. */
  private pruneRangeTestObservations() {
    this.db.exec(`
      DELETE FROM range_test_observations
      WHERE id IN (
        SELECT id FROM range_test_observations
        ORDER BY timestamp DESC
        LIMIT -1 OFFSET 5000
      )
    `);
  }

  // ---------------------------------------------------------------------
  // Blocked nodes (server-side block list — visible to every client)
  // ---------------------------------------------------------------------
  loadBlockedNodes(): string[] {
    const rows = this.db.prepare(`
      SELECT node_id FROM blocked_nodes ORDER BY blocked_at ASC
    `).all() as Array<{ node_id: string }>;
    return rows.map(r => r.node_id);
  }

  addBlockedNode(nodeId: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO blocked_nodes (node_id, blocked_at)
      VALUES (?, ?)
    `).run(nodeId, Date.now());
    return Number((result as any).changes ?? 0) > 0;
  }

  removeBlockedNode(nodeId: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM blocked_nodes WHERE node_id = ?
    `).run(nodeId);
    return Number((result as any).changes ?? 0) > 0;
  }

  // ---------------------------------------------------------------------
  // Node sessions (online/offline transition history)
  // ---------------------------------------------------------------------

  /**
   * Record that we just observed a node go online. If there's already an open
   * session (offline_at IS NULL) for this node, this is a no-op so we don't
   * generate spurious overlapping sessions on duplicate "online" events.
   */
  openNodeSession(nodeId: string, onlineAt: number): void {
    const existingOpen = this.db.prepare(`
      SELECT id FROM node_sessions WHERE node_id = ? AND offline_at IS NULL LIMIT 1
    `).get(nodeId);
    if (existingOpen) return;
    this.db.prepare(`
      INSERT INTO node_sessions (node_id, online_at) VALUES (?, ?)
    `).run(nodeId, onlineAt);
  }

  /**
   * Close the most-recently-opened still-open session for this node by setting
   * offline_at. No-op if no open session exists (e.g. server restart while node
   * was already offline).
   */
  closeNodeSession(nodeId: string, offlineAt: number): void {
    this.db.prepare(`
      UPDATE node_sessions
         SET offline_at = ?
       WHERE id = (SELECT id FROM node_sessions WHERE node_id = ? AND offline_at IS NULL ORDER BY online_at DESC LIMIT 1)
    `).run(offlineAt, nodeId);
  }

  /**
   * Sessions for a single node within the given time window (epoch ms cutoff).
   * Sessions that overlap the cutoff are returned with their original
   * online_at — the caller is expected to clamp display ranges as needed.
   */
  getNodeSessions(nodeId: string, sinceMs?: number, limit = 1000): Array<{ onlineAt: number; offlineAt: number | null }> {
    const since = sinceMs ?? 0;
    const rows = this.db.prepare(`
      SELECT online_at, offline_at FROM node_sessions
       WHERE node_id = ?
         AND (offline_at IS NULL OR offline_at >= ?)
       ORDER BY online_at DESC
       LIMIT ?
    `).all(nodeId, since, limit) as Array<{ online_at: number; offline_at: number | null }>;
    return rows.map(r => ({ onlineAt: r.online_at, offlineAt: r.offline_at }));
  }

  /** Bound the table; keep at most the most recent N sessions across all nodes. */
  pruneNodeSessions(maxRows = 100_000) {
    this.db.exec(`
      DELETE FROM node_sessions
      WHERE id IN (
        SELECT id FROM node_sessions ORDER BY online_at DESC LIMIT -1 OFFSET ${Math.max(1, maxRows | 0)}
      )
    `);
  }

  /**
   * Close any session that's still marked open at the given cutoff. Called on
   * bridge boot to flush sessions that were left dangling by a previous crash
   * or restart. Sets `offline_at = cutoffMs` for every still-open row.
   */
  closeOrphanedSessions(cutoffMs: number): number {
    const result = this.db.prepare(`
      UPDATE node_sessions SET offline_at = ? WHERE offline_at IS NULL
    `).run(cutoffMs);
    return Number((result as any).changes ?? 0);
  }

  /**
   * Roll up a per-node uptime summary across the given window. Returns one row
   * per node that's been seen in the window, including aggregate session
   * length stats and a 24-element peak-hours histogram (UTC hours).
   */
  computeNodeUptime(windowMs: number, nowMs = Date.now()): Array<{
    nodeId: string;
    sessions: number;
    onlineMs: number;
    avgSessionMs: number | null;
    peakHourCounts: number[];   // length 24, hour-of-day → ms-online-this-hour
    lastOnlineAt: number | null;
  }> {
    const sinceMs = nowMs - windowMs;
    const rows = this.db.prepare(`
      SELECT node_id, online_at, offline_at FROM node_sessions
       WHERE (offline_at IS NULL OR offline_at >= ?)
         AND online_at <= ?
    `).all(sinceMs, nowMs) as Array<{ node_id: string; online_at: number; offline_at: number | null }>;

    type Acc = { sessions: number; onlineMs: number; sumMs: number; peak: number[]; lastOnlineAt: number };
    const byNode = new Map<string, Acc>();
    for (const r of rows) {
      const start = Math.max(r.online_at, sinceMs);
      const end = Math.min(r.offline_at ?? nowMs, nowMs);
      if (end <= start) continue;
      const dur = end - start;

      let acc = byNode.get(r.node_id);
      if (!acc) {
        acc = { sessions: 0, onlineMs: 0, sumMs: 0, peak: new Array(24).fill(0), lastOnlineAt: 0 };
        byNode.set(r.node_id, acc);
      }
      acc.sessions += 1;
      acc.onlineMs += dur;
      acc.sumMs += dur;
      if (end > acc.lastOnlineAt) acc.lastOnlineAt = end;

      // Distribute the session's duration across the hour-of-day buckets it
      // crosses. We sample at minute granularity to keep the math simple.
      const minutes = Math.ceil(dur / 60_000);
      for (let i = 0; i < minutes; i++) {
        const t = start + i * 60_000;
        if (t >= end) break;
        const hr = new Date(t).getUTCHours();
        acc.peak[hr] += Math.min(60_000, end - t);
      }
    }

    return Array.from(byNode.entries()).map(([nodeId, a]) => ({
      nodeId,
      sessions: a.sessions,
      onlineMs: a.onlineMs,
      avgSessionMs: a.sessions ? a.sumMs / a.sessions : null,
      peakHourCounts: a.peak,
      lastOnlineAt: a.lastOnlineAt || null,
    }));
  }

  // ---------------------------------------------------------------------
  // Store & Forward routers
  // ---------------------------------------------------------------------
  upsertStoreForwardRouter(r: MeshStoreForwardRouter) {
    this.db.prepare(`
      INSERT INTO store_forward_routers (node_id, period_secs, is_secondary, last_heartbeat, stats_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        period_secs    = excluded.period_secs,
        is_secondary   = excluded.is_secondary,
        last_heartbeat = excluded.last_heartbeat,
        stats_json     = COALESCE(excluded.stats_json, store_forward_routers.stats_json)
    `).run(
      r.nodeId,
      r.periodSecs,
      r.isSecondary ? 1 : 0,
      r.lastHeartbeat,
      r.stats ? JSON.stringify(r.stats) : null,
    );
  }

  loadStoreForwardRouters(): MeshStoreForwardRouter[] {
    const rows = this.db.prepare(`
      SELECT node_id, period_secs, is_secondary, last_heartbeat, stats_json
      FROM store_forward_routers
      ORDER BY last_heartbeat DESC
    `).all() as Array<{
      node_id: string; period_secs: number; is_secondary: number;
      last_heartbeat: number; stats_json: string | null;
    }>;
    return rows.map(r => ({
      nodeId: r.node_id,
      periodSecs: r.period_secs,
      isSecondary: !!r.is_secondary,
      lastHeartbeat: r.last_heartbeat,
      stats: r.stats_json ? safeParse<any>(r.stats_json) ?? undefined : undefined,
    }));
  }

  loadWaypoints(): MeshWaypoint[] {
    // Drop expired entries on read so they don't linger forever.
    const nowSec = Math.floor(Date.now() / 1000);
    this.db.prepare(`DELETE FROM waypoints WHERE expire > 0 AND expire < ?`).run(nowSec);

    const rows = this.db.prepare(`
      SELECT id, lat, lng, name, description, icon, expire, locked_to, created_by, last_seen
      FROM waypoints
      ORDER BY last_seen DESC
    `).all() as Array<{
      id: number; lat: number; lng: number;
      name: string | null; description: string | null; icon: number | null;
      expire: number; locked_to: number; created_by: string | null; last_seen: number;
    }>;

    return rows.map(r => ({
      id: r.id,
      lat: r.lat,
      lng: r.lng,
      name: r.name ?? '',
      description: r.description ?? '',
      icon: r.icon ?? 0,
      expire: r.expire,
      lockedTo: r.locked_to,
      createdBy: r.created_by ?? '',
      lastSeen: r.last_seen,
    }));
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
        id, from_id, to_id, channel, text, timestamp, hop_limit,
        rx_snr, rx_rssi, hops_json, status, error_code, is_own,
        packet_id, reply_to, is_reaction, delivery_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      msg.status ?? null,
      typeof msg.errorCode === 'number' ? msg.errorCode : null,
      msg.isOwn ? 1 : 0,
      typeof msg.packetId === 'number' ? msg.packetId : null,
      typeof msg.replyTo === 'number' ? msg.replyTo : null,
      msg.isReaction ? 1 : 0,
      typeof msg.deliveryMs === 'number' ? msg.deliveryMs : null,
    );
    this.pruneMessages();
  }

  loadMessages(limit = LOAD_MESSAGES): MeshMessage[] {
    const rows = this.db.prepare(`
      SELECT id, from_id, to_id, channel, text, timestamp, hop_limit,
             rx_snr, rx_rssi, hops_json, status, error_code, is_own,
             packet_id, reply_to, is_reaction, delivery_ms
      FROM messages
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string; from_id: string; to_id: string; channel: string | null;
      text: string; timestamp: number; hop_limit: number | null;
      rx_snr: number | null; rx_rssi: number | null; hops_json: string | null;
      status: string | null; error_code: number | null; is_own: number;
      packet_id: number | null; reply_to: number | null; is_reaction: number;
      delivery_ms: number | null;
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
      status: (r.status as MeshMessage['status']) ?? undefined,
      errorCode: r.error_code ?? undefined,
      isOwn: !!r.is_own,
      packetId: r.packet_id ?? undefined,
      replyTo: r.reply_to ?? undefined,
      isReaction: r.is_reaction ? true : undefined,
      deliveryMs: r.delivery_ms ?? undefined,
    }) as MeshMessage);
  }

  private pruneMessages() {
    this.db.prepare(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM messages ORDER BY timestamp DESC LIMIT -1 OFFSET ?
      )
    `).run(MAX_MESSAGES);
  }

  /** Delete messages older than the given epoch-ms cutoff. Returns rows removed. */
  pruneMessagesOlderThan(cutoffMs: number): number {
    const result = this.db.prepare(`DELETE FROM messages WHERE timestamp < ?`).run(cutoffMs);
    return Number((result as any).changes ?? 0);
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

  /** Delete events older than the given epoch-ms cutoff. Returns rows removed. */
  pruneEventsOlderThan(cutoffMs: number): number {
    const result = this.db.prepare(`DELETE FROM events WHERE timestamp < ?`).run(cutoffMs);
    return Number((result as any).changes ?? 0);
  }

  // ---------------------------------------------------------------------
  // Channels
  // ---------------------------------------------------------------------
  upsertChannel(ch: MeshChannel) {
    this.db.prepare(`
      INSERT INTO channels (idx, name, role, psk_b64, uplink, downlink, position_precision, updated_at)
      VALUES (@idx, @name, @role, @psk_b64, @uplink, @downlink, @position_precision, @updated_at)
      ON CONFLICT(idx) DO UPDATE SET
        name               = excluded.name,
        role               = excluded.role,
        psk_b64            = excluded.psk_b64,
        uplink             = excluded.uplink,
        downlink           = excluded.downlink,
        position_precision = excluded.position_precision,
        updated_at         = excluded.updated_at
    `).run({
      idx: ch.index,
      name: ch.name,
      role: ch.role,
      psk_b64: ch.pskBase64,
      uplink: ch.uplinkEnabled ? 1 : 0,
      downlink: ch.downlinkEnabled ? 1 : 0,
      position_precision: ch.positionPrecision ?? null,
      updated_at: Date.now(),
    });
  }

  loadChannels(): MeshChannel[] {
    const rows = this.db.prepare(`SELECT * FROM channels ORDER BY idx`).all() as Array<{
      idx: number; name: string; role: string;
      psk_b64: string; uplink: number; downlink: number;
      position_precision: number | null;
    }>;
    return rows.map(r => ({
      index: r.idx,
      name: r.name,
      role: r.role as ChannelRole,
      pskBase64: r.psk_b64,
      uplinkEnabled: !!r.uplink,
      downlinkEnabled: !!r.downlink,
      positionPrecision: r.position_precision ?? undefined,
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
