/**
 * v2.1 — MarkdownGuide extracted from SettingsModal.tsx.
 *
 * Generic markdown viewer used by InstallGuideSection (pre-built install
 * doc) and JetsonGuideSection (Jetson Nano deployment doc). Loads the
 * markdown body lazily via a caller-supplied async loader, with Copy +
 * Download buttons. No side-effects on import.
 */
import React from 'react';
import { Check, Copy, Download, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

function MarkdownGuide({
  title,
  description,
  icon,
  loadContent,
  downloadFilename,
  displayFilename,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  loadContent: () => Promise<string>;
  downloadFilename: string;
  displayFilename: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const [content, setContent] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    loadContent().then(c => { if (!cancelled) setContent(c); });
    return () => { cancelled = true; };
  }, [loadContent]);

  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  const handleDownload = () => {
    if (!content) return;
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold tracking-tight uppercase flex items-center gap-2">
            {icon}
            {title}
          </h3>
          <p className="text-xs text-brand-muted leading-snug mt-1">{description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleCopy}
            disabled={!content}
            className="flex items-center gap-2 px-3 py-1.5 rounded border border-brand-line bg-brand-line/10 hover:bg-brand-line/30 text-[10px] font-bold uppercase tracking-widest disabled:opacity-40"
            title="Copy markdown source to clipboard"
          >
            {copied ? <Check size={12} className="text-brand-accent" /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy Source'}
          </button>
          <button
            onClick={handleDownload}
            disabled={!content}
            className="flex items-center gap-2 px-3 py-1.5 rounded bg-brand-accent text-black hover:brightness-110 text-[10px] font-bold uppercase tracking-widest disabled:opacity-40"
            title="Download as .md file"
          >
            <Download size={12} />
            Download MD
          </button>
        </div>
      </div>

      <div className="technical-panel overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-brand-line/30 border-b border-brand-line">
          <div className="w-2 h-2 rounded-full bg-brand-error/40" />
          <div className="w-2 h-2 rounded-full bg-brand-warning/40" />
          <div className="w-2 h-2 rounded-full bg-brand-accent/40" />
          <span className="ml-2 text-[10px] mono-text text-brand-muted uppercase">{displayFilename}</span>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-4 bg-brand-bg/40">
          {!content ? (
            <div className="flex items-center gap-2 text-xs text-brand-muted">
              <Loader2 size={14} className="animate-spin" /> Loading guide…
            </div>
          ) : (
            <pre className="text-[11px] mono-text text-brand-ink whitespace-pre-wrap leading-relaxed">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export default MarkdownGuide;
export { MarkdownGuide };
