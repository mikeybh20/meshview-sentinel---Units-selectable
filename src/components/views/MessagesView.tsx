import React from 'react';
import { Filter, Signal, Activity, Users, ArrowRight, Settings, Clock, Check, CheckCheck, AlertCircle, RotateCcw, Wifi, WifiOff, CornerDownRight, Smile, X, Search } from 'lucide-react';
// ReactionPicker is lazy-loaded so emoji-picker-react (~140 KB) only ships
// when the operator actually opens a reaction picker.
const ReactionPicker = React.lazy(() => import('../lazy/ReactionPicker'));

import { Node, Message, Channel } from '../../types';
import { cn } from '../../lib/utils';
import { ChannelItem } from '../ui/ChannelItem';
import { HopNode } from '../ui/HopNode';
import { meshDataService } from '../../services/meshDataService';
import { parseMentions } from '../../lib/mentions';
import { useRadios } from '../../hooks/useRadios';

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
  handleSendMessage: (overrideText?: string, opts?: { replyTo?: number; isReaction?: boolean; radioId?: string | null }) => void;
  onManageChannels: () => void;
  localNodeId: string | null;
  blockedNodeIds: Set<string>;
  /** Per-chat unread counts (sidebar pills). */
  unreadCounts: Record<string, number>;
  /** Snapshot of lastReadAt for the active chat at the moment we entered it.
   *  Used to position the "—— New ——" divider — frozen during the visit. */
  firstUnreadAt: number;
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

/**
 * Map a stored `errorCode` to operator-facing diagnostics.
 *
 * Negative codes are bridge-internal (we set them ourselves):
 *   -1 = 30s ACK timeout (the most common DM failure)
 *   -2 = synchronous radio-write error (frame build / link not open)
 * Positive codes 0-9, 32-38 are the firmware's `Routing.Error` enum from
 * mesh.proto — when a peer or relay sends a NAK, that enum value flows back
 * through PORT_ROUTING_APP and we store it on the message.
 *
 * Returns `{ short, long }`:
 *   short — uppercase tag for the inline pill (e.g. "TIMEOUT", "NO_ROUTE")
 *   long  — multi-line tooltip body explaining what it usually means
 */
function describeMessageError(errorCode: number | undefined): { short: string; long: string } {
  switch (errorCode) {
    case -1: return {
      short: 'TIMEOUT',
      long: 'Timeout — no ACK received within 30 s.\n\nMost common cause: the destination is offline or unreachable. Check the node\'s "last seen" time. If it was last seen via MQTT, ACKs often don\'t round-trip through the public broker.',
    };
    case -2: return {
      short: 'SEND ERR',
      long: 'Radio write failed before the packet went out.\n\nUsually means the serial link dropped or the bridge is in a stuck state. Check `docker compose logs meshview` and consider `docker compose restart meshview`.',
    };
    case 1: return {
      short: 'NO ROUTE',
      long: 'NO_ROUTE — no path to destination. The mesh\'s routers don\'t have a route to this node.\n\nUsually means too many hops, or the destination has been off the mesh long enough that route cache expired.',
    };
    case 2: return {
      short: 'GOT NAK',
      long: 'GOT_NAK — a relay along the path explicitly NAK\'d the packet (couldn\'t forward it).',
    };
    case 3: return {
      short: 'FW TIMEOUT',
      long: 'TIMEOUT — the firmware itself timed out waiting for an ACK before our 30 s wrapper did. Same root cause as our timeout: destination unreachable.',
    };
    case 4: return {
      short: 'NO IFACE',
      long: 'NO_INTERFACE — no interface available to send on. The radio\'s LoRa or WiFi/MQTT stack isn\'t up.',
    };
    case 5: return {
      short: 'MAX RETRY',
      long: 'MAX_RETRANSMIT — the firmware retried internally up to its limit and never got an ACK. Usually weak link or duty-cycle congestion.',
    };
    case 6: return {
      short: 'NO CHANNEL',
      long: 'NO_CHANNEL — the destination isn\'t configured for any channel we know about. Common when DMing a node we only see via MQTT but don\'t share a channel PSK with.',
    };
    case 7: return {
      short: 'TOO LARGE',
      long: 'TOO_LARGE — message exceeds the LoRa max payload size (~228 bytes). Shorten the text and resend.',
    };
    case 8: return {
      short: 'NO RESPONSE',
      long: 'NO_RESPONSE — the destination never responded. Effectively the same as TIMEOUT but reported by the firmware rather than our 30 s wrapper.',
    };
    case 9: return {
      short: 'DUTY CYCLE',
      long: 'DUTY_CYCLE_LIMIT — your radio hit the regulatory airtime cap (1 % in EU, etc.) and refused to TX. Wait a few minutes and retry.',
    };
    case 32: return {
      short: 'BAD REQ',
      long: 'BAD_REQUEST — the firmware considered the packet malformed. This is unusual; check the bridge logs.',
    };
    case 33: return {
      short: 'NOT AUTH',
      long: 'NOT_AUTHORIZED — operation requires admin auth that wasn\'t provided. Most often seen on admin writes, not DMs.',
    };
    case 34: return {
      short: 'PKI FAIL',
      long: 'PKI_FAILED — the destination\'s public-key encryption rejected our packet. Usually means a stale public key on our side; the destination has rotated keys since we cached them.',
    };
    case 35: return {
      short: 'PKI UNKNOWN',
      long: 'PKI_UNKNOWN_PUBKEY — the destination has no record of our public key. They may have wiped their NodeDB or never received our NodeInfo.',
    };
    case 36: return {
      short: 'ADMIN KEY',
      long: 'ADMIN_BAD_SESSION_KEY — admin session key invalid (firmware admin auth feature).',
    };
    case 37: return {
      short: 'ADMIN PUB',
      long: 'ADMIN_PUBLIC_KEY_UNAUTHORIZED — admin public key not in the destination\'s allow-list.',
    };
    case 38: return {
      short: 'RATE LIMIT',
      long: 'RATE_LIMIT_EXCEEDED — you\'ve sent too much traffic too fast for this destination. Slow down.',
    };
    default: return {
      short: `ERR ${errorCode ?? '?'}`,
      long: errorCode === undefined
        ? 'Send failed (no error code recorded).'
        : `Send failed with Routing.Error code ${errorCode}. See mesh.proto for the full enum — or check the server logs for context.`,
    };
  }
}

