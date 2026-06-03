/**
 * v2.0 Beta 5 — Jetson Nano live stats reader.
 *
 * Provides a structured tegrastats-equivalent snapshot WITHOUT shelling
 * out to the tegrastats binary (not installed in the container, requires
 * sudo anyway). Everything comes from /proc + /sys, both of which are
 * accessible from inside the meshview container:
 *
 *   - /proc/{stat,meminfo,loadavg,uptime}   container view but reflects
 *                                           HOST stats because Docker
 *                                           doesn't namespace these for
 *                                           the default cgroup driver
 *   - /sys/...                              mounted read-only from host
 *                                           via the docker-compose volume,
 *                                           so it's the host's sysfs
 *
 * CPU utilization is computed by sampling /proc/stat twice with a short
 * delay between reads and diffing the totals — same approach top(1)
 * and tegrastats use under the hood. A 200ms sample window is enough
 * to be visually responsive without being noisy.
 *
 * The endpoint that surfaces this caches the result for 2s so that a
 * dashboard polling every 5s + a second tab + a curl probe don't each
 * trigger their own /proc/stat sample.
 *
 * Works on non-Jetson Linux hosts too — the Jetson-specific bits
 * (thermal zone labels, GPU load, device-tree model) just return their
 * empty-state without erroring.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';

export interface CpuPerCore {
  id: number;
  utilPercent: number;
  freqKhz: number | null;
}

export interface ThermalZone {
  /** Zone label from /sys/.../type (e.g. "CPU-therm", "GPU-therm",
   *  "PMIC-Die", "AO-therm", "PLL", "thermal"). On non-Jetson Linux
   *  this is whatever the kernel exposes — often less interesting. */
  zone: string;
  tempC: number;
}

export interface JetsonStatsSnapshot {
  capturedAt: number;
  /** Whether this host appears to be a Jetson (device-tree compatible
   *  string contains "tegra" or "jetson"). Frontend uses this to decide
   *  whether to label the panel "Jetson stats" or "System stats". */
  isJetson: boolean;
  jetsonModel: string | null;
  uptimeSecs: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  // Memory + swap in MB to match tegrastats's RAM/SWAP formatting.
  ramTotalMb: number;
  ramUsedMb: number;
  ramFreeMb: number;
  ramCachedMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  // CPU
  cpuCount: number;
  cpuUtilPercent: number;         // averaged across cores
  cpuPerCore: CpuPerCore[];
  // Thermal
  thermal: ThermalZone[];
  // GPU (best-effort — may be null on locked-down L4T builds)
  gpuLoadPercent: number | null;
  gpuFreqMhz: number | null;
}

// /proc/stat per-CPU snapshot. user+nice+system+idle+iowait+irq+softirq+steal+...
interface CpuRaw {
  id: number;             // -1 for the "cpu" aggregate line
  total: number;
  idle: number;
}

function readCpuStat(): CpuRaw[] {
  const out: CpuRaw[] = [];
  try {
    const txt = readFileSync('/proc/stat', 'utf-8');
    for (const line of txt.split('\n')) {
      // Match `cpu` (aggregate) or `cpu0`, `cpu1`, ... (per-core).
      // Anything else (intr, ctxt, etc.) gets skipped.
      const m = line.match(/^cpu(\d*)\s+(.*)$/);
      if (!m) continue;
      const id = m[1] === '' ? -1 : parseInt(m[1], 10);
      const fields = m[2].trim().split(/\s+/).map(Number);
      if (fields.length < 5) continue;
      const total = fields.reduce((a, b) => a + b, 0);
      const idle = (fields[3] ?? 0) + (fields[4] ?? 0); // idle + iowait
      out.push({ id, total, idle });
    }
  } catch { /* /proc/stat unreadable — return empty, caller substitutes 0% util */ }
  return out;
}

function diffCpuUtil(a: CpuRaw, b: CpuRaw): number {
  const totalDelta = b.total - a.total;
  const idleDelta  = b.idle  - a.idle;
  if (totalDelta <= 0) return 0;
  const busy = totalDelta - idleDelta;
  return Math.max(0, Math.min(100, Math.round((busy / totalDelta) * 100)));
}

