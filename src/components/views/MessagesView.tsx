import React from 'react';
import { Filter, Signal, Activity, Users, ArrowRight, Settings, Clock, Check, CheckCheck, AlertCircle, RotateCcw, Wifi, WifiOff } from 'lucide-react';

import { Node, Message, Channel } from '../../types';
import { cn } from '../../lib/utils';
import { ChannelItem } from '../ui/ChannelItem';
import { HopNode } from '../ui/HopNode';

interface MessagesViewProps {
  nodes: Node[];
  messages: Message[];
  channels: Channel[];
  filteredMessages: Message[];
  activeChatId: string;
  setActiveChatId: (id: string) => void;
  activeChatPartner: Node | undefined;
  activeChannel: Channel | undefined;
  traceMessageId: string | null;
  setTraceMessageId: (id: string | null) => void;
  setActiveTab: (tab: 'map') => void;
  draftMessage: string;
  setDraftMessage: (msg: string) => void;
  handleSendMessage: (overrideText?: string) => void;
  onManageChannels: () => void;
}

function channelLabel(c: Channel): string {
  if (c.name) return c.name;
  return c.role === 'PRIMARY' ? 'LongFast' : `Channel ${c.index}`;
}

function lastSeenLabel(lastSeen: number): string {
  const seconds = Math.floor((Date.now() - lastSeen) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function MessageStatusIcon({ status, errorCode, onRetry }: {
  status?: Message['status'];
  errorCode?: number;
  onRetry?: () => void;
}) {
  if (!status || status === 'acked') {
    return status === 'acked'
      ? <span title="Delivered"><CheckCheck size={11} className="text-brand-accent" /></span>
      : null;
  }
  if (status === 'sending') {
    return <span title="Sending…"><Clock size={11} className="text-brand-muted animate-pulse" /></span>;
  }
  if (status === 'sent') {
    return <span title="Sent to radio"><Check size={11} className="text-brand-muted" /></span>;
  }
  if (status === 'error') {
    const label = errorCode === -1 ? 'Timeout — no ACK received'
      : errorCode === -2 ? 'Radio write failed'
      : `Routing error ${errorCode}`;
    return (
      <span className="flex items-center gap-1">
        <span title={label}><AlertCircle size={11} className="text-red-400" /></span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center gap-0.5 text-[9px] text-red-400 hover:text-red-300 mono-text uppercase transition-colors"
            title="Retry"
          >
            <RotateCcw size={9} />
            RETRY
          </button>
        )}
      </span>
    );
  }
  return null;
}

