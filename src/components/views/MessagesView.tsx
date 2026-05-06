import React from 'react';
import { Filter, Signal, Activity, Users, ArrowRight, Settings, Clock, Check, CheckCheck, AlertCircle, RotateCcw, Wifi, WifiOff, CornerDownRight, Smile, X, Search } from 'lucide-react';
import EmojiPicker, { Theme, EmojiStyle } from 'emoji-picker-react';

import { Node, Message, Channel } from '../../types';
import { cn } from '../../lib/utils';
import { ChannelItem } from '../ui/ChannelItem';
import { HopNode } from '../ui/HopNode';
import { useReadStatus } from '../../hooks/useReadStatus';
import { meshDataService } from '../../services/meshDataService';
import { parseMentions } from '../../lib/mentions';

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
  handleSendMessage: (overrideText?: string, opts?: { replyTo?: number; isReaction?: boolean }) => void;
  onManageChannels: () => void;
  localNodeId: string | null;
  blockedNodeIds: Set<string>;
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
  localNodeId,
  blockedNodeIds,
}: MessagesViewProps) {
  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filteredMessages.length]);

  const { unreadCounts } = useReadStatus({
    messages,
    channels,
    localNodeId,
    activeChatId,
    markActiveAsRead: true, // mounted = user is on the messages tab
  });

  const [replyingTo, setReplyingTo] = React.useState<Message | null>(null);
  const [reactPickerForId, setReactPickerForId] = React.useState<string | null>(null);

  // Reset reply state when the user switches chats
  React.useEffect(() => { setReplyingTo(null); }, [activeChatId]);

  // Group reactions by parent packetId → emoji → count
  const reactionsByParent = React.useMemo(() => {
    const map = new Map<number, Map<string, { count: number; selfReacted: boolean }>>();
    for (const m of filteredMessages) {
      if (!m.isReaction || !m.replyTo) continue;
      const emoji = m.text;
      let inner = map.get(m.replyTo);
      if (!inner) { inner = new Map(); map.set(m.replyTo, inner); }
      const cur = inner.get(emoji) || { count: 0, selfReacted: false };
      cur.count++;
      if (m.isOwn) cur.selfReacted = true;
      inner.set(emoji, cur);
    }
    return map;
  }, [filteredMessages]);

  const messageByPacketId = React.useMemo(() => {
    const map = new Map<number, Message>();
    for (const m of filteredMessages) {
      if (typeof m.packetId === 'number') map.set(m.packetId, m);
    }
    return map;
  }, [filteredMessages]);

  const handleReact = (parent: Message, emoji: string) => {
    if (typeof parent.packetId !== 'number') return;
    handleSendMessage(emoji, { replyTo: parent.packetId, isReaction: true });
    setReactPickerForId(null);
  };

  // ---- Search state (server-side FTS5) ----
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<Message[]>([]);
  const [searchLoading, setSearchLoading] = React.useState(false);
  const searchSeqRef = React.useRef(0);

  React.useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const seq = ++searchSeqRef.current;
    const handle = setTimeout(async () => {
      const results = await meshDataService.searchMessages(q, 30);
      // Drop stale responses
      if (seq !== searchSeqRef.current) return;
      setSearchResults(results);
      setSearchLoading(false);
    }, 250);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  /** Jump to the chat containing a search-result message and clear the search. */
  const jumpToResult = (m: Message) => {
    let target: string | null = null;
    if (localNodeId && m.to === localNodeId && m.to !== '!ffffffff') {
      target = m.from;
    } else if (m.isOwn && m.to !== '!ffffffff') {
      target = m.to;
    } else {
      const ch = channels.find(c =>
        c.name === m.channel ||
        (c.role === 'PRIMARY' && (m.channel === 'LongFast' || m.channel === 'Broadcast' || m.channel === ''))
      );
      if (ch) target = `chan:${ch.index}`;
      else target = 'chan:0';
    }
    if (target) setActiveChatId(target);
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleSendWithReply = () => {
    if (replyingTo && typeof replyingTo.packetId === 'number') {
      handleSendMessage(undefined, { replyTo: replyingTo.packetId });
    } else {
      handleSendMessage();
    }
    setReplyingTo(null);
  };

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

        {/* Search */}
        <div className="px-3 pt-2 pb-1 border-b border-brand-line/50 relative">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search messages…"
              className="w-full bg-brand-line/50 border border-transparent rounded pl-7 pr-7 py-1.5 text-xs focus:outline-none focus:border-brand-accent/40 placeholder:text-brand-muted"
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); setSearchResults([]); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-brand-muted hover:text-white"
                title="Clear"
              >
                <X size={11} />
              </button>
            )}
          </div>
          {searchQuery.trim().length >= 2 && (
            <div className="absolute left-3 right-3 top-full mt-1 z-30 bg-brand-bg border border-brand-line rounded-lg shadow-xl max-h-80 overflow-y-auto">
              {searchLoading && (
                <p className="px-3 py-2 text-[10px] text-brand-muted italic">Searching…</p>
              )}
              {!searchLoading && searchResults.length === 0 && (
                <p className="px-3 py-2 text-[10px] text-brand-muted italic">No matches</p>
              )}
              {searchResults.map(r => {
                const sender = nodes.find(n => n.id === r.from);
                return (
                  <button
                    key={r.id}
                    onClick={() => jumpToResult(r)}
                    className="w-full text-left px-3 py-2 hover:bg-brand-line/30 border-b border-brand-line/40 last:border-b-0 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] font-bold uppercase tracking-tight text-brand-accent">
                        {r.isOwn ? 'You' : (sender?.name || r.from)}
                      </span>
                      <span className="text-[9px] mono-text text-brand-muted">
                        {new Date(r.timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-[11px] text-brand-ink/90 line-clamp-2 break-words">
                      {r.text}
                    </p>
                    <p className="text-[9px] mono-text text-brand-muted opacity-60 mt-0.5">
                      in {r.channel || 'DM'}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
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
                count={unreadCounts[id]}
                lastMsg={c.role === 'PRIMARY' ? 'Primary mesh traffic' : `Secondary · slot ${c.index}`}
              />
            );
          })}

          <div className="p-2">
            <p className="text-[10px] text-brand-muted px-2 py-1 uppercase font-bold tracking-widest">Direct Messages</p>
            {nodes.filter(n => n.online && n.id !== '!abcdef01' && !blockedNodeIds.has(n.id)).map(n => (
              <ChannelItem
                key={n.id}
                name={n.name}
                isDM={true}
                isPkc={!!n.publicKey}
                active={activeChatId === n.id}
                count={unreadCounts[n.id]}
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
                {activeChannel
                  ? '#'
                  : activeChatPartner?.shortName
                    ? <span className="text-[10px] mono-text text-brand-accent">{activeChatPartner.shortName}</span>
                    : '@'}
              </div>
              <div>
                <h3 className="text-sm font-bold uppercase tracking-tight flex items-center gap-2">
                  {activeChannel
                    ? `${channelLabel(activeChannel)} (CH ${activeChannel.index})`
                    : <>
                        <span>{activeChatPartner?.name || 'Private Chat'}</span>
                        {activeChatPartner?.id && (
                          <span className="text-[9px] mono-text text-brand-muted normal-case font-normal">
                            {activeChatPartner.id}
                          </span>
                        )}
                      </>}
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
              // Reactions don't render as standalone messages — they appear as
              // chips under the parent message they're reacting to.
              if (m.isReaction) return null;

              const isOwn = m.isOwn === true || m.status === 'sending' || m.status === 'sent';
              const senderName = nodes.find(n => n.id === m.from)?.name || m.from;
              const parentMsg = m.replyTo ? messageByPacketId.get(m.replyTo) : undefined;
              const reactions = m.packetId ? reactionsByParent.get(m.packetId) : undefined;
              const canReplyOrReact = typeof m.packetId === 'number' && !m.isReaction;

              return (
                <div key={m.id} className={cn('flex flex-col gap-1 group/msg', isOwn ? 'items-end' : 'items-start')}>
                  <div className="flex items-center gap-2 px-2">
                    <span className="text-[10px] font-bold uppercase tracking-tighter opacity-50">
                      {isOwn ? 'You' : senderName}
                    </span>
                    <span className="text-[9px] mono-text opacity-30">{new Date(m.timestamp).toLocaleTimeString()}</span>
                  </div>

                  {/* Reply indicator — shown above the bubble if this message is a reply */}
                  {parentMsg && (
                    <div className={cn(
                      'flex items-center gap-1.5 max-w-[80%] px-2 py-1 rounded text-[10px] border-l-2',
                      'bg-brand-line/30 border-brand-accent/50 text-brand-muted'
                    )}>
                      <CornerDownRight size={10} className="text-brand-accent shrink-0" />
                      <span className="truncate">
                        <span className="font-bold opacity-70">{parentMsg.isOwn ? 'You' : (nodes.find(n => n.id === parentMsg.from)?.name || parentMsg.from)}: </span>
                        <span className="opacity-60">{parentMsg.text.length > 60 ? parentMsg.text.slice(0, 60) + '…' : parentMsg.text}</span>
                      </span>
                    </div>
                  )}

                  <div className="relative">
                    <div className={cn(
                      'px-3 py-2 rounded-lg max-w-[80%] text-sm',
                      isOwn
                        ? 'bg-brand-accent text-black rounded-tr-none'
                        : 'bg-brand-line text-brand-ink rounded-tl-none border border-brand-line',
                      m.status === 'error' && 'opacity-70'
                    )}>
                      {parseMentions(m.text, nodes).map((seg, i) => (
                        seg.type === 'mention' ? (
                          <button
                            key={i}
                            onClick={() => seg.node && setActiveChatId(seg.node.id)}
                            className={cn(
                              'font-bold rounded px-1 transition-colors',
                              isOwn
                                ? 'bg-black/20 hover:bg-black/30 text-black'
                                : 'bg-brand-accent/20 hover:bg-brand-accent/30 text-brand-accent'
                            )}
                          >
                            {seg.text}
                          </button>
                        ) : (
                          <React.Fragment key={i}>{seg.text}</React.Fragment>
                        )
                      ))}
                    </div>

                    {/* Hover actions: Reply / React (only when we have a packetId to reference) */}
                    {canReplyOrReact && (
                      <div className={cn(
                        'absolute top-0 -translate-y-1/2 flex gap-1 opacity-0 group-hover/msg:opacity-100 transition-opacity',
                        isOwn ? 'right-full mr-1' : 'left-full ml-1'
                      )}>
                        <button
                          onClick={() => setReplyingTo(m)}
                          title="Reply"
                          className="p-1 rounded bg-brand-bg border border-brand-line hover:border-brand-accent/50 text-brand-muted hover:text-brand-accent transition-colors"
                        >
                          <CornerDownRight size={11} />
                        </button>
                        <button
                          onClick={() => setReactPickerForId(prev => prev === m.id ? null : m.id)}
                          title="React"
                          className="p-1 rounded bg-brand-bg border border-brand-line hover:border-brand-accent/50 text-brand-muted hover:text-brand-accent transition-colors"
                        >
                          <Smile size={11} />
                        </button>
                      </div>
                    )}

                    {/* Emoji picker (popover) */}
                    {reactPickerForId === m.id && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setReactPickerForId(null)} />
                        <div className={cn(
                          'absolute z-50 top-full mt-1 rounded overflow-hidden border border-slate-700 shadow-xl',
                          isOwn ? 'right-0' : 'left-0'
                        )}>
                          <EmojiPicker
                            theme={Theme.DARK}
                            emojiStyle={EmojiStyle.NATIVE}
                            width={300}
                            height={350}
                            searchDisabled={false}
                            skinTonesDisabled
                            previewConfig={{ showPreview: false }}
                            onEmojiClick={(e) => handleReact(m, e.emoji)}
                          />
                        </div>
                      </>
                    )}
                  </div>

                  {/* Reaction chips — aggregated by emoji, with counts */}
                  {reactions && reactions.size > 0 && (
                    <div className="flex flex-wrap gap-1 max-w-[80%]">
                      {Array.from(reactions.entries()).map(([emoji, info]) => (
                        <button
                          key={emoji}
                          onClick={() => handleReact(m, emoji)}
                          className={cn(
                            'flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] border transition-colors',
                            info.selfReacted
                              ? 'bg-brand-accent/15 border-brand-accent/40 text-brand-accent'
                              : 'bg-brand-line/50 border-brand-line/70 text-brand-ink/80 hover:border-brand-accent/30'
                          )}
                          title={info.selfReacted ? 'You reacted' : 'Tap to react'}
                        >
                          <span>{emoji}</span>
                          <span className="mono-text text-[10px] opacity-70">{info.count}</span>
                        </button>
                      ))}
                    </div>
                  )}

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
            {replyingTo && (
              <div className="mb-2 flex items-center gap-2 px-3 py-1.5 bg-brand-accent/10 border-l-2 border-brand-accent rounded text-[11px]">
                <CornerDownRight size={11} className="text-brand-accent shrink-0" />
                <span className="flex-1 truncate">
                  <span className="opacity-70 font-bold">
                    Replying to {replyingTo.isOwn ? 'yourself' : (nodes.find(n => n.id === replyingTo.from)?.name || replyingTo.from)}:{' '}
                  </span>
                  <span className="opacity-60">{replyingTo.text.length > 60 ? replyingTo.text.slice(0, 60) + '…' : replyingTo.text}</span>
                </span>
                <button
                  onClick={() => setReplyingTo(null)}
                  className="text-brand-muted hover:text-white shrink-0"
                  title="Cancel reply"
                >
                  <X size={11} />
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={draftMessage}
                onChange={(e) => setDraftMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendWithReply()}
                placeholder={
                  replyingTo ? 'Reply…'
                  : `Message ${activeChannel ? channelLabel(activeChannel) : activeChatPartner?.name || 'the network'}…`
                }
                className="flex-1 bg-brand-line border border-brand-line rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-brand-accent"
              />
              <button
                onClick={handleSendWithReply}
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
