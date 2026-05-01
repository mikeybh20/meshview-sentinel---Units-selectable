import React from 'react';
import { X, Check, Eye, EyeOff, Loader2, Bot } from 'lucide-react';
import { cn } from '../lib/utils';
import { motion } from 'motion/react';

interface AIConfig {
  provider: 'anthropic' | 'gemini';
  anthropicModel: string;
  geminiModel: string;
  hasAnthropicKey: boolean;
  hasGeminiKey: boolean;
  anthropicKeyHint: string;
  geminiKeyHint: string;
}

interface AISettingsModalProps {
  onClose: () => void;
}

const API_BASE = import.meta.env.VITE_API_URL || '';

export function AISettingsModal({ onClose }: AISettingsModalProps) {
  const [config, setConfig] = React.useState<AIConfig | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState('');

  const [anthropicKey, setAnthropicKey] = React.useState('');
  const [geminiKey, setGeminiKey] = React.useState('');
  const [showAnthropicKey, setShowAnthropicKey] = React.useState(false);
  const [showGeminiKey, setShowGeminiKey] = React.useState(false);
  const [provider, setProvider] = React.useState<'anthropic' | 'gemini'>('anthropic');

  React.useEffect(() => {
    fetch(`${API_BASE}/api/ai/config`)
      .then(r => r.json())
      .then((cfg: AIConfig) => {
        setConfig(cfg);
        setProvider(cfg.provider);
      })
      .catch(() => setError('Failed to load AI config'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);

    try {
      const body: Record<string, string> = { provider };
      if (anthropicKey) body.anthropicKey = anthropicKey;
      if (geminiKey) body.geminiKey = geminiKey;

      const res = await fetch(`${API_BASE}/api/ai/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('Save failed');

      // Refresh config
      const updated = await fetch(`${API_BASE}/api/ai/config`).then(r => r.json());
      setConfig(updated);
      setProvider(updated.provider);
      setAnthropicKey('');
      setGeminiKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-lg bg-brand-bg border border-brand-line rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="p-5 border-b border-brand-line flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-brand-accent/20 p-2 rounded-lg">
              <Bot size={18} className="text-brand-accent" />
            </div>
            <div>
              <h2 className="text-sm font-bold uppercase tracking-widest">AI Provider Settings</h2>
              <p className="text-[9px] text-brand-muted mono-text">Configure your AI assistant API keys</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-brand-line rounded-lg transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-brand-muted" />
            </div>
          ) : (
            <>
              {/* Provider Selection */}
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-brand-muted block mb-2">
                  Active Provider
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setProvider('anthropic')}
                    className={cn(
                      "p-3 border rounded-xl text-left transition-all",
                      provider === 'anthropic'
                        ? "border-brand-accent bg-brand-accent/10"
                        : "border-brand-line hover:border-brand-muted"
                    )}
                  >
                    <p className="text-xs font-bold">Anthropic</p>
                    <p className="text-[9px] text-brand-muted mono-text">Claude Sonnet / Opus / Haiku</p>
                    {config?.hasAnthropicKey && (
                      <span className="text-[8px] text-emerald-400 mono-text">KEY SET ({config.anthropicKeyHint})</span>
                    )}
                  </button>
                  <button
                    onClick={() => setProvider('gemini')}
                    className={cn(
                      "p-3 border rounded-xl text-left transition-all",
                      provider === 'gemini'
                        ? "border-brand-accent bg-brand-accent/10"
                        : "border-brand-line hover:border-brand-muted"
                    )}
                  >
                    <p className="text-xs font-bold">Google Gemini</p>
                    <p className="text-[9px] text-brand-muted mono-text">Gemini Flash / Pro</p>
                    {config?.hasGeminiKey && (
                      <span className="text-[8px] text-emerald-400 mono-text">KEY SET ({config.geminiKeyHint})</span>
                    )}
                  </button>
                </div>
              </div>

              {/* Anthropic Key */}
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-brand-muted block mb-1.5">
                  Anthropic API Key {config?.hasAnthropicKey && <span className="text-emerald-400">(configured)</span>}
                </label>
                <div className="relative">
                  <input
                    type={showAnthropicKey ? 'text' : 'password'}
                    value={anthropicKey}
                    onChange={e => setAnthropicKey(e.target.value)}
                    placeholder={config?.hasAnthropicKey ? `Current: ${config.anthropicKeyHint}` : 'sk-ant-...'}
                    className="w-full bg-brand-bg border border-brand-line rounded-lg py-2.5 pl-3 pr-10 text-xs mono-text focus:outline-none focus:border-brand-accent transition-all placeholder:text-brand-muted/50"
                  />
                  <button
                    onClick={() => setShowAnthropicKey(!showAnthropicKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-brand-line rounded transition-colors"
                  >
                    {showAnthropicKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {/* Gemini Key */}
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-brand-muted block mb-1.5">
                  Gemini API Key {config?.hasGeminiKey && <span className="text-emerald-400">(configured)</span>}
                </label>
                <div className="relative">
                  <input
                    type={showGeminiKey ? 'text' : 'password'}
                    value={geminiKey}
                    onChange={e => setGeminiKey(e.target.value)}
                    placeholder={config?.hasGeminiKey ? `Current: ${config.geminiKeyHint}` : 'AIza...'}
                    className="w-full bg-brand-bg border border-brand-line rounded-lg py-2.5 pl-3 pr-10 text-xs mono-text focus:outline-none focus:border-brand-accent transition-all placeholder:text-brand-muted/50"
                  />
                  <button
                    onClick={() => setShowGeminiKey(!showGeminiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-brand-line rounded transition-colors"
                  >
                    {showGeminiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-[10px] text-red-400 font-bold">{error}</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && (
          <div className="p-5 border-t border-brand-line flex items-center justify-between">
            <p className="text-[9px] text-brand-muted mono-text">
              Keys are stored server-side and never sent to the browser.
            </p>
            <button
              onClick={handleSave}
              disabled={saving}
              className={cn(
                "px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all flex items-center gap-2",
                saved
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  : "bg-brand-accent text-black hover:brightness-110"
              )}
            >
              {saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : saved ? (
                <>
                  <Check size={14} /> Saved
                </>
              ) : (
                'Save'
              )}
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
