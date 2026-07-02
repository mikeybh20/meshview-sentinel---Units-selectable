/**
 * v3.0 First-Run Wizard — replaces the v1.0/v2.x "demo mode" entry
 * point.
 *
 * Shown once when a fresh Sentinel install has:
 *   - No configured radios
 *   - AND the user hasn't dismissed the wizard yet
 * Also opened from the "First-time here?" affordance in Settings for
 * anyone who wants to re-see it (or hand it to a new user).
 *
 * Two paths:
 *   1. Pair a Radio — closes the wizard, navigates the operator to
 *      Settings → Radios (or the top-level Radios tab). Real
 *      Meshtastic hardware, real mesh data.
 *   2. Playground — activates the client-side simulator FOR THIS
 *      SESSION ONLY. Not persisted. Synthetic nodes, fake telemetry,
 *      auto-clears when the user pairs a radio or closes the tab.
 *
 * Deliberately different from v1.x/v2.x demo mode:
 *   - v2.x simulator was a Settings → Mode toggle that PERSISTED
 *     across reloads. Some new users would leave it on by accident
 *     and later wonder why their real radio's traffic wasn't
 *     showing up.
 *   - v3.0 Playground is session-only. Reload = back to Live. No
 *     hidden state to trip over.
 *
 * Dismissal: setting `mesh.wizardDismissed=true` in localStorage.
 * Cleared by "Reset wizard" button in Settings so an operator
 * onboarding a new colleague can walk them through it fresh.
 */
import React from 'react';
import { Radio, Play, X, ArrowRight, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/utils';

interface FirstRunWizardProps {
  /** Called when the user picks "Pair a Radio". Parent handles the
   *  actual navigation to the Radios tab. */
  onPairRadio: () => void;
  /** Called when the user picks "Playground". Parent flips dataSource
   *  to 'simulator' for the session (without persisting). */
  onStartPlayground: () => void;
  /** Called when the user dismisses the wizard entirely without
   *  choosing an option. Parent sets the dismissed flag. */
  onDismiss: () => void;
}

export function FirstRunWizard({
  onPairRadio,
  onStartPlayground,
  onDismiss,
}: FirstRunWizardProps) {
  const handlePair = () => {
    localStorage.setItem('mesh.wizardDismissed', 'true');
    onPairRadio();
  };
  const handlePlayground = () => {
    localStorage.setItem('mesh.wizardDismissed', 'true');
    onStartPlayground();
  };
  const handleDismiss = () => {
    localStorage.setItem('mesh.wizardDismissed', 'true');
    onDismiss();
  };

  return (
    <div className="fixed inset-0 bg-brand-bg/90 backdrop-blur-sm z-50 flex items-center justify-center p-6 overflow-y-auto">
      <div className="technical-panel max-w-2xl w-full p-8 relative">
        <button
          onClick={handleDismiss}
          className="absolute top-3 right-3 p-1.5 rounded hover:bg-brand-line/40 text-brand-muted hover:text-brand-ink transition-colors"
          title="Dismiss"
        >
          <X size={18} />
        </button>

        <div className="mb-6">
          <div className="text-[10px] uppercase font-bold tracking-widest text-brand-accent mb-2">
            First-run · v3.0
          </div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">Welcome to MeshView Sentinel</h1>
          <p className="text-sm text-brand-muted leading-relaxed">
            Sentinel is a self-hosted operator console for Meshtastic LoRa mesh
            networks — nodes, channels, messages, BBS, weather alerts, SKYWARN
            storm reports, and mesh-ops intelligence on one dashboard. Pick how
            you want to start:
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          {/* Path 1: Pair a Radio (recommended) */}
          <button
            onClick={handlePair}
            className={cn(
              "text-left p-5 rounded-lg border transition-colors group",
              "bg-brand-accent/5 border-brand-accent/30 hover:bg-brand-accent/10 hover:border-brand-accent/50",
            )}
          >
            <div className="flex items-center justify-between mb-3">
              <Radio size={20} className="text-brand-accent" />
              <span className="text-[9px] uppercase tracking-widest font-bold text-brand-accent bg-brand-accent/15 px-2 py-0.5 rounded">
                Recommended
              </span>
            </div>
            <div className="text-lg font-bold tracking-tight mb-1">Pair a Radio</div>
            <p className="text-xs text-brand-muted leading-relaxed mb-4">
              Connect a real Meshtastic radio over USB serial or TCP (over
              WiFi). Live mesh traffic, real subscribers, actual weather
              alerts — the way Sentinel is meant to run.
            </p>
            <div className="text-[10px] uppercase font-bold tracking-widest text-brand-accent flex items-center gap-1 group-hover:gap-2 transition-all">
              Go to Radios <ArrowRight size={11} />
            </div>
          </button>

          {/* Path 2: Playground (session-only) */}
          <button
            onClick={handlePlayground}
            className={cn(
              "text-left p-5 rounded-lg border transition-colors group",
              "bg-brand-warning/5 border-brand-warning/30 hover:bg-brand-warning/10 hover:border-brand-warning/50",
            )}
          >
            <div className="flex items-center justify-between mb-3">
              <Play size={20} className="text-brand-warning" />
              <span className="text-[9px] uppercase tracking-widest font-bold text-brand-warning bg-brand-warning/15 px-2 py-0.5 rounded">
                Session only
              </span>
            </div>
            <div className="text-lg font-bold tracking-tight mb-1">Playground</div>
            <p className="text-xs text-brand-muted leading-relaxed mb-4">
              Synthetic nodes, fake telemetry, no radio needed. Great for
              trying the UI before you have hardware. Auto-clears when you
              close this tab or pair a real radio.
            </p>
            <div className="text-[10px] uppercase font-bold tracking-widest text-brand-warning flex items-center gap-1 group-hover:gap-2 transition-all">
              Start playground <ArrowRight size={11} />
            </div>
          </button>
        </div>

        {/* Session-only disclaimer for the playground path — matches the
            "don't be the official app" quality posture; a subscriber who
            spent an hour setting up Playground state and then reloaded
            SHOULD know beforehand it won't persist. */}
        <div className="mt-5 flex items-start gap-2 text-[11px] text-brand-muted p-3 rounded bg-brand-line/20 border border-brand-line/60">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-brand-warning" />
          <span>
            Playground is deliberately session-only in v3.0 — a change from
            v2.x's persistent "simulator" toggle, which occasionally trapped
            operators who forgot they'd enabled it and wondered why their
            real radio's traffic wasn't showing up. Reload = back to Live.
          </span>
        </div>

        <div className="mt-5 flex items-center justify-between text-[10px] text-brand-muted">
          <span>You can re-open this wizard from Settings → Mode.</span>
          <button
            onClick={handleDismiss}
            className="uppercase tracking-widest font-bold hover:text-brand-ink"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
