import React from 'react';
import { motion } from 'motion/react';
import { X, Copy, Check, Lock, AlertCircle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

import { Node } from '../types';
import { buildSharedContactUrl } from '../lib/sharedContact';

interface ContactQrModalProps {
  node: Node;
  onClose: () => void;
}

export function ContactQrModal({ node, onClose }: ContactQrModalProps) {
  const url = React.useMemo(() => buildSharedContactUrl(node), [node]);
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard not available */ }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-brand-bg/85 backdrop-blur-md p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg border border-emerald-500/30 overflow-hidden flex flex-col"
        style={{ background: '#020617', boxShadow: '0 20px 60px rgba(0,0,0,0.7)' }}
      >
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Lock size={14} className="text-emerald-400" />
            <h3 className="text-sm font-bold tracking-tight uppercase text-white">Share Contact</h3>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 flex flex-col items-center gap-4">
          <div className="text-center">
            <p className="text-sm font-bold text-white">{node.name}</p>
            {node.shortName && (
              <p className="text-[10px] mono-text text-emerald-400 mt-0.5">{node.shortName} · {node.id}</p>
            )}
          </div>

          {url ? (
            <>
              <div className="bg-white p-3 rounded-lg">
                <QRCodeSVG value={url} size={224} level="L" />
              </div>

              <p className="text-[11px] text-slate-400 text-center leading-relaxed">
                Scan with the Meshtastic mobile app to add this contact.<br />
                The QR encodes the node's ID, name, and public key.
              </p>

              <div className="w-full">
                <button
                  onClick={handleCopy}
                  className="w-full flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 hover:text-white text-[10px] font-bold uppercase tracking-widest rounded py-1.5 transition-colors"
                >
                  {copied ? <><Check size={12} className="text-emerald-400" /> Copied</> : <><Copy size={12} /> Copy URL</>}
                </button>
              </div>
            </>
          ) : (
            <div className="w-full bg-amber-500/10 border border-amber-500/30 rounded p-3 flex items-start gap-2">
              <AlertCircle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-[11px] text-amber-300 font-bold uppercase tracking-wide">Public key unknown</p>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  This node hasn't broadcast its public key yet, so we can't build a complete contact card.
                  The key arrives in NodeInfo packets — try again after the node announces (typically every few minutes).
                </p>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
