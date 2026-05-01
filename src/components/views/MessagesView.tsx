import React from 'react';
import { Filter, Signal, Activity, Users, ArrowRight } from 'lucide-react';

import { Node, Message } from '../../types';
import { cn } from '../../lib/utils';
import { ChannelItem } from '../ui/ChannelItem';
import { HopNode } from '../ui/HopNode';

interface MessagesViewProps {
  nodes: Node[];
  messages: Message[];
  filteredMessages: Message[];
  activeChatId: string;
  setActiveChatId: (id: string) => void;
  activeChatPartner: Node | undefined;
  traceMessageId: string | null;
  setTraceMessageId: (id: string | null) => void;
  setActiveTab: (tab: 'map') => void;
  draftMessage: string;
  setDraftMessage: (msg: string) => void;
  handleSendMessage: () => void;
}

export function MessagesView({
  nodes,
  messages,
  filteredMessages,
  activeChatId,
  setActiveChatId,
  activeChatPartner,
  traceMessageId,
  setTraceMessageId,
  setActiveTab,
  draftMessage,
  setDraftMessage,
  handleSendMessage,
}: MessagesViewProps) {
  return (
    <>
       {/* Chat List */}
          <div className="md:col-span-4 technical-panel flex flex-col h-full bg-brand-bg/50">
          <div className="p-4 border-b border-brand-line flex items-center justify-between">
            <h3 className="font-bold text-xs uppercase tracking-widest">Active Channels</h3>
            <button className="p-1 hover:bg-brand-line rounded transition-colors"><Filter size={14}/></button>
          </div>
          <div className="flex-1 overflow-y-auto">
             {/* Hardcoded system channels */}
             <ChannelItem 
               name="LongFast" 
               active={activeChatId === 'global'} 
               onClick={() => setActiveChatId('global')}
               count={messages.filter(m => m.channel === 'LongFast').length} 
               lastMsg="Global mesh traffic"
             />
             
             <div className="p-2">
               <p className="text-[10px] text-brand-muted px-2 py-1 uppercase font-bold tracking-widest">Direct Messages</p>
               {nodes.filter(n => n.online && n.id !== '!abcdef01').map(n => (
                 <ChannelItem 
                   key={n.id} 
                   name={n.name} 
                   isDM={true} 
                   active={activeChatId === n.id}
                   onClick={() => setActiveChatId(n.id)}
                   lastMsg={messages.find(m => m.from === n.id || m.to === n.id)?.text || "No messages"} 
                 />
               ))}
             </div>
          </div>
       </div>

       {/* Message View + Trace */}
       <div className="md:col-span-8 flex flex-col gap-6 h-full overflow-hidden">
          <div className="technical-panel flex-[2] flex flex-col bg-brand-bg/30">
             <div className="p-4 border-b border-brand-line flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-brand-line flex items-center justify-center font-bold">
                    {activeChatId === 'global' ? '#' : '@'}
                  </div>
                  <div>
                     <h3 className="text-sm font-bold uppercase tracking-tight">
                       {activeChatId === 'global' ? 'LongFast (Global)' : activeChatPartner?.name || 'Private Chat'}
                     </h3>
                     <p className="text-[10px] text-brand-accent mono-text uppercase">
                       {activeChatId === 'global' ? 'Broadcast Mode' : 'Direct Link: Secure'}
                     </p>
                  </div>
                </div>
             </div>
             <div className="flex-1 p-4 overflow-y-auto space-y-4">
                {filteredMessages.length > 0 ? filteredMessages.map((m) => (
                  <div key={m.id} className={cn("flex flex-col gap-1", m.from === '!abcdef01' ? "items-end" : "items-start")}>
                     <div className="flex items-center gap-2 px-2">
                        <span className="text-[10px] font-bold uppercase tracking-tighter opacity-50">
                          {nodes.find(n => n.id === m.from)?.name || m.from}
                        </span>
                        <span className="text-[9px] mono-text opacity-30">{new Date(m.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <div className={cn(
                        "px-3 py-2 rounded-lg max-w-[80%] text-sm",
                        m.from === '!abcdef01' ? "bg-brand-accent text-black rounded-tr-none" : "bg-brand-line text-brand-ink rounded-tl-none border border-brand-line"
                      )}>
                        {m.text}
                      </div>
                      {m.hops && m.hops.length > 0 && (
                        <button 
                          onClick={() => {
                            setTraceMessageId(m.id);
                            setActiveTab('map');
                          }}
                          className={cn(
                            "px-2 flex items-center gap-1 transition-all rounded hover:bg-brand-accent/10 group",
                            traceMessageId === m.id ? "opacity-100 text-brand-accent scale-105" : "opacity-50 hover:opacity-100"
                          )}
                        >
                          <Signal size={10} className={cn(traceMessageId === m.id ? "animate-pulse" : "")}/>
                          <span className="text-[8px] mono-text uppercase">
                            {traceMessageId === m.id ? "Tracing Path..." : `Hops: ${m.hops.length}`}
                          </span>
                        </button>
                      )}
                  </div>
                )) : (
                  <div className="h-full flex items-center justify-center opacity-30 italic text-sm">No communication history found</div>
                )}
             </div>
             <div className="p-4 border-t border-brand-line">
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    value={draftMessage}
                    onChange={(e) => setDraftMessage(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                    placeholder={`Message ${activeChatId === 'global' ? 'the network' : activeChatPartner?.name}...`} 
                    className="flex-1 bg-brand-line border border-brand-line rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-brand-accent"
                  />
                  <button 
                    onClick={handleSendMessage}
                    className="bg-brand-accent text-black px-4 py-2 rounded-lg font-bold text-sm hover:brightness-110 transition-all"
                  >
                    SEND
                  </button>
                </div>
             </div>
          </div>

          {/* Message Routing Visualizer */}
          <div className="technical-panel flex-1 p-4">
              <h4 className="text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-4 flex items-center gap-2">
                <Activity size={12}/> Route Visualization ({activeChatId === 'global' ? 'Broadcast' : 'Path to Peer'})
              </h4>
              <div className="flex items-center justify-between px-8 relative">
                 {/* Progress Line */}
                 <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-brand-line/50 -translate-y-1/2 z-0 mx-12" />
                 
                 <HopNode id="H-BASE" name="Home" active />
                 <ArrowRight className="text-brand-muted" size={16} />
                 
                 {activeChatId !== 'global' ? (
                   <>
                     <HopNode id="RELAY-1" name="Router" active={true} />
                     <ArrowRight className="text-brand-muted" size={16} />
                     <HopNode id={activeChatId.slice(1, 6)} name={activeChatPartner?.name || 'Peer'} active={true} />
                   </>
                 ) : (
                   <>
                     <div className="flex flex-col items-center opacity-30">
                       <Users size={20} />
                       <span className="text-[8px] mono-text mt-1 text-center">ALL PEERS</span>
                     </div>
                     <ArrowRight className="text-brand-muted" size={16} />
                     <div className="flex flex-col items-center opacity-30">
                       <Signal size={20} />
                       <span className="text-[8px] mono-text mt-1 text-center">AIRWAVES</span>
                     </div>
                   </>
                 )}
              </div>
          </div>
       </div>
    </>
  );
}
