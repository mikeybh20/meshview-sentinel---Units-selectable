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

const STATE_TIMEOUT_MS = 30_000;
/** Fallback channel index for push notifications when we don't know which
 *  channel a recipient shares with us. 0 = PRIMARY, the only universally
 *  shared channel on a default Meshtastic install. */
const PUSH_CHANNEL_FALLBACK = 0;

type SessionState =
  | { kind: 'awaiting-recipient'; enteredAt: number; channelIndex: number }
  | { kind: 'awaiting-recipient-pick'; enteredAt: number; channelIndex: number; candidates: MeshNode[] }
  | { kind: 'awaiting-body'; enteredAt: number; channelIndex: number; recipientNodeId: string; recipientShortName: string }
  | { kind: 'reading'; enteredAt: number; channelIndex: number; currentMailId: number };

export class BbsService {
  private sessions = new Map<string, SessionState>(); // senderNodeId → state
  /** Per-destination last-send timestamp for pacing. Cleared lazily — we never
   *  need this for nodes we haven't talked to in hours. */
  private lastSendAt = new Map<string, number>();
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

  /** Test whether this text is one of our configured triggers OR continues an
   *  active session. Replaces the standalone isBbsCommand() function so the
   *  trigger isn't a module const. */
  isCommand(text: string, fromId: string): boolean {
    if (!this.config.enabled) return false;
    if (!text) return false;
    const t = text.trim().toLowerCase();
    if (t.startsWith(this.config.mailTrigger)) return true;
    if (t.startsWith(this.config.weatherTrigger)) return true;
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

    if (lower === mailTrigger) {
      return this.openMenu(fromId, channelIndex);
    }
    if (lower === `${mailTrigger} send` || lower === `${mailTrigger} s`) {
      return this.startSend(fromId, channelIndex);
    }
    if (lower === `${mailTrigger} read` || lower === `${mailTrigger} r`) {
      return this.startRead(fromId, channelIndex);
    }

    // Weather trigger — open the ZIP prompt.
    if (lower === weatherTrigger) {
      return this.startWeather(fromId, channelIndex);
    }
    // Subcommand: subscribe / unsubscribe / stop / off / status.
    // Recognized BEFORE the generic `<trigger> <zip>` shortcut so e.g.
    // ":weather subscribe" doesn't get treated as ZIP=subscribe.
    if (lower === `${weatherTrigger} subscribe`) {
      return this.handleWeatherSubscribe(fromId, channelIndex);
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
    // Shortcut: `:weather <zip>` skips the prompt step. ZIP is always 5 digits;
    // any non-digit subcommand has been handled above.
    if (lower.startsWith(`${weatherTrigger} `)) {
      const zip = trimmed.slice(weatherTrigger.length + 1).trim();
      return this.handleWeatherZip(fromId, zip, channelIndex);
    }

    // Anything else with the `:` prefix — politely reject so the AI assistant
    // doesn't also try to handle it.
    if (trimmed.startsWith(':')) {
      await this.reply(fromId, `Unknown command. Try ${mailTrigger} or ${weatherTrigger}`, channelIndex);
      return true;
    }

    return false;
  }

  // ---- State entry points ----

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
    await this.reply(fromId, 'Send TO: short name (4 chars) or X.', channelIndex);
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
    // Hex id form (!02eb3bec) — bypass short-name lookup.
    if (/^![0-9a-f]{8}$/i.test(text)) {
      const targetId = text.toLowerCase();
      const node = this.bridge.getNodes().find(n => n.id === targetId);
      if (!node) {
        await this.reply(fromId, `No node ${targetId} on mesh.`, channelIndex);
        return true;
      }
      return this.advanceToBody(fromId, node, channelIndex);
    }

    // Pick-by-number flow if we previously offered candidates.
    const session = this.sessions.get(fromId);
    if (session?.kind === 'awaiting-recipient-pick' && session.candidates.length > 0) {
      const idx = parseInt(text, 10) - 1;
      if (Number.isFinite(idx) && idx >= 0 && idx < session.candidates.length) {
        return this.advanceToBody(fromId, session.candidates[idx], channelIndex);
      }
      // Not a number? Treat as a fresh short-name lookup.
    }

    // Short-name lookup.
    const wanted = text.toUpperCase().slice(0, 4);
    const matches = this.bridge.getNodes().filter(
      n => (n.shortName || '').toUpperCase() === wanted
    );

    if (matches.length === 0) {
      const recent = this.bridge.getNodes()
        .filter(n => n.online && n.id !== fromId)
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .slice(0, 6)
        .map(n => n.shortName)
        .filter(Boolean)
        .join(' ');
      await this.reply(fromId, `No '${wanted}'. Online: ${recent || '(none)'}.`, channelIndex);
      return true;
    }

    if (matches.length === 1) {
      return this.advanceToBody(fromId, matches[0], channelIndex);
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
    });
    await this.reply(fromId, `${matches.length} '${wanted}': ${listing}. Reply 1-${Math.min(4, matches.length)}.`, channelIndex);
    return true;
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

