import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, UserCheck, MessageSquare } from 'lucide-react';

interface IncomingContact {
  type: 'contact';
  nodeId: string;
  nodeNum: number;
  longName: string;
  shortName: string;
  publicKey?: string;
}

interface Props {
  contact: IncomingContact | null;
  /** Whether we already know this node from the mesh (e.g. it announced via NodeInfo). */
  alreadyKnown: boolean;
  onDismiss: () => void;
  onOpenChat: (nodeId: string) => void;
}

export function IncomingContactToast({ contact, alreadyKnown, onDismiss, onOpenChat }: Props) {
  return (
    <AnimatePresence>
      {contact && (
        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[300] w-[min(420px,calc(100vw-2rem))]"
        >
          <div
            className="rounded-lg border border-emerald-500/40 p-4 shadow-2xl"
            style={{ background: '#020617', boxShadow: '0 12px 40px rgba(0,0,0,0.6)' }}
          >
            <div className="flex items-start gap-3">
              <div className="bg-emerald-500/15 border border-emerald-500/30 rounded-lg p-2 flex-shrink-0">
                <UserCheck size={16} className="text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold uppercase tracking-widest text-white">Contact Shared</p>
                <p className="text-[11px] text-slate-300 mt-1">
                  <span className="font-bold">{contact.longName || contact.nodeId}</span>
                  {contact.shortName && (
                    <span className="text-emerald-400 mono-text"> · {contact.shortName}</span>
                  )}
                </p>
                <p className="text-[10px] mono-text text-slate-400 mt-0.5">{contact.nodeId}</p>
                <div className="flex items-center gap-2 mt-2">
                  <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded ${
                    contact.publicKey
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      : 'bg-slate-800 text-slate-400 border border-slate-700'
                  }`}>
                    {contact.publicKey ? 'PKC key included' : 'No key'}
                  </span>
                  <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded ${
                    alreadyKnown
                      ? 'bg-slate-800 text-slate-400 border border-slate-700'
                      : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  }`}>
                    {alreadyKnown ? 'Already on mesh' : 'Not yet seen'}
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                  {alreadyKnown
                    ? 'This node is already in your mesh — open a DM to start chatting.'
                    : 'You\'ll be able to message this node once it announces itself on the mesh.'}
                </p>
                <div className="flex items-center gap-2 mt-3">
                  {alreadyKnown && (
                    <button
                      onClick={() => { onOpenChat(contact.nodeId); onDismiss(); }}
                      className="flex items-center gap-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 hover:text-emerald-200 text-[10px] font-bold uppercase tracking-widest rounded px-2.5 py-1 transition-colors"
                    >
                      <MessageSquare size={10} />
                      Open DM
                    </button>
                  )}
                  <button
                    onClick={onDismiss}
                    className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white px-2.5 py-1"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <button
                onClick={onDismiss}
                className="text-slate-400 hover:text-white flex-shrink-0"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
