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
  private dbPath: string;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.runMigrations();
    console.log(`[MeshDB] Opened ${dbPath}`);
  }

  getDbPath(): string {
    return this.dbPath;
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

      -- BBS mail. Body-only (no subject) to keep the send flow at three messages
      -- per the design. 200-char body cap enforced at insert time. Auto-pruned
      -- after 30 days regardless of read state.
      CREATE TABLE IF NOT EXISTS bbs_mail (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_node_id     TEXT NOT NULL,
        sender_short_name  TEXT NOT NULL,
        recipient_node_id  TEXT NOT NULL,
        posted_at          INTEGER NOT NULL,
        body               TEXT NOT NULL,
        read_at            INTEGER,
        delivered_at       INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_bbs_mail_recipient ON bbs_mail(recipient_node_id, posted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bbs_mail_unread ON bbs_mail(recipient_node_id) WHERE read_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_bbs_mail_sender ON bbs_mail(sender_node_id, posted_at DESC);

      -- Weather alert subscribers. Each row is a node that has DM'd
      -- ":weather subscribe [ZIP]" to opt into proactive alerts. zip is the
      -- 5-digit ZIP the subscriber asked to be alerted for; NULL falls back
      -- to the operator's homeZipCode (preserves the original behavior for
      -- pre-Beta-4 subscribers). channel_index is remembered so we reply on
      -- the same channel they subscribed on (encryption parity).
      CREATE TABLE IF NOT EXISTS bbs_weather_subscribers (
        node_id        TEXT PRIMARY KEY,
        subscribed_at  INTEGER NOT NULL,
        channel_index  INTEGER NOT NULL DEFAULT 0,
        last_alert_at  INTEGER,
        zip            TEXT
      );

      -- Per-node position history. Backs the iOS-style "Position Log" view in
      -- the node detail panel. We write a row every time a Position arrives
      -- (POSITION_APP packet OR NodeInfo-embedded position). Tracks lat/lng/
      -- alt/source/precision at the moment of arrival. Caller-side dedup not
      -- needed — every row is a discrete data point with its own timestamp.
      CREATE TABLE IF NOT EXISTS position_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id         TEXT NOT NULL,
        timestamp       INTEGER NOT NULL,
        lat             REAL NOT NULL,
        lng             REAL NOT NULL,
        alt             REAL,
        source          TEXT,
        precision_bits  INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_pos_hist_node_ts ON position_history(node_id, timestamp DESC);

      -- v2.0: multi-radio support. Each row is one configured radio. The
      -- radio_id is the 4-char Meshtastic short_name (User.short_name), kept
      -- unique across the deployment. Existing single-radio installs get
      -- their current radio auto-registered on first 2.0 boot.
      CREATE TABLE IF NOT EXISTS radios (
        radio_id        TEXT PRIMARY KEY,
        long_name       TEXT NOT NULL,
        transport       TEXT NOT NULL,
        target          TEXT NOT NULL,
        region          TEXT,
        modem_preset    TEXT,
        frequency_slot  INTEGER,
        primary_channel TEXT,
        num_hops        INTEGER DEFAULT 3,
        enabled         INTEGER NOT NULL DEFAULT 1,
        color_hex       TEXT,
        network_label   TEXT,
        is_default      INTEGER NOT NULL DEFAULT 0,
        -- v2.0 Beta 4: BBS-only mode. When 1, this radio auto-replies to
        -- any DM that ISN'T a BBS command with the command index. Lets a
        -- multi-radio operator dedicate one radio as a BBS endpoint while
        -- another stays a general chat node. The original DM still gets
        -- stored so the operator can see who's pinging the BBS; only the
        -- auto-reply behavior is new.
        bbs_only        INTEGER NOT NULL DEFAULT 0,
        -- v2.0 Beta 5 Phase 2 (Services Pattern): "this radio runs the
        -- install's BBS service." At most one row has this set (UI +
        -- setBbsNodeRadio() enforce mutex). When set, the BBS state
        -- machine intercepts incoming DMs only on this bridge; the
        -- WeatherAlertPoller routes outbound alerts + the daily
        -- forecast through this bridge. Other radios stay as
        -- general-purpose operator endpoints. Distinct from bbs_only
        -- which is purely the auto-reply UX; operators typically set
        -- both on the BBS radio (the "services" radio in the Home
        -- workspace).
        is_bbs_node     INTEGER NOT NULL DEFAULT 0,
        -- v2.0 Beta 5 Workspaces: which workspace owns this radio. NULL
        -- only during the migration window before bootstrapMultiTenant()
        -- runs; afterward every radio has a workspace. Cascade SET NULL
        -- when a workspace is deleted (the radio survives but becomes
        -- unassigned — admin gets prompted to reassign).
        workspace_id    INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_radios_enabled ON radios(enabled);

      -- v2.0 Beta 5: multi-user authentication.
      --
      -- users table = the local-account directory. password_hash is the
      -- full "scrypt$<salt-b64>$<hash-b64>" form produced by auth.ts;
      -- algorithm prefix lets us migrate to a stronger KDF later
      -- without a schema break. role is checked at the API layer.
      --
      -- sessions table is keyed by an opaque random token. The cookie
      -- sent to the client is a signed wrapper around this token (HMAC
      -- over AUTH_SECRET) so tampering is detected without a DB lookup.
      -- expires_at is renewed by resolveSession via the sliding-expiry
      -- rule (refresh if within 24h of expiring).
      CREATE TABLE IF NOT EXISTS users (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash   TEXT NOT NULL,
        role            TEXT NOT NULL CHECK(role IN ('admin', 'viewer')),
        created_at      INTEGER NOT NULL,
        last_login_at   INTEGER,
        locked          INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS sessions (
        token           TEXT PRIMARY KEY,
        user_id         INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL,
        ip_first_seen   TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

      -- v2.0 Beta 5 Workspaces: multi-tenant scoping.
      --
      -- A workspace is a container for radios + the messages/channels/
      -- BBS that come from them. Each radio belongs to exactly one
      -- workspace; users can be members of multiple workspaces and
      -- switch between them. Designed for the family use case ("each
      -- household member sees their subset of the shared radios"):
      -- create one "Household" workspace for shared infra, plus one
      -- workspace per person for their personal radios.
      --
      -- The default workspace_id on radios is set during bootstrap
      -- migration (auto-creates a "Household" workspace + assigns
      -- every existing radio to it + adds every existing user as a
      -- member). After migration the column is effectively NOT NULL.
      CREATE TABLE IF NOT EXISTS workspaces (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        slug            TEXT NOT NULL UNIQUE COLLATE NOCASE,
        owner_user_id   INTEGER,
        created_at      INTEGER NOT NULL,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id    INTEGER NOT NULL,
        user_id         INTEGER NOT NULL,
        joined_at       INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, user_id),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id)      REFERENCES users(id)      ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ws_members_user ON workspace_members(user_id);

      -- v2.0 Beta 5 Labeled Devices: lightweight "managed e-ink labels"
      -- (Heltec Vision Master, etc.) used as physical signage — tap
      -- labels, station IDs, room signs. The device's long_name is the
      -- displayed text on its e-paper home screen; this table holds
      -- the connection info + last-pushed label so Sentinel can do a
      -- one-shot TCP connect → AdminMessage.set_owner → disconnect
      -- without holding a persistent bridge per device. Scales to
      -- many more devices than the full radio bridge path can on a
      -- constrained host like the Jetson Nano 2GB.
      CREATE TABLE IF NOT EXISTS labeled_devices (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id    INTEGER NOT NULL,
        display_name    TEXT NOT NULL,
        host            TEXT NOT NULL,
        port            INTEGER NOT NULL DEFAULT 4403,
        current_label   TEXT,
        current_short   TEXT,
        last_pushed_at  INTEGER,
        last_error      TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_labeled_devices_ws ON labeled_devices(workspace_id);

      -- v2.0 Beta 5 Phase 4: per-user preferences.
      --
      -- Generic key/value store, one row per (user, key). value is a
      -- JSON-serialized blob so the same schema covers numbers, strings,
      -- objects, arrays, and Map<string, X> shapes (e.g. read status
      -- timestamps). Keeping it generic means new prefs land without
      -- schema migrations.
      --
      -- Cascade-delete with the user — deleting an account drops all
      -- their saved state in one shot, no orphaned rows.
      CREATE TABLE IF NOT EXISTS user_prefs (
        user_id      INTEGER NOT NULL,
        key          TEXT NOT NULL,
        value_json   TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_user_prefs_user ON user_prefs(user_id);

      -- v2.0.0 (post-GA) Web Push: per-user browser push subscriptions.
      --
      -- A single user can have multiple subscriptions (phone, laptop,
      -- desktop browser) so the natural key is (user_id, endpoint).
      -- The endpoint is the URL the push service hands back from
      -- pushManager.subscribe(); p256dh + auth are the per-subscription
      -- crypto material the push service expects on every send.
      --
      -- categories holds the per-subscription opt-in mask as a JSON
      -- array of strings — empty array means "subscribed but muted,"
      -- letting the user disable without re-prompting the browser for
      -- permission. user_agent is informational (helps the operator
      -- recognize "this is my work laptop" in Settings → Notifications).
      --
      -- Cascade-delete with the user so deleting an account drops their
      -- push subscriptions too — no orphaned rows pinging dead push
      -- endpoints forever.
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          INTEGER NOT NULL,
        endpoint         TEXT NOT NULL,
        p256dh           TEXT NOT NULL,
        auth_secret      TEXT NOT NULL,
        categories_json  TEXT NOT NULL DEFAULT '["dm","mention","outage","weather"]',
        user_agent       TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (user_id, endpoint)
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
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
    // v2.0 Beta 5 Workspaces (per-workspace primary): explicit choice of
    // which radio is "the primary" for this workspace, used by
    // workspacePrimaryBridge() to override the implicit heuristic.
    // NULL means fall back to the heuristic (install default in this
    // workspace → first connected → first assigned).
    //
    // Foreign-key behavior on radio deletion: SET NULL via app-layer
    // because SQLite can't add FKs to existing tables. The radios
    // DELETE endpoint runs a clearing UPDATE.
    addColumnIfMissing('workspaces', 'primary_radio_id TEXT');
    addColumnIfMissing('messages', 'status TEXT');
    addColumnIfMissing('messages', 'error_code INTEGER');
    addColumnIfMissing('messages', 'is_own INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('messages', 'packet_id INTEGER');
    addColumnIfMissing('messages', 'reply_to INTEGER');
    addColumnIfMissing('messages', 'is_reaction INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('messages', 'delivery_ms INTEGER');
    addColumnIfMissing('channels', 'position_precision INTEGER');
    addColumnIfMissing('bbs_weather_subscribers', 'zip TEXT');
    addColumnIfMissing('radios', 'bbs_only INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('radios', 'is_bbs_node INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('radios', 'workspace_id INTEGER');

    // v2.0 Beta 5 Phase 2 (Services Pattern) one-shot migration:
    // if NO radio is currently designated as the BBS node AND exactly
    // ONE radio has bbs_only=1, promote that one. Operators who
    // already chose a single "BBS endpoint" radio with the existing
    // bbs_only flag get a sane default; operators with zero or
    // multiple bbs_only radios need to pick explicitly in Settings.
    try {
      const haveBbsNode = (this.db.prepare(
        `SELECT COUNT(*) AS c FROM radios WHERE is_bbs_node = 1`
      ).get() as { c: number }).c > 0;
      if (!haveBbsNode) {
        const candidates = this.db.prepare(
          `SELECT radio_id FROM radios WHERE bbs_only = 1`
        ).all() as Array<{ radio_id: string }>;
        if (candidates.length === 1) {
          this.db.prepare(
            `UPDATE radios SET is_bbs_node = 1 WHERE radio_id = ?`
          ).run(candidates[0].radio_id);
          console.log(`[MeshDB] Auto-promoted radio "${candidates[0].radio_id}" to is_bbs_node (sole bbs_only=1 radio at migration time)`);
        }
      }
    } catch (err: any) {
      console.warn('[MeshDB] BBS-node migration warning:', err.message);
    }

    // Workspaces bootstrap migration. Runs idempotently every boot —
    // safe to call repeatedly. Creates a default "Household" workspace
    // and assigns every existing user + radio to it on first boot
    // post-Workspaces. Subsequent boots no-op.
    this.bootstrapWorkspaces();

    // v2.0 multi-radio additive migration. Every radio-scoped table gets a
    // radio_id column. Stays nullable for the migration window so existing
    // rows aren't rejected; BridgeManager backfills NULLs to the
    // auto-registered default radio's short_name on first 2.0 boot.
    const RADIO_SCOPED_TABLES = [
      'nodes', 'messages', 'events', 'channels', 'telemetry', 'waypoints',
      'neighbor_info', 'store_forward_routers', 'trace_results',
      'range_test_observations', 'blocked_nodes', 'node_sessions',
      'bbs_mail', 'bbs_weather_subscribers', 'position_history',
    ];
    for (const t of RADIO_SCOPED_TABLES) {
      addColumnIfMissing(t, 'radio_id TEXT');
    }
    // Indexes on radio_id for the high-cardinality / high-query tables.
    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_radio_id    ON nodes(radio_id);
        CREATE INDEX IF NOT EXISTS idx_messages_radio_id ON messages(radio_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_events_radio_id   ON events(radio_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_pos_hist_radio    ON position_history(radio_id, node_id, timestamp DESC);
      `);
    } catch (err: any) {
      console.warn('[MeshDB] v2 radio_id index creation warning:', err.message);
    }

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

    // v2.0 multi-radio: merge heardByRadios + lastHeardAtPerRadio with any
    // already-persisted state. Without this, two bridges writing the same
    // node clobber each other's attribution because raw_json is fully
    // overwritten on conflict. We read the existing row, merge, and let the
    // writer continue with the combined view.
    try {
      const existing = this.db.prepare(`SELECT raw_json FROM nodes WHERE id = ?`).get(node.id) as { raw_json: string } | undefined;
      if (existing) {
        const prev = safeParse<MeshNode>(existing.raw_json);
        if (prev) {
          const prevHeard = prev.heardByRadios ?? [];
          const nextHeard = node.heardByRadios ?? [];
          // Combine, deduplicate, newest-first (so the bridge that just wrote
          // is at index 0).
          const seen = new Set<string>();
          const merged: string[] = [];
          for (const r of [...nextHeard, ...prevHeard]) {
            if (!seen.has(r)) { seen.add(r); merged.push(r); }
          }
          if (merged.length > 0) node.heardByRadios = merged;

          const prevAt = prev.lastHeardAtPerRadio ?? {};
          const nextAt = node.lastHeardAtPerRadio ?? {};
          const mergedAt: Record<string, number> = { ...prevAt };
          for (const [rid, t] of Object.entries(nextAt)) {
            mergedAt[rid] = Math.max(mergedAt[rid] ?? 0, t);
          }
          if (Object.keys(mergedAt).length > 0) node.lastHeardAtPerRadio = mergedAt;
        }
      }
    } catch (err: any) {
      // Best-effort merge; don't fail the write.
      console.warn('[MeshDB] heardByRadios merge skipped:', err.message);
    }

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
      first_seen: node.firstSeen ?? node.lastSeen ?? now,
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
    // Pull the first_seen column alongside raw_json so older nodes whose
    // raw_json predates the firstSeen field get backfilled from the column.
    // This guarantees every node we hand back has a firstSeen value, which
    // the UI can show as "First heard X ago" without null-handling.
    const rows = this.db.prepare(
      `SELECT raw_json, first_seen FROM nodes`
    ).all() as { raw_json: string; first_seen: number | null }[];
    const out: MeshNode[] = [];
    for (const r of rows) {
      try {
        const node = JSON.parse(r.raw_json) as MeshNode;
        if (node.firstSeen === undefined && r.first_seen) {
          node.firstSeen = r.first_seen;
        }
        out.push(node);
      } catch { /* skip corrupt row */ }
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
  insertMessage(msg: MeshMessage, radioId: string | null = null) {
    this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, from_id, to_id, channel, text, timestamp, hop_limit,
        rx_snr, rx_rssi, hops_json, status, error_code, is_own,
        packet_id, reply_to, is_reaction, delivery_ms, radio_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      radioId,
    );
    this.pruneMessages();
  }

  loadMessages(limit = LOAD_MESSAGES): MeshMessage[] {
    const rows = this.db.prepare(`
      SELECT id, from_id, to_id, channel, text, timestamp, hop_limit,
             rx_snr, rx_rssi, hops_json, status, error_code, is_own,
             packet_id, reply_to, is_reaction, delivery_ms, radio_id
      FROM messages
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string; from_id: string; to_id: string; channel: string | null;
      text: string; timestamp: number; hop_limit: number | null;
      rx_snr: number | null; rx_rssi: number | null; hops_json: string | null;
      status: string | null; error_code: number | null; is_own: number;
      packet_id: number | null; reply_to: number | null; is_reaction: number;
      delivery_ms: number | null; radio_id: string | null;
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
      radioId: r.radio_id ?? undefined,
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

  /**
   * v2.0 Beta 5: server-side CSV export queries.
   *
   * The legacy ExportModal filters props.messages / props.events in the
   * browser, which only ever sees what the snapshot endpoint loaded
   * (most-recent N rows). A "messages from last month" export would
   * silently return empty even with the rows present in SQLite. These
   * helpers go to the source of truth so date ranges actually work.
   *
   * Each returns ASC by timestamp so a CSV-row reader can stream
   * chronologically without re-sorting. All filters are optional.
   */
  exportMessages(opts: {
    fromMs?: number;
    toMs?: number;
    nodeId?: string | null;
    radioId?: string | null;
  } = {}): Array<{
    id: string;
    fromId: string;
    toId: string;
    channel: string | null;
    text: string;
    timestamp: number;
    isOwn: number;
    isReaction: number;
    hopLimit: number | null;
    rxSnr: number | null;
    rxRssi: number | null;
    status: string | null;
    errorCode: number | null;
    deliveryMs: number | null;
    radioId: string | null;
  }> {
    const where: string[] = [];
    const params: any[] = [];
    if (typeof opts.fromMs === 'number') { where.push('timestamp >= ?'); params.push(opts.fromMs); }
    if (typeof opts.toMs === 'number')   { where.push('timestamp <= ?'); params.push(opts.toMs); }
    if (opts.nodeId)                     { where.push('(from_id = ? OR to_id = ?)'); params.push(opts.nodeId, opts.nodeId); }
    if (opts.radioId)                    { where.push('(radio_id = ? OR radio_id IS NULL)'); params.push(opts.radioId); }
    const sql = `
      SELECT id, from_id AS fromId, to_id AS toId, channel, text, timestamp,
             is_own AS isOwn, is_reaction AS isReaction,
             hop_limit AS hopLimit, rx_snr AS rxSnr, rx_rssi AS rxRssi,
             status, error_code AS errorCode, delivery_ms AS deliveryMs,
             radio_id AS radioId
      FROM messages
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY timestamp ASC
    `;
    return this.db.prepare(sql).all(...params) as any;
  }

  exportEvents(opts: {
    fromMs?: number;
    toMs?: number;
    nodeId?: string | null;
    radioId?: string | null;
  } = {}): Array<{
    id: string;
    type: string;
    nodeId: string | null;
    timestamp: number;
    details: string;
    radioId: string | null;
  }> {
    const where: string[] = [];
    const params: any[] = [];
    if (typeof opts.fromMs === 'number') { where.push('timestamp >= ?'); params.push(opts.fromMs); }
    if (typeof opts.toMs === 'number')   { where.push('timestamp <= ?'); params.push(opts.toMs); }
    if (opts.nodeId)                     { where.push('node_id = ?'); params.push(opts.nodeId); }
    if (opts.radioId)                    { where.push('(radio_id = ? OR radio_id IS NULL)'); params.push(opts.radioId); }
    const sql = `
      SELECT id, type, node_id AS nodeId, timestamp, details, radio_id AS radioId
      FROM events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY timestamp ASC
    `;
    return this.db.prepare(sql).all(...params) as any;
  }

  /** Telemetry has no radio_id column (it's per-node, not per-radio), so the
   *  radioId filter is intentionally absent. The node_id filter is the
   *  authoritative scope for telemetry exports. */
  exportTelemetry(opts: {
    fromMs?: number;
    toMs?: number;
    nodeId?: string | null;
  } = {}): Array<{
    nodeId: string;
    timestamp: number;
    battery: number | null;
    voltage: number | null;
    chUtil: number | null;
    airUtilTx: number | null;
    snr: number | null;
    rssi: number | null;
    temperature: number | null;
    humidity: number | null;
    pressure: number | null;
  }> {
    const where: string[] = [];
    const params: any[] = [];
    if (typeof opts.fromMs === 'number') { where.push('timestamp >= ?'); params.push(opts.fromMs); }
    if (typeof opts.toMs === 'number')   { where.push('timestamp <= ?'); params.push(opts.toMs); }
    if (opts.nodeId)                     { where.push('node_id = ?'); params.push(opts.nodeId); }
    const sql = `
      SELECT node_id AS nodeId, timestamp, battery, voltage,
             ch_util AS chUtil, air_util_tx AS airUtilTx,
             snr, rssi, temperature, humidity, pressure
      FROM telemetry
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY timestamp ASC
    `;
    return this.db.prepare(sql).all(...params) as any;
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------
  insertEvent(ev: MeshEvent, radioId: string | null = null) {
    this.db.prepare(`
      INSERT OR REPLACE INTO events (id, type, node_id, timestamp, details, radio_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ev.id, ev.type, ev.nodeId ?? null, ev.timestamp, ev.details, radioId);
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

  // -------------------------------------------------------------------
  // v2.0 Beta 3: full-fidelity backup helpers.
  //
  // The encrypted-backup endpoint started life capturing only the radios
  // registry + channels + BBS config (enough to migrate a fresh install
  // and let it decrypt the same mesh). For a real "move this dev console
  // to my long-term host" workflow that's not enough — operator data
  // (groups, waypoints, block list, BBS mail, weather subscribers) lives
  // in the SQLite DB and would be lost.
  //
  // `dumpTable` returns raw SQLite rows for a single table by name; the
  // backup endpoint composes those into a versioned envelope. We gate on
  // an explicit allowlist of table names so the public surface can't be
  // tricked into SELECT-ing from arbitrary identifiers.
  //
  // `loadTable` reverses the dump: INSERT OR REPLACE for each row using
  // the columns present on the first row. Returns the count inserted.
  // Use within a transaction at the call site for atomicity.
  // -------------------------------------------------------------------

  private static readonly EXPORTABLE_TABLES = new Set([
    'radios', 'channels',
    'groups', 'waypoints', 'blocked_nodes',
    'bbs_mail', 'bbs_weather_subscribers',
    // v2.0 Beta 5: multi-user accounts. Carries username + hash + role
    // across migrations. Sessions deliberately NOT in this list — they're
    // per-host transient state.
    'users',
    // v2.0 Beta 5 Workspaces: tenant scoping. workspaces + memberships
    // round-trip so a backup-then-restore preserves the multi-tenant
    // layout (otherwise the restore re-runs bootstrapWorkspaces and
    // throws everything into one Household).
    'workspaces', 'workspace_members',
    // history (opt-in)
    'nodes', 'messages', 'events', 'telemetry',
    'neighbor_info', 'store_forward_routers',
    'position_history', 'trace_results', 'range_test_observations',
  ]);

  dumpTable(table: string): any[] {
    if (!MeshDatabase.EXPORTABLE_TABLES.has(table)) {
      throw new Error(`table "${table}" is not exportable`);
    }
    return this.db.prepare(`SELECT * FROM ${table}`).all() as any[];
  }

  loadTable(table: string, rows: any[], opts?: { truncate?: boolean }): number {
    if (!MeshDatabase.EXPORTABLE_TABLES.has(table)) {
      throw new Error(`table "${table}" is not exportable`);
    }
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    // v2.0 Beta 4 (Item 10): schema-drift recovery. If the backup envelope
    // was produced by a newer build with extra columns (or has stale
    // columns from an older build that we've since dropped), the raw row
    // would fail to INSERT against the current schema with "no column
    // named X" or "table has no column …". Intersect the backup's
    // first-row columns with the current schema's actual columns before
    // building the INSERT statement. Anything in the backup but missing
    // here gets dropped silently with a one-time log; anything in the
    // current schema but missing from the backup is left to its column
    // default (or NULL). Rows still INSERT OR REPLACE — same upsert
    // semantics as before, just on the column subset that exists in both.
    const liveCols = new Set<string>(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(r => r.name)
    );
    const backupCols = Object.keys(rows[0]);
    const cols = backupCols.filter(c => liveCols.has(c));
    if (cols.length === 0) {
      console.warn(`[MeshDB] loadTable ${table}: no column overlap between backup and current schema, skipping table`);
      return 0;
    }
    const dropped = backupCols.filter(c => !liveCols.has(c));
    if (dropped.length > 0) {
      console.warn(`[MeshDB] loadTable ${table}: dropping ${dropped.length} unknown column(s) from backup: ${dropped.join(', ')}`);
    }

    const placeholders = cols.map(c => `@${c}`).join(', ');
    const colList = cols.join(', ');
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO ${table} (${colList}) VALUES (${placeholders})`);
    const tx = this.db.transaction((batch: any[]) => {
      if (opts?.truncate) this.db.prepare(`DELETE FROM ${table}`).run();
      let n = 0;
      for (const row of batch) {
        // Build a row object containing ONLY the columns we'll bind. If
        // the source row is missing a current-schema column entirely,
        // bind null for it so the prepared statement's @-bindings still
        // resolve cleanly.
        const filtered: any = {};
        for (const c of cols) filtered[c] = row[c] ?? null;
        try {
          stmt.run(filtered);
          n++;
        } catch (e: any) {
          // Should be rare now that columns are pre-filtered; remaining
          // failures are typically PK / NOT NULL constraints from data
          // shape divergence (e.g., a NOT NULL column added since the
          // backup that has no default).
          console.warn(`[MeshDB] loadTable ${table}: skipped row — ${e.message}`);
        }
      }
      return n;
    });
    return tx(rows);
  }

  /**
   * Comprehensive per-table inventory for the Settings → Disk panel.
   *
   * For each table we return:
   *   - row count
   *   - oldest row's timestamp (if the table has a meaningful time column)
   *   - newest row's timestamp (likewise)
   *   - retention policy description (rendered by the UI)
   *
   * Caller is expected to derive total DB size from the file itself; we just
   * report what's INSIDE the DB here.
   */
  diskInventory(): Array<{
    table: string;
    rows: number;
    oldest: number | null;
    newest: number | null;
    retention: string;
  }> {
    const count = (sql: string): number => {
      try { return (this.db.prepare(sql).get() as { c: number }).c; }
      catch { return 0; }
    };
    const range = (table: string, col: string): { oldest: number | null; newest: number | null } => {
      try {
        const row = this.db.prepare(
          `SELECT MIN(${col}) AS lo, MAX(${col}) AS hi FROM ${table}`
        ).get() as { lo: number | null; hi: number | null };
        return { oldest: row.lo ?? null, newest: row.hi ?? null };
      } catch {
        return { oldest: null, newest: null };
      }
    };

    const out: Array<{ table: string; rows: number; oldest: number | null; newest: number | null; retention: string }> = [];

    const push = (table: string, rows: number, col: string | null, retention: string) => {
      const tr = col ? range(table, col) : { oldest: null, newest: null };
      out.push({ table, rows, oldest: tr.oldest, newest: tr.newest, retention });
    };

    push('nodes',                       count(`SELECT COUNT(*) AS c FROM nodes`),                       'last_seen',     'One row per known node (no prune)');
    push('messages',                    count(`SELECT COUNT(*) AS c FROM messages`),                    'timestamp',     `${MAX_MESSAGES}-row cap + retention window (Settings → Data)`);
    push('messages_fts',                count(`SELECT COUNT(*) AS c FROM messages_fts`),                null,            'Mirrors messages via FTS5 trigger');
    push('events',                      count(`SELECT COUNT(*) AS c FROM events`),                      'timestamp',     `${MAX_EVENTS}-row cap + retention window (Settings → Data)`);
    push('telemetry',                   count(`SELECT COUNT(*) AS c FROM telemetry`),                   'timestamp',     `${MAX_TELEMETRY_PER_NODE} rows per node`);
    push('channels',                    count(`SELECT COUNT(*) AS c FROM channels`),                    'updated_at',    'Up to 8 channels (firmware limit)');
    push('waypoints',                   count(`SELECT COUNT(*) AS c FROM waypoints`),                   'last_seen',     'Operator-controlled, no prune');
    push('neighbor_info',               count(`SELECT COUNT(*) AS c FROM neighbor_info`),               'last_seen',     'One row per node (replace, no prune)');
    push('store_forward_routers',       count(`SELECT COUNT(*) AS c FROM store_forward_routers`),       'last_heartbeat','One row per S&F router');
    push('groups',                      count(`SELECT COUNT(*) AS c FROM groups`),                      'created_at',    'Operator-controlled, no prune');
    push('trace_results',               count(`SELECT COUNT(*) AS c FROM trace_results`),               'started_at',    '500-row cap');
    push('range_test_observations',     count(`SELECT COUNT(*) AS c FROM range_test_observations`),     'timestamp',     '5000-row cap');
    push('blocked_nodes',               count(`SELECT COUNT(*) AS c FROM blocked_nodes`),               'blocked_at',    'Operator-controlled, no prune');
    push('node_sessions',               count(`SELECT COUNT(*) AS c FROM node_sessions`),               'online_at',     '100k-row cap (auto-pruned)');
    push('position_history',            count(`SELECT COUNT(*) AS c FROM position_history`),            'timestamp',     '30 days (auto-pruned)');
    push('bbs_mail',                    count(`SELECT COUNT(*) AS c FROM bbs_mail`),                    'posted_at',     '30 days (auto-pruned)');
    push('bbs_weather_subscribers',     count(`SELECT COUNT(*) AS c FROM bbs_weather_subscribers`),     'subscribed_at', 'Operator + subscriber controlled');

    return out;
  }

  /** Total bytes occupied by all rows + indexes, computed from the SQLite
   *  page allocator. This is the "logical" size — what the DB would compact
   *  to if you ran VACUUM. The on-disk file size (separate measurement)
   *  may include freed pages not yet reclaimed. */
  logicalDbBytes(): number {
    try {
      const pageCount = (this.db.pragma('page_count', { simple: true }) as number) ?? 0;
      const pageSize = (this.db.pragma('page_size', { simple: true }) as number) ?? 0;
      return pageCount * pageSize;
    } catch {
      return 0;
    }
  }

  /** Trigger a VACUUM to reclaim space from previously-deleted rows. Returns
   *  bytes freed (file size before − file size after). Expensive on large
   *  DBs — UI should warn before calling. */
  vacuum(): { freedBytes: number; finalBytes: number } {
    const before = this.logicalDbBytes();
    this.db.exec('VACUUM');
    const after = this.logicalDbBytes();
    return { freedBytes: Math.max(0, before - after), finalBytes: after };
  }

  // ---------------------------------------------------------------------
  // BBS Mail
  // ---------------------------------------------------------------------

  /** Insert a new piece of mail. Caller is responsible for trimming/validating
   *  body length. Returns the rowid so the caller can echo it back. */
  /**
   * Insert a BBS mail row. v2.0 multi-radio: when `radio_id` is supplied the
   * row is stamped with the receiving radio so loadInbox/loadOutbox can
   * scope per radio. Omitting it keeps 1.x behavior (radio_id stays NULL =
   * "any radio").
   */
  insertMail(row: {
    sender_node_id: string;
    sender_short_name: string;
    recipient_node_id: string;
    posted_at: number;
    body: string;
    radio_id?: string | null;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO bbs_mail (sender_node_id, sender_short_name, recipient_node_id, posted_at, body, radio_id)
      VALUES (@sender_node_id, @sender_short_name, @recipient_node_id, @posted_at, @body, @radio_id)
    `).run({
      sender_node_id: row.sender_node_id,
      sender_short_name: row.sender_short_name,
      recipient_node_id: row.recipient_node_id,
      posted_at: row.posted_at,
      body: row.body,
      radio_id: row.radio_id ?? null,
    });
    return Number(result.lastInsertRowid);
  }

  /**
   * Load mail rows for a specific recipient, newest first. v2.0 multi-radio:
   * pass `radioId` to scope to mail received on a specific radio (matches
   * either rows stamped with that radio_id OR legacy NULL rows, so 1.x data
   * remains visible).
   */
  loadInbox(recipientNodeId: string, limit = 200, radioId?: string | null): Array<{
    id: number; senderNodeId: string; senderShortName: string;
    postedAt: number; body: string; readAt: number | null;
    deliveredAt: number | null; radioId: string | null;
  }> {
    const sql = radioId
      ? `SELECT id, sender_node_id, sender_short_name, posted_at, body, read_at, delivered_at, radio_id
         FROM bbs_mail
         WHERE recipient_node_id = ? AND (radio_id = ? OR radio_id IS NULL)
         ORDER BY posted_at DESC LIMIT ?`
      : `SELECT id, sender_node_id, sender_short_name, posted_at, body, read_at, delivered_at, radio_id
         FROM bbs_mail
         WHERE recipient_node_id = ?
         ORDER BY posted_at DESC LIMIT ?`;
    const params = radioId ? [recipientNodeId, radioId, limit] : [recipientNodeId, limit];
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number; sender_node_id: string; sender_short_name: string;
      posted_at: number; body: string; read_at: number | null;
      delivered_at: number | null; radio_id: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      senderNodeId: r.sender_node_id,
      senderShortName: r.sender_short_name,
      postedAt: r.posted_at,
      body: r.body,
      readAt: r.read_at,
      deliveredAt: r.delivered_at,
      radioId: r.radio_id,
    }));
  }

  /** Load mail rows sent by a specific node, newest first. */
  loadOutbox(senderNodeId: string, limit = 200, radioId?: string | null): Array<{
    id: number; recipientNodeId: string; senderShortName: string;
    postedAt: number; body: string; readAt: number | null;
    radioId: string | null;
  }> {
    const sql = radioId
      ? `SELECT id, recipient_node_id, sender_short_name, posted_at, body, read_at, radio_id
         FROM bbs_mail
         WHERE sender_node_id = ? AND (radio_id = ? OR radio_id IS NULL)
         ORDER BY posted_at DESC LIMIT ?`
      : `SELECT id, recipient_node_id, sender_short_name, posted_at, body, read_at, radio_id
         FROM bbs_mail
         WHERE sender_node_id = ?
         ORDER BY posted_at DESC LIMIT ?`;
    const params = radioId ? [senderNodeId, radioId, limit] : [senderNodeId, limit];
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number; recipient_node_id: string; sender_short_name: string;
      posted_at: number; body: string; read_at: number | null;
      radio_id: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      recipientNodeId: r.recipient_node_id,
      senderShortName: r.sender_short_name,
      postedAt: r.posted_at,
      body: r.body,
      readAt: r.read_at,
      radioId: r.radio_id,
    }));
  }

  /** Count of unread messages for a recipient. Optional radio_id scope. */
  countUnread(recipientNodeId: string, radioId?: string | null): number {
    const sql = radioId
      ? `SELECT COUNT(*) AS c FROM bbs_mail
         WHERE recipient_node_id = ? AND read_at IS NULL AND (radio_id = ? OR radio_id IS NULL)`
      : `SELECT COUNT(*) AS c FROM bbs_mail
         WHERE recipient_node_id = ? AND read_at IS NULL`;
    const row = this.db.prepare(sql).get(...(radioId ? [recipientNodeId, radioId] : [recipientNodeId])) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** Fetch a single unread mail item by recipient, oldest first (for sequential reading). */
  nextUnreadFor(recipientNodeId: string, radioId?: string | null): {
    id: number; senderNodeId: string; senderShortName: string;
    postedAt: number; body: string;
  } | null {
    const sql = radioId
      ? `SELECT id, sender_node_id, sender_short_name, posted_at, body
         FROM bbs_mail
         WHERE recipient_node_id = ? AND read_at IS NULL AND (radio_id = ? OR radio_id IS NULL)
         ORDER BY posted_at ASC LIMIT 1`
      : `SELECT id, sender_node_id, sender_short_name, posted_at, body
         FROM bbs_mail
         WHERE recipient_node_id = ? AND read_at IS NULL
         ORDER BY posted_at ASC LIMIT 1`;
    const row = this.db.prepare(sql).get(...(radioId ? [recipientNodeId, radioId] : [recipientNodeId])) as {
      id: number; sender_node_id: string; sender_short_name: string;
      posted_at: number; body: string;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      senderNodeId: row.sender_node_id,
      senderShortName: row.sender_short_name,
      postedAt: row.posted_at,
      body: row.body,
    };
  }

  markMailRead(id: number, readAt: number = Date.now()): boolean {
    const r = this.db.prepare(`UPDATE bbs_mail SET read_at = ? WHERE id = ? AND read_at IS NULL`).run(readAt, id);
    return Number((r as any).changes ?? 0) > 0;
  }

  markMailDelivered(id: number, deliveredAt: number = Date.now()): boolean {
    const r = this.db.prepare(`UPDATE bbs_mail SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`).run(deliveredAt, id);
    return Number((r as any).changes ?? 0) > 0;
  }

  deleteMail(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM bbs_mail WHERE id = ?`).run(id);
    return Number((r as any).changes ?? 0) > 0;
  }

  /** Delete mail older than the given epoch-ms cutoff (regardless of read state).
   *  Returns rows removed. Called by the periodic retention pruner. */
  pruneMailOlderThan(cutoffMs: number): number {
    const result = this.db.prepare(`DELETE FROM bbs_mail WHERE posted_at < ?`).run(cutoffMs);
    return Number((result as any).changes ?? 0);
  }

  // ---------------------------------------------------------------------
  // BBS Weather Subscribers
  // ---------------------------------------------------------------------

  /**
   * Add or refresh a subscription. If the node already subscribed, we update
   * the channel_index in case they're subscribing from a different channel
   * than before. v2.0: also stamps the receiving radio so alerts route back
   * through the same bridge the node first contacted us on. Returns true if
   * this is a NEW subscription, false if refreshing an existing one.
   */
  addWeatherSubscriber(
    nodeId: string,
    channelIndex: number,
    radioId?: string | null,
    zip?: string | null,
    now: number = Date.now(),
  ): boolean {
    const existing = this.db.prepare(
      `SELECT 1 FROM bbs_weather_subscribers WHERE node_id = ?`
    ).get(nodeId);
    // v2.0 Beta 4: zip nullable — null means "follow operator's home ZIP."
    // Validated at the caller (BBS command parser), stored verbatim here.
    const normalizedZip = (typeof zip === 'string' && /^\d{5}$/.test(zip)) ? zip : null;
    this.db.prepare(`
      INSERT INTO bbs_weather_subscribers (node_id, subscribed_at, channel_index, radio_id, zip)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        channel_index = excluded.channel_index,
        radio_id      = excluded.radio_id,
        zip           = excluded.zip
    `).run(nodeId, now, channelIndex, radioId ?? null, normalizedZip);
    return !existing;
  }

  removeWeatherSubscriber(nodeId: string): boolean {
    const r = this.db.prepare(
      `DELETE FROM bbs_weather_subscribers WHERE node_id = ?`
    ).run(nodeId);
    return Number((r as any).changes ?? 0) > 0;
  }

  isWeatherSubscriber(nodeId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM bbs_weather_subscribers WHERE node_id = ?`
    ).get(nodeId);
    return !!row;
  }

  /**
   * v2.0 multi-radio: when `radioId` is supplied, returns only subscribers
   * routed through that radio (so per-radio BBS UIs show only their own
   * audience). Omit to list every subscriber across all radios.
   */
  listWeatherSubscribers(radioId?: string | null): Array<{
    nodeId: string; subscribedAt: number; channelIndex: number;
    lastAlertAt: number | null; radioId: string | null; zip: string | null;
  }> {
    const sql = radioId
      ? `SELECT node_id, subscribed_at, channel_index, last_alert_at, radio_id, zip
         FROM bbs_weather_subscribers
         WHERE radio_id = ? OR radio_id IS NULL
         ORDER BY subscribed_at DESC`
      : `SELECT node_id, subscribed_at, channel_index, last_alert_at, radio_id, zip
         FROM bbs_weather_subscribers
         ORDER BY subscribed_at DESC`;
    const rows = this.db.prepare(sql).all(...(radioId ? [radioId] : [])) as Array<{
      node_id: string; subscribed_at: number; channel_index: number;
      last_alert_at: number | null; radio_id: string | null; zip: string | null;
    }>;
    return rows.map(r => ({
      nodeId: r.node_id,
      subscribedAt: r.subscribed_at,
      channelIndex: r.channel_index,
      lastAlertAt: r.last_alert_at,
      radioId: r.radio_id,
      zip: r.zip,
    }));
  }

  countWeatherSubscribers(radioId?: string | null): number {
    const sql = radioId
      ? `SELECT COUNT(*) AS c FROM bbs_weather_subscribers WHERE radio_id = ? OR radio_id IS NULL`
      : `SELECT COUNT(*) AS c FROM bbs_weather_subscribers`;
    const row = this.db.prepare(sql).get(...(radioId ? [radioId] : [])) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * v2.0 Beta 4 (Item 8): list ALL mail rows, optionally scoped by date
   * range and/or radio. Used by the CSV export endpoint — the existing
   * loadInbox/loadOutbox helpers are scoped to a single nodeId, which is
   * fine for the UI panels but not for the operator's "archive everything
   * the BBS has ever handled" export.
   */
  listAllMail(opts: { radioId?: string | null; fromMs?: number; toMs?: number } = {}): Array<{
    id: number;
    senderNodeId: string;
    senderShortName: string;
    recipientNodeId: string;
    postedAt: number;
    body: string;
    readAt: number | null;
    deliveredAt: number | null;
    radioId: string | null;
  }> {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.radioId) { where.push('(radio_id = ? OR radio_id IS NULL)'); params.push(opts.radioId); }
    if (typeof opts.fromMs === 'number') { where.push('posted_at >= ?'); params.push(opts.fromMs); }
    if (typeof opts.toMs === 'number')   { where.push('posted_at <= ?'); params.push(opts.toMs); }
    const sql = `
      SELECT id, sender_node_id, sender_short_name, recipient_node_id,
             posted_at, body, read_at, delivered_at, radio_id
      FROM bbs_mail
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY posted_at DESC
    `;
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number; sender_node_id: string; sender_short_name: string;
      recipient_node_id: string; posted_at: number; body: string;
      read_at: number | null; delivered_at: number | null; radio_id: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      senderNodeId: r.sender_node_id,
      senderShortName: r.sender_short_name,
      recipientNodeId: r.recipient_node_id,
      postedAt: r.posted_at,
      body: r.body,
      readAt: r.read_at,
      deliveredAt: r.delivered_at,
      radioId: r.radio_id,
    }));
  }

  /** Record that we just pushed an alert to this subscriber. Diagnostic only —
   *  used for the operator's subscriber list. */
  touchWeatherSubscriberAlert(nodeId: string, now: number = Date.now()): void {
    this.db.prepare(
      `UPDATE bbs_weather_subscribers SET last_alert_at = ? WHERE node_id = ?`
    ).run(now, nodeId);
  }

  // ---------------------------------------------------------------------
  // Position history
  // ---------------------------------------------------------------------

  /** Append one position observation for the given node. */
  insertPositionHistory(row: {
    nodeId: string;
    timestamp: number;
    lat: number;
    lng: number;
    alt?: number | null;
    source?: 'manual' | 'gps' | null;
    precisionBits?: number | null;
  }): void {
    this.db.prepare(`
      INSERT INTO position_history (node_id, timestamp, lat, lng, alt, source, precision_bits)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.nodeId,
      row.timestamp,
      row.lat,
      row.lng,
      row.alt ?? null,
      row.source ?? null,
      row.precisionBits ?? null,
    );
  }

  /** Delete position history older than the given epoch-ms cutoff. Returns
   *  number of rows removed. Called by the periodic retention pruner so the
   *  table doesn't grow unbounded on chatty meshes (a single node broadcasting
   *  position every 15 min produces ~35k rows/year). */
  prunePositionHistoryOlderThan(cutoffMs: number): number {
    const r = this.db.prepare(`DELETE FROM position_history WHERE timestamp < ?`).run(cutoffMs);
    return Number((r as any).changes ?? 0);
  }

  /** Newest-first history for a single node, capped at `limit`. */
  loadPositionHistory(nodeId: string, limit = 500): Array<{
    id: number;
    timestamp: number;
    lat: number;
    lng: number;
    alt: number | null;
    source: 'manual' | 'gps' | null;
    precisionBits: number | null;
  }> {
    const rows = this.db.prepare(`
      SELECT id, timestamp, lat, lng, alt, source, precision_bits
      FROM position_history
      WHERE node_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(nodeId, limit) as Array<{
      id: number; timestamp: number; lat: number; lng: number;
      alt: number | null; source: string | null; precision_bits: number | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      lat: r.lat,
      lng: r.lng,
      alt: r.alt,
      source: r.source as 'manual' | 'gps' | null,
      precisionBits: r.precision_bits,
    }));
  }

  /**
   * Aggregate per-node mail activity for the operator's BBS Users panel.
   * Each row is one distinct node that has either sent or received mail
   * through this BBS, with counts and most-recent-activity timestamp.
   *
   * Implementation: UNION ALL of sender side and recipient side, grouped.
   * SQLite handles this efficiently against the indexes we already have
   * on sender/recipient node ids.
   */
  listMailUsers(): Array<{
    nodeId: string;
    sentCount: number;
    receivedCount: number;
    unreadCount: number;
    lastActivity: number;
  }> {
    const rows = this.db.prepare(`
      SELECT
        user_id AS nodeId,
        SUM(sent) AS sentCount,
        SUM(received) AS receivedCount,
        SUM(unread) AS unreadCount,
        MAX(last_activity) AS lastActivity
      FROM (
        SELECT
          sender_node_id AS user_id,
          1 AS sent,
          0 AS received,
          0 AS unread,
          posted_at AS last_activity
        FROM bbs_mail
        UNION ALL
        SELECT
          recipient_node_id AS user_id,
          0 AS sent,
          1 AS received,
          CASE WHEN read_at IS NULL THEN 1 ELSE 0 END AS unread,
          posted_at AS last_activity
        FROM bbs_mail
      )
      GROUP BY user_id
      ORDER BY lastActivity DESC
    `).all() as Array<{
      nodeId: string;
      sentCount: number;
      receivedCount: number;
      unreadCount: number;
      lastActivity: number;
    }>;
    return rows;
  }

  // ---------------------------------------------------------------------
  // v2.0 Multi-radio (radios table)
  // ---------------------------------------------------------------------

  listRadios(): RadioRow[] {
    return this.db.prepare(`
      SELECT radio_id, long_name, transport, target, region, modem_preset,
             frequency_slot, primary_channel, num_hops, enabled, color_hex,
             network_label, is_default, bbs_only, is_bbs_node, workspace_id, created_at, updated_at
      FROM radios
      ORDER BY is_default DESC, created_at ASC
    `).all() as RadioRow[];
  }

  getRadio(radioId: string): RadioRow | null {
    const row = this.db.prepare(`
      SELECT radio_id, long_name, transport, target, region, modem_preset,
             frequency_slot, primary_channel, num_hops, enabled, color_hex,
             network_label, is_default, bbs_only, is_bbs_node, workspace_id, created_at, updated_at
      FROM radios WHERE radio_id = ?
    `).get(radioId) as RadioRow | undefined;
    return row ?? null;
  }

  getDefaultRadio(): RadioRow | null {
    const row = this.db.prepare(`
      SELECT radio_id, long_name, transport, target, region, modem_preset,
             frequency_slot, primary_channel, num_hops, enabled, color_hex,
             network_label, is_default, bbs_only, is_bbs_node, workspace_id, created_at, updated_at
      FROM radios WHERE is_default = 1
      LIMIT 1
    `).get() as RadioRow | undefined;
    return row ?? null;
  }

  upsertRadio(r: RadioRow): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO radios (
        radio_id, long_name, transport, target, region, modem_preset,
        frequency_slot, primary_channel, num_hops, enabled, color_hex,
        network_label, is_default, bbs_only, is_bbs_node, workspace_id, created_at, updated_at
      ) VALUES (
        @radio_id, @long_name, @transport, @target, @region, @modem_preset,
        @frequency_slot, @primary_channel, @num_hops, @enabled, @color_hex,
        @network_label, @is_default, @bbs_only, @is_bbs_node, @workspace_id, @created_at, @updated_at
      )
      ON CONFLICT(radio_id) DO UPDATE SET
        long_name       = excluded.long_name,
        transport       = excluded.transport,
        target          = excluded.target,
        region          = excluded.region,
        modem_preset    = excluded.modem_preset,
        frequency_slot  = excluded.frequency_slot,
        primary_channel = excluded.primary_channel,
        num_hops        = excluded.num_hops,
        enabled         = excluded.enabled,
        color_hex       = excluded.color_hex,
        network_label   = excluded.network_label,
        is_default      = excluded.is_default,
        bbs_only        = excluded.bbs_only,
        -- is_bbs_node + workspace_id deliberately not in the update set:
        -- both are sensitive cross-row state (only one radio can hold
        -- is_bbs_node; workspace_id has its own admin reassignment
        -- flow). setBbsNodeRadio() / setRadioWorkspace() are the
        -- only sanctioned ways to change them. upsertRadio preserves
        -- both unchanged.
        updated_at      = excluded.updated_at
    `).run({
      radio_id:        r.radio_id,
      long_name:       r.long_name,
      transport:       r.transport,
      target:          r.target,
      region:          r.region ?? null,
      modem_preset:    r.modem_preset ?? null,
      frequency_slot:  r.frequency_slot ?? null,
      primary_channel: r.primary_channel ?? null,
      num_hops:        r.num_hops ?? 3,
      enabled:         r.enabled ? 1 : 0,
      color_hex:       r.color_hex ?? null,
      network_label:   r.network_label ?? null,
      is_default:      r.is_default ? 1 : 0,
      bbs_only:        r.bbs_only ? 1 : 0,
      // is_bbs_node: same rule as workspace_id — preserved on upsert,
      // never set via this path. Only setBbsNodeRadio() flips it (with
      // mutex enforcement). New radio inserts use 0; existing rows
      // keep their current value via the ON CONFLICT update-set omit.
      is_bbs_node:     r.is_bbs_node ? 1 : 0,
      // workspace_id: nullable; bootstrapWorkspaces() backfills NULLs at
      // boot. tryAutoRegisterDefault + spawnSecondary leave it NULL so
      // the migration assigns the radio to Household. Workspace
      // reassignment happens via setRadioWorkspace.
      workspace_id:    r.workspace_id ?? null,
      created_at:      r.created_at ?? now,
      updated_at:      now,
    });
  }

  /** Toggle a radio's BBS-only mode. Returns false if no row matches. */
  setRadioBbsOnly(radioId: string, on: boolean): boolean {
    const r = this.db.prepare(
      `UPDATE radios SET bbs_only = ?, updated_at = ? WHERE radio_id = ?`
    ).run(on ? 1 : 0, Date.now(), radioId);
    return r.changes > 0;
  }

  /**
   * v2.0 Beta 5 Phase 2 (Services Pattern): designate THE BBS service
   * radio. Enforces install-wide uniqueness — clears is_bbs_node on
   * every other radio in the same transaction. Pass null to clear the
   * designation entirely (BBS service goes off).
   *
   * Returns the new BBS radio_id (or null) so the caller can confirm
   * what landed. Refuses with false-ish when radioId is provided but
   * doesn't exist.
   *
   * Also re-stamps bbs_mail.radio_id + bbs_weather_subscribers.radio_id
   * to match the new BBS node, so the mail history + subscriber list
   * appears in the new BBS radio's workspace immediately after the
   * flip (rather than living in the OLD radio's workspace where the
   * new BBS node can't see them).
   */
  setBbsNodeRadio(radioId: string | null): string | null {
    const tx = this.db.transaction((target: string | null) => {
      // Clear everywhere first so re-running with the same id stays
      // idempotent (and so an explicit null cleanly turns off BBS).
      this.db.prepare(
        `UPDATE radios SET is_bbs_node = 0, updated_at = ? WHERE is_bbs_node = 1`
      ).run(Date.now());
      if (target == null) return null;
      // Confirm the target exists, then set its flag.
      const row = this.db.prepare(
        `SELECT 1 FROM radios WHERE radio_id = ?`
      ).get(target);
      if (!row) return null;
      this.db.prepare(
        `UPDATE radios SET is_bbs_node = 1, updated_at = ? WHERE radio_id = ?`
      ).run(Date.now(), target);
      // Re-stamp BBS-stored data so the operator sees their mail +
      // subscriber list under the new BBS node's workspace. Without
      // this, the dashboard filter (snapshot scopes by radio_id ∈
      // workspace) would hide the history until admin manually
      // migrates the rows.
      this.db.prepare(
        `UPDATE bbs_mail SET radio_id = ?`
      ).run(target);
      this.db.prepare(
        `UPDATE bbs_weather_subscribers SET radio_id = ?`
      ).run(target);
      return target;
    });
    return tx(radioId) as string | null;
  }

  /** Returns the radio_id currently serving BBS, or null when no
   *  radio is designated. Cached by callers — toggling fires the
   *  bbsConfigUpdate SSE event so subscribers re-fetch. */
  getBbsNodeRadioId(): string | null {
    const row = this.db.prepare(
      `SELECT radio_id FROM radios WHERE is_bbs_node = 1 LIMIT 1`
    ).get() as { radio_id: string } | undefined;
    return row?.radio_id ?? null;
  }

  // ---------------------------------------------------------------------
  // v2.0 Beta 5: users + sessions
  // ---------------------------------------------------------------------

  /** Count rows in the users table. Used by /api/auth/bootstrap to detect
   *  the "first boot, no admin yet" state where we need to surface the
   *  bootstrap UI instead of the login form. */
  countUsers(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  countAdmins(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND locked = 0`
    ).get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  createUser(input: {
    username: string;
    passwordHash: string;
    role: 'admin' | 'viewer';
    createdAt?: number;
  }): number {
    const now = input.createdAt ?? Date.now();
    const r = this.db.prepare(`
      INSERT INTO users (username, password_hash, role, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.username, input.passwordHash, input.role, now);
    return Number(r.lastInsertRowid);
  }

  getUserById(id: number): {
    id: number; username: string; passwordHash: string;
    role: 'admin' | 'viewer'; createdAt: number; lastLoginAt: number | null; locked: number;
  } | null {
    const row = this.db.prepare(`
      SELECT id, username, password_hash AS passwordHash, role,
             created_at AS createdAt, last_login_at AS lastLoginAt, locked
      FROM users WHERE id = ?
    `).get(id) as any;
    return row ?? null;
  }

  getUserByUsername(username: string): {
    id: number; username: string; passwordHash: string;
    role: 'admin' | 'viewer'; createdAt: number; lastLoginAt: number | null; locked: number;
  } | null {
    // Username collation is NOCASE so case-insensitive match comes from
    // the schema. No need for LOWER() here.
    const row = this.db.prepare(`
      SELECT id, username, password_hash AS passwordHash, role,
             created_at AS createdAt, last_login_at AS lastLoginAt, locked
      FROM users WHERE username = ?
    `).get(username) as any;
    return row ?? null;
  }

  listUsers(): Array<{
    id: number; username: string; role: 'admin' | 'viewer';
    createdAt: number; lastLoginAt: number | null; locked: number;
  }> {
    return this.db.prepare(`
      SELECT id, username, role, created_at AS createdAt,
             last_login_at AS lastLoginAt, locked
      FROM users
      ORDER BY created_at ASC
    `).all() as any;
  }

  updateUserPassword(id: number, passwordHash: string): boolean {
    const r = this.db.prepare(
      `UPDATE users SET password_hash = ? WHERE id = ?`
    ).run(passwordHash, id);
    return r.changes > 0;
  }

  updateUserRole(id: number, role: 'admin' | 'viewer'): boolean {
    const r = this.db.prepare(
      `UPDATE users SET role = ? WHERE id = ?`
    ).run(role, id);
    return r.changes > 0;
  }

  updateUserLocked(id: number, locked: boolean): boolean {
    const r = this.db.prepare(
      `UPDATE users SET locked = ? WHERE id = ?`
    ).run(locked ? 1 : 0, id);
    return r.changes > 0;
  }

  touchUserLogin(id: number, now: number = Date.now()): void {
    this.db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(now, id);
  }

  deleteUser(id: number): boolean {
    // ON DELETE CASCADE on the sessions FK takes care of the user's sessions.
    const r = this.db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  // -- sessions --

  createSession(input: {
    token: string; userId: number; createdAt: number;
    expiresAt: number; ipFirstSeen: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO sessions (token, user_id, created_at, expires_at, ip_first_seen)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.token, input.userId, input.createdAt, input.expiresAt, input.ipFirstSeen);
  }

  /** Returns the session joined with the user — auth path needs both. */
  getSession(token: string): {
    token: string; userId: number; createdAt: number; expiresAt: number;
    username: string; role: 'admin' | 'viewer'; locked: number;
  } | null {
    const row = this.db.prepare(`
      SELECT s.token, s.user_id AS userId, s.created_at AS createdAt, s.expires_at AS expiresAt,
             u.username, u.role, u.locked
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token) as any;
    if (!row) return null;
    // Locked users get rejected even with a valid session — admin can lock
    // an account without forcing every session token to be deleted.
    if (row.locked) return null;
    return row;
  }

  updateSessionExpiry(token: string, expiresAt: number): void {
    this.db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`).run(expiresAt, token);
  }

  deleteSession(token: string): boolean {
    const r = this.db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return r.changes > 0;
  }

  /** Used when an admin locks/deletes a user — drop all their sessions
   *  too so existing tabs get bounced to the login screen on next request. */
  deleteSessionsForUser(userId: number): number {
    const r = this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
    return Number(r.changes ?? 0);
  }

  pruneExpiredSessions(now: number = Date.now()): number {
    const r = this.db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
    return Number(r.changes ?? 0);
  }

  // ---------------------------------------------------------------------
  // v2.0 Beta 5 Workspaces — Phase 1 schema + bootstrap migration
  // ---------------------------------------------------------------------

  /**
   * One-shot bootstrap that gets the DB into the "every existing user is
   * in the Household workspace, every existing radio is assigned to it"
   * state. Idempotent — running on a post-migration DB does nothing.
   *
   * The migration runs unconditionally at constructor time. Three guards
   * make it cheap on subsequent boots:
   *   - If at least one workspace already exists, we skip creating the
   *     default one (but still backfill any unassigned radios + users —
   *     covers the case where workspaces were deleted and re-added).
   *   - The backfills use INSERT OR IGNORE so re-running is a no-op.
   *   - The radio.workspace_id update is a NULL-guarded UPDATE.
   *
   * "Household" was picked over "Default" because the target audience is
   * a family install — the name reflects the actual use case. The slug
   * is "household" lowercased — slugs are stable identifiers used in
   * URLs and shouldn't change even if the display name does.
   */
  private bootstrapWorkspaces(): void {
    try {
      // Idempotent: if a Household workspace already exists, use it;
      // otherwise create it. Either way we end up with a row to assign
      // orphaned radios + users to.
      let defaultWs = this.db.prepare(
        `SELECT id FROM workspaces ORDER BY id ASC LIMIT 1`
      ).get() as { id: number } | undefined;

      if (!defaultWs) {
        const now = Date.now();
        const r = this.db.prepare(`
          INSERT INTO workspaces (name, slug, owner_user_id, created_at)
          VALUES (?, ?, NULL, ?)
        `).run('Household', 'household', now);
        defaultWs = { id: Number(r.lastInsertRowid) };
        console.log('[MeshDB] Bootstrapped default workspace "Household" (id=' + defaultWs.id + ')');
      }

      // Backfill: every existing user joins the default workspace.
      // INSERT OR IGNORE handles the case where some users are already in.
      const memberInsert = this.db.prepare(`
        INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, joined_at)
        VALUES (?, ?, ?)
      `);
      const userIds = this.db.prepare(`SELECT id FROM users`).all() as Array<{ id: number }>;
      const now = Date.now();
      for (const u of userIds) memberInsert.run(defaultWs.id, u.id, now);

      // Backfill: every radio with NULL workspace_id joins the default.
      this.db.prepare(
        `UPDATE radios SET workspace_id = ? WHERE workspace_id IS NULL`
      ).run(defaultWs.id);

      // Set owner if the default workspace doesn't have one yet — picks
      // the first admin (or the first user if no admin yet, e.g. pre-
      // bootstrap install with no users at all yet).
      const owner = this.db.prepare(`
        SELECT id FROM users
        WHERE locked = 0
        ORDER BY (role = 'admin') DESC, id ASC
        LIMIT 1
      `).get() as { id: number } | undefined;
      if (owner) {
        this.db.prepare(
          `UPDATE workspaces SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL`
        ).run(owner.id, defaultWs.id);
      }
    } catch (err: any) {
      console.warn('[MeshDB] Workspace bootstrap failed (continuing — workspaces feature may not work):', err.message);
    }
  }

  // -- workspace CRUD --

  listWorkspaces(opts: { forUserId?: number | null } = {}): Array<{
    id: number; name: string; slug: string;
    ownerUserId: number | null; createdAt: number;
    memberCount: number; radioCount: number;
    /** v2.0 Beta 5 (per-workspace primary): operator's explicit pick of
     *  the workspace's primary radio. NULL when the heuristic in
     *  workspacePrimaryBridge() should still apply. */
    primaryRadioId: string | null;
    /** True only when forUserId was supplied — useful for "all
     *  workspaces I'm a member of" queries. */
    isMember?: boolean;
  }> {
    if (opts.forUserId == null) {
      return this.db.prepare(`
        SELECT
          w.id, w.name, w.slug,
          w.owner_user_id AS ownerUserId,
          w.created_at AS createdAt,
          w.primary_radio_id AS primaryRadioId,
          (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS memberCount,
          (SELECT COUNT(*) FROM radios r WHERE r.workspace_id = w.id) AS radioCount
        FROM workspaces w
        ORDER BY w.created_at ASC
      `).all() as any;
    }
    return this.db.prepare(`
      SELECT
        w.id, w.name, w.slug,
        w.owner_user_id AS ownerUserId,
        w.created_at AS createdAt,
        w.primary_radio_id AS primaryRadioId,
        (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS memberCount,
        (SELECT COUNT(*) FROM radios r WHERE r.workspace_id = w.id) AS radioCount,
        1 AS isMember
      FROM workspaces w
      JOIN workspace_members me ON me.workspace_id = w.id AND me.user_id = ?
      ORDER BY w.created_at ASC
    `).all(opts.forUserId) as any;
  }

  getWorkspace(id: number): { id: number; name: string; slug: string; ownerUserId: number | null; createdAt: number; primaryRadioId: string | null } | null {
    const row = this.db.prepare(`
      SELECT id, name, slug, owner_user_id AS ownerUserId, created_at AS createdAt,
             primary_radio_id AS primaryRadioId
      FROM workspaces WHERE id = ?
    `).get(id) as any;
    return row ?? null;
  }

  /** v2.0 Beta 5 Workspaces: set or clear a workspace's primary radio.
   *  Caller validates that radioId (when non-null) belongs to the
   *  workspace; this helper just runs the UPDATE. Returns true on a
   *  row change. */
  setWorkspacePrimaryRadio(workspaceId: number, radioId: string | null): boolean {
    const r = this.db.prepare(
      `UPDATE workspaces SET primary_radio_id = ? WHERE id = ?`
    ).run(radioId, workspaceId);
    return r.changes > 0;
  }

  /** v2.0 Beta 5 Workspaces: clear the primary_radio_id pointer on
   *  every workspace that currently references the given radio. Called
   *  from the radios DELETE endpoint so deleted radios don't leave a
   *  dangling primary_radio_id pointer. Returns number of rows
   *  cleared. */
  clearWorkspacePrimaryForRadio(radioId: string): number {
    const r = this.db.prepare(
      `UPDATE workspaces SET primary_radio_id = NULL WHERE primary_radio_id = ?`
    ).run(radioId);
    return Number(r.changes ?? 0);
  }

  createWorkspace(input: { name: string; slug: string; ownerUserId: number | null }): number {
    const r = this.db.prepare(`
      INSERT INTO workspaces (name, slug, owner_user_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.name, input.slug, input.ownerUserId, Date.now());
    return Number(r.lastInsertRowid);
  }

  updateWorkspaceName(id: number, name: string): boolean {
    const r = this.db.prepare(`UPDATE workspaces SET name = ? WHERE id = ?`).run(name, id);
    return r.changes > 0;
  }

  /** Assign or clear a workspace's owner. Only used by the bootstrap +
   *  admin transfer paths. */
  setWorkspaceOwner(id: number, ownerUserId: number | null): boolean {
    const r = this.db.prepare(
      `UPDATE workspaces SET owner_user_id = ? WHERE id = ?`
    ).run(ownerUserId, id);
    return r.changes > 0;
  }

  deleteWorkspace(id: number): boolean {
    // Cascade rules: workspace_members → CASCADE (members vanish).
    // radios.workspace_id → SET NULL (radios survive but unassigned;
    // admin gets prompted to reassign).
    const r = this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  countWorkspaces(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM workspaces`).get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  // -- membership --

  listWorkspaceMembers(workspaceId: number): Array<{
    userId: number; username: string; role: 'admin' | 'viewer';
    joinedAt: number; isOwner: boolean;
  }> {
    return this.db.prepare(`
      SELECT
        u.id AS userId, u.username, u.role,
        m.joined_at AS joinedAt,
        (SELECT owner_user_id FROM workspaces WHERE id = m.workspace_id) = u.id AS isOwner
      FROM workspace_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ?
      ORDER BY u.created_at ASC
    `).all(workspaceId) as any;
  }

  addWorkspaceMember(workspaceId: number, userId: number): boolean {
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, joined_at)
      VALUES (?, ?, ?)
    `).run(workspaceId, userId, Date.now());
    return r.changes > 0;
  }

  removeWorkspaceMember(workspaceId: number, userId: number): boolean {
    const r = this.db.prepare(`
      DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?
    `).run(workspaceId, userId);
    return r.changes > 0;
  }

  isWorkspaceMember(workspaceId: number, userId: number): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?
    `).get(workspaceId, userId);
    return !!row;
  }

  /** All workspace ids the user belongs to. Powers the "what can this
   *  user see?" filter in list endpoints. Admins typically bypass this. */
  workspaceIdsForUser(userId: number): number[] {
    const rows = this.db.prepare(`
      SELECT workspace_id AS id FROM workspace_members WHERE user_id = ?
    `).all(userId) as Array<{ id: number }>;
    return rows.map(r => r.id);
  }

  /** Set the workspace_id of a radio. Returns false if no row matched. */
  setRadioWorkspace(radioId: string, workspaceId: number | null): boolean {
    const r = this.db.prepare(`
      UPDATE radios SET workspace_id = ?, updated_at = ? WHERE radio_id = ?
    `).run(workspaceId, Date.now(), radioId);
    return r.changes > 0;
  }

  // ---------------------------------------------------------------------
  // v2.0 Beta 5 Labeled Devices
  // ---------------------------------------------------------------------

  /** Workspace-filtered list when workspaceIds supplied (member view).
   *  Admin gets every device when called without filter. */
  listLabeledDevices(opts: { workspaceIds?: number[] } = {}): Array<{
    id: number; workspaceId: number; displayName: string;
    host: string; port: number;
    currentLabel: string | null; currentShort: string | null;
    lastPushedAt: number | null; lastError: string | null;
    createdAt: number; updatedAt: number;
  }> {
    let sql: string;
    let params: any[] = [];
    if (opts.workspaceIds && opts.workspaceIds.length > 0) {
      const placeholders = opts.workspaceIds.map(() => '?').join(',');
      sql = `
        SELECT id, workspace_id AS workspaceId, display_name AS displayName,
               host, port,
               current_label AS currentLabel, current_short AS currentShort,
               last_pushed_at AS lastPushedAt, last_error AS lastError,
               created_at AS createdAt, updated_at AS updatedAt
        FROM labeled_devices
        WHERE workspace_id IN (${placeholders})
        ORDER BY display_name ASC
      `;
      params = opts.workspaceIds;
    } else {
      sql = `
        SELECT id, workspace_id AS workspaceId, display_name AS displayName,
               host, port,
               current_label AS currentLabel, current_short AS currentShort,
               last_pushed_at AS lastPushedAt, last_error AS lastError,
               created_at AS createdAt, updated_at AS updatedAt
        FROM labeled_devices
        ORDER BY display_name ASC
      `;
    }
    return this.db.prepare(sql).all(...params) as any;
  }

  getLabeledDevice(id: number): {
    id: number; workspaceId: number; displayName: string;
    host: string; port: number;
    currentLabel: string | null; currentShort: string | null;
    lastPushedAt: number | null; lastError: string | null;
    createdAt: number; updatedAt: number;
  } | null {
    const row = this.db.prepare(`
      SELECT id, workspace_id AS workspaceId, display_name AS displayName,
             host, port,
             current_label AS currentLabel, current_short AS currentShort,
             last_pushed_at AS lastPushedAt, last_error AS lastError,
             created_at AS createdAt, updated_at AS updatedAt
      FROM labeled_devices WHERE id = ?
    `).get(id) as any;
    return row ?? null;
  }

  createLabeledDevice(input: {
    workspaceId: number; displayName: string; host: string; port: number;
  }): number {
    const now = Date.now();
    const r = this.db.prepare(`
      INSERT INTO labeled_devices
        (workspace_id, display_name, host, port, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.workspaceId, input.displayName, input.host, input.port, now, now);
    return Number(r.lastInsertRowid);
  }

  updateLabeledDevice(id: number, patch: {
    displayName?: string; host?: string; port?: number; workspaceId?: number;
  }): boolean {
    const sets: string[] = [];
    const params: any[] = [];
    if (patch.displayName !== undefined) { sets.push('display_name = ?');  params.push(patch.displayName); }
    if (patch.host        !== undefined) { sets.push('host = ?');          params.push(patch.host); }
    if (patch.port        !== undefined) { sets.push('port = ?');          params.push(patch.port); }
    if (patch.workspaceId !== undefined) { sets.push('workspace_id = ?');  params.push(patch.workspaceId); }
    if (sets.length === 0) return false;
    sets.push('updated_at = ?'); params.push(Date.now());
    params.push(id);
    const r = this.db.prepare(`
      UPDATE labeled_devices SET ${sets.join(', ')} WHERE id = ?
    `).run(...params);
    return r.changes > 0;
  }

  /** Record the result of a label-push attempt — success or failure. */
  recordLabeledDevicePush(id: number, opts: {
    label: string; short: string; error?: string | null;
  }): boolean {
    const r = this.db.prepare(`
      UPDATE labeled_devices SET
        current_label = ?,
        current_short = ?,
        last_pushed_at = ?,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
    `).run(opts.label, opts.short, Date.now(), opts.error ?? null, Date.now(), id);
    return r.changes > 0;
  }

  deleteLabeledDevice(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM labeled_devices WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  // -- user prefs --

  /** Whole-row dump for one user. Values come back as parsed JSON
   *  (whatever was stored). Used on login + every focus to seed the
   *  client cache. */
  listUserPrefs(userId: number): Record<string, any> {
    const rows = this.db.prepare(
      `SELECT key, value_json FROM user_prefs WHERE user_id = ?`
    ).all(userId) as Array<{ key: string; value_json: string }>;
    const out: Record<string, any> = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value_json); }
      catch { /* corrupted entry — skip it rather than crashing the whole load */ }
    }
    return out;
  }

  /** Read one pref. Returns undefined for missing or unparseable. */
  getUserPref(userId: number, key: string): any | undefined {
    const row = this.db.prepare(
      `SELECT value_json FROM user_prefs WHERE user_id = ? AND key = ?`
    ).get(userId, key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value_json); } catch { return undefined; }
  }

  /** Upsert one pref. value is serialized via JSON.stringify (caller's
   *  responsibility to pass something serializable; rejecting cycles
   *  surfaces as the upsert throwing). */
  setUserPref(userId: number, key: string, value: any): void {
    const json = JSON.stringify(value);
    this.db.prepare(`
      INSERT INTO user_prefs (user_id, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(userId, key, json, Date.now());
  }

  deleteUserPref(userId: number, key: string): boolean {
    const r = this.db.prepare(
      `DELETE FROM user_prefs WHERE user_id = ? AND key = ?`
    ).run(userId, key);
    return r.changes > 0;
  }

  // -- v2.0.0 Web Push: per-user browser push subscriptions ---------

  /**
   * Idempotent upsert keyed on (user_id, endpoint). The browser hands
   * the same endpoint back across page reloads as long as the
   * underlying ServiceWorkerRegistration survives, so re-subscribing
   * from the same browser updates the row instead of stacking dupes.
   * Returns the resulting row's id.
   */
  upsertPushSubscription(input: {
    userId: number;
    endpoint: string;
    p256dh: string;
    authSecret: string;
    categories: string[];
    userAgent: string | null;
  }): number {
    const now = Date.now();
    const existing = this.db.prepare(
      `SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`
    ).get(input.userId, input.endpoint) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE push_subscriptions
        SET p256dh = ?, auth_secret = ?, categories_json = ?, user_agent = ?, updated_at = ?
        WHERE id = ?
      `).run(input.p256dh, input.authSecret, JSON.stringify(input.categories), input.userAgent, now, existing.id);
      return existing.id;
    }
    const r = this.db.prepare(`
      INSERT INTO push_subscriptions
        (user_id, endpoint, p256dh, auth_secret, categories_json, user_agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.userId, input.endpoint, input.p256dh, input.authSecret,
      JSON.stringify(input.categories), input.userAgent, now, now
    );
    return Number(r.lastInsertRowid);
  }

  /** List subscriptions for a given user (Settings → Notifications) or
   *  for the dispatch fanout. Pass userIds: undefined to fetch ALL. */
  listPushSubscriptions(opts: { userIds?: number[] } = {}): PushSubscriptionRow[] {
    let rows;
    if (opts.userIds && opts.userIds.length > 0) {
      const placeholders = opts.userIds.map(() => '?').join(',');
      rows = this.db.prepare(`
        SELECT id, user_id AS userId, endpoint, p256dh, auth_secret AS authSecret,
               categories_json AS categoriesJson, user_agent AS userAgent,
               created_at AS createdAt, updated_at AS updatedAt
        FROM push_subscriptions
        WHERE user_id IN (${placeholders})
        ORDER BY created_at ASC
      `).all(...opts.userIds) as any[];
    } else {
      rows = this.db.prepare(`
        SELECT id, user_id AS userId, endpoint, p256dh, auth_secret AS authSecret,
               categories_json AS categoriesJson, user_agent AS userAgent,
               created_at AS createdAt, updated_at AS updatedAt
        FROM push_subscriptions
        ORDER BY created_at ASC
      `).all() as any[];
    }
    return rows.map(r => ({
      ...r,
      categories: safeParseJsonArray(r.categoriesJson),
    }));
  }

  /** Update just the categories mask for a single subscription. The UI
   *  toggles individual categories without re-prompting the browser. */
  setPushSubscriptionCategories(id: number, categories: string[]): boolean {
    const r = this.db.prepare(
      `UPDATE push_subscriptions SET categories_json = ?, updated_at = ? WHERE id = ?`
    ).run(JSON.stringify(categories), Date.now(), id);
    return r.changes > 0;
  }

  deletePushSubscription(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  /** Helper for the API endpoint: delete the row matching (user, endpoint).
   *  Avoids handing the subscription id back to the client just for
   *  unsubscribe. */
  deletePushSubscriptionByEndpoint(userId: number, endpoint: string): boolean {
    const r = this.db.prepare(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`
    ).run(userId, endpoint);
    return r.changes > 0;
  }

  /**
   * Delete the radios row. v2.0 bugfix: the DB layer no longer enforces an
   * `is_default = 0` guard — that conflated "operator-preferred default"
   * (this column) with "currently held by the singleton bridge" (a runtime
   * concept). The API layer at /api/mesh/radios/:id checks the singleton
   * via BridgeManager before calling this.
   */
  deleteRadio(radioId: string): boolean {
    const r = this.db.prepare(`DELETE FROM radios WHERE radio_id = ?`).run(radioId);
    return r.changes > 0;
  }

  setDefaultRadio(radioId: string): boolean {
    const found = this.db.prepare(`SELECT 1 FROM radios WHERE radio_id = ?`).get(radioId);
    if (!found) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE radios SET is_default = 0 WHERE is_default = 1`).run();
      this.db.prepare(`UPDATE radios SET is_default = 1, updated_at = ? WHERE radio_id = ?`).run(Date.now(), radioId);
    });
    tx();
    return true;
  }

  /**
   * One-time backfill: stamp NULL radio_id rows with the supplied radio_id.
   * Called by BridgeManager exactly once when the default radio is first
   * auto-registered (so legacy 1.x data is attributed to that radio).
   * Returns counts per table.
   */
  backfillRadioId(radioId: string): Record<string, number> {
    const tables = [
      'nodes', 'messages', 'events', 'channels', 'telemetry', 'waypoints',
      'neighbor_info', 'store_forward_routers', 'trace_results',
      'range_test_observations', 'blocked_nodes', 'node_sessions',
      'bbs_mail', 'bbs_weather_subscribers', 'position_history',
    ];
    const results: Record<string, number> = {};
    const tx = this.db.transaction(() => {
      for (const t of tables) {
        const r = this.db.prepare(`UPDATE ${t} SET radio_id = ? WHERE radio_id IS NULL`).run(radioId);
        if (r.changes > 0) results[t] = r.changes;
      }
    });
    tx();
    return results;
  }
}

// ---------------------------------------------------------------------
// v2.0.0 Web Push: push subscription row shape (mirrors the
// push_subscriptions table with categoriesJson already parsed to an
// array for caller convenience).
// ---------------------------------------------------------------------
export interface PushSubscriptionRow {
  id: number;
  userId: number;
  endpoint: string;
  p256dh: string;
  authSecret: string;
  /** Parsed from categories_json. Use one of the strings the dispatcher
   *  recognises ('dm' | 'mention' | 'outage' | 'weather') — empty
   *  array means "subscribed but muted." */
  categories: string[];
  userAgent: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Defensive parse for categories_json. Bad / missing JSON falls back
 *  to an empty array (subscription kept, silent until user opts back in). */
function safeParseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Radio row shape (mirrors the radios table 1:1).
// ---------------------------------------------------------------------
export interface RadioRow {
  radio_id: string;
  long_name: string;
  transport: 'serial' | 'tcp' | 'ble';
  target: string;
  region: string | null;
  modem_preset: string | null;
  frequency_slot: number | null;
  primary_channel: string | null;
  num_hops: number | null;
  enabled: number;          // 0|1 (SQLite booleans)
  color_hex: string | null;
  network_label: string | null;
  is_default: number;       // 0|1
  /** v2.0 Beta 4: when 1, this radio auto-replies to non-BBS DMs with
   *  the command index. Lets an operator dedicate one radio to BBS while
   *  others stay general chat nodes. 0 = standard behavior. */
  bbs_only: number;         // 0|1
  /** v2.0 Beta 5 Phase 2 (Services Pattern): "this radio runs the
   *  install's BBS service." setBbsNodeRadio() enforces install-wide
   *  uniqueness — flipping this on any radio clears it everywhere
   *  else atomically. */
  is_bbs_node: number;      // 0|1
  /** v2.0 Beta 5 Workspaces: which workspace owns this radio. Nullable
   *  during the migration window only; bootstrapWorkspaces() backfills
   *  every NULL on every boot so post-migration this is effectively
   *  NOT NULL. Cascade-SET-NULL when the workspace gets deleted. */
  workspace_id: number | null;
  created_at: number;
  updated_at: number;
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
