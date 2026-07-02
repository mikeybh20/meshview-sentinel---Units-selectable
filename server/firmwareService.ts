/**
 * v3.0 Mesh Ops Intelligence — firmware update-reminder service.
 *
 * Polls github.com/meshtastic/firmware for the latest release,
 * caches the version, and lets the API layer compare it against
 * each connected radio's reported firmware version.
 *
 * Scope discipline: Sentinel only knows the firmware version of
 * radios it's directly connected to (via DeviceMetadata /
 * MyNodeInfo.firmware_version). Other mesh members' firmware
 * versions aren't reliably advertised in standard NodeInfo
 * packets, so per-mesh-member firmware tracking is a future
 * follow-up. For v3.0 MVP we surface the operator's OWN radios'
 * status — which is what an operator managing THEIR mesh cares
 * about.
 *
 * GitHub public API allows 60 unauth requests/hour. Poll every
 * 12h so we use 2 requests/day — well under any limit. No token
 * required, keeps the deployment story simple.
 */

const GH_LATEST_URL = 'https://api.github.com/repos/meshtastic/firmware/releases/latest';
const POLL_INTERVAL_MS = 12 * 3600_000;   // 12h
const RETRY_INTERVAL_MS = 30 * 60_000;    // 30 min on failure
const STARTUP_DELAY_MS = 15_000;          // 15s after boot
const GH_UA = process.env.MESHVIEW_GH_UA
  || 'MeshViewSentinel/1.0 (https://github.com/mikeybh20/meshview-sentinel)';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Trailing git-hash / build-id after the semver portion — Meshtastic
   *  release tags look like "v2.6.11" OR "v2.5.19.f77c4b6", so we
   *  capture the extra segment separately for display. */
  build?: string;
  /** The raw tag string as returned by GitHub / read from a radio. */
  raw: string;
}

interface LatestRelease {
  tagName: string;
  name: string;
  htmlUrl: string;
  publishedAt: string; // ISO-8601 from GitHub
  parsed: ParsedVersion;
  /** Epoch-ms when THIS process last fetched successfully. */
  fetchedAt: number;
}

interface GhReleaseResponse {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
}

/**
 * Parse a Meshtastic firmware version string ("2.6.11",
 * "v2.5.19.f77c4b6", "2.5.19-alpha") into a comparable form.
 * Returns null on malformed input.
 */
export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^v/i, '');
  // Match major.minor.patch, optionally followed by ".<build>" or
  // "-<qualifier>" that we capture as `build`.
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[.\-](.+))?$/.exec(cleaned);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  const patch = parseInt(m[3], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch, build: m[4] || undefined, raw };
}

/** Semver-ish comparison. Returns negative if `a` is older, 0 if equal
 *  by major.minor.patch (ignoring build), positive if `a` is newer. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Classify how far behind `installed` is vs `latest`. Used by the
 * Health panel to color-code radios.
 *
 *   'unknown'    — no installed version parseable
 *   'newer'      — installed is somehow ahead of the published
 *                   release (pre-release / dev build)
 *   'current'    — equal major.minor.patch
 *   'patch'      — same major+minor, older patch
 *   'minor'      — same major, older minor
 *   'major'      — older major
 */
export type BehindClassification = 'unknown' | 'newer' | 'current' | 'patch' | 'minor' | 'major';

export function classifyBehind(installed: ParsedVersion | null, latest: ParsedVersion): BehindClassification {
  if (!installed) return 'unknown';
  const cmp = compareVersions(installed, latest);
  if (cmp > 0) return 'newer';
  if (cmp === 0) return 'current';
  if (installed.major < latest.major) return 'major';
  if (installed.minor < latest.minor) return 'minor';
  return 'patch';
}

class FirmwareService {
  private latest: LatestRelease | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private started = false;

  /**
   * Kick off periodic polling of the latest Meshtastic firmware
   * release. Idempotent — calling twice is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    console.log(`[FirmwareService] Starting — poll github.com/meshtastic/firmware every ${Math.round(POLL_INTERVAL_MS / 3600_000)}h`);
    // Bootstrap fetch a few seconds after boot so /api/mesh/ops/
    // firmware-status has real data when the operator first opens
    // the Health panel. The delay keeps GitHub-slow-response from
    // competing with server init.
    setTimeout(() => this.tick('startup'), STARTUP_DELAY_MS);
    this.pollTimer = setInterval(() => this.tick('scheduled'), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer)  { clearInterval(this.pollTimer);  this.pollTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer);  this.retryTimer = null; }
    this.started = false;
  }

  /** Latest known release, or null if we haven't successfully
   *  fetched yet. Consumers should handle null gracefully — a
   *  brand-new install checking the Health panel before the first
   *  scheduled tick lands. */
  getLatest(): LatestRelease | null {
    return this.latest;
  }

  private async tick(cause: 'startup' | 'scheduled' | 'retry'): Promise<void> {
    try {
      const res = await fetch(GH_LATEST_URL, {
        headers: { 'User-Agent': GH_UA, 'Accept': 'application/vnd.github+json' },
      });
      if (!res.ok) {
        throw new Error(`GitHub HTTP ${res.status}`);
      }
      const data = await res.json() as GhReleaseResponse;
      const tag = data.tag_name;
      if (!tag) throw new Error('release response missing tag_name');
      const parsed = parseVersion(tag);
      if (!parsed) throw new Error(`unparseable release tag: ${tag}`);
      this.latest = {
        tagName: tag,
        name: data.name || tag,
        htmlUrl: data.html_url || `https://github.com/meshtastic/firmware/releases/tag/${encodeURIComponent(tag)}`,
        publishedAt: data.published_at || '',
        parsed,
        fetchedAt: Date.now(),
      };
      // Success cancels any pending retry.
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
      console.log(`[FirmwareService] ${cause} fetch OK — latest is ${tag}`);
    } catch (err: any) {
      console.warn(`[FirmwareService] ${cause} fetch FAILED: ${err?.message}. Retrying in ${Math.round(RETRY_INTERVAL_MS / 60_000)} min.`);
      // Schedule a single retry — the normal poll cadence will pick
      // things up eventually anyway. No exponential backoff needed
      // for a 12h base cadence.
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.tick('retry').catch(() => {});
      }, RETRY_INTERVAL_MS);
      this.retryTimer.unref?.();
    }
  }
}

export const firmwareService = new FirmwareService();
export type { LatestRelease, ParsedVersion };