function MessageStatusIcon({ status, errorCode, onRetry, isBroadcast }: {
  status?: Message['status'];
  errorCode?: number;
  onRetry?: () => void;
  /** Broadcasts never reach 'acked' — render 'queued' as the terminal positive state for them. */
  isBroadcast?: boolean;
}) {
  if (!status) return null;
  if (status === 'acked') {
    return <span title="Delivered (peer ACK received)"><CheckCheck size={11} className="text-brand-accent" /></span>;
  }
  if (status === 'queued') {
    // For broadcasts this is the happy-path terminal state; for DMs it's
    // a halfway signal while we wait for the peer's routing reply.
    const tooltip = isBroadcast
      ? 'Queued for transmit (broadcasts get no over-the-air ACK)'
      : 'Queued for transmit — waiting for peer ACK…';
    return <span title={tooltip}><CheckCheck size={11} className="text-brand-muted" /></span>;
  }
  if (status === 'sending') {
    return <span title="Sending…"><Clock size={11} className="text-brand-muted animate-pulse" /></span>;
  }
  if (status === 'sent') {
    return <span title="Sent to radio"><Check size={11} className="text-brand-muted" /></span>;
  }
  if (status === 'error') {
    const { short, long } = describeMessageError(errorCode);
    return (
      <span className="flex items-center gap-1" title={long}>
        <AlertCircle size={11} className="text-brand-error" />
        <span className="text-[9px] mono-text uppercase tracking-wider text-brand-error font-bold">
          {short}
        </span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center gap-0.5 text-[9px] text-brand-error hover:text-brand-error mono-text uppercase transition-colors"
            title={`Retry sending\n\n${long}`}
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
  unreadCounts,
  firstUnreadAt,
}: MessagesViewProps) {
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const messageRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const [highlightId, setHighlightId] = React.useState<string | null>(null);

  // v2.0 multi-radio: look up the per-radio color for the message chip.
  const { radios } = useRadios();
  const radioColors = React.useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const r of radios) if (r.color_hex) m[r.radio_id] = r.color_hex;
    return m;
  }, [radios]);
  const showRadioChips = radios.length > 1;

  // Auto-scroll to bottom when new messages arrive (suppressed briefly while a
  // search-result highlight is anchoring on a specific older message).
  React.useEffect(() => {
    if (highlightId) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filteredMessages.length, highlightId]);

  // When a search result is jumped to, scroll its bubble into view and flash it.
  React.useEffect(() => {
    if (!highlightId) return;
    const el = messageRefs.current.get(highlightId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setHighlightId(null), 2000);
    return () => clearTimeout(t);
  }, [highlightId]);

  // Index of the first unread message in the current chat — frozen at chat entry.
  // Used to render the "—— New ——" divider above that message. -1 if none.
  const firstUnreadIndex = React.useMemo(() => {
    if (!firstUnreadAt) return -1;
    return filteredMessages.findIndex(
      m => !m.isOwn && !m.isReaction && m.timestamp > firstUnreadAt
    );
  }, [filteredMessages, firstUnreadAt]);

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
    // v2.0 multi-radio: reactions go out via the radio that received the
    // parent message so they land in the same mesh.
    handleSendMessage(emoji, {
      replyTo: parent.packetId,
      isReaction: true,
      radioId: parent.radioId ?? undefined,
    });
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
    // Defer the highlight set so the chat switch and re-render happen first;
    // the effect above then scrolls the bubble into view.
    requestAnimationFrame(() => setHighlightId(m.id));
  };

  const handleSendWithReply = () => {
    if (replyingTo && typeof replyingTo.packetId === 'number') {
      // v2.0 multi-radio: route the reply through the radio that received
      // the original. Otherwise a reply on (e.g.) WRTJ's LongFast would
      // go out on 3BEC's LongFast — a totally different mesh — and the
      // sender would never see it.
      handleSendMessage(undefined, {
        replyTo: replyingTo.packetId,
        radioId: replyingTo.radioId ?? undefined,
      });
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
                className="absolute right-2 top-1/2 -translate-y-1/2 text-brand-muted hover:text-brand-ink"
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
            {nodes
              // Filter out: the placeholder demo node, blocked nodes, and
              // the local node itself. The local node can't be DMed —
              // self-DMs don't actually transmit, they just consume rate-
              // limit budget — so we don't show it as a target at all.
              .filter(n =>
                n.online
                && n.id !== '!abcdef01'
                && n.id !== localNodeId
                && !blockedNodeIds.has(n.id)
              )
              .map(n => (
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
            {filteredMessages.length > 0 ? filteredMessages.map((m, idx) => {
              // Reactions don't render as standalone messages — they appear as
              // chips under the parent message they're reacting to.
              if (m.isReaction) return null;

              const isOwn = m.isOwn === true || m.status === 'sending' || m.status === 'sent';
              const senderName = nodes.find(n => n.id === m.from)?.name || m.from;
              const parentMsg = m.replyTo ? messageByPacketId.get(m.replyTo) : undefined;
              const reactions = m.packetId ? reactionsByParent.get(m.packetId) : undefined;
              const canReplyOrReact = typeof m.packetId === 'number' && !m.isReaction;

              const isHighlighted = highlightId === m.id;
              const isNew = !isOwn && firstUnreadAt > 0 && m.timestamp > firstUnreadAt;
              const showUnreadDivider = idx === firstUnreadIndex;
              return (
                <React.Fragment key={m.id}>
                  {showUnreadDivider && (
                    <div className="flex items-center gap-3 py-1 select-none" aria-label="New messages divider">
                      <div className="flex-1 h-px bg-brand-warning/40" />
                      <span className="text-[9px] font-bold mono-text uppercase tracking-widest text-brand-warning px-2 py-0.5 rounded-full bg-brand-warning/10 border border-brand-warning/30">
                        New
                      </span>
                      <div className="flex-1 h-px bg-brand-warning/40" />
                    </div>
                  )}
                <div
                  ref={(el) => {
                    if (el) messageRefs.current.set(m.id, el);
                    else messageRefs.current.delete(m.id);
                  }}
                  className={cn(
                    'flex flex-col gap-1 group/msg transition-all rounded-lg relative',
                    isOwn ? 'items-end' : 'items-start',
                    isHighlighted && 'bg-brand-accent/10 ring-1 ring-brand-accent/40 -mx-2 px-2 py-2',
                    isNew && !isHighlighted && 'animate-[pulse_2s_ease-out_1]'
                  )}
                >
                  <div className="flex items-center gap-2 px-2">
                    <span className="text-[11px] font-bold uppercase tracking-tight text-brand-ink">
                      {isOwn ? 'You' : senderName}
                    </span>
                    <span className="text-[10px] mono-text text-brand-muted">{new Date(m.timestamp).toLocaleTimeString()}</span>
                    {/* v2.0 multi-radio: tag the message with the radio that
                        received (or sent) it, so messages from different
                        meshes don't blend into one ambiguous stream. Hidden
                        when only one radio is registered (no ambiguity). */}
                    {showRadioChips && m.radioId && (
                      <span
                        title={isOwn ? `Sent via ${m.radioId}` : `Received via ${m.radioId}`}
                        className="text-[8px] font-bold mono-text px-1 py-px rounded border"
                        style={{
                          color: radioColors[m.radioId] ?? '#888',
                          borderColor: `${radioColors[m.radioId] ?? '#888'}55`,
                          background: `${radioColors[m.radioId] ?? '#888'}15`,
                        }}
                      >
                        {isOwn ? '→ ' : '← '}{m.radioId}
                      </span>
                    )}
                    {isNew && (
                      <span
                        className="text-[8px] mono-text uppercase font-bold tracking-widest text-brand-warning bg-brand-warning/10 border border-brand-warning/30 rounded px-1 py-px"
                        title="Arrived since you last opened this chat"
                      >
                        New
                      </span>
                    )}
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

                  <div className="relative max-w-[80%]">
                    <div className={cn(
                      'px-4 py-2 rounded-2xl text-sm break-words',
                      isOwn
                        ? 'bg-brand-accent text-black'
                        : 'bg-brand-line text-brand-ink',
                      m.status === 'error' && 'opacity-70'
                    )}>
                      {parseMentions(m.text, nodes).map((seg, i) => {
                        if (seg.type !== 'mention') {
                          return <React.Fragment key={i}>{seg.text}</React.Fragment>;
                        }
                        // Channel-wide mention (`@everyone` / `@all` / `@channel`):
                        // not clickable (no specific node to navigate to) and styled
                        // with the warning palette to distinguish from regular mentions.
                        if (seg.channelWide) {
                          return (
                            <span
                              key={i}
                              className={cn(
                                'font-bold rounded px-1',
                                isOwn
                                  ? 'bg-black/25 text-black'
                                  : 'bg-brand-warning/20 text-brand-warning',
                              )}
                              title="Channel-wide mention — every recipient sees this as a mention"
                            >
                              {seg.text}
                            </span>
                          );
                        }
                        return (
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
                        );
                      })}
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

                    {/* Emoji picker (popover) — lazy-loaded */}
                    {reactPickerForId === m.id && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setReactPickerForId(null)} />
                        <div className={cn(
                          'absolute z-50 top-full mt-1 rounded overflow-hidden border border-brand-line shadow-xl',
                          isOwn ? 'right-0' : 'left-0'
                        )}>
                          <React.Suspense fallback={
                            <div className="w-[300px] h-[350px] flex items-center justify-center bg-brand-surface text-[10px] text-brand-muted italic">
                              Loading emoji picker…
                            </div>
                          }>
                            <ReactionPicker onPick={(emoji) => handleReact(m, emoji)} />
                          </React.Suspense>
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
                        isBroadcast={m.to === '!ffffffff'}
                      />
                      {m.status !== 'error' && m.status !== 'sending' && m.hops && m.hops.length > 0 && (
                        <button
                          onClick={() => { setTraceMessageId(m.id); setActiveTab('map'); }}
                          className={cn(
                            'flex items-center gap-1 transition-all rounded hover:bg-brand-accent/10 group',
                            traceMessageId === m.id ? 'text-brand-accent scale-105' : 'text-brand-muted hover:text-brand-ink'
                          )}
                        >
                          <Signal size={10} className={cn(traceMessageId === m.id ? 'animate-pulse' : '')} />
                          <span className="text-[9px] mono-text uppercase">
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
                        traceMessageId === m.id ? 'text-brand-accent scale-105' : 'text-brand-muted hover:text-brand-ink'
                      )}
                    >
                      <Signal size={10} className={cn(traceMessageId === m.id ? 'animate-pulse' : '')} />
                      <span className="text-[9px] mono-text uppercase">
                        {traceMessageId === m.id ? 'Tracing Path…' : `Hops: ${m.hops.length}`}
                      </span>
                    </button>
                  )}
                </div>
                </React.Fragment>
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
                  className="text-brand-muted hover:text-brand-ink shrink-0"
                  title="Cancel reply"
                >
                  <X size={11} />
                </button>
              </div>
            )}
            {(() => {
              // Self-DM guard. DMing your own local node doesn't transmit
              // anything useful — the firmware sees `to == my_node_num` and
              // loops the packet back internally — but each attempt still
              // consumes a slot in the per-destination rate limiter, which
              // can block legitimate outbound traffic. Block the compose
              // surface entirely when the active chat IS the local node.
              const isSelfDm = !activeChannel
                && !!localNodeId
                && !!activeChatPartner
                && activeChatPartner.id === localNodeId;
              if (isSelfDm) {
                return (
                  <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-brand-warning/30 bg-brand-warning/10 text-xs text-brand-warning">
                    <Activity size={14} className="shrink-0" />
                    <span>
                      You can't DM your own node. The radio loops self-DMs back internally
                      and they consume rate-limit budget without going on-air. Pick a different
                      chat to compose a message.
                    </span>
                  </div>
                );
              }
              return (
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
              );
            })()}
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