function readMemInfo(): { totalMb: number; freeMb: number; availableMb: number; cachedMb: number; buffersMb: number; swapTotalMb: number; swapFreeMb: number } {
  const out = { totalMb: 0, freeMb: 0, availableMb: 0, cachedMb: 0, buffersMb: 0, swapTotalMb: 0, swapFreeMb: 0 };
  try {
    const txt = readFileSync('/proc/meminfo', 'utf-8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
      if (!m) continue;
      const kb = parseInt(m[2], 10);
      const mb = Math.round(kb / 1024);
      switch (m[1]) {
        case 'MemTotal':     out.totalMb     = mb; break;
        case 'MemFree':      out.freeMb      = mb; break;
        case 'MemAvailable': out.availableMb = mb; break;
        case 'Cached':       out.cachedMb    = mb; break;
        case 'Buffers':      out.buffersMb   = mb; break;
        case 'SwapTotal':    out.swapTotalMb = mb; break;
        case 'SwapFree':     out.swapFreeMb  = mb; break;
      }
    }
  } catch { /* /proc/meminfo unreadable on this host — zeros are fine */ }
  return out;
}

function readLoadAvg(): { one: number; five: number; fifteen: number } {
  try {
    const txt = readFileSync('/proc/loadavg', 'utf-8').trim();
    const parts = txt.split(/\s+/);
    return {
      one:     parseFloat(parts[0] ?? '0'),
      five:    parseFloat(parts[1] ?? '0'),
      fifteen: parseFloat(parts[2] ?? '0'),
    };
  } catch { return { one: 0, five: 0, fifteen: 0 }; }
}

function readUptimeSecs(): number {
  try {
    const txt = readFileSync('/proc/uptime', 'utf-8').trim();
    return Math.floor(parseFloat(txt.split(/\s+/)[0] ?? '0'));
  } catch { return 0; }
}

/** Read the current scaling frequency for one CPU core. Returns null on
 *  hosts where cpufreq isn't exposed (e.g., dev VMs, locked-down
 *  containers). */
function readCpuFreqKhz(cpuId: number): number | null {
  const p = `/sys/devices/system/cpu/cpu${cpuId}/cpufreq/scaling_cur_freq`;
  if (!existsSync(p)) return null;
  try {
    return parseInt(readFileSync(p, 'utf-8').trim(), 10) || null;
  } catch { return null; }
}

/** Walk /sys/class/thermal/thermal_zone* and return labeled temps.
 *  Each zone has `type` (label like "CPU-therm") and `temp` (millicelsius). */
function readThermalZones(): ThermalZone[] {
  const root = '/sys/class/thermal';
  const out: ThermalZone[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(root).filter(n => n.startsWith('thermal_zone')); }
  catch { return out; }
  for (const name of entries) {
    try {
      const type = readFileSync(`${root}/${name}/type`, 'utf-8').trim();
      const tempMilli = parseInt(readFileSync(`${root}/${name}/temp`, 'utf-8').trim(), 10);
      if (!Number.isFinite(tempMilli)) continue;
      out.push({ zone: type, tempC: Math.round((tempMilli / 1000) * 10) / 10 });
    } catch { /* zone unreadable — skip it */ }
  }
  return out;
}

/** Best-effort Jetson GPU load + frequency. Path varies by L4T release;
 *  fail silently when not present. */
function readGpuStats(): { loadPercent: number | null; freqMhz: number | null } {
  // Load — `/sys/devices/gpu.0/load` on Tegra X1 (Nano), reported in
  // tenths of a percent (e.g. "237" = 23.7%). Some L4T builds expose
  // it at `/sys/devices/57000000.gpu/load` instead.
  const loadPaths = [
    '/sys/devices/gpu.0/load',
    '/sys/devices/57000000.gpu/load',
  ];
  let loadPercent: number | null = null;
  for (const p of loadPaths) {
    if (!existsSync(p)) continue;
    try {
      const raw = parseInt(readFileSync(p, 'utf-8').trim(), 10);
      if (Number.isFinite(raw)) { loadPercent = Math.round(raw / 10); break; }
    } catch { /* permission denied — try next path */ }
  }

  // Current GPU clock frequency. Same pattern: a couple of known paths,
  // try each, give up silently.
  const freqPaths = [
    '/sys/devices/57000000.gpu/devfreq/57000000.gpu/cur_freq',
    '/sys/devices/gpu.0/devfreq/cur_freq',
  ];
  let freqMhz: number | null = null;
  for (const p of freqPaths) {
    if (!existsSync(p)) continue;
    try {
      const hz = parseInt(readFileSync(p, 'utf-8').trim(), 10);
      if (Number.isFinite(hz)) { freqMhz = Math.round(hz / 1_000_000); break; }
    } catch { /* skip */ }
  }
  return { loadPercent, freqMhz };
}

