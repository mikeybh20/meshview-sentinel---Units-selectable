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

type SessionState =
  | { kind: 'awaiting-recipient'; enteredAt: number; channelIndex: number; pendingBody?: string }
  | { kind: 'awaiting-recipient-pick'; enteredAt: number; channelIndex: number; candidates: MeshNode[]; pendingBody?: string }
  | { kind: 'awaiting-body'; enteredAt: number; channelIndex: number; recipientNodeId: string; recipientShortName: string }
  | { kind: 'reading'; enteredAt: number; channelIndex: number; currentMailId: number };

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

  /** Called from meshtasticSerial's TEXT handler AFTER isCommand returns
   *  false, when the DM is addressed to the local node and we're in
   *  bbs-only mode. Sends the command index back as an auto-reply.
   *  The original DM still flows through to normal storage; only this
   *  reply is new. Best-effort — sender retry covers transient drops. */
  async maybeAutoReplyForBbsOnly(fromId: string, channelIndex: number): Promise<boolean> {
    if (!this.bbsOnlyMode) return false;
    if (!this.config.enabled) return false;
    // Don't auto-reply to ourselves (covers loopback if the firmware ever
    // delivers a self-DM) and don't auto-reply if a session is in flight
    // (the dispatcher will respond on its own — we'd double-up).
    const localNodeId = (this.bridge as any).localNodeId as string | null;
    if (localNodeId && fromId === localNodeId) return false;
    if (this.sessions.has(fromId) || this.weatherSessions.has(fromId)) return false;
    const triggers = [this.config.mailTrigger, this.config.weatherTrigger, this.config.cmdTrigger];
    await this.reply(fromId, `BBS node. Cmds: ${triggers.join(' ')}`, channelIndex);
    return true;
  }

  /** Test whether this text is one of our configured triggers OR continues an
   *  active session. Replaces the standalone isBbsCommand() function so the
   *  trigger isn't a module const. */
  isCommand(text: string, fromId: string): boolean {
    if (!this.config.enabled) return false;
    if (!text) return false;
    const t = text.trim().toLowerCase();
    if (t.startsWith(this.config.mailTrigger)) return true;
    if (t.startsWith(this.config.weatherTrigger)) return true;
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
    const trimmed = text.trim();
    const senderNode = this.bridge.getNodes().find(n => n.id === fromId);
    const senderShortName = senderNode?.shortName || fromId.slice(-4);
    const mailTrigger = this.config.mailTrigger;
    const weatherTrigger = this.config.weatherTrigger;
    const cmdTrigger = this.config.cmdTrigger;

    // Cancellation always wins, regardless of current state.
    if (/^(x|cancel|exit|quit)$/i.test(trimmed)) {
      const hadMail = this.sessions.delete(fromId);
      const hadWeather = this.weatherSessions.delete(fromId);
      if (hadMail || hadWeather) await this.reply(fromId, 'OK, exited.', channelIndex);
      return hadMail || hadWeather;
    }

    // Help command at any time during a session.
    if (/^(\?|help|h)$/i.test(trimmed) && (this.sessions.has(fromId) || this.weatherSessions.has(fromId))) {
      await this.reply(fromId, `X=cancel. Body cap ${this.config.bodyMaxChars} chars.`, channelIndex);
      return true;
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
      return this.startRead(fromId, channelIndex);
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
    const triggers = [this.config.mailTrigger, this.config.weatherTrigger, this.config.cmdTrigger];
    await this.reply(fromId, `Cmds: ${triggers.join(' ')}`, channelIndex);
    return true;
  }

  private async openMenu(fromId: string, channelIndex: number): Promise<boolean> {
    const unread = meshDb.countUnread(fromId, this.radioId);
    if (unread > 0) {
      await this.reply(
        fromId,
        `MAIL: ${unread} new. Reply R=read, S=send, X=exit.`,
        channelIndex,
      );
    } else {
      await this.reply(fromId, 'MAIL: no new. Reply S=send, X=exit.', channelIndex);
    }
    // Park them in a synthetic awaiting state where their next single-letter
    // input picks an action. We piggyback on awaiting-recipient with a sentinel
    // candidates list to keep state shape simple — see dispatchInFlow.
    this.sessions.set(fromId, { kind: 'awaiting-recipient-pick', enteredAt: Date.now(), channelIndex, candidates: [] });
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

  private async startRead(fromId: string, channelIndex: number): Promise<boolean> {
    const next = meshDb.nextUnreadFor(fromId, this.radioId);
    if (!next) {
      this.sessions.delete(fromId);
      await this.reply(fromId, 'No unread mail.', channelIndex);
      return true;
    }
    this.sessions.set(fromId, { kind: 'reading', enteredAt: Date.now(), channelIndex, currentMailId: next.id });
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
        return this.startRead(fromId, channelIndex);
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
      return this.startRead(fromId, channelIndex);
    }

    if (/^n$/i.test(text)) {
      // Read mark already happened in startRead when this mail was served;
      // just advance to the next unread.
      return this.startRead(fromId, channelIndex);
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
