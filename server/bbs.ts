/**
 * BBS-Mail — Bulletin Board System mail subset, inspired by TC2-BBS-mesh.
 *
 * Flow (per the design agreed with the operator):
 *   1. Remote node DMs ":mail" → menu reply
 *   2. Operator-side state-machine asks: "send recipient short name"
 *   3. Remote replies with short name → we resolve, ask for body
 *   4. Remote replies with body (≤200 chars) → we persist + push-notify recipient
 *
 * Reading:
 *   1. Remote DMs ":mail" → if they have unread, menu offers [R]ead
 *   2. "R" → next unread shown, prompt for [N]ext / [D]elete / [X]
 *
 * Push notification: when mail is stored, we immediately DM the recipient
 * ("✉ Mail from XXXX. DM :mail R to read."). No bounce handling — the radio
 * will retry/drop per its own queue; the mail is in our DB either way.
 *
 * State is held in-memory (no separate sessions table) — survives only for
 * the duration of the conversation, which matches both the original TC2-BBS
 * behavior and the 30-second timeout we apply.
 *
 * Conflicts with the AI assistant: BBS handles any DM starting with ":" plus
 * any DM whose sender is mid-state-machine. Everything else falls through to
 * the AI assistant unchanged.
 */

import { meshDb as meshDbFactory, type MeshDatabase } from './database.js';
import type { MeshtasticSerialBridge, MeshNode } from './meshtasticSerial.js';
import { type BbsConfig, defaultBbsConfig } from './bbsConfig.js';
import { weatherService } from './weather.js';

const meshDb: MeshDatabase = meshDbFactory();

// v2.0 Beta 3: session idle timeout is now driven by BbsConfig.sessionTimeoutSecs
// (default 300s, clamped 30..1800s). The legacy 30s default was way too short
// for typing a ~200-char mail body on mobile — by the time the operator
// finished typing, the reaper had already swept the session and the body
// arrived to a BBS that no longer recognized them mid-flow. Kept here as the
// fallback when the runtime config hasn't been pushed yet.
const STATE_TIMEOUT_MS_FALLBACK = 300_000;
/** Fallback channel index for push notifications when we don't know which
 *  channel a recipient shares with us. 0 = PRIMARY, the only universally
 *  shared channel on a default Meshtastic install. */
const PUSH_CHANNEL_FALLBACK = 0;

/** v2.0 Beta 5 BBS (alias): permanent aliases for the weather subsystem.
 *  The configured weatherTrigger is whichever one of these the operator
 *  has saved (defaults to :wx for fresh installs, :weather for pre-Beta-4
 *  upgrades). The OTHER ONE in this list always works as a shortcut —
 *  so a subscriber typing :weather hits the same flow as :wx and vice
 *  versa without the operator having to pick one and stick with it.
 *  All entries must be lowercase, must start with ':', and must NOT
 *  collide with mailTrigger / cmdTrigger after normalization. */
const WEATHER_ALIASES: readonly string[] = [':wx', ':weather'];

/**
 * v3.0 SKYWARN — Local Storm Report event type table.
 *
 * The one-letter (or two-letter) `code` is what the reporter types
 * in the :spot event-selection step; it maps to the NWS LSR
 * `eventType` string that gets stored (and, in v3.1, submitted to
 * eSpotter). `magnitudeUnit` drives the follow-up magnitude prompt
 * — null skips straight to remarks (WALL CLOUD has no natural
 * scalar; TORNADO uses EF-rating which spotters rarely know in the
 * moment, so also skipped).
 *
 * Keeping this in one table means the prompt string, the parser,
 * and the submitter all agree on the code set — no drift.
 */
interface SpotEventDef {
  code: string;
  eventType: string;
  magnitudeUnit: string | null;
  /** Optional label for the confirm summary — defaults to eventType. */
  label?: string;
}
const SPOT_EVENTS: readonly SpotEventDef[] = [
  { code: 'H',  eventType: 'HAIL',        magnitudeUnit: 'INCHES' },
  { code: 'T',  eventType: 'TSTM WND',    magnitudeUnit: 'MPH' },
  { code: 'TR', eventType: 'TORNADO',     magnitudeUnit: null },
  { code: 'F',  eventType: 'FUNNEL',      magnitudeUnit: null },
  { code: 'FL', eventType: 'FLOOD',       magnitudeUnit: 'FEET' },
  { code: 'W',  eventType: 'WALL CLOUD',  magnitudeUnit: null },
  { code: 'O',  eventType: 'OTHER',       magnitudeUnit: null },
];

/** One-line event-selection menu — packet-cap tight. Sample when all
 *  defaults are present:
 *    "H=HAIL T=TSTM_WND TR=TORNADO F=FUNNEL FL=FLOOD W=WALL_CLOUD O=OTHER"
 *  ~72 chars. Fits under 200 with the wrapper prompt around it. */
const SPOT_EVENT_MENU: string = SPOT_EVENTS
  .map(e => `${e.code}=${e.eventType.replace(/\s+/g, '_')}`)
  .join(' ');

function findSpotEventByCode(code: string): SpotEventDef | null {
  const up = code.toUpperCase();
  return SPOT_EVENTS.find(e => e.code === up) ?? null;
}

/**
 * Rewrite a leading weather-alias prefix to the configured weatherTrigger
 * so every downstream `lower.startsWith(weatherTrigger …)` check in
 * handleInboundDm hits without us having to duplicate every comparison
 * across all aliases.
 *
 * Pure prefix rewrite — case-preserving on the tail, lowercase-matching
 * on the head. If the input doesn't start with a known alias, returns
 * the original untouched.
 *
 * Excludes the configured trigger from the rewrite (already canonical)
 * and any alias that would collide with mailTrigger / cmdTrigger so a
 * pathological operator config can't accidentally redirect a different
 * subsystem into the weather flow.
 */
function canonicalizeWeatherAlias(text: string, cfg: BbsConfig): string {
  const lower = text.toLowerCase();
  for (const alias of WEATHER_ALIASES) {
    if (alias === cfg.weatherTrigger) continue;
    if (alias === cfg.mailTrigger || alias === cfg.cmdTrigger || alias === cfg.spotTrigger) continue;
    if (lower === alias) return cfg.weatherTrigger;
    if (lower.startsWith(alias + ' ')) return cfg.weatherTrigger + text.slice(alias.length);
  }
  return text;
}

type SessionState =
  | { kind: 'awaiting-recipient'; enteredAt: number; channelIndex: number; pendingBody?: string }
  | { kind: 'awaiting-recipient-pick'; enteredAt: number; channelIndex: number; candidates: MeshNode[]; pendingBody?: string }
  | { kind: 'awaiting-body'; enteredAt: number; channelIndex: number; recipientNodeId: string; recipientShortName: string }
  | {
      kind: 'reading';
      enteredAt: number;
      channelIndex: number;
      currentMailId: number;
      /** v2.1: which category the subscriber asked to read. Null/
       *  undefined = "all unread" (legacy `:mail r`). 'WX' | 'FX' |
       *  'OTHER' = filtered. Sticky across N taps so the second
       *  unread in this session pulls from the same bucket. */
      category?: 'WX' | 'FX' | 'OTHER' | null;
    }
  // v3.0 SKYWARN — :spot multi-step form. Reporter types :spot,
  // picks an event type, provides a magnitude if the event has one,
  // adds optional remarks, confirms. Each step gets its own kind
  // so the state machine stays flat and the reaper can time out
  // stuck mid-report sessions the same way it does :mail flows.
  | {
      kind: 'spot-event';
      enteredAt: number;
      channelIndex: number;
    }
  | {
      kind: 'spot-magnitude';
      enteredAt: number;
      channelIndex: number;
      /** NWS LSR event code chosen in the previous step (HAIL, TSTM WND, etc). */
      eventType: string;
      /** Prompt-side hint of what units we're asking for (INCHES, MPH, FEET). */
      magnitudeUnit: string;
    }
  | {
      kind: 'spot-remarks';
      enteredAt: number;
      channelIndex: number;
      eventType: string;
      magnitudeValue: number | null;
      magnitudeUnit: string | null;
    }
  | {
      kind: 'spot-confirm';
      enteredAt: number;
      channelIndex: number;
      eventType: string;
      magnitudeValue: number | null;
      magnitudeUnit: string | null;
      remarks: string | null;
      /** Location resolved at :spot entry (from reporter's last known
       *  MeshNode.position). Null if the reporter has no position;
       *  the operator can still submit but with lat/lng null. */
      lat: number | null;
      lng: number | null;
      locationSource: 'AUTO_LAST_POSITION' | 'SPOTTER_TYPED' | 'LANDMARK';
    };

