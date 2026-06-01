/**
 * v2.0 Beta 3: mDNS / Bonjour scanner for nearby Meshtastic radios.
 *
 * The Meshtastic firmware advertises `_meshtastic._tcp.local` on port 4403
 * whenever WiFi is enabled. The official iOS / desktop / web clients all use
 * this to populate their "Add Radio" pickers automatically; this module gives
 * Sentinel the same capability.
 *
 * Note on Docker networking: mDNS uses link-local multicast (224.0.0.251:5353)
 * which does NOT traverse Docker's default bridge network. For the scanner to
 * actually see radios on your LAN, the meshview container needs one of:
 *   - `network_mode: host` in docker-compose.yml
 *   - A macvlan/ipvlan network attaching the container directly to the LAN
 *   - An mDNS reflector running on the host (avahi-daemon + reflector mode)
 *
 * The scanner starts unconditionally; if no multicast reaches the container it
 * just returns an empty service list (no error). The Add Radio form falls back
 * to manual IP entry when discovery yields nothing.
 */

import Bonjour from 'bonjour-service';

/** Subset of bonjour-service's Service shape we actually consume. */
type RawService = {
  name: string;
  fqdn: string;
  host: string;
  port: number;
  addresses?: string[];
  txt?: unknown;
};

export interface DiscoveredMeshtasticService {
  /** mDNS service name (typically the radio's short_name or board hostname). */
  name: string;
  /** Fully-qualified domain name advertised by the radio. */
  fqdn: string;
  /** mDNS-advertised hostname (e.g. `meshtastic-3bec.local`). */
  host: string;
  /** TCP StreamAPI port — always 4403 for stock Meshtastic firmware. */
  port: number;
  /** Resolved IPv4 + IPv6 addresses. Sentinel prefers the first IPv4 for `target`. */
  addresses: string[];
  /** First IPv4 in `addresses`, or null if only IPv6 was advertised. */
  ipv4: string | null;
  /** Optional TXT record key/value pairs the firmware may include
   *  (region, modem preset, etc. — varies by firmware version). */
  txt: Record<string, string>;
  /** Epoch ms when the scanner first observed this service. */
  firstSeen: number;
  /** Epoch ms when the scanner last observed this service (refreshed on
   *  re-announce; services not re-seen within ~90 s get pruned). */
  lastSeen: number;
}

class MdnsDiscovery {
  // bonjour-service uses CommonJS namespaced exports that don't translate
  // cleanly to TypeScript value-as-type — keep the privately-held instances
  // as `any`; the library's surface is small enough that we don't lose much.
  private bonjour: any = null;
  private browser: any = null;
  /** Keyed by FQDN; survives transient "down then up" announce cycles. */
  private services = new Map<string, DiscoveredMeshtasticService>();
  /** Periodic prune of services we haven't seen in a while. */
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** How long a service can go unseen before we drop it. */
  private readonly STALE_MS = 90_000;

  start(): void {
    if (this.bonjour) return;
    try {
      this.bonjour = new Bonjour();
      // Meshtastic advertises `_meshtastic._tcp`. `bonjour-service` takes the
      // type WITHOUT the leading underscore and `_tcp` suffix.
      this.browser = this.bonjour.find({ type: 'meshtastic' });
      this.browser.on('up', (svc: RawService) => this.upsert(svc));
      this.browser.on('down', (svc: RawService) => this.services.delete(svc.fqdn));
      // Some firmware versions re-announce the same service with updated TXT
      // (e.g. when the radio's RSSI or battery changes); 'srv-update' fires
      // for that. We just refresh the cached entry.
      this.browser.on('srv-update', (svc: RawService) => this.upsert(svc));

      this.pruneTimer = setInterval(() => this.prune(), 30_000);
      console.log('[MdnsDiscovery] scanner started — listening for _meshtastic._tcp announcements');
    } catch (err: any) {
      // mDNS init can fail in restricted networking environments (Docker
      // bridge mode with no multicast forwarding, locked-down corporate
      // networks). Don't crash the API; just log and leave list empty.
      console.warn(`[MdnsDiscovery] failed to start scanner: ${err?.message ?? err}`);
      this.bonjour = null;
      this.browser = null;
    }
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    try { this.browser?.stop(); } catch { /* idem */ }
    try { this.bonjour?.destroy(); } catch { /* idem */ }
    this.browser = null;
    this.bonjour = null;
    this.services.clear();
  }

  /** Snapshot of currently-known services, IPv4-preferring, sorted by name. */
  list(): DiscoveredMeshtasticService[] {
    return Array.from(this.services.values())
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private upsert(svc: RawService): void {
    const addresses = (svc.addresses ?? []).slice();
    const ipv4 = addresses.find(a => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)) ?? null;
    const txt = this.normalizeTxt(svc.txt);
    const now = Date.now();
    const existing = this.services.get(svc.fqdn);
    this.services.set(svc.fqdn, {
      name: svc.name,
      fqdn: svc.fqdn,
      host: svc.host,
      port: svc.port,
      addresses,
      ipv4,
      txt,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    });
  }

  private normalizeTxt(raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
      else if (Buffer.isBuffer(v)) out[k] = v.toString('utf-8');
      else if (v != null) out[k] = String(v);
    }
    return out;
  }

  private prune(): void {
    const cutoff = Date.now() - this.STALE_MS;
    for (const [fqdn, svc] of this.services) {
      if (svc.lastSeen < cutoff) this.services.delete(fqdn);
    }
  }
}

export const mdnsDiscovery = new MdnsDiscovery();
