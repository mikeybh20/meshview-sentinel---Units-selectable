/**
 * Background poller for NWS active alerts on the operator's configured home
 * ZIP. Runs every 20 minutes (configurable via env override for testing).
 * Deduplicates by alert id so the dashboard event log only fires once per
 * alert no matter how many times we poll while it's active.
 *
 * Output: emits 'event' on the bridge for each new alert. Surfaces as a
 * WEATHER_ALERT row in the dashboard event log. Browser notifications fire
 * automatically through the existing useMeshNotifications hook (it watches
 * the events stream).
 *
 * Stays silent when:
 *   - BBS is disabled
 *   - homeZipCode is empty
 *   - NWS/zippopotam is unreachable (logs the error but doesn't crash)
 */

import { randomUUID } from 'crypto';
import { weatherService, type NwsAlert } from './weather.js';
import type { BbsConfig } from './bbsConfig.js';
import { meshDb as meshDbFactory } from './database.js';

// Forward-declared type to avoid a runtime circular import with BridgeManager.
// We only use it nominally — the methods we touch are listed inline below.
interface BridgeManagerLike {
  getDefault(): { bridge: any } | null;
  get(radioId: string): { bridge: any } | null;
  list(): Array<{ radioId: string; bridge: any }>;
  getDefaultRadioId(): string | null;
  /** v2.0 Beta 5 Phase 2 (Services Pattern): the radio currently
   *  designated to run BBS services. WeatherAlertPoller now ONLY
   *  delivers alerts + the daily forecast through this bridge —
   *  matches the operator's "Home workspace is the services area"
   *  model. Returns null when no BBS node is designated; the poller
   *  silently skips delivery. */
  getBbsNode(): { radioId: string; bridge: any } | null;
}

const meshDb = meshDbFactory();

/** Synthetic short name shown as the sender on alert mail. Three chars to fit
 *  conventional Meshtastic 4-char short_name displays comfortably. */
const ALERT_SENDER_SHORT = 'WX';

const POLL_INTERVAL_MS = parseInt(process.env.MESHVIEW_WEATHER_POLL_MS || '', 10) || (20 * 60_000);
const FIRST_POLL_DELAY_MS = 10_000; // wait for radio to settle before first poll

/** Daily-forecast scheduler tick interval. 60s is fine — we only fire when
 *  the wall clock crosses the configured HH:MM target, and we dedupe per
 *  day so missing the exact minute by a few seconds doesn't double-fire. */
const DAILY_TICK_MS = 60_000;

/** Synthetic short name for the daily forecast sender. Distinct from the
 *  alert sender (WX) so subscribers see which mail rows are routine
 *  morning forecasts vs. urgent alerts. */
const FORECAST_SENDER_SHORT = 'FX';

export class WeatherAlertPoller {
  private bm: BridgeManagerLike;
  private getConfig: () => BbsConfig;
  /** Alert IDs we've already surfaced this run. Cleared when an alert is no
   *  longer in NWS's active list (so a repeat after expiry shows again). */
  private seenAlertIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstRun = true;

  /** Daily-forecast scheduler state. */
  private dailyTimer: ReturnType<typeof setInterval> | null = null;
  /** v2.0 Beta 5: per-time daily-fire ledger. Key is "HH:MM" → dayKey
   *  of the last day that slot fired. Lets each configured push time
   *  (morning, midday, evening …) track independently so missing the
   *  07:30 slot doesn't suppress the 12:00 one. */
  private lastDailySentByTime: Map<string, string> = new Map();

  constructor(bm: BridgeManagerLike, getConfig: () => BbsConfig) {
    this.bm = bm;
    this.getConfig = getConfig;
  }