export class BbsService {
  private sessions = new Map<string, SessionState>(); // senderNodeId → state
  /** Per-destination last-send timestamp for pacing. Cleared lazily — we never
   *  need this for nodes we haven't talked to in hours. */
  private lastSendAt = new Map<string, number>();
  /** v2.0 Beta 3: track sender → epoch-ms of when the reaper last killed
   *  their session, so a DM arriving shortly after gets a helpful hint
   *  ("your session timed out, send :mail to restart") instead of being
   *  silently swallowed as a normal DM. Entries age out after 30 min. */
  private recentlyReaped = new Map<string, number>();
  private bridge: MeshtasticSerialBridge;
  private config: BbsConfig = defaultBbsConfig();
  /** v2.0 multi-radio: the receiving radio's 4-char short_name. Stamped onto
   *  every mail row + weather-subscriber row so per-radio MailView and
   *  WeatherAlertPoller route correctly. Null until BridgeManager calls
   *  setRadioId — most commonly during the brief window between bridge boot
   *  and identity reveal. */
  private radioId: string | null = null;
  /** Per-sender weather-flow state: when set, the next message they send is
   *  treated as a ZIP code lookup. Lives in a separate map so it doesn't
   *  collide with the mail state machine. */
  private weatherSessions = new Map<string, { enteredAt: number; channelIndex: number }>();

  constructor(bridge: MeshtasticSerialBridge) {
    this.bridge = bridge;
    setInterval(() => this.reapStaleSessions(), 15_000).unref?.();
  }

  /** v2.0: BridgeManager calls this after the bridge's identity is known. */
  setRadioId(radioId: string): void {
    this.radioId = radioId;
  }

  getRadioId(): string | null {
    return this.radioId;
  }

  /** Replace the active config. Called by the API layer after a settings
   *  POST so the live state machine picks up the new triggers / pacing
   *  without a restart. */
  setConfig(config: BbsConfig): void {
    this.config = config;
  }

  getConfig(): BbsConfig {
    return this.config;
  }

  /** v2.0 Beta 4: when on, this BBS auto-replies to any DM that isn't a
   *  BBS command with the :cmd index. Per-radio, set by BridgeManager
   *  from the radios.bbs_only column. */
  private bbsOnlyMode = false;
  setBbsOnlyMode(on: boolean): void { this.bbsOnlyMode = on; }
  isBbsOnly(): boolean { return this.bbsOnlyMode; }

  /** v2.0 Beta 5 Phase 2 (Services Pattern): "is this bridge the
   *  install's designated BBS service node?" Only the BBS node
   *  intercepts BBS commands. Other radios stay general-purpose —
   *  their bbs.isCommand() short-circuits to false, so :mail / :wx
   *  land as plain DMs there. BridgeManager sets this from
   *  radios.is_bbs_node at attach time + on every setBbsNodeRadio
   *  flip. Default false so a freshly-created BbsService stays
   *  inert until BridgeManager confirms. */
  private isBbsServiceNode = false;
  setIsBbsServiceNode(on: boolean): void { this.isBbsServiceNode = on; }
  isBbsNode(): boolean { return this.isBbsServiceNode; }

  /** Called from meshtasticSerial's TEXT handler AFTER isCommand returns
   *  false, when the DM is addressed to the local node and we're in
   *  bbs-only mode. Sends the command index back as an auto-reply.
   *  The original DM still flows through to normal storage; only this
   *  reply is new. Best-effort — sender retry covers transient drops. */
  async maybeAutoReplyForBbsOnly(fromId: string, channelIndex: number): Promise<boolean> {
    if (!this.bbsOnlyMode) return false;
    // v2.0 Beta 5 Phase 2: auto-reply only fires on the install's BBS
    // service node. If admin set bbs_only=1 on a radio that isn't
    // also the BBS node, we suppress the auto-reply — the radio isn't
    // serving BBS commands either way, and replying with the :cmd
    // index would point the sender at commands that won't work on
    // this radio.
    if (!this.isBbsServiceNode) return false;
    if (!this.config.enabled) return false;
    // Don't auto-reply to ourselves (covers loopback if the firmware ever
    // delivers a self-DM) and don't auto-reply if a session is in flight
    // (the dispatcher will respond on its own — we'd double-up).
    const localNodeId = (this.bridge as any).localNodeId as string | null;
    if (localNodeId && fromId === localNodeId) return false;
    if (this.sessions.has(fromId) || this.weatherSessions.has(fromId)) return false;
    const triggers = [this.config.mailTrigger, this.config.weatherTrigger, this.config.spotTrigger, this.config.cmdTrigger];
    await this.reply(fromId, `BBS node. Cmds: ${triggers.join(' ')}`, channelIndex);
    return true;
  }

  /** Test whether this text is one of our configured triggers OR continues an
   *  active session. Replaces the standalone isBbsCommand() function so the
   *  trigger isn't a module const.
   *
   *  v2.0 Beta 5 Phase 2: only the install's designated BBS service node
   *  returns true. Non-BBS bridges short-circuit here so :mail / :wx
   *  land as normal DMs on those radios — there's only ONE BBS endpoint
   *  install-wide, addressed by mesh peers via the BBS radio's node_id. */
  isCommand(text: string, fromId: string): boolean {
    if (!this.config.enabled) return false;
    if (!this.isBbsServiceNode) return false;
    if (!text) return false;
    const t = text.trim().toLowerCase();
    if (t.startsWith(this.config.mailTrigger)) return true;
    if (t.startsWith(this.config.weatherTrigger)) return true;
    if (t.startsWith(this.config.spotTrigger)) return true;
    // v2.0 Beta 5 BBS (alias): :wx and :weather are interchangeable —
    // both prefixes hit the weather flow regardless of which one the
    // operator has saved as the configured trigger. See
    // WEATHER_ALIASES + canonicalizeWeatherAlias().
    for (const alias of WEATHER_ALIASES) {
      if (alias === this.config.weatherTrigger) continue;
      if (alias === this.config.mailTrigger || alias === this.config.cmdTrigger || alias === this.config.spotTrigger) continue;
      if (t === alias || t.startsWith(alias + ' ')) return true;
    }
    if (t === this.config.cmdTrigger) return true;
    // Mid-flow continuation — anything goes if they're in a session.
    if (this.sessions.has(fromId) || this.weatherSessions.has(fromId)) return true;
    return false;
  }

  hasSession(senderNodeId: string): boolean {
    return this.sessions.has(senderNodeId) || this.weatherSessions.has(senderNodeId);
  }

