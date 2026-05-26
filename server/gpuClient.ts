/**
 * v2.0 — Sentinel-side HTTP client for the [meshview-gpu](../gpu/README.md)
 * Python sidecar.
 *
 * Contract:
 *   - Every accelerated workload has BOTH a GPU implementation (this client,
 *     calling the sidecar) and a CPU fallback (TypeScript, lives here).
 *   - When the sidecar is reachable + responds 200, the GPU result is used.
 *   - When the sidecar is unreachable OR responds 5xx/501, the CPU fallback
 *     runs and we log a one-shot startup banner so the operator knows.
 *   - Both implementations are tested against the same fixtures with
 *     identical numerical outputs (within float tolerance).
 *
 * Phase 1.5: the only working endpoint is /health. All compute endpoints
 * return 501; the client immediately uses CPU fallbacks. Per-phase work
 * (3/4/5) implements the GPU paths in the sidecar AND adds the matching
 * CPU fallbacks here so dev machines without a sidecar still work.
 */

const SIDECAR_URL = process.env.MESHVIEW_GPU_URL || 'http://meshview-gpu:7100';
const HEALTH_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 5000;

export interface GpuHealth {
  status: 'ok' | 'unreachable';
  gpu?: {
    gpu_present: boolean;
    name?: string;
    memory_total?: string;
    driver_version?: string;
  };
  error?: string;
}

let _fallbackBannerShown = false;
function bannerOnce(reason: string): void {
  if (_fallbackBannerShown) return;
  _fallbackBannerShown = true;
  console.warn(`[GpuClient] sidecar unreachable — using CPU fallback (dev mode): ${reason}`);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function health(): Promise<GpuHealth> {
  try {
    const r = await fetchWithTimeout(`${SIDECAR_URL}/health`, { method: 'GET' }, HEALTH_TIMEOUT_MS);
    if (!r.ok) return { status: 'unreachable', error: `HTTP ${r.status}` };
    return await r.json() as GpuHealth;
  } catch (err: any) {
    return { status: 'unreachable', error: err?.message ?? String(err) };
  }
}

/**
 * Generic JSON POST wrapper. Returns null on any failure (network, 5xx, 501);
 * callers run their CPU fallback when null is returned.
 */
export async function callSidecar<TReq, TRes>(
  path: string,
  body: TReq,
): Promise<TRes | null> {
  try {
    const r = await fetchWithTimeout(
      `${SIDECAR_URL}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      REQUEST_TIMEOUT_MS,
    );
    if (!r.ok) {
      bannerOnce(`POST ${path} returned ${r.status}`);
      return null;
    }
    return await r.json() as TRes;
  } catch (err: any) {
    bannerOnce(`POST ${path} failed: ${err?.message ?? String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------
// Boot probe — logs the sidecar status at startup so the operator knows
// what acceleration tier they have. Non-blocking; sidecar may not be up
// yet when this runs.
// ---------------------------------------------------------------------
export function probeGpuOnBoot(): void {
  health().then(h => {
    if (h.status === 'ok') {
      const g = h.gpu;
      if (g?.gpu_present) {
        console.log(`[GpuClient] sidecar healthy. GPU=${g.name ?? '?'} mem=${g.memory_total ?? '?'}`);
      } else {
        console.log('[GpuClient] sidecar healthy. No GPU detected (CPU-only sidecar mode).');
      }
    } else {
      console.warn(`[GpuClient] sidecar not reachable at ${SIDECAR_URL}: ${h.error ?? 'unknown'}`);
      console.warn('[GpuClient] Sentinel will use CPU fallbacks for all GPU workloads.');
    }
  }).catch(() => {
    // Should never throw because health() catches internally.
  });
}