  start(): void {
    if (this.timer) return;
    console.log(`[WeatherPoller] Starting (interval=${Math.round(POLL_INTERVAL_MS / 1000)}s)`);
    // Stagger the first poll so radio init has time to finish.
    setTimeout(() => this.tick(), FIRST_POLL_DELAY_MS);
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.timer.unref?.();

    // Daily forecast scheduler — independent from the alert poller so a
    // 7:30am morning push doesn't block on the 20-minute alert cadence.
    if (!this.dailyTimer) {
      console.log(`[WeatherPoller] Daily forecast scheduler enabled (tick=${Math.round(DAILY_TICK_MS / 1000)}s)`);
      // Seed the per-time ledger so any slot whose target time has
      // already passed today gets skipped at boot. Without this, a
      // container restart at 14:00 would immediately fire the 07:30
      // AND 12:00 forecasts back-to-back — subscribers already got
      // their morning + noon fresh and don't need a duplicate.
      const cfg = this.getConfig();
      const nowKey = this.todayKey();
      const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
      for (const t of cfg.dailyForecastTimes ?? []) {
        const [h, m] = t.split(':').map(Number);
        const targetMins = (h ?? 0) * 60 + (m ?? 0);
        if (targetMins <= nowMins) this.lastDailySentByTime.set(t, nowKey);
      }
      this.dailyTimer = setInterval(() => this.dailyTick(), DAILY_TICK_MS);
      this.dailyTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.dailyTimer) {
      clearInterval(this.dailyTimer);
      this.dailyTimer = null;
    }
  }

  /** Force an immediate poll. Useful from the config-change handler so a
   *  freshly-set home ZIP gets its first check right away instead of waiting
   *  20 minutes. */
  async pollNow(): Promise<void> {
    return this.tick();
  }