  /**
   * Main entry point — call from handleTextMessage AFTER isBbsCommand returned
   * true. Returns true if we consumed the message (caller should suppress
   * normal handling); false if the message wasn't actually a BBS command.
   *
   * `channelIndex` is the channel the inbound DM rode in on — replies MUST
   * be sent on the same channel because Meshtastic encrypts DMs with the
   * per-channel PSK. Replying on a different channel sends a packet the
   * recipient can't decrypt and they'll never see our menu/prompt.
   */
  async handleInboundDm(fromId: string, text: string, channelIndex: number): Promise<boolean> {
    if (!this.config.enabled) return false;
    // v2.0 Beta 5 BBS (alias): rewrite a leading :wx ↔ :weather to the
    // configured weatherTrigger BEFORE we trim / lowercase / dispatch.
    // Lets every downstream `lower.startsWith(weatherTrigger…)` check
    // hit without having to duplicate matchers across both alias forms.
    // Mid-session messages are untouched (no leading colon to match).
    const canonicalized = canonicalizeWeatherAlias(text, this.config);
    const trimmed = canonicalized.trim();
    const senderNode = this.bridge.getNodes().find(n => n.id === fromId);
    const senderShortName = senderNode?.shortName || fromId.slice(-4);
    const mailTrigger = this.config.mailTrigger;
    const weatherTrigger = this.config.weatherTrigger;
    const cmdTrigger = this.config.cmdTrigger;
    const spotTrigger = this.config.spotTrigger;

    // Cancellation always wins, regardless of current state.
    if (/^(x|cancel|exit|quit)$/i.test(trimmed)) {
      const hadMail = this.sessions.delete(fromId);
      const hadWeather = this.weatherSessions.delete(fromId);
      if (hadMail || hadWeather) await this.reply(fromId, 'OK, exited.', channelIndex);
      return hadMail || hadWeather;
    }

    // v2.1: context-aware in-session help. Pre-2.1 this always replied
    // with `X=cancel. Body cap N chars.` — wrong for every state EXCEPT
    // body-compose. A subscriber typing `?` right after `:mail` hits
    // the just-opened menu (awaiting-recipient-pick) and expects the
    // command catalog, NOT a stray body-compose fragment. Route the
    // reply off the active session kind:
    //  - menu / before-recipient → full :mail command catalog
    //  - awaiting body            → keep the legacy "X=cancel. Body cap"
    //  - reading                  → restate N/D/X choices
    //  - weather (awaiting ZIP)   → restate the ZIP prompt
    if (/^(\?|help|h)$/i.test(trimmed) && (this.sessions.has(fromId) || this.weatherSessions.has(fromId))) {
      const mailSession = this.sessions.get(fromId);
      if (mailSession) {
        if (mailSession.kind === 'awaiting-recipient-pick') {
          return this.sendMailHelp(fromId, channelIndex);
        }
        if (mailSession.kind === 'awaiting-recipient') {
          await this.reply(fromId, `TO whom? 4-char shortname (e.g. BH20), !02eb3bec hex form, or X=cancel.`, channelIndex);
          return true;
        }
        if (mailSession.kind === 'awaiting-body') {
          await this.reply(fromId, `Type message body. X=cancel. Body cap ${this.config.bodyMaxChars} chars.`, channelIndex);
          return true;
        }
        if (mailSession.kind === 'reading') {
          await this.reply(fromId, `Replying anything composes a reply. N=next D=delete X=exit.`, channelIndex);
          return true;
        }
        // v3.0 SKYWARN spot-flow help — each step gets a state-
        // specific hint restating the choices, since a reporter
        // pinging `?` mid-flow is typically confused about what
        // the current prompt wants.
        if (mailSession.kind === 'spot-event') {
          await this.reply(fromId, `SPOT event? ${SPOT_EVENT_MENU} X=cancel.`, channelIndex);
          return true;
        }
        if (mailSession.kind === 'spot-magnitude') {
          await this.reply(fromId, `${mailSession.eventType} ${mailSession.magnitudeUnit.toLowerCase()}? Type a number, .=skip, X=cancel.`, channelIndex);
          return true;
        }
        if (mailSession.kind === 'spot-remarks') {
          await this.reply(fromId, `Remarks (optional). Type text, .=skip, X=cancel.`, channelIndex);
          return true;
        }
        if (mailSession.kind === 'spot-confirm') {
          await this.reply(fromId, `Y=send N=cancel. Retype anything to edit remarks.`, channelIndex);
          return true;
        }
      }
      if (this.weatherSessions.has(fromId)) {
        await this.reply(fromId, `Send 5-digit US ZIP, or X=cancel.`, channelIndex);
        return true;
      }
      // Belt-and-suspenders default — every session.kind is handled
      // above, but if a future kind lands without an update here the
      // catalog is the safest fallback.
      return this.sendMailHelp(fromId, channelIndex);
    }

    // Weather flow — single-message exchange. If they're waiting for a ZIP,
    // anything that arrives now is the ZIP.
    const weatherSession = this.weatherSessions.get(fromId);
    if (weatherSession) {
      weatherSession.enteredAt = Date.now();
      weatherSession.channelIndex = channelIndex;
      return this.handleWeatherZip(fromId, trimmed, channelIndex);
    }

    const session = this.sessions.get(fromId);
    if (session) {
      session.enteredAt = Date.now();
      session.channelIndex = channelIndex;
      return this.dispatchInFlow(fromId, senderShortName, session, trimmed, channelIndex);
    }

    // No active session — match against configured triggers.
    const lower = trimmed.toLowerCase();

    // Command index — :cmd lists every root trigger this BBS responds to,
    // in classic BBS tradition. No descriptions, just the names so the
    // packet fits comfortably regardless of how many subsystems we add.
    if (lower === cmdTrigger) {
      return this.handleCmdIndex(fromId, channelIndex);
    }

    if (lower === mailTrigger) {
      return this.openMenu(fromId, channelIndex);
    }
    if (lower === `${mailTrigger} send` || lower === `${mailTrigger} s`) {
      return this.startSend(fromId, channelIndex);
    }
    if (lower === `${mailTrigger} read` || lower === `${mailTrigger} r`) {
      return this.startRead(fromId, channelIndex, null);
    }
    // v2.1: category-filtered read. `:mail r wx` / `:mail r fx` /
    // `:mail r other` lets a subscriber drown out the weather noise
    // (or surf JUST the weather) without paging through every item.
    if (lower === `${mailTrigger} r wx` || lower === `${mailTrigger} read wx`) {
      return this.startRead(fromId, channelIndex, 'WX');
    }
    if (lower === `${mailTrigger} r fx` || lower === `${mailTrigger} read fx`) {
      return this.startRead(fromId, channelIndex, 'FX');
    }
    if (lower === `${mailTrigger} r other` || lower === `${mailTrigger} read other`) {
      return this.startRead(fromId, channelIndex, 'OTHER');
    }
    // v2.1: bulk delete by category. `:mail d wx` wipes every WX
    // alert in the subscriber's inbox (read OR unread); `:mail d fx`
    // wipes daily forecasts; `:mail d other` is intentionally NOT
    // supported — that would risk a misfire wiping real messages
    // the subscriber actually wanted.
    if (lower === `${mailTrigger} d wx` || lower === `${mailTrigger} delete wx`) {
      return this.bulkDelete(fromId, channelIndex, 'WX');
    }
    if (lower === `${mailTrigger} d fx` || lower === `${mailTrigger} delete fx`) {
      return this.bulkDelete(fromId, channelIndex, 'FX');
    }
    // v2.1: command catalog. With the category filters + bulk
    // deletes the surface grew enough that a subscriber should be
    // able to discover the commands from the air. Mirrors how
    // `:weather help` and `:weather ?` already work.
    if (lower === `${mailTrigger} help` || lower === `${mailTrigger} ?`) {
      return this.sendMailHelp(fromId, channelIndex);
    }

    // v3.0 SKYWARN: :spot — start a Local Storm Report intake. Multi-
    // step form (event type → magnitude if applicable → remarks →
    // confirm). See sessionState kinds 'spot-event' / 'spot-magnitude'
    // / 'spot-remarks' / 'spot-confirm' + dispatchInFlow branches.
    if (lower === spotTrigger) {
      return this.startSpot(fromId, senderShortName, channelIndex);
    }
    if (lower === `${spotTrigger} help` || lower === `${spotTrigger} ?`) {
      return this.sendSpotHelp(fromId, channelIndex);
    }

    // Weather trigger (no args) — return the command menu. v2.0 Beta 4:
    // replaces the old "send a ZIP" prompt flow with a help message so
    // subscribers can discover what's actually available. The prompt path
    // wasn't discoverable and operators had to remember the subcommands.
    if (lower === weatherTrigger) {
      return this.handleWeatherHelp(fromId, channelIndex);
    }
    if (lower === `${weatherTrigger} help` || lower === `${weatherTrigger} ?`) {
      return this.handleWeatherHelp(fromId, channelIndex);
    }
    // Subcommand: subscribe / unsubscribe / stop / off / status.
    // Recognized BEFORE the generic `<trigger> <zip>` shortcut so e.g.
    // ":weather subscribe" doesn't get treated as ZIP=subscribe.
    if (lower === `${weatherTrigger} subscribe`) {
      // No ZIP given — subscribe to the operator's home ZIP (back-compat).
      return this.handleWeatherSubscribe(fromId, channelIndex, null);
    }
    if (lower.startsWith(`${weatherTrigger} subscribe `)) {
      // v2.0 Beta 4: per-subscriber ZIP. `:weather subscribe 21701` opts
      // into alerts for that ZIP specifically (not the operator's home).
      const zip = trimmed.slice(`${weatherTrigger} subscribe `.length).trim();
      return this.handleWeatherSubscribe(fromId, channelIndex, zip);
    }
    if (
      lower === `${weatherTrigger} unsubscribe` ||
      lower === `${weatherTrigger} stop` ||
      lower === `${weatherTrigger} off`
    ) {
      return this.handleWeatherUnsubscribe(fromId, channelIndex);
    }
    if (lower === `${weatherTrigger} status`) {
      return this.handleWeatherStatus(fromId, channelIndex);
    }
    // Shortcut: `:weather <zip>` returns an on-demand forecast for that ZIP.
    // Any non-digit subcommand has been handled above; what falls through
    // here is treated as a ZIP lookup.
    if (lower.startsWith(`${weatherTrigger} `)) {
      const zip = trimmed.slice(weatherTrigger.length + 1).trim();
      return this.handleWeatherZip(fromId, zip, channelIndex);
    }

    // Anything else with the `:` prefix — politely reject so the AI assistant
    // doesn't also try to handle it. Point at the command index for discovery.
    if (trimmed.startsWith(':')) {
      await this.reply(fromId, `Unknown command. Send ${cmdTrigger} for available commands.`, channelIndex);
      return true;
    }

    return false;
  }

