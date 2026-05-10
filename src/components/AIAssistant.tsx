import React from 'react';
import { Bot, Send, User, X, Sparkles, Loader2, Minimize2, Maximize2 } from 'lucide-react';
import { geminiService } from '../services/geminiService';
import { Node, Message, RadioEvent } from '../types';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface AIAssistantProps {
  nodes: Node[];
  messages: Message[];
  events: RadioEvent[];
}

export function AIAssistant({ nodes, messages, events }: AIAssistantProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [isMinimized, setIsMinimized] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [chatHistory, setChatHistory] = React.useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [redactPii, setRedactPii] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const API_BASE = import.meta.env.VITE_API_URL || '';

  // Read the operator's redaction preference from the AI config when the
  // assistant first opens. We deliberately re-fetch on each open (cheap, and
  // means a Settings change is picked up without a hard reload).
  React.useEffect(() => {
    if (!isOpen) return;
    fetch(`${API_BASE}/api/ai/config`)
      .then(r => r.ok ? r.json() : null)
      .then(cfg => { if (cfg && typeof cfg.redactPii === 'boolean') setRedactPii(cfg.redactPii); })
      .catch(() => { /* fall back to non-redacted */ });
  }, [isOpen, API_BASE]);

  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatHistory, isMinimized]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      role: 'user',
      content: input,
      timestamp: Date.now()
    };

    setChatHistory(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await geminiService.askAssistant(input, { nodes, messages, events }, { redactPii });
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response || "I'm sorry, I couldn't process that request.",
        timestamp: Date.now()
      };
      setChatHistory(prev => [...prev, assistantMsg]);
    } catch (error) {
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: "Error: Failed to connect to the network intelligence. Please check your API configuration.",
        timestamp: Date.now()
      };
      setChatHistory(prev => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) {
    return (
      <button 
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-[100] bg-brand-accent text-black p-4 rounded-full shadow-lg hover:scale-110 transition-all status-glow-green group"
      >
        <Bot size={24} className="group-hover:rotate-12 transition-transform" />
        <div className="absolute -top-1 -right-1">
          <Sparkles size={14} className="text-brand-ink animate-pulse" />
        </div>
      </button>
    );
  }

  return (
    <div className={cn(
      "fixed z-[100] transition-all duration-300 flex flex-col",
      isMinimized 
        ? "bottom-6 right-6 w-72 h-14" 
        : "bottom-6 right-6 w-96 h-[500px]",
      "bg-brand-bg/95 backdrop-blur-xl border border-brand-line rounded-2xl shadow-2xl overflow-hidden"
    )}>
      {/* Header */}
      <div className="p-4 border-b border-brand-line flex items-center justify-between bg-brand-line/10">
        <div className="flex items-center gap-2">
          <div className="bg-brand-accent/20 p-1.5 rounded-lg">
            <Bot size={18} className="text-brand-accent" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-bold uppercase tracking-widest leading-none">Net-AI Assistant</h3>
              {redactPii && (
                <span
                  className="text-[8px] mono-text uppercase font-bold tracking-widest text-brand-warning bg-brand-warning/15 border border-brand-warning/40 rounded px-1 py-0.5"
                  title="PII redaction is on — only aggregate counts are sent to the AI provider. Toggle in Settings → AI."
                >
                  Redacted
                </span>
              )}
            </div>
            {!isMinimized && <span className="text-[9px] text-brand-accent animate-pulse">SYSTEM ONLINE</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button 
            onClick={() => setIsMinimized(!isMinimized)}
            className="p-1 hover:bg-brand-line rounded-md transition-colors"
          >
            {isMinimized ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
          </button>
          <button 
            onClick={() => setIsOpen(false)}
            className="p-1 hover:bg-brand-line rounded-md transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <>
          {/* Chat Body */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {chatHistory.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-4 opacity-50">
                <Bot size={48} className="text-brand-muted" />
                <div className="space-y-1">
                  <p className="text-sm font-bold uppercase tracking-widest">Network Intelligence</p>
                  <p className="text-[10px] leading-relaxed">
                    I can analyze mesh topology, summarize message traffic, and help troubleshoot node connectivity.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-2 w-full mt-4">
                  {[
                    "How many nodes are online?",
                    "Analyze recent network events.",
                    "Summarize the general chat."
                  ].map(q => (
                    <button 
                      key={q}
                      onClick={() => setInput(q)}
                      className="text-[9px] p-2 border border-brand-line rounded hover:border-brand-accent transition-all text-left"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            
            {chatHistory.map((msg, i) => (
              <div key={i} className={cn(
                "flex gap-3",
                msg.role === 'user' ? "flex-row-reverse" : "flex-row"
              )}>
                <div className={cn(
                  "p-2 rounded-lg shrink-0",
                  msg.role === 'user' ? "bg-brand-line text-brand-ink" : "bg-brand-accent/10 border border-brand-accent/20 text-brand-accent"
                )}>
                  {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
                </div>
                <div className={cn(
                  "max-w-[75%] p-3 rounded-2xl text-xs leading-relaxed",
                  msg.role === 'user' ? "bg-brand-line/30 rounded-tr-none" : "bg-brand-line/10 border border-brand-line/50 rounded-tl-none"
                )}>
                  {msg.content}
                </div>
              </div>
            ))}
            
            {isLoading && (
              <div className="flex gap-3">
                <div className="bg-brand-accent/10 border border-brand-accent/20 text-brand-accent p-2 rounded-lg shrink-0 h-fit">
                  <Loader2 size={14} className="animate-spin" />
                </div>
                <div className="bg-brand-line/10 border border-brand-line/50 p-3 rounded-2xl rounded-tl-none text-[10px] italic text-brand-muted">
                  Analyzing mesh telemetry data...
                </div>
              </div>
            )}
          </div>

          {/* Input Area */}
          <div className="p-4 border-t border-brand-line bg-brand-line/5">
            <div className="relative group">
              <input 
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyPress={e => e.key === 'Enter' && handleSend()}
                placeholder="Ask network intelligence..."
                className="w-full bg-brand-bg border border-brand-line rounded-xl py-3 pl-4 pr-12 text-xs focus:outline-none focus:border-brand-accent transition-all placeholder:text-brand-muted"
              />
              <button 
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-brand-accent text-black rounded-lg disabled:opacity-30 transition-all hover:brightness-110"
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