export function MessagesView({
  nodes,
  messages,
  channels,
  filteredMessages,
  activeChatId,
  setActiveChatId,
  activeChatPartner,
  activeChannel,
  traceMessageId,
  setTraceMessageId,
  setActiveTab,
  draftMessage,
  setDraftMessage,
  handleSendMessage,
  onManageChannels,
}: MessagesViewProps) {
  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filteredMessages.length]);

  const visibleChannels = channels
    .filter(c => c.role !== 'DISABLED')
    .sort((a, b) => a.index - b.index);

  const channelEntries = visibleChannels.length > 0
    ? visibleChannels
    : [{ index: 0, name: '', role: 'PRIMARY', pskBase64: '', uplinkEnabled: true, downlinkEnabled: true } as Channel];

  const partnerOnline = activeChatPartner?.online ?? false;
  const partnerLastSeen = activeChatPartner?.lastSeen;

  return (
    <>
      {/* Chat List */}
      <div className="md:col-span-4 technical-panel flex flex-col h-full bg-brand-bg/50">
        <div className="p-4 border-b border-brand-line flex items-center justify-between">
          <h3 className="font-bold text-xs uppercase tracking-widest">Active Channels</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={onManageChannels}
              className="p-1 hover:bg-brand-line rounded transition-colors"
              title="Manage channels"
            >
              <Settings size={14} />
            </button>
            <button className="p-1 hover:bg-brand-line rounded transition-colors" title="Filter">
              <Filter size={14} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {channelEntries.map(c => {
            const id = `chan:${c.index}`;
            const label = channelLabel(c);
            return (
              <ChannelItem
                key={id}
                name={label}
                active={activeChatId === id}
                onClick={() => setActiveChatId(id)}
                count={messages.filter(m => m.channel === label || (c.role === 'PRIMARY' && m.channel === 'LongFast')).length}
                lastMsg={c.role === 'PRIMARY' ? 'Primary mesh traffic' : `Secondary · slot ${c.index}`}
              />
            );
          })}

          <div className="p-2">
            <p className="text-[10px] text-brand-muted px-2 py-1 uppercase font-bold tracking-widest">Direct Messages</p>
            {nodes.filter(n => n.online && n.id !== '!abcdef01').map(n => (
              <ChannelItem
                key={n.id}
                name={n.name}
                isDM={true}
                active={activeChatId === n.id}
                onClick={() => setActiveChatId(n.id)}
                lastMsg={messages.find(m => m.from === n.id || m.to === n.id)?.text || 'No messages'}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Message View + Trace */}
      <div className="md:col-span-8 flex flex-col gap-6 h-full overflow-hidden">
        <div className="technical-panel flex-[2] flex flex-col bg-brand-bg/30">
          {/* Chat header with connection status */}
          <div className="p-4 border-b border-brand-line flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded bg-brand-line flex items-center justify-center font-bold">
                {activeChannel ? '#' : '@'}
              </div>
              <div>
                <h3 className="text-sm font-bold uppercase tracking-tight">
                  {activeChannel
                    ? `${channelLabel(activeChannel)} (CH ${activeChannel.index})`
                    : activeChatPartner?.name || 'Private Chat'}
                </h3>
                <p className="text-[10px] text-brand-accent mono-text uppercase">
                  {activeChannel
                    ? (activeChannel.role === 'PRIMARY' ? 'Broadcast Mode' : 'Secondary Channel')
                    : 'Direct Link: Secure'}
                </p>
              </div>
            </div>
            {/* Connection / last-seen indicator */}
            {activeChatPartner && (
              <div className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded text-[10px] mono-text uppercase font-bold',
                partnerOnline
                  ? 'text-brand-accent bg-brand-accent/10'
                  : 'text-brand-muted bg-brand-line/50'
              )}>
                {partnerOnline
                  ? <Wifi size={11} className="text-brand-accent" />
                  : <WifiOff size={11} />}
                {partnerOnline
                  ? 'Online'
                  : partnerLastSeen ? `Last seen ${lastSeenLabel(partnerLastSeen)}` : 'Offline'}
              </div>
            )}
            {activeChannel && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] mono-text uppercase font-bold text-brand-accent bg-brand-accent/10">
                <Signal size={11} className="animate-pulse" />
                Broadcast
              </div>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 p-4 overflow-y-auto space-y-4">
            {filteredMessages.length > 0 ? filteredMessages.map((m) => {
              const isOwn = m.isOwn === true || m.status === 'sending' || m.status === 'sent';
              const senderName = nodes.find(n => n.id === m.from)?.name || m.from;
              return (
                <div key={m.id} className={cn('flex flex-col gap-1', isOwn ? 'items-end' : 'items-start')}>
                  <div className="flex items-center gap-2 px-2">
                    <span className="text-[10px] font-bold uppercase tracking-tighter opacity-50">
                      {isOwn ? 'You' : senderName}
                    </span>
                    <span className="text-[9px] mono-text opacity-30">{new Date(m.timestamp).toLocaleTimeString()}</span>
                  </div>

                  <div className={cn(
                    'px-3 py-2 rounded-lg max-w-[80%] text-sm',
                    isOwn
                      ? 'bg-brand-accent text-black rounded-tr-none'
                      : 'bg-brand-line text-brand-ink rounded-tl-none border border-brand-line',
                    m.status === 'error' && 'opacity-70'
                  )}>
                    {m.text}
                  </div>

                  {/* Status row — only for own messages */}
                  {isOwn && (
                    <div className="flex items-center gap-1.5 px-2">
                      <MessageStatusIcon
                        status={m.status}
                        errorCode={m.errorCode}
                        onRetry={m.status === 'error' ? () => handleSendMessage(m.text) : undefined}
                      />
                      {m.status !== 'error' && m.status !== 'sending' && m.hops && m.hops.length > 0 && (
                        <button
                          onClick={() => { setTraceMessageId(m.id); setActiveTab('map'); }}
                          className={cn(
                            'flex items-center gap-1 transition-all rounded hover:bg-brand-accent/10 group',
                            traceMessageId === m.id ? 'opacity-100 text-brand-accent scale-105' : 'opacity-50 hover:opacity-100'
                          )}
                        >
                          <Signal size={10} className={cn(traceMessageId === m.id ? 'animate-pulse' : '')} />
                          <span className="text-[8px] mono-text uppercase">
                            {traceMessageId === m.id ? 'Tracing…' : `Hops: ${m.hops.length}`}
                          </span>
                        </button>
                      )}
                    </div>
                  )}

                  {/* Hop trace button for received messages */}
                  {!isOwn && m.hops && m.hops.length > 0 && (
                    <button
                      onClick={() => { setTraceMessageId(m.id); setActiveTab('map'); }}
                      className={cn(
                        'px-2 flex items-center gap-1 transition-all rounded hover:bg-brand-accent/10',
                        traceMessageId === m.id ? 'opacity-100 text-brand-accent scale-105' : 'opacity-50 hover:opacity-100'
                      )}
                    >
                      <Signal size={10} className={cn(traceMessageId === m.id ? 'animate-pulse' : '')} />
                      <span className="text-[8px] mono-text uppercase">
                        {traceMessageId === m.id ? 'Tracing Path…' : `Hops: ${m.hops.length}`}
                      </span>
                    </button>
                  )}
                </div>
              );
            }) : (
              <div className="h-full flex items-center justify-center opacity-30 italic text-sm">
                No communication history found
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-4 border-t border-brand-line">
            <div className="flex gap-2">
              <input
                type="text"
                value={draftMessage}
                onChange={(e) => setDraftMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                placeholder={`Message ${activeChannel ? channelLabel(activeChannel) : activeChatPartner?.name || 'the network'}…`}
                className="flex-1 bg-brand-line border border-brand-line rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-brand-accent"
              />
              <button
                onClick={() => handleSendMessage()}
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
            <Activity size={12} /> Route Visualization ({activeChannel ? 'Broadcast' : 'Path to Peer'})
          </h4>
          <div className="flex items-center justify-between px-8 relative">
            <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-brand-line/50 -translate-y-1/2 z-0 mx-12" />
            <HopNode id="H-BASE" name="Home" active />
            <ArrowRight className="text-brand-muted" size={16} />
            {!activeChannel ? (
              <>
                <HopNode id="RELAY-1" name="Router" active={true} />
                <ArrowRight className="text-brand-muted" size={16} />
                <HopNode id={activeChatId.slice(1, 6)} name={activeChatPartner?.name || 'Peer'} active={partnerOnline} />
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