  // ---- State entry points ----

  /** v2.0 Beta 4: classic BBS command index. DMing :cmd returns the active
   *  trigger roots only — names, no descriptions — so the message stays
   *  tiny regardless of how many subsystems we add. Subscribers chase the
   *  subsystem's own `help` for usage (e.g., `:wx help`). */
  private async handleCmdIndex(fromId: string, channelIndex: number): Promise<boolean> {
    const triggers = [this.config.mailTrigger, this.config.weatherTrigger, this.config.spotTrigger, this.config.cmdTrigger];
    await this.reply(fromId, `Cmds: ${triggers.join(' ')}`, channelIndex);
    return true;
  }

  private async openMenu(fromId: string, channelIndex: number): Promise<boolean> {
    // v2.1: categorised breakdown so a subscriber buried in weather
    // pushes can see at a glance whether anything REAL is waiting.
    // WX = NWS alerts, FX = scheduled daily forecast pushes,
    // Other = everything else (real mail from real nodes).
    const counts = meshDb.countUnreadByCategory(fromId, this.radioId);
    // Trigger name reused in the hints so the subscriber doesn't have
    // to remember the configured mail trigger when copy-pasting.
    const t = this.config.mailTrigger;
    if (counts.total > 0) {
      // Single-packet ceiling is 200; this fits under 130 chars with
      // realistic counts (≤ ~999 per bucket).
      const breakdown = `${counts.total} new (WX:${counts.wx} FX:${counts.fx} Other:${counts.other})`;
      // v2.1: always include `?=help` so the new command surface
      // (`r wx|fx|other`, `d wx|fx`) is discoverable without us
      // having to bloat this prompt. The conditional `r other` hint
      // stays — it's the highest-value tip when an inbox is
      // weather-flooded but has real mail behind it.
      const hints = counts.other > 0
        ? `${t} r other = real mail. R=all S=send X=exit ?=help.`
        : `R=read all S=send X=exit ?=help.`;
      await this.reply(fromId, `MAIL: ${breakdown}. ${hints}`, channelIndex);
    } else {
      await this.reply(fromId, `MAIL: no new. Reply S=send, X=exit, ${t} ? = help.`, channelIndex);
    }
    // Park them in a synthetic awaiting state where their next single-letter
    // input picks an action. We piggyback on awaiting-recipient with a sentinel
    // candidates list to keep state shape simple — see dispatchInFlow.
    this.sessions.set(fromId, { kind: 'awaiting-recipient-pick', enteredAt: Date.now(), channelIndex, candidates: [] });
    return true;
  }

  /**
   * v2.1 — bulk delete unread + read mail in a single category for
   * one subscriber. Used by `:mail d wx` / `:mail d fx` to wipe
   * stale weather noise. Always scoped to the requesting node id so
   * a subscriber can only wipe their OWN mail.
   */
  private async bulkDelete(
    fromId: string,
    channelIndex: number,
    category: 'WX' | 'FX',
  ): Promise<boolean> {
    const n = meshDb.deleteMailByCategory(fromId, category, this.radioId);
    this.sessions.delete(fromId);
    this.bridge.emit('bbsMail', { recipientNodeId: fromId, bulkDelete: true, category, count: n });
    const label = category === 'WX' ? 'weather alerts' : 'daily forecasts';
    await this.reply(fromId, n > 0
      ? `Deleted ${n} ${label}.`
      : `No ${label} in inbox.`,
      channelIndex,
    );
    return true;
  }

  /**
   * v2.1 — single-packet help reply for `:mail help` / `:mail ?`.
   * Matches the format of handleWeatherHelp(): one line, pipe-
   * separated, templated on the configured mailTrigger so a
   * subscriber who's renamed the trigger sees the same trigger
   * back. ~125 chars when trigger is the default `:mail` — fits
   * the 200-char single-packet ceiling with margin.
   */
  private async sendMailHelp(fromId: string, channelIndex: number): Promise<boolean> {
    const t = this.config.mailTrigger;
    const msg =
      `${t} = inbox | ` +
      `${t} r [wx|fx|other] = read | ` +
      `${t} s = send | ` +
      `${t} d wx|fx = bulk del | ` +
      `${t} SHORT = quick-to-node`;
    await this.reply(fromId, msg, channelIndex);
    return true;
  }

  // -------------------------------------------------------------------
  // v3.0 SKYWARN — :spot Local Storm Report flow
  // -------------------------------------------------------------------

  /**
   * Entry point for :spot. Puts the reporter into the event-type
   * selection step and prompts with the one-line event menu. Location
   * is captured lazily at confirm time from the reporter's last known
   * MeshNode.position; if no position exists at confirm, the report
   * goes in with lat/lng null and location_source='SPOTTER_TYPED'
   * (the remarks field becomes the geographic description).
   */
  private async startSpot(
    fromId: string,
    _senderShortName: string,
    channelIndex: number,
  ): Promise<boolean> {
    this.sessions.set(fromId, {
      kind: 'spot-event',
      enteredAt: Date.now(),
      channelIndex,
    });
    // Prompt fits in one packet — SPOT_EVENT_MENU is ~72 chars, plus
    // wrapper ~40 chars = ~112 total.
    await this.reply(
      fromId,
      `SPOT: what happened? ${SPOT_EVENT_MENU} X=cancel.`,
      channelIndex,
    );
    return true;
  }

  /** One-line command catalog for :spot. Mirrors sendMailHelp shape. */
  private async sendSpotHelp(fromId: string, channelIndex: number): Promise<boolean> {
    const t = this.config.spotTrigger;
    const msg =
      `${t} = start LSR (Local Storm Report) | ` +
      `${t} ? = help | ` +
      `flow: pick event -> magnitude if applicable -> optional remarks -> Y to send`;
    await this.reply(fromId, msg, channelIndex);
    return true;
  }

  /**
   * Handle the event-type selection step. Reporter typed a single or
   * two-letter code — resolve to a SpotEventDef and transition to the
   * next appropriate state:
   *
   *   - Events with a magnitudeUnit  → spot-magnitude
   *   - Events without (WALL CLOUD,
   *     FUNNEL, TORNADO, OTHER)      → spot-remarks
   *
   * Unrecognized input → re-prompt with the menu.
   */
  private async handleSpotEvent(
    fromId: string,
    channelIndex: number,
    trimmed: string,
  ): Promise<boolean> {
    const def = findSpotEventByCode(trimmed);
    if (!def) {
      await this.reply(fromId, `Unknown code. ${SPOT_EVENT_MENU} X=cancel.`, channelIndex);
      return true;
    }
    if (def.magnitudeUnit) {
      this.sessions.set(fromId, {
        kind: 'spot-magnitude',
        enteredAt: Date.now(),
        channelIndex,
        eventType: def.eventType,
        magnitudeUnit: def.magnitudeUnit,
      });
      // Unit-specific prompt so a reporter typing "3" for hail knows
      // that means 3 inches, not 3 mph.
      const unitWord = def.magnitudeUnit === 'INCHES' ? 'inches'
        : def.magnitudeUnit === 'MPH' ? 'mph'
        : def.magnitudeUnit === 'FEET' ? 'feet'
        : def.magnitudeUnit.toLowerCase();
      await this.reply(
        fromId,
        `${def.eventType} — ${unitWord}? Type a number (e.g. 1.5), .=skip, X=cancel.`,
        channelIndex,
      );
      return true;
    }
    // No magnitude to collect — jump straight to remarks.
    this.sessions.set(fromId, {
      kind: 'spot-remarks',
      enteredAt: Date.now(),
      channelIndex,
      eventType: def.eventType,
      magnitudeValue: null,
      magnitudeUnit: null,
    });
    await this.reply(fromId, `Remarks? Describe what you saw, or .=skip, X=cancel.`, channelIndex);
    return true;
  }