function detectJetson(): { isJetson: boolean; model: string | null } {
  try {
    if (existsSync('/proc/device-tree/compatible')) {
      const compat = readFileSync('/proc/device-tree/compatible', 'utf-8');
      if (/tegra|jetson/i.test(compat)) {
        let model: string | null = null;
        try {
          model = readFileSync('/proc/device-tree/model', 'utf-8').replace(/\0/g, '').trim();
        } catch { /* model is optional */ }
        return { isJetson: true, model };
      }
    }
  } catch { /* not Linux or no perms */ }
  return { isJetson: false, model: null };
}

/**
 * Take one stats snapshot. The CPU utilization measurement requires a
 * delay between two /proc/stat reads — 200ms is enough to be
 * representative without making the request feel slow. The other
 * sources are point-in-time reads so they don't need the same sampling.
 *
 * Throws only on truly catastrophic conditions (/proc not mounted at
 * all). Individual missing files fall back to zeros / nulls so the
 * caller always gets a usable snapshot.
 */
export async function readJetsonStats(): Promise<JetsonStatsSnapshot> {
  // Two-sample CPU util — read /proc/stat, wait, read again, diff.
  const before = readCpuStat();
  await new Promise(r => setTimeout(r, 200));
  const after = readCpuStat();

  // Build per-core util by matching ids; fall back to 0 for cores that
  // appear in only one sample (rare but possible during CPU hotplug).
  const beforeById = new Map(before.map(c => [c.id, c]));
  const cpuCount = Math.max(0, after.filter(c => c.id >= 0).length);
  const cpuPerCore: CpuPerCore[] = [];
  for (const cur of after) {
    if (cur.id < 0) continue;
    const prev = beforeById.get(cur.id);
    const util = prev ? diffCpuUtil(prev, cur) : 0;
    cpuPerCore.push({ id: cur.id, utilPercent: util, freqKhz: readCpuFreqKhz(cur.id) });
  }
  // Overall util: the aggregate "cpu" line is the most accurate; fall
  // back to averaging cores if it's missing.
  let cpuUtilPercent = 0;
  const aggBefore = before.find(c => c.id === -1);
  const aggAfter  = after.find(c => c.id === -1);
  if (aggBefore && aggAfter) {
    cpuUtilPercent = diffCpuUtil(aggBefore, aggAfter);
  } else if (cpuPerCore.length > 0) {
    cpuUtilPercent = Math.round(cpuPerCore.reduce((a, c) => a + c.utilPercent, 0) / cpuPerCore.length);
  }

  const mem = readMemInfo();
  const load = readLoadAvg();
  const thermal = readThermalZones();
  const gpu = readGpuStats();
  const jetson = detectJetson();

  // Used memory: total minus available is the most accurate (matches
  // `free -m` "used" column). Fall back to total - free for kernels
  // without MemAvailable (very old).
  const ramUsedMb = mem.availableMb > 0
    ? Math.max(0, mem.totalMb - mem.availableMb)
    : Math.max(0, mem.totalMb - mem.freeMb - mem.buffersMb - mem.cachedMb);

  return {
    capturedAt: Date.now(),
    isJetson: jetson.isJetson,
    jetsonModel: jetson.model,
    uptimeSecs: readUptimeSecs(),
    loadAvg1: load.one,
    loadAvg5: load.five,
    loadAvg15: load.fifteen,
    ramTotalMb: mem.totalMb,
    ramUsedMb,
    ramFreeMb: mem.freeMb,
    ramCachedMb: mem.cachedMb,
    swapTotalMb: mem.swapTotalMb,
    swapUsedMb: Math.max(0, mem.swapTotalMb - mem.swapFreeMb),
    cpuCount,
    cpuUtilPercent,
    cpuPerCore,
    thermal,
    gpuLoadPercent: gpu.loadPercent,
    gpuFreqMhz: gpu.freqMhz,
  };
}