  /** Force the daily forecast push to fire NOW, regardless of clock. Used
   *  by the "Send test" button in the BBS settings panel so the operator
   *  can verify subscriber delivery without waiting until tomorrow's 7:30. */
  async sendDailyForecastNow(): Promise<{ ok: true; subscribers: number; perZip: Record<string, number> } | { ok: false; error: string }> {
    const cfg = this.getConfig();
    if (!cfg.enabled) return { ok: false, error: 'BBS is disabled' };
    try {
      const r = await this.pushDailyForecastByZip(cfg.homeZipCode);
      return { ok: true, ...r };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'forecast fetch failed' };
    }
  }

  /**
   * v2.0 Beta 4: group subscribers by effective ZIP (their `zip` column, or
   * homeZip fallback), fetch ONE forecast per distinct ZIP, deliver each
   * forecast only to that ZIP's subscriber subset. Operators no longer
   * push a single home forecast to everyone — Baltimore subscribers get
   * Baltimore weather, Frederick subscribers get Frederick's.
   */
  private async pushDailyForecastByZip(homeZip: string): Promise<{ subscribers: number; perZip: Record<string, number> }> {
    const subs = meshDb.listWeatherSubscribers();
    // Group by effective ZIP. Drop subscribers whose effective ZIP is
    // empty (no home configured AND no opt-in zip) — nothing to fetch.
    const groups = new Map<string, typeof subs>();
    for (const s of subs) {
      const effective = s.zip ?? homeZip;
      if (!effective) continue;
      const group = groups.get(effective);
      if (group) group.push(s);
      else groups.set(effective, [s]);
    }

    const perZip: Record<string, number> = {};
    let total = 0;
    for (const [zip, group] of groups) {
      let summary: string;
      try {
        summary = await weatherService.getCurrentSummary(zip);
      } catch (err: any) {
        console.warn(`[WeatherPoller] forecast fetch for ${zip} failed: ${err?.message} — skipping ${group.length} subscriber(s)`);
        continue;
      }
      await this.deliverToSpecificSubscribers(group, summary, FORECAST_SENDER_SHORT);
      perZip[zip] = group.length;
      total += group.length;
    }
    return { subscribers: total, perZip };
  }

  /** "YYYY-MM-DD" in server-local time. The container's TZ environment
   *  variable controls what "local" means — operators set TZ in
   *  docker-compose to align with their region. */
  private todayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Minute-resolution scheduler tick. Fires each configured daily
   *  forecast slot when the wall clock crosses its HH:MM and that
   *  slot hasn't sent today yet. Per-minute polling instead of
   *  next-fire setTimeout because timeout drift over a 24h window is
   *  unreliable (system sleep, NTP steps, container restarts) — a
   *  minute tick is robust and cheap.
   *
   *  v2.0 Beta 5: multi-time scheduler. Each entry in
   *  cfg.dailyForecastTimes fires once per day, tracked independently
   *  in lastDailySentByTime. Adding/removing/editing times in
   *  Settings → BBS takes effect on the next minute tick — no
   *  scheduler restart required. */
  private async dailyTick(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled) return;
    const times = cfg.dailyForecastTimes ?? [];
    if (times.length === 0) return;

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const clock = `${hh}:${mm}`;
    if (!times.includes(clock)) return;

    const dayKey = this.todayKey();
    if (this.lastDailySentByTime.get(clock) === dayKey) return;
    this.lastDailySentByTime.set(clock, dayKey);

    const subs = meshDb.listWeatherSubscribers();
    if (subs.length === 0) {
      console.log(`[WeatherPoller] Daily forecast time reached (${clock}) but 0 subscribers — skipping`);
      return;
    }

    try {
      // v2.0 Beta 4: per-subscriber-ZIP routing. pushDailyForecastByZip
      // groups subscribers by their effective ZIP and fetches one forecast
      // per distinct ZIP — Baltimore subs get Baltimore weather, not the
      // operator's Frederick weather.
      const r = await this.pushDailyForecastByZip(cfg.homeZipCode);
      const zipSummary = Object.entries(r.perZip)
        .map(([z, n]) => `${z}=${n}`).join(', ');
      console.log(`[WeatherPoller] Daily forecast (${clock}) sent to ${r.subscribers} subscriber(s): ${zipSummary || '(none)'}`);
    } catch (err: any) {
      console.warn(`[WeatherPoller] daily forecast fan-out failed: ${err?.message}`);
      // Clear this slot's fire-marker so we'll retry on the next tick.
      // NWS hiccups shouldn't cost the operator a slot of forecasts.
      // Other slots' state stays intact.
      this.lastDailySentByTime.delete(clock);
    }
  }

  /**
   * v2.0 Beta 4: per-subscriber ZIP alert routing.
   *
   * Pre-Beta-4 the poller asked NWS for active alerts at the operator's
   * homeZipCode only and fanned every alert out to all subscribers. With
   * `:weather subscribe <ZIP>` adding per-subscriber zips, the poll set
   * is now the UNION of:
   *   - the operator's homeZipCode (always polled — drives event log +
   *     home subscribers with a null `zip` column)
   *   - every distinct `zip` value across `bbs_weather_subscribers`
   *
   * For each unique ZIP we issue one NWS active-alerts request, dedupe
   * against `seenAlertIds`, write the WEATHER_ALERT event log row only
   * for the home ZIP (operator's local zone), and DM each subscriber
   * whose `effective zip` (their stored zip || home) matches the ZIP
   * that produced the alert.
   *
   * Dedup is per-alert-id GLOBALLY (an NWS alert id is unique). If two
   * adjacent ZIPs return the same alert, we surface it once and route to
   * whichever subscriber set matches. The alert's NWS-side coverage area
   * already determined which ZIPs were affected.
   */
  private async tick(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      if (this.seenAlertIds.size > 0) this.seenAlertIds.clear();
      return;
    }

    // Build the union of ZIPs we need to poll. Always include the home
    // ZIP if set; add every distinct subscriber-requested ZIP on top.
    const subs = meshDb.listWeatherSubscribers();
    const zipsToPoll = new Set<string>();
    if (cfg.homeZipCode) zipsToPoll.add(cfg.homeZipCode);
    for (const s of subs) if (s.zip) zipsToPoll.add(s.zip);
    if (zipsToPoll.size === 0) {
      if (this.seenAlertIds.size > 0) this.seenAlertIds.clear();
      return;
    }

    // Poll each ZIP serially — small set, no concurrency benefit + keeps
    // NWS's 10-req/s soft limit comfortably out of reach. Collect per-ZIP
    // alert lists for the dedup-rollover step + the per-subscriber fanout.
    const alertsByZip = new Map<string, NwsAlert[]>();
    const labelsByZip = new Map<string, string>();
    for (const zip of zipsToPoll) {
      try {
        const alerts = await weatherService.getActiveAlerts(zip);
        const loc = await weatherService.resolveZip(zip);
        alertsByZip.set(zip, alerts);
        labelsByZip.set(zip, `${loc.city}, ${loc.state}`);
      } catch (err: any) {
        console.warn(`[WeatherPoller] poll failed for ${zip}: ${err?.message}`);
        // Soft-fail this ZIP — other ZIPs still get processed.
      }
    }

    // Roll dedup state forward — any alert id we'd previously surfaced
    // that's no longer in ANY ZIP's active list expires from `seenAlertIds`
    // so a future re-issue surfaces normally.
    const currentIds = new Set<string>();
    for (const list of alertsByZip.values()) for (const a of list) currentIds.add(a.id);
    for (const oldId of this.seenAlertIds) {
      if (!currentIds.has(oldId)) this.seenAlertIds.delete(oldId);
    }

    let newCount = 0;
    for (const [zip, alerts] of alertsByZip) {
      const locationLabel = labelsByZip.get(zip) ?? zip;
      const isHomeZip = zip === cfg.homeZipCode;
      for (const alert of alerts) {
        if (this.seenAlertIds.has(alert.id)) continue;
        this.seenAlertIds.add(alert.id);

        // First-tick baseline absorption — still don't spam the event log
        // with everything that was already active when the container booted.
        if (this.firstRun) continue;

        newCount++;
        const compact = weatherService.formatAlertCompact(alert, locationLabel);

        // v2.0 Beta 5 Phase 2: surface the alert event on the BBS
        // service node only — that's the "home / services" radio's
        // event log, which is where operators look for install-wide
        // alerts. Previously fanned out to every bridge, which made
        // the same WEATHER_ALERT row appear in each personal
        // workspace's event log; now it lives only in the services
        // workspace.
        if (isHomeZip) {
          const bbsCtx = this.bm.getBbsNode();
          if (bbsCtx?.bridge) {
            bbsCtx.bridge.recordEvent({
              id: `wx-${alert.id}-${bbsCtx.radioId}`,
              type: 'WEATHER_ALERT',
              nodeId: 'local',
              timestamp: Date.now(),
              details: compact,
            });
          }
        }
        console.log(`[WeatherPoller] NEW alert for ${zip}${isHomeZip ? ' (home)' : ''}: ${compact}`);

        // Subscriber subset whose effective ZIP equals this poll's ZIP.
        const matchingSubs = subs.filter(s => {
          const effective = s.zip ?? cfg.homeZipCode;
          return effective === zip;
        });
        if (matchingSubs.length === 0) {
          // Polled this ZIP (subscriber requested it) but no one's matching
          // now — could happen if they unsubscribed mid-tick. Skip the fanout.
          continue;
        }
        await this.deliverToSpecificSubscribers(matchingSubs, compact, ALERT_SENDER_SHORT);
      }
    }

    if (this.firstRun) {
      const totalSeen = Array.from(alertsByZip.values()).reduce((a, l) => a + l.length, 0);
      console.log(`[WeatherPoller] First-run baseline absorbed ${totalSeen} alert(s) across ${zipsToPoll.size} ZIP(s)`);
      this.firstRun = false;
    } else if (newCount > 0) {
      console.log(`[WeatherPoller] surfaced ${newCount} new alert(s) across ${zipsToPoll.size} ZIP(s)`);
    }
  }

  /**
   * Deliver a compact alert to every subscriber. Each subscriber gets:
   *   1. A DM on the channel they subscribed via (transient, may not reach
   *      offline nodes; the firmware's own retry covers transient drops).
   *   2. A row in the bbs_mail table addressed to them, sender_short_name=WX
   *      (persistent — they'll see it when they next DM ":mail R").
   *
   * Pacing: the DM path goes through meshBridge.sendMessage which auto-retries
   * RATE_LIMIT_EXCEEDED, so we don't need to space these out ourselves. But
   * we DO wait briefly between subscribers to avoid hitting the firmware's
   * global TX queue limit when many are subscribed.
   */
  private async deliverToSubscribers(compact: string, senderShort: string): Promise<void> {
    return this.deliverToSpecificSubscribers(meshDb.listWeatherSubscribers(), compact, senderShort);
  }

  /**
   * v2.0 Beta 4: same DM-then-mail-row delivery as deliverToSubscribers,
   * but the subscriber set is supplied by the caller. Lets the per-ZIP
   * alert routing in tick() send each alert only to subscribers whose
   * effective ZIP matches the alert's origin, and lets the daily-forecast
   * scheduler group subscribers by ZIP so each gets THEIR forecast.
   */
  private async deliverToSpecificSubscribers(
    subscribers: Array<{ nodeId: string; channelIndex: number; radioId: string | null; zip: string | null }>,
    compact: string,
    senderShort: string,
  ): Promise<void> {
    if (subscribers.length === 0) return;

    // v2.0 Beta 5 Phase 2 (Services Pattern): every alert + forecast
    // now routes through the install's designated BBS service node.
    // Operators who haven't picked a BBS radio yet get a logged
    // skip + the mail row still persists so the next time someone
    // hits `:mail R` from the BBS radio (once picked) they see it.
    const bbsCtx = this.bm.getBbsNode();
    if (!bbsCtx?.bridge) {
      console.warn('[WeatherPoller] No BBS service node designated — skipping fanout. Pick one in Settings → BBS.');
      return;
    }
    const bbsRadioId = bbsCtx.radioId;
    const bbsBridge = bbsCtx.bridge;
    const localNodeId = (bbsBridge as any).localNodeId as string | null;

    console.log(`[WeatherPoller] Fanning out to ${subscribers.length} subscriber(s) via BBS node "${bbsRadioId}"`);
    let delivered = 0;
    let selfSubscribed = 0;
    let skipped = 0;
    for (const sub of subscribers) {
      // Persist mail row first — even if the DM fails, the subscriber can pull
      // the alert via :mail R later. Always stamped with the BBS node's
      // radio_id so the row lives in the same workspace as the BBS service
      // (where it'll be visible from the BBS radio's :mail R reads).
      let mailId: number | undefined;
      try {
        if (localNodeId) {
          mailId = meshDb.insertMail({
            sender_node_id: localNodeId,
            sender_short_name: senderShort,
            recipient_node_id: sub.nodeId,
            posted_at: Date.now(),
            body: compact,
            radio_id: bbsRadioId,
          });
          bbsBridge.emit('bbsMail', { recipientNodeId: sub.nodeId, mailId, source: 'weather' });
        }
      } catch (err: any) {
        console.warn(`[WeatherPoller] insertMail failed for ${sub.nodeId}: ${err?.message}`);
      }

      const bridge = bbsBridge;
      if (!bridge) { skipped++; continue; }

      // v2.1 fix: defensive guard — the weather poller MUST NEVER send
      // to the broadcast address. sendMessage interprets to='!ffffffff'
      // as a primary-channel broadcast, which would spam everyone on
      // LongFast. Subscriber rows should always carry a hex node id;
      // bail loudly if anything else slipped in.
      if (!sub.nodeId || !/^![0-9a-f]{8}$/i.test(sub.nodeId) || sub.nodeId.toLowerCase() === '!ffffffff') {
        console.warn(`[WeatherPoller] Refusing send: subscriber.nodeId="${sub.nodeId}" is not a valid hex DM target. Skipping.`);
        skipped++;
        continue;
      }

      // v2.1 fix: skip the over-the-air sendMessage when the subscriber IS
      // the BBS node's local node. Meshtastic firmware silently absorbs
      // self-DMs — they never fire a notification on the operator's
      // physical device, even though the mail row above persists fine.
      if (localNodeId && sub.nodeId === localNodeId) {
        if (mailId !== undefined) meshDb.markMailDelivered(mailId);
        meshDb.touchWeatherSubscriberAlert(sub.nodeId);
        selfSubscribed++;
        continue;
      }

      // v2.1: full ACK lifecycle. sendMessage hands the packet to the
      // firmware and returns immediately with a localId; we then await
      // the bridge's terminal ackUpdate ('acked' | 'error') or our own
      // 60s 'noack' timeout. Each phase logs to the Event Log as
      // WEATHER_DELIVERY so the operator can grep "did 7fba ACK?"
      // without parsing docker logs.
      const subShort = sub.nodeId.slice(-4);
      let localId: string;
      try {
        localId = await bridge.sendMessage(compact, sub.nodeId, sub.channelIndex);
        meshDb.touchWeatherSubscriberAlert(sub.nodeId);
        bridge.recordEvent({
          id: randomUUID(),
          type: 'WEATHER_DELIVERY',
          nodeId: sub.nodeId,
          timestamp: Date.now(),
          details: `SENT alert to ${subShort} via ${bbsRadioId} ch=${sub.channelIndex} (awaiting ACK)`,
        });
        console.log(`[WeatherPoller] SENT alert to ${sub.nodeId} via ${bbsRadioId} ch=${sub.channelIndex} localId=${localId} (awaiting ACK)`);
      } catch (err: any) {
        console.warn(`[WeatherPoller] sendMessage threw for ${sub.nodeId}: ${err?.message}`);
        bridge.recordEvent({
          id: randomUUID(),
          type: 'WEATHER_DELIVERY',
          nodeId: sub.nodeId,
          timestamp: Date.now(),
          details: `SEND FAILED to ${subShort}: ${err?.message ?? 'unknown error'} — mail row left in inbox`,
        });
        continue;
      }

      const ack = await bridge.waitForAckOutcome(localId, 60_000);
      if (ack.outcome === 'acked') {
        if (mailId !== undefined) meshDb.markMailDelivered(mailId);
        bridge.recordEvent({
          id: randomUUID(),
          type: 'WEATHER_DELIVERY',
          nodeId: sub.nodeId,
          timestamp: Date.now(),
          details: `ACKed by ${subShort} — alert delivered`,
        });
        console.log(`[WeatherPoller] ACKed by ${sub.nodeId} for localId=${localId}`);
        delivered++;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // v2.1: ACK failure (noack timeout OR firmware error). Send the
      // short mail-notice DM as a fallback — same DM channel, no
      // broadcast — on the theory that a 50-char packet has a better
      // chance of getting through a marginal link than the 200-char
      // alert body. The mail row is already in the inbox; this notice
      // tells the recipient to come read it.
      const failDetail = ack.outcome === 'error'
        ? `firmware error code=${ack.errorCode}`
        : 'no ACK in 60s';
      console.warn(`[WeatherPoller] No ACK from ${sub.nodeId} for alert (${failDetail}). Trying mail-notice fallback.`);
      bridge.recordEvent({
        id: randomUUID(),
        type: 'WEATHER_DELIVERY',
        nodeId: sub.nodeId,
        timestamp: Date.now(),
        details: `NO ACK from ${subShort} (${failDetail}) — trying mail-notice fallback`,
      });

      const notice = `✉ Weather alert. DM :mail R to read.`;
      let noticeLocalId: string | null = null;
      try {
        noticeLocalId = await bridge.sendMessage(notice, sub.nodeId, sub.channelIndex);
      } catch (err: any) {
        console.warn(`[WeatherPoller] Mail-notice sendMessage threw for ${sub.nodeId}: ${err?.message}`);
        bridge.recordEvent({
          id: randomUUID(),
          type: 'WEATHER_DELIVERY',
          nodeId: sub.nodeId,
          timestamp: Date.now(),
          details: `MAIL-NOTICE SEND FAILED to ${subShort}: ${err?.message ?? 'unknown'} — left in inbox`,
        });
      }
      if (noticeLocalId) {
        const noticeAck = await bridge.waitForAckOutcome(noticeLocalId, 30_000);
        if (noticeAck.outcome === 'acked') {
          if (mailId !== undefined) meshDb.markMailDelivered(mailId);
          bridge.recordEvent({
            id: randomUUID(),
            type: 'WEATHER_DELIVERY',
            nodeId: sub.nodeId,
            timestamp: Date.now(),
            details: `ACKed mail-notice from ${subShort} — fallback delivered (alert body still in inbox)`,
          });
          console.log(`[WeatherPoller] Mail-notice ACKed by ${sub.nodeId}`);
          delivered++;
        } else {
          const notice2Detail = noticeAck.outcome === 'error'
            ? `firmware error code=${noticeAck.errorCode}`
            : 'no ACK in 30s';
          bridge.recordEvent({
            id: randomUUID(),
            type: 'WEATHER_DELIVERY',
            nodeId: sub.nodeId,
            timestamp: Date.now(),
            details: `NO ACK from ${subShort} on fallback (${notice2Detail}) — left in inbox`,
          });
          console.warn(`[WeatherPoller] No ACK from ${sub.nodeId} on mail-notice fallback either (${notice2Detail}). Mail row stays in inbox.`);
        }
      }

      // Small inter-subscriber pause so we don't slam the firmware queue.
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[WeatherPoller] Subscriber fanout complete: ${delivered} DM, ${selfSubscribed} self-subscribed (mail only), ${skipped} skipped, of ${subscribers.length} total`);
  }
}
