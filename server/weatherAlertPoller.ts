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
  /** Date key (YYYY-MM-DD in server-local time) for the last day we sent
   *  the daily forecast. Prevents double-fire when the minute tick
   *  straddles the target time. */
  private lastDailySentDay: string | null = null;

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
      // Seed lastDailySentDay to "today" so if we boot AFTER the target
      // time we don't immediately fire a stale forecast at startup —
      // operator gets it tomorrow morning instead. Boot-time push is
      // the wrong behavior: subscribers got their morning fresh, they
      // don't need it again at 2pm.
      this.lastDailySentDay = this.todayKey();
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

  /** Minute-resolution scheduler tick. Fires the daily forecast when the
   *  wall clock crosses the configured HH:MM and we haven't sent today
   *  yet. Per-minute polling instead of next-fire setTimeout because
   *  timeout drift over a 24h window is unreliable (system sleep, NTP
   *  steps, container restarts) — a minute tick is robust and cheap. */
  private async dailyTick(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.dailyForecastTime) return;

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const clock = `${hh}:${mm}`;
    if (clock !== cfg.dailyForecastTime) return;

    const dayKey = this.todayKey();
    if (this.lastDailySentDay === dayKey) return;
    this.lastDailySentDay = dayKey;

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
      // Roll back the dayKey so we'll retry on the next tick. NWS hiccups
      // shouldn't cost the operator a day of forecasts.
      this.lastDailySentDay = null;
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

        // Surface the alert on the operator's event log only for home-ZIP
        // alerts. Per-subscriber-ZIP alerts route to the subscriber but
        // shouldn't pollute the operator's local-area alert feed.
        if (isHomeZip) {
          for (const ctx of this.bm.list()) {
            ctx.bridge.recordEvent({
              id: `wx-${alert.id}-${ctx.radioId}`,
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

    const defaultBridge = this.bm.getDefault()?.bridge ?? null;
    if (!defaultBridge && !this.bm.list().length) {
      console.warn('[WeatherPoller] Skipping subscriber fanout — no bridge connected');
      return;
    }

    console.log(`[WeatherPoller] Fanning out to ${subscribers.length} subscriber(s)`);
    let delivered = 0;
    let skipped = 0;
    for (const sub of subscribers) {
      const ctx = sub.radioId ? this.bm.get(sub.radioId) : this.bm.getDefault();
      if (!ctx?.bridge) {
        skipped++;
        console.warn(`[WeatherPoller] subscriber ${sub.nodeId} routed via radio "${sub.radioId ?? '<default>'}" but that bridge isn't connected — skipping DM, mail row still persisted`);
      }
      const bridge = ctx?.bridge ?? null;
      const localNodeId = bridge ? (bridge as any).localNodeId as string | null : null;

      // Persist mail row first — even if the DM fails, the subscriber can pull
      // the alert via :mail R later.
      let mailId: number | undefined;
      try {
        if (localNodeId) {
          mailId = meshDb.insertMail({
            sender_node_id: localNodeId,
            sender_short_name: senderShort,
            recipient_node_id: sub.nodeId,
            posted_at: Date.now(),
            body: compact,
            radio_id: sub.radioId ?? this.bm.getDefaultRadioId(),
          });
          bridge?.emit('bbsMail', { recipientNodeId: sub.nodeId, mailId, source: 'weather' });
        }
      } catch (err: any) {
        console.warn(`[WeatherPoller] insertMail failed for ${sub.nodeId}: ${err?.message}`);
      }

      if (!bridge) continue;

      // Best-effort DM. sendMessage handles auto-retry on rate limit + transient
      // routing errors internally.
      try {
        await bridge.sendMessage(compact, sub.nodeId, sub.channelIndex);
        meshDb.touchWeatherSubscriberAlert(sub.nodeId);
        if (mailId !== undefined) meshDb.markMailDelivered(mailId);
        delivered++;
      } catch (err: any) {
        console.warn(`[WeatherPoller] DM to ${sub.nodeId} via radio ${sub.radioId ?? '<default>'} failed: ${err?.message}`);
      }

      // Small inter-subscriber pause so we don't slam the firmware queue.
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[WeatherPoller] Subscriber fanout complete: ${delivered}/${subscribers.length} DM delivered (${skipped} skipped — radio disconnected)`);
  }
}
