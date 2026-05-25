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
import type { MeshtasticSerialBridge } from './meshtasticSerial.js';
import type { BbsConfig } from './bbsConfig.js';
import { meshDb as meshDbFactory } from './database.js';

const meshDb = meshDbFactory();

/** Synthetic short name shown as the sender on alert mail. Three chars to fit
 *  conventional Meshtastic 4-char short_name displays comfortably. */
const ALERT_SENDER_SHORT = 'WX';

const POLL_INTERVAL_MS = parseInt(process.env.MESHVIEW_WEATHER_POLL_MS || '', 10) || (20 * 60_000);
const FIRST_POLL_DELAY_MS = 10_000; // wait for radio to settle before first poll

export class WeatherAlertPoller {
  private bridge: MeshtasticSerialBridge;
  private getConfig: () => BbsConfig;
  /** Alert IDs we've already surfaced this run. Cleared when an alert is no
   *  longer in NWS's active list (so a repeat after expiry shows again). */
  private seenAlertIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstRun = true;

  constructor(bridge: MeshtasticSerialBridge, getConfig: () => BbsConfig) {
    this.bridge = bridge;
    this.getConfig = getConfig;
  }

  start(): void {
    if (this.timer) return;
    console.log(`[WeatherPoller] Starting (interval=${Math.round(POLL_INTERVAL_MS / 1000)}s)`);
    // Stagger the first poll so radio init has time to finish.
    setTimeout(() => this.tick(), FIRST_POLL_DELAY_MS);
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force an immediate poll. Useful from the config-change handler so a
   *  freshly-set home ZIP gets its first check right away instead of waiting
   *  20 minutes. */
  async pollNow(): Promise<void> {
    return this.tick();
  }

  private async tick(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.homeZipCode) {
      // Cleared while we were waiting — drop the dedup state so a re-enable
      // doesn't suppress alerts that are no longer "seen this run".
      if (this.seenAlertIds.size > 0) this.seenAlertIds.clear();
      return;
    }

    let alerts: NwsAlert[];
    let locationLabel: string;
    try {
      alerts = await weatherService.getActiveAlerts(cfg.homeZipCode);
      const loc = await weatherService.resolveZip(cfg.homeZipCode);
      locationLabel = `${loc.city}, ${loc.state}`;
    } catch (err: any) {
      console.warn(`[WeatherPoller] poll failed: ${err?.message}`);
      return;
    }

    // Reset dedup for any alerts that have rolled off NWS's active list.
    const currentIds = new Set(alerts.map(a => a.id));
    for (const oldId of this.seenAlertIds) {
      if (!currentIds.has(oldId)) this.seenAlertIds.delete(oldId);
    }

    let newCount = 0;
    for (const alert of alerts) {
      if (this.seenAlertIds.has(alert.id)) continue;
      this.seenAlertIds.add(alert.id);

      // On the very first tick after startup we silently absorb existing
      // alerts — the operator already knows about them from their phone /
      // radio / TV / etc. We don't want to spam the event log with stale
      // alerts every time the container restarts. Subsequent ticks fire
      // events normally.
      if (this.firstRun) continue;

      newCount++;
      const compact = weatherService.formatAlertCompact(alert, locationLabel);
      this.bridge.recordEvent({
        // Prefix with `wx-` so the alert id doesn't collide with the normal
        // randomId() format used for radio events.
        id: `wx-${alert.id}`,
        type: 'WEATHER_ALERT',
        nodeId: 'local',
        timestamp: Date.now(),
        details: compact,
      });
      console.log(`[WeatherPoller] NEW alert: ${compact}`);

      // Fan out to subscribers. DM goes out over the radio (best-effort — may
      // bounce if recipient is offline); mail row is persisted unconditionally
      // so subscribers can pull it later via :mail R.
      await this.deliverToSubscribers(compact);
    }

    if (this.firstRun) {
      console.log(`[WeatherPoller] First-run baseline absorbed ${alerts.length} existing alert(s) for ${locationLabel}`);
      this.firstRun = false;
    } else if (newCount > 0) {
      console.log(`[WeatherPoller] surfaced ${newCount} new alert(s)`);
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
  private async deliverToSubscribers(compact: string): Promise<void> {
    const subscribers = meshDb.listWeatherSubscribers();
    if (subscribers.length === 0) return;

    const localNodeId = (this.bridge as any).localNodeId as string | null;
    if (!localNodeId) {
      console.warn('[WeatherPoller] Skipping subscriber fanout — local node not yet identified');
      return;
    }

    console.log(`[WeatherPoller] Fanning out alert to ${subscribers.length} subscriber(s)`);
    let delivered = 0;
    for (const sub of subscribers) {
      // Persist mail row first — even if the DM fails, the subscriber can pull
      // the alert via :mail R later.
      let mailId: number | undefined;
      try {
        mailId = meshDb.insertMail({
          sender_node_id: localNodeId,
          sender_short_name: ALERT_SENDER_SHORT,
          recipient_node_id: sub.nodeId,
          posted_at: Date.now(),
          body: compact,
        });
        this.bridge.emit('bbsMail', { recipientNodeId: sub.nodeId, mailId, source: 'weather' });
      } catch (err: any) {
        console.warn(`[WeatherPoller] insertMail failed for ${sub.nodeId}: ${err?.message}`);
      }

      // Best-effort DM. sendMessage handles auto-retry on rate limit + transient
      // routing errors internally.
      try {
        await this.bridge.sendMessage(compact, sub.nodeId, sub.channelIndex);
        meshDb.touchWeatherSubscriberAlert(sub.nodeId);
        if (mailId !== undefined) meshDb.markMailDelivered(mailId);
        delivered++;
      } catch (err: any) {
        console.warn(`[WeatherPoller] DM to ${sub.nodeId} failed: ${err?.message}`);
      }

      // Small inter-subscriber pause so we don't slam the firmware queue.
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[WeatherPoller] Subscriber fanout complete: ${delivered}/${subscribers.length} DM delivered`);
  }
}
