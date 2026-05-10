import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Download, Copy, Check, FileText } from 'lucide-react';
import { INSTALLATION_GUIDE_DELL_GB10 } from '../constants/installationGuide';
import { downloadFile } from '../lib/exportUtils';

export function RecipeView() {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALLATION_GUIDE_DELL_GB10);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    downloadFile(INSTALLATION_GUIDE_DELL_GB10, 'DELL_GB10_INSTALLATION_RECIPE.md', 'text/markdown');
  };

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-accent/20 flex items-center justify-center border border-brand-accent/40 shadow-glow-sm">
            <FileText size={20} className="text-brand-accent" />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight uppercase italic">Installation Recipe</h2>
            <p className="text-xs text-brand-muted uppercase tracking-widest">Dell GB10 Edge Gateway Configuration</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <button 
            onClick={handleCopy}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-brand-line bg-brand-line/10 hover:bg-brand-line/20 transition-all text-[10px] font-bold uppercase tracking-widest"
          >
            {copied ? <Check size={14} className="text-brand-accent" /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy Source'}
          </button>
          
          <button 
            onClick={handleDownload}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-brand-accent text-black hover:opacity-90 transform active:scale-95 transition-all text-[10px] font-bold uppercase tracking-widest"
          >
            <Download size={14} />
            Download MD
          </button>
        </div>
      </div>

      <div className="flex-1 bg-brand-surface/40 border border-brand-line rounded-2xl overflow-hidden shadow-inner flex flex-col">
        <div className="flex items-center gap-2 px-4 py-2 bg-brand-line/30 border-b border-brand-line">
          <div className="w-2.5 h-2.5 rounded-full bg-brand-error/40" />
          <div className="w-2.5 h-2.5 rounded-full bg-brand-warning/40" />
          <div className="w-2.5 h-2.5 rounded-full bg-brand-accent/40" />
          <span className="ml-2 text-[10px] font-mono text-brand-muted uppercase">recipe_v2.0.md</span>
        </div>

        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-brand-bg/40">
          <div className="max-w-none text-brand-ink space-y-6">
            <ReactMarkdown
              components={{
                h1: ({ children }) => (
                  <h1 className="text-2xl md:text-3xl font-bold uppercase tracking-widest italic mb-6 border-b-2 border-brand-accent/30 pb-4 text-brand-ink">
                    {children}
                  </h1>
                ),
                h2: ({ children }) => (
                  <h2 className="text-lg md:text-xl font-bold uppercase tracking-widest italic mt-8 mb-3 text-brand-accent">
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-sm font-bold uppercase tracking-widest mt-5 mb-2 text-brand-ink">
                    {children}
                  </h3>
                ),
                p: ({ children }) => (
                  <p className="text-sm leading-relaxed text-brand-ink">
                    {children}
                  </p>
                ),
                ul: ({ children }) => (
                  <ul className="list-disc list-inside text-sm space-y-2 text-brand-ink ml-4">
                    {children}
                  </ul>
                ),
                ol: ({ children }) => (
                  <ol className="list-decimal list-inside text-sm space-y-2 text-brand-ink ml-4">
                    {children}
                  </ol>
                ),
                li: ({ children }) => (
                  <li className="text-brand-ink leading-relaxed">{children}</li>
                ),
                a: ({ children, href }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-accent hover:underline break-all"
                  >
                    {children}
                  </a>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="border-l-4 border-brand-accent/50 pl-4 py-1 my-3 bg-brand-surface/40 rounded-r text-brand-ink/90 text-sm">
                    {children}
                  </blockquote>
                ),
                table: ({ children }) => (
                  <div className="overflow-x-auto my-4">
                    <table className="w-full text-xs border-collapse">{children}</table>
                  </div>
                ),
                thead: ({ children }) => (
                  <thead className="bg-brand-line/40 text-brand-ink uppercase tracking-widest text-[10px]">{children}</thead>
                ),
                th: ({ children }) => (
                  <th className="border border-brand-line px-3 py-1.5 text-left font-bold">{children}</th>
                ),
                td: ({ children }) => (
                  <td className="border border-brand-line px-3 py-1.5 text-brand-ink align-top">{children}</td>
                ),
                code: ({ children }) => (
                  <code className="bg-brand-line/50 border border-brand-line px-1.5 py-0.5 rounded text-brand-accent font-mono text-xs">
                    {children}
                  </code>
                ),
                pre: ({ children }) => (
                  <pre className="bg-brand-surface border border-brand-line p-4 rounded-xl overflow-x-auto my-4 font-mono text-xs text-brand-ink">
                    {children}
                  </pre>
                ),
                hr: () => <hr className="border-brand-line my-8" />,
                strong: ({ children }) => (
                  <strong className="text-brand-accent font-bold">
                    {children}
                  </strong>
                ),
                em: ({ children }) => (
                  <em className="text-brand-ink italic">{children}</em>
                ),
              }}
            >
              {INSTALLATION_GUIDE_DELL_GB10}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