  /** Park the sender in the weather state so their next message is treated
   *  as the ZIP. Single-step flow — no further state after the ZIP arrives. */
  private async startWeather(fromId: string, channelIndex: number): Promise<boolean> {
    this.weatherSessions.set(fromId, { enteredAt: Date.now(), channelIndex });
    await this.reply(fromId, 'WEATHER: send 5-digit US ZIP or X to cancel.', channelIndex);
    return true;
  }

  /** Subscribe a node to alerts on the operator's home ZIP. Idempotent —
   *  re-subscribing just updates the reply channel. */
  private async handleWeatherSubscribe(fromId: string, channelIndex: number): Promise<boolean> {
    const isNew = meshDb.addWeatherSubscriber(fromId, channelIndex, this.radioId);
    const home = this.config.homeZipCode;
    if (!home) {
      await this.reply(
        fromId,
        isNew
          ? 'Subscribed. No home ZIP configured yet — you\'ll get alerts when the operator sets one.'
          : 'Already subscribed (channel updated). No home ZIP configured yet — alerts inactive.',
        channelIndex,
      );
      this.bridge.emit('bbsSubscriber', { nodeId: fromId, action: 'subscribed' });
      return true;
    }
    try {
      const loc = await weatherService.resolveZip(home);
      const where = `${loc.city}, ${loc.state}`;
      await this.reply(
        fromId,
        isNew
          ? `Subscribed to ${where} alerts. Reply :weather stop to unsubscribe.`
          : `Already subscribed to ${where}. Reply :weather stop to unsubscribe.`,
        channelIndex,
      );
    } catch (err: any) {
      console.warn(`[BBS] subscribe location lookup failed: ${err?.message}`);
      await this.reply(
        fromId,
        isNew
          ? `Subscribed. (Location lookup failed — will retry.)`
          : `Already subscribed.`,
        channelIndex,
      );
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
    const subscribed = meshDb.isWeatherSubscriber(fromId);
    const home = this.config.homeZipCode;
    if (!subscribed) {
      await this.reply(fromId, 'Not subscribed. Reply :weather subscribe to opt in.', channelIndex);
      return true;
    }
    if (!home) {
      await this.reply(fromId, 'Subscribed, but operator has no home ZIP set — alerts inactive.', channelIndex);
      return true;
    }
    try {
      const loc = await weatherService.resolveZip(home);
      await this.reply(fromId, `Subscribed to ${loc.city}, ${loc.state} alerts. :weather stop to opt out.`, channelIndex);
    } catch {
      await this.reply(fromId, `Subscribed to ZIP ${home} alerts. :weather stop to opt out.`, channelIndex);
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
      this.lastSendAt.set(toId, Date.now());
    } catch (err: any) {
      console.error(`[BBS] reply to ${toId} (ch=${channelIndex}) failed:`, err?.message);
    }
  }

  private reapStaleSessions() {
    const cutoff = Date.now() - STATE_TIMEOUT_MS;
    for (const [id, s] of this.sessions) {
      if (s.enteredAt < cutoff) this.sessions.delete(id);
    }
    for (const [id, s] of this.weatherSessions) {
      if (s.enteredAt < cutoff) this.weatherSessions.delete(id);
    }
  }
}

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