  /**
   * Handle the magnitude step. `.` skips; otherwise parse a positive
   * finite number and clamp to sane bounds (hail ≤ 6 inches — Aurora
   * NE 2003 record was 7"; wind ≤ 300 mph; flood depth ≤ 100 ft).
   * Out-of-range or non-numeric → re-prompt.
   */
  private async handleSpotMagnitude(
    fromId: string,
    channelIndex: number,
    trimmed: string,
    session: Extract<SessionState, { kind: 'spot-magnitude' }>,
  ): Promise<boolean> {
    let value: number | null = null;
    if (trimmed !== '.') {
      const parsed = parseFloat(trimmed);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        await this.reply(fromId, `Not a number. Type e.g. 1.5, or .=skip, X=cancel.`, channelIndex);
        return true;
      }
      // Sanity clamp — a report of "500 mph wind" is a typo, not a
      // real observation.
      const upper = session.magnitudeUnit === 'INCHES' ? 6
        : session.magnitudeUnit === 'MPH' ? 300
        : session.magnitudeUnit === 'FEET' ? 100
        : 10000;
      if (parsed > upper) {
        await this.reply(fromId, `Value ${parsed} exceeds ${upper} ${session.magnitudeUnit.toLowerCase()} — retype, .=skip, X=cancel.`, channelIndex);
        return true;
      }
      value = parsed;
    }
    this.sessions.set(fromId, {
      kind: 'spot-remarks',
      enteredAt: Date.now(),
      channelIndex,
      eventType: session.eventType,
      magnitudeValue: value,
      magnitudeUnit: session.magnitudeUnit,
    });
    await this.reply(fromId, `Remarks? Describe what you saw, or .=skip, X=cancel.`, channelIndex);
    return true;
  }

  /**
   * Handle the remarks step. `.` skips (null remarks). Anything else
   * is captured verbatim up to bodyMaxChars (same 200-char cap the
   * mail body uses). Then resolves location from the reporter's last
   * known MeshNode.position and transitions to the confirm step.
   */
  private async handleSpotRemarks(
    fromId: string,
    channelIndex: number,
    trimmed: string,
    session: Extract<SessionState, { kind: 'spot-remarks' }>,
  ): Promise<boolean> {
    const remarks = trimmed === '.' ? null : trimmed.slice(0, this.config.bodyMaxChars);
    // Location resolution — snapshot at confirm-time, not entry-time,
    // so if the reporter's position updates while they're typing we
    // pick up the fresher fix.
    const senderNode = this.bridge.getNodes().find(n => n.id === fromId);
    const pos = senderNode?.position;
    const lat = pos?.lat ?? null;
    const lng = pos?.lng ?? null;
    const locationSource: 'AUTO_LAST_POSITION' | 'SPOTTER_TYPED' =
      lat !== null && lng !== null ? 'AUTO_LAST_POSITION' : 'SPOTTER_TYPED';

    this.sessions.set(fromId, {
      kind: 'spot-confirm',
      enteredAt: Date.now(),
      channelIndex,
      eventType: session.eventType,
      magnitudeValue: session.magnitudeValue,
      magnitudeUnit: session.magnitudeUnit,
      remarks,
      lat, lng, locationSource,
    });

    // Confirm summary. Fits under 200 chars in realistic cases:
    //   "SPOT: HAIL 1.5in at 39.4213,-77.4103. Rmks: golf-ball. Y=send N=cancel."
    const mag = session.magnitudeValue !== null && session.magnitudeUnit
      ? ` ${session.magnitudeValue}${this.abbrevUnit(session.magnitudeUnit)}`
      : '';
    const loc = lat !== null && lng !== null
      ? `${lat.toFixed(4)},${lng.toFixed(4)}`
      : '<no fix — will submit without coords>';
    const rmks = remarks ? ` Rmks: ${remarks.slice(0, 60)}${remarks.length > 60 ? '…' : ''}.` : '';
    await this.reply(
      fromId,
      `SPOT: ${session.eventType}${mag} at ${loc}.${rmks} Y=send N=cancel.`,
      channelIndex,
    );
    return true;
  }

  /** Abbreviate a NWS unit code for the tight confirm summary. */
  private abbrevUnit(unit: string): string {
    switch (unit) {
      case 'INCHES': return 'in';
      case 'MPH':    return 'mph';
      case 'FEET':   return 'ft';
      default:       return unit.toLowerCase();
    }
  }

  /**
   * Handle the confirm step. Y writes the row + acks; N cancels; any
   * other input is treated as "edit remarks" (drops back to
   * spot-remarks with the same event/magnitude and lets the reporter
   * re-type the remarks field). This lets a reporter fix a typo
   * without abandoning the whole form.
   */
  private async handleSpotConfirm(
    fromId: string,
    senderShortName: string,
    channelIndex: number,
    trimmed: string,
    session: Extract<SessionState, { kind: 'spot-confirm' }>,
  ): Promise<boolean> {
    if (/^n(o)?$/i.test(trimmed)) {
      this.sessions.delete(fromId);
      await this.reply(fromId, `SPOT cancelled. Nothing saved.`, channelIndex);
      return true;
    }
    if (/^y(es)?$/i.test(trimmed)) {
      return this.finalizeSpot(fromId, senderShortName, channelIndex, session);
    }
    // Anything else = edit remarks. Preserve everything else, re-prompt.
    this.sessions.set(fromId, {
      kind: 'spot-remarks',
      enteredAt: Date.now(),
      channelIndex,
      eventType: session.eventType,
      magnitudeValue: session.magnitudeValue,
      magnitudeUnit: session.magnitudeUnit,
    });
    await this.reply(fromId, `Edit remarks. Type new text, .=skip (clear), X=cancel.`, channelIndex);
    return true;
  }

  /**
   * Write the storm report to the DB, emit the STORM_REPORT event so
   * the operator's Event Log lights up, and reply with the confirmed
   * report id so the reporter can reference it later.
   *
   * spotter_source defaults to 'SPOTTER' in v3.0. A future slice could
   * add a `:spot source trained` shortcut to let a SKYWARN-certified
   * reporter self-identify, but for the first cut everyone lands as
   * SPOTTER — the operator can promote the row via a dashboard edit
   * or a PATCH endpoint we'll add later.
   */
  private async finalizeSpot(
    fromId: string,
    senderShortName: string,
    channelIndex: number,
    session: Extract<SessionState, { kind: 'spot-confirm' }>,
  ): Promise<boolean> {
    const now = Date.now();
    const id = meshDb.addStormReport({
      reporterNodeId: fromId,
      reporterShortName: senderShortName,
      radioId: this.radioId,
      // workspace_id resolution is a v3.0-next-slice concern — for
      // now we leave it null; the storm_reports index by radio_id
      // covers the operator's dashboard queries either way, and a
      // v3.0.x follow-up can backfill workspace_id from the radio's
      // workspace association at insert-time.
      workspaceId: null,
      reportedAt: now,
      receivedAt: now,
      eventType: session.eventType,
      magnitudeValue: session.magnitudeValue,
      magnitudeUnit: session.magnitudeUnit,
      lat: session.lat,
      lng: session.lng,
      locationSource: session.locationSource,
      locationDescription: null,
      county: null,
      state: null,
      spotterSource: 'SPOTTER',
      remarks: session.remarks,
      now,
    });
    this.sessions.delete(fromId);

    // Emit the operator-visible event so the Event Log surfaces it in
    // real time. STORM_REPORT event type is v3.0-new — see
    // meshtastic/types.ts MeshEvent union.
    const magStr = session.magnitudeValue !== null && session.magnitudeUnit
      ? ` ${session.magnitudeValue}${this.abbrevUnit(session.magnitudeUnit)}`
      : '';
    this.bridge.emit('event', {
      id: `storm-${id}`,
      type: 'STORM_REPORT',
      timestamp: now,
      nodeId: fromId,
      details: `${senderShortName}: ${session.eventType}${magStr}${session.remarks ? ' — ' + session.remarks.slice(0, 80) : ''}`,
    });
    // Also emit the fine-grained storm-report event for the future
    // SSE-driven Storm Reports tab to pick up (parallels bbsMail /
    // bbsSubscriber events).
    this.bridge.emit('stormReport', { id, action: 'created', reporterNodeId: fromId });

    console.log(`[BBS] SPOT logged id=${id} reporter=${senderShortName} (${fromId}) event="${session.eventType}"${magStr} loc=${session.lat ?? 'null'},${session.lng ?? 'null'} remarks="${session.remarks ?? ''}"`);
    await this.reply(fromId, `SPOT logged #${id}. Thanks — stay safe.`, channelIndex);
    return true;
  }

  private async startSend(fromId: string, channelIndex: number): Promise<boolean> {
    this.sessions.set(fromId, { kind: 'awaiting-recipient', enteredAt: Date.now(), channelIndex });
    // v2.0 Beta 3: explicit "recipient first" wording. The old "Send TO: short
    // name (4 chars) or X." prompt left operators thinking the next thing
    // they typed was the body — and the body would then get silently
    // truncated to its first 4 chars and looked up as a recipient name. The
    // fallback path in handleRecipientText now catches that case + caches
    // the body, but a clearer prompt up front prevents the confusion at all.
    await this.reply(fromId, 'TO whom? Reply with 4-char name (e.g. BH20) or X to cancel. Body comes after.', channelIndex);
    return true;
  }

  private async startRead(
    fromId: string,
    channelIndex: number,
    // v2.1: category filter sticks across the read session — N
    // tap fetches the NEXT unread in the same bucket.
    category: 'WX' | 'FX' | 'OTHER' | null = null,
  ): Promise<boolean> {
    const next = category
      ? meshDb.nextUnreadByCategory(fromId, category, this.radioId)
      : meshDb.nextUnreadFor(fromId, this.radioId);
    if (!next) {
      this.sessions.delete(fromId);
      const noneLabel = category === 'WX' ? 'No unread weather alerts.'
        : category === 'FX' ? 'No unread daily forecasts.'
        : category === 'OTHER' ? 'No unread real mail.'
        : 'No unread mail.';
      await this.reply(fromId, noneLabel, channelIndex);
      return true;
    }
    this.sessions.set(fromId, {
      kind: 'reading',
      enteredAt: Date.now(),
      channelIndex,
      currentMailId: next.id,
      category,
    });
    const when = relTime(next.postedAt);
    const body = next.body.length > 160 ? next.body.slice(0, 160) + '…' : next.body;
    await this.reply(fromId, `From ${next.senderShortName} ${when}: ${body}\nN=next D=delete X=exit`, channelIndex);
    // Mark the mail as read the moment we successfully serve it — earlier we
    // only marked on N/D, which meant (a) the dashboard couldn't reflect the
    // remote's read state until they moved past the message, and (b) a user
    // exiting with X while reading the last item left it unread forever.
    // Emitting the bbsMail event makes the operator's MailView re-fetch via
    // its SSE subscription so the outbox "Unread by recipient" indicator
    // flips to "Read Xs ago" in real time.
    if (meshDb.markMailRead(next.id)) {
      this.bridge.emit('bbsMail', { recipientNodeId: fromId, mailId: next.id, read: true });
    }
    return true;
  }

  // ---- In-flow dispatch ----

  private async dispatchInFlow(
    fromId: string,
    senderShortName: string,
    session: SessionState,
    trimmed: string,
    channelIndex: number,
  ): Promise<boolean> {
    if (session.kind === 'awaiting-recipient-pick') {
      // Top-level menu choice. R = read, S = send. Anything else: treat as
      // an attempt to send-by-short-name (skip the explicit S step) so people
      // can type `:mail` then `BH20` then a body without the menu friction.
      if (/^r$/i.test(trimmed)) {
        return this.startRead(fromId, channelIndex, null);
      }
      if (/^s$/i.test(trimmed)) {
        return this.startSend(fromId, channelIndex);
      }
      // Implicit "S then this short name" shortcut.
      return this.handleRecipientText(fromId, trimmed, channelIndex);
    }

    if (session.kind === 'awaiting-recipient') {
      return this.handleRecipientText(fromId, trimmed, channelIndex);
    }

    if (session.kind === 'awaiting-body') {
      return this.storeMail(fromId, senderShortName, session.recipientNodeId, session.recipientShortName, trimmed, channelIndex);
    }

    if (session.kind === 'reading') {
      return this.handleReadingInput(fromId, session, trimmed, channelIndex);
    }

    // v3.0 SKYWARN spot-flow branches. Each session kind maps to the
    // matching handler that reads the current step's input, updates
    // the DB or session, and transitions to the next state.
    if (session.kind === 'spot-event') {
      return this.handleSpotEvent(fromId, channelIndex, trimmed);
    }
    if (session.kind === 'spot-magnitude') {
      return this.handleSpotMagnitude(fromId, channelIndex, trimmed, session);
    }
    if (session.kind === 'spot-remarks') {
      return this.handleSpotRemarks(fromId, channelIndex, trimmed, session);
    }
    if (session.kind === 'spot-confirm') {
      return this.handleSpotConfirm(fromId, senderShortName, channelIndex, trimmed, session);
    }

    return false;
  }

  // ---- Recipient resolution ----

  private async handleRecipientText(fromId: string, text: string, channelIndex: number): Promise<boolean> {
    const session = this.sessions.get(fromId);
    // Carry pendingBody forward across re-prompts so the operator only types
    // it once. Set only on awaiting-recipient(-pick) sessions; cleared once
    // we hand off to storeMail or to awaiting-body.
    const pendingBody = (session?.kind === 'awaiting-recipient' || session?.kind === 'awaiting-recipient-pick')
      ? session.pendingBody
      : undefined;
    const senderShortName = this.bridge.getNodes().find(n => n.id === fromId)?.shortName || fromId.slice(-4);

    // Hex id form (!02eb3bec) — bypass short-name lookup.
    if (/^![0-9a-f]{8}$/i.test(text)) {
      const targetId = text.toLowerCase();
      const node = this.bridge.getNodes().find(n => n.id === targetId);
      if (!node) {
        await this.reply(fromId, `No node ${targetId} on mesh.`, channelIndex);
        return true;
      }
      return pendingBody
        ? this.storeMail(fromId, senderShortName, node.id, node.shortName || node.id.slice(-4), pendingBody, channelIndex)
        : this.advanceToBody(fromId, node, channelIndex);
    }

    // Pick-by-number flow if we previously offered candidates.
    if (session?.kind === 'awaiting-recipient-pick' && session.candidates.length > 0) {
      const idx = parseInt(text, 10) - 1;
      if (Number.isFinite(idx) && idx >= 0 && idx < session.candidates.length) {
        const recipient = session.candidates[idx];
        return pendingBody
          ? this.storeMail(fromId, senderShortName, recipient.id, recipient.shortName || recipient.id.slice(-4), pendingBody, channelIndex)
          : this.advanceToBody(fromId, recipient, channelIndex);
      }
      // Not a number? Treat as a fresh short-name lookup.
    }

    // v2.0 Beta 3: detect "this input is clearly a body, not a 4-char name."
    // A valid Meshtastic short name is 1-4 chars and is a single token (no
    // spaces). If the operator dumps a real message at this prompt — what
    // they expected to be the body field, since the UI looks like iMessage
    // — cache it as pendingBody and re-prompt for the recipient instead of
    // truncating to the first 4 chars and silently losing their typing.
    // Bypass when we ALREADY have a pendingBody cached so they don't
    // accidentally overwrite it by typing twice.
    const looksLikeBody = !pendingBody && (text.length > 4 || /\s/.test(text));
    if (looksLikeBody) {
      const recent = this.recentOnlineNames(fromId);
      this.sessions.set(fromId, {
        kind: 'awaiting-recipient',
        enteredAt: Date.now(),
        channelIndex,
        pendingBody: text.slice(0, this.config.bodyMaxChars),
      });
      const truncNote = text.length > this.config.bodyMaxChars
        ? ` (trimmed to ${this.config.bodyMaxChars}c)`
        : '';
      await this.reply(
        fromId,
        `Body saved (${Math.min(text.length, this.config.bodyMaxChars)}c)${truncNote}. TO whom? 4-char name. Online: ${recent || '(none)'}.`,
        channelIndex,
      );
      return true;
    }

    // Short-name lookup.
    const wanted = text.toUpperCase().slice(0, 4);
    const matches = this.bridge.getNodes().filter(
      n => (n.shortName || '').toUpperCase() === wanted
    );

    if (matches.length === 0) {
      const recent = this.recentOnlineNames(fromId);
      const bodyHint = pendingBody ? ' Body still saved.' : '';
      await this.reply(fromId, `No '${wanted}'. Online: ${recent || '(none)'}.${bodyHint}`, channelIndex);
      return true;
    }

    if (matches.length === 1) {
      const recipient = matches[0];
      return pendingBody
        ? this.storeMail(fromId, senderShortName, recipient.id, recipient.shortName || recipient.id.slice(-4), pendingBody, channelIndex)
        : this.advanceToBody(fromId, recipient, channelIndex);
    }

    // Multiple — disambiguate.
    const listing = matches.slice(0, 4).map((n, i) =>
      `${i + 1}=${n.name || n.id} (${relTime(n.lastSeen)})`
    ).join(', ');
    this.sessions.set(fromId, {
      kind: 'awaiting-recipient-pick',
      enteredAt: Date.now(),
      channelIndex,
      candidates: matches.slice(0, 4),
      pendingBody,
    });
    await this.reply(fromId, `${matches.length} '${wanted}': ${listing}. Reply 1-${Math.min(4, matches.length)}.`, channelIndex);
    return true;
  }

  /** Helper: comma-less list of recent-online short names for the
   *  "Online: …" hint in error replies. Skips the sender themselves. */
  private recentOnlineNames(fromId: string): string {
    return this.bridge.getNodes()
      .filter(n => n.online && n.id !== fromId)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 6)
      .map(n => n.shortName)
      .filter(Boolean)
      .join(' ');
  }

  private async advanceToBody(fromId: string, recipient: MeshNode, channelIndex: number): Promise<boolean> {
    this.sessions.set(fromId, {
      kind: 'awaiting-body',
      enteredAt: Date.now(),
      channelIndex,
      recipientNodeId: recipient.id,
      recipientShortName: recipient.shortName || recipient.id.slice(-4),
    });
    await this.reply(fromId, `TO ${recipient.shortName} (${recipient.name || recipient.id}). Send body, max 200, X to cancel.`, channelIndex);
    return true;
  }

  // ---- Store + push-notify ----

  private async storeMail(
    fromId: string,
    senderShortName: string,
    recipientNodeId: string,
    recipientShortName: string,
    body: string,
    channelIndex: number,
  ): Promise<boolean> {
    // Enforce cap at the boundary so we don't store partial-encrypted oversize
    // payloads. Trim then truncate.
    const clean = body.trim().slice(0, this.config.bodyMaxChars);
    if (!clean) {
      await this.reply(fromId, 'Empty body. Try again or X.', channelIndex);
      return true;
    }

    let mailId: number;
    try {
      mailId = meshDb.insertMail({
        sender_node_id: fromId,
        sender_short_name: senderShortName,
        recipient_node_id: recipientNodeId,
        posted_at: Date.now(),
        body: clean,
        radio_id: this.radioId,
      });
    } catch (err: any) {
      console.error('[BBS] insertMail failed:', err.message);
      await this.reply(fromId, 'Storage error. Try again later.', channelIndex);
      this.sessions.delete(fromId);
      return true;
    }

    this.sessions.delete(fromId);
    await this.reply(fromId, `✉ Sent to ${recipientShortName} (id=${mailId}).`, channelIndex);
    // Tell the dashboard a new piece of mail landed so the UI updates immediately.
    this.bridge.emit('bbsMail', { recipientNodeId, mailId });
    // Push notification — fire-and-forget. Use the same channel the sender
    // came in on; that's the channel the BBS conversation is happening on
    // and the recipient's most likely to share with us. If they don't share
    // it, we'll fall back to channel 0 (PRIMARY) which is universal-default.
    this.pushNotify(recipientNodeId, senderShortName, mailId, channelIndex).catch(err => {
      console.warn(`[BBS] push notify to ${recipientNodeId} failed:`, err?.message);
    });

    return true;
  }

  private async pushNotify(
    recipientNodeId: string,
    senderShortName: string,
    mailId: number,
    preferredChannel: number,
  ): Promise<void> {
    const localNodeId = (this.bridge as any).localNodeId as string | null;
    if (recipientNodeId === localNodeId) return;

    const text = `✉ Mail from ${senderShortName}. DM :mail R to read.`;
    // Try the conversation's channel first; if the firmware NAKs it (e.g.,
    // recipient doesn't share that channel with us), retry on PRIMARY.
    try {
      await this.bridge.sendMessage(text, recipientNodeId, preferredChannel);
      meshDb.markMailDelivered(mailId);
    } catch (err: any) {
      console.warn(`[BBS] push notify on ch=${preferredChannel} failed for mail ${mailId}: ${err?.message}. Retrying on ch=${PUSH_CHANNEL_FALLBACK}.`);
      if (preferredChannel === PUSH_CHANNEL_FALLBACK) return;
      try {
        await this.bridge.sendMessage(text, recipientNodeId, PUSH_CHANNEL_FALLBACK);
        meshDb.markMailDelivered(mailId);
      } catch (err2: any) {
        console.warn(`[BBS] push notify fallback also failed for mail ${mailId}:`, err2?.message);
      }
    }
  }

  // ---- Reading flow ----

  private async handleReadingInput(
    fromId: string,
    session: Extract<SessionState, { kind: 'reading' }>,
    text: string,
    channelIndex: number,
  ): Promise<boolean> {
    if (/^d$/i.test(text)) {
      meshDb.deleteMail(session.currentMailId);
      this.bridge.emit('bbsMail', { recipientNodeId: fromId, mailId: session.currentMailId, deleted: true });
      // v2.1: stay within the original category filter when advancing
      // — if the operator started with `:mail r other`, D and N keep
      // serving only Other mail until they're empty.
      return this.startRead(fromId, channelIndex, session.category ?? null);
    }

    if (/^n$/i.test(text)) {
      // Read mark already happened in startRead when this mail was served;
      // just advance to the next unread. v2.1: same category-stickiness
      // as the D branch above.
      return this.startRead(fromId, channelIndex, session.category ?? null);
    }

    // Anything else → treat as reply body (compose mail back to the sender).
    const mail = meshDb.loadInbox(fromId, 200, this.radioId).find(m => m.id === session.currentMailId);
    if (!mail) {
      this.sessions.delete(fromId);
      await this.reply(fromId, 'Mail vanished. Try :mail.', channelIndex);
      return true;
    }
    // Read mark already happened in startRead when this mail was served; the
    // reply path here just composes a return mail to the original sender.

    // Compose reply directly without re-running the recipient prompt.
    const senderNode = this.bridge.getNodes().find(n => n.id === fromId);
    return this.storeMail(
      fromId,
      senderNode?.shortName || fromId.slice(-4),
      mail.senderNodeId,
      mail.senderShortName,
      text,
      channelIndex,
    );
  }

  // ---- Weather flow ----

  /** v2.0 Beta 4: replaces the old "send ZIP" prompt with a discoverable
   *  command menu. The prompt flow was a hidden two-step path operators
   *  couldn't discover; help is one packet and lists every available
   *  subcommand. ≤200 chars per Meshtastic packet — must stay compact. */
  private async handleWeatherHelp(fromId: string, channelIndex: number): Promise<boolean> {
    const t = this.config.weatherTrigger;
    // Total = 197 chars when t = ":weather". Tight on the 200-char cap;
    // shorter triggers buy headroom.
    const msg =
      `${t} <ZIP> = forecast | ` +
      `${t} subscribe [ZIP] = alerts (default=home) | ` +
      `${t} stop = unsub | ` +
      `${t} status = check`;
    await this.reply(fromId, msg, channelIndex);
    return true;
  }

  /** Subscribe a node to alerts. v2.0 Beta 4: `zip` parameter — if null,
   *  follows the operator's home ZIP (back-compat); if set, validated as
   *  5 digits and stored on the subscriber row for per-ZIP alert routing.
   *  Idempotent — re-subscribing updates channel + zip. */
  private async handleWeatherSubscribe(fromId: string, channelIndex: number, zipRaw: string | null): Promise<boolean> {
    let zip: string | null = null;
    if (zipRaw) {
      const trimmed = zipRaw.trim();
      if (!/^\d{5}$/.test(trimmed)) {
        await this.reply(fromId, `ZIP must be 5 digits, or omit it to follow the operator's home.`, channelIndex);
        return true;
      }
      zip = trimmed;
    }

    const isNew = meshDb.addWeatherSubscriber(fromId, channelIndex, this.radioId, zip);
    const effectiveZip = zip ?? this.config.homeZipCode;

    if (!effectiveZip) {
      await this.reply(
        fromId,
        isNew
          ? 'Subscribed. No ZIP set yet (no home configured) — you\'ll get alerts once one is set.'
          : 'Already subscribed. No ZIP set — alerts inactive until one is configured.',
        channelIndex,
      );
      this.bridge.emit('bbsSubscriber', { nodeId: fromId, action: 'subscribed' });
      return true;
    }

    const scope = zip ? `ZIP ${zip}` : `home ZIP ${effectiveZip}`;
    try {
      const loc = await weatherService.resolveZip(effectiveZip);
      const where = `${loc.city}, ${loc.state}`;
      const verb = isNew ? 'Subscribed to' : 'Already subscribed to';
      await this.reply(
        fromId,
        `${verb} ${where} alerts (${scope}). :weather stop to unsubscribe.`,
        channelIndex,
      );
    } catch (err: any) {
      console.warn(`[BBS] subscribe location lookup for ${effectiveZip} failed: ${err?.message}`);
      const verb = isNew ? 'Subscribed to' : 'Already subscribed to';
      await this.reply(fromId, `${verb} ${scope} alerts. (Location lookup will retry.)`, channelIndex);
    }
    this.bridge.emit('bbsSubscriber', { nodeId: fromId, action: 'subscribed' });
    return true;
  }

  private async handleWeatherUnsubscribe(fromId: string, channelIndex: number): Promise<boolean> {
    const removed = meshDb.removeWeatherSubscriber(fromId);
    await this.reply(
      fromId,
      removed ? 'Unsubscribed. You\'ll no longer receive weather alerts.' : 'You weren\'t subscribed.',
      channelIndex,
    );
    if (removed) this.bridge.emit('bbsSubscriber', { nodeId: fromId, action: 'unsubscribed' });
    return true;
  }

  private async handleWeatherStatus(fromId: string, channelIndex: number): Promise<boolean> {
    if (!meshDb.isWeatherSubscriber(fromId)) {
      await this.reply(fromId, 'Not subscribed. Reply :weather subscribe to opt in.', channelIndex);
      return true;
    }
    // v2.0 Beta 4: per-subscriber ZIP. Look up THIS subscriber's row to
    // surface their effective ZIP — could be their own opt-in (`zip`
    // column non-null) or the operator's home (zip column null).
    const subs = meshDb.listWeatherSubscribers();
    const me = subs.find(s => s.nodeId === fromId);
    const subscriberZip = me?.zip ?? null;
    const effectiveZip = subscriberZip ?? this.config.homeZipCode;
    if (!effectiveZip) {
      await this.reply(fromId, 'Subscribed, but no ZIP set (no home configured) — alerts inactive.', channelIndex);
      return true;
    }
    const scopeNote = subscriberZip ? `your ZIP ${subscriberZip}` : `home ZIP ${effectiveZip}`;
    try {
      const loc = await weatherService.resolveZip(effectiveZip);
      await this.reply(fromId, `Subscribed to ${loc.city}, ${loc.state} alerts (${scopeNote}). :weather stop to opt out.`, channelIndex);
    } catch {
      await this.reply(fromId, `Subscribed to ${scopeNote} alerts. :weather stop to opt out.`, channelIndex);
    }
    return true;
  }

  /** Resolve a ZIP to a forecast and send a compact response. Always clears the
   *  weather session whether the lookup succeeded or not — the user can re-run
   *  `:weather` to try again. */
  private async handleWeatherZip(fromId: string, text: string, channelIndex: number): Promise<boolean> {
    this.weatherSessions.delete(fromId);
    const zip = text.trim();
    if (!/^\d{5}$/.test(zip)) {
      await this.reply(fromId, 'ZIP must be exactly 5 digits. Try :weather again.', channelIndex);
      return true;
    }
    try {
      const summary = await weatherService.getCurrentSummary(zip);
      await this.reply(fromId, summary, channelIndex);
    } catch (err: any) {
      console.warn(`[BBS] weather lookup for ${zip} failed:`, err?.message);
      await this.reply(fromId, `Weather lookup failed for ${zip}. Try again later.`, channelIndex);
    }
    return true;
  }

  // ---- Helpers ----

  private async reply(toId: string, text: string, channelIndex: number): Promise<void> {
    // Pace per-destination so we don't trip the firmware's rate limiter when
    // a conversation produces multiple replies in quick succession. The
    // sendMessage path already auto-retries err=38 with a 10s backoff, but
    // pacing here is cheaper — it usually keeps us under the limit entirely
    // so we never see the firmware reject.
    const last = this.lastSendAt.get(toId) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < this.config.replyPaceMs) {
      const wait = this.config.replyPaceMs - elapsed;
      console.log(`[BBS] pacing reply to ${toId} — waiting ${wait}ms (last send ${elapsed}ms ago)`);
      await new Promise<void>(r => setTimeout(r, wait));
    }
    try {
      await this.bridge.sendMessage(text, toId, channelIndex);
      const now = Date.now();
      this.lastSendAt.set(toId, now);
      // v2.0 Beta 3: each reply extends the session window. Previously
      // enteredAt only got bumped on inbound messages, so a slow operator
      // could get reaped mid-flow even though we were actively talking to
      // them (we sent the prompt → they took 30s+ to type → reaper killed
      // the session before their reply landed). Bumping on every reply
      // gives them the full sessionTimeoutSecs from the prompt instead of
      // from their previous input.
      const mailSession = this.sessions.get(toId);
      if (mailSession) mailSession.enteredAt = now;
      const weatherSession = this.weatherSessions.get(toId);
      if (weatherSession) weatherSession.enteredAt = now;
    } catch (err: any) {
      console.error(`[BBS] reply to ${toId} (ch=${channelIndex}) failed:`, err?.message);
    }
  }

  private reapStaleSessions() {
    const timeoutMs = (this.config.sessionTimeoutSecs ?? 0) > 0
      ? this.config.sessionTimeoutSecs * 1000
      : STATE_TIMEOUT_MS_FALLBACK;
    const now = Date.now();
    const cutoff = now - timeoutMs;
    for (const [id, s] of this.sessions) {
      if (s.enteredAt < cutoff) {
        const idleSecs = Math.round((now - s.enteredAt) / 1000);
        console.log(`[BBS] reaped stale session ${id} (kind=${s.kind} idle=${idleSecs}s, timeout=${Math.round(timeoutMs / 1000)}s)`);
        this.sessions.delete(id);
        this.recentlyReaped.set(id, now);
      }
    }
    for (const [id, s] of this.weatherSessions) {
      if (s.enteredAt < cutoff) {
        const idleSecs = Math.round((now - s.enteredAt) / 1000);
        console.log(`[BBS] reaped stale weather session ${id} (idle=${idleSecs}s)`);
        this.weatherSessions.delete(id);
        this.recentlyReaped.set(id, now);
      }
    }
    // Age out recentlyReaped entries older than 30 min so the hint doesn't
    // surface long after the operator has moved on.
    const reapedCutoff = now - 30 * 60 * 1000;
    for (const [id, t] of this.recentlyReaped) {
      if (t < reapedCutoff) this.recentlyReaped.delete(id);
    }
  }

  /**
   * v2.0 Beta 3: called from the bridge when a DM arrives to the local node
   * that DOESN'T match isCommand() — i.e., no active session, doesn't start
   * with a trigger. If we recently reaped this sender's session, send a hint
   * so they know the BBS isn't ignoring them and how to recover. Returns
   * true if a hint was sent (caller can use it for logging if useful).
   */
  async maybeHintReapedSession(fromId: string, channelIndex: number): Promise<boolean> {
    if (!this.config.enabled) return false;
    const reapedAt = this.recentlyReaped.get(fromId);
    if (!reapedAt) return false;
    // Only hint within a short window — if it's been longer, the operator
    // has likely moved on and a stale hint would be noise.
    if (Date.now() - reapedAt > 10 * 60 * 1000) {
      this.recentlyReaped.delete(fromId);
      return false;
    }
    // One-shot: don't re-hint if they keep sending non-trigger DMs.
    this.recentlyReaped.delete(fromId);
    await this.reply(fromId, `BBS session timed out. Send "${this.config.mailTrigger}" to start over.`, channelIndex);
    return true;
  }
}

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
