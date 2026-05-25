/**
 * BBS Mail view. Three tabs:
 *   - Inbox: mail addressed to the local node
 *   - Outbox: mail the local operator (or BBS state machine) has sent
 *   - Compose: send a new piece of mail to any node on the mesh
 *
 * Mail conversations between remote operators happen over DM (`:mail` trigger
 * handled by server/bbs.ts). This view is the bookkeeping/operator surface —
 * it lets the dashboard operator see what's been exchanged and originate
 * mail directly without typing the state-machine commands at the radio.
 */

import React from 'react';
import { Mail, Send, Inbox as InboxIcon, Forward as OutboxIcon, Users, Trash2, Check, X, RefreshCw } from 'lucide-react';
import { Node } from '../../types';
import { cn } from '../../lib/utils';
import { meshDataService } from '../../services/meshDataService';

interface MailViewProps {
  nodes: Node[];
  localNodeId: string | null;
}

type Tab = 'inbox' | 'outbox' | 'compose' | 'users';

interface MailUser {
  nodeId: string;
  sentCount: number;
  receivedCount: number;
  unreadCount: number;
  lastActivity: number;
  name: string | null;
  shortName: string | null;
  isLocal: boolean;
}

interface InboxRow {
  id: number;
  senderNodeId: string;
  senderShortName: string;
  postedAt: number;
  body: string;
  readAt: number | null;
  deliveredAt: number | null;
}

interface OutboxRow {
  id: number;
  recipientNodeId: string;
  senderShortName: string;
  postedAt: number;
  body: string;
  readAt: number | null;
}

const BODY_CAP = 200;

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function MailView({ nodes, localNodeId }: MailViewProps) {
  const [tab, setTab] = React.useState<Tab>('inbox');
  const [inbox, setInbox] = React.useState<InboxRow[]>([]);
  const [outbox, setOutbox] = React.useState<OutboxRow[]>([]);
  const [users, setUsers] = React.useState<MailUser[]>([]);
  const [loading, setLoading] = React.useState(false);

  // Compose state
  const [recipientId, setRecipientId] = React.useState('');
  const [body, setBody] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [sendOk, setSendOk] = React.useState(false);
  const [nodeFilter, setNodeFilter] = React.useState('');

  const refresh = React.useCallback(async () => {
    if (!localNodeId) return;
    setLoading(true);
    try {
      const [i, o, u] = await Promise.all([
        meshDataService.getBbsInbox(localNodeId),
        meshDataService.getBbsOutbox(localNodeId),
        meshDataService.getBbsUsers(),
      ]);
      if (i) setInbox(i.mail);
      if (o) setOutbox(o.mail);
      if (u) setUsers(u.users);
    } finally {
      setLoading(false);
    }
  }, [localNodeId]);

  // Initial load + live updates via SSE
  React.useEffect(() => {
    refresh();
    const unsub = meshDataService.onBbsMail(() => { refresh(); });
    return unsub;
  }, [refresh]);

  const unread = inbox.filter(m => m.readAt === null).length;

  // Sort candidates by lastSeen desc, exclude blocked / self, filter by query
  const recipientCandidates = React.useMemo(() => {
    const q = nodeFilter.trim().toLowerCase();
    return nodes
      .filter(n => n.id !== localNodeId)
      .filter(n => !q
        || n.id.toLowerCase().includes(q)
        || (n.name || '').toLowerCase().includes(q)
        || (n.shortName || '').toLowerCase().includes(q)
      )
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 50);
  }, [nodes, localNodeId, nodeFilter]);

  const handleSend = async () => {
    setSendError(null);
    setSendOk(false);
    if (!recipientId) { setSendError('Pick a recipient.'); return; }
    if (!body.trim()) { setSendError('Body is empty.'); return; }
    setSending(true);
    try {
      const r = await meshDataService.composeBbsMail(recipientId, body);
      if (!r.ok) {
        setSendError(r.error || 'Send failed.');
        return;
      }
      setSendOk(true);
      setBody('');
      setRecipientId('');
      setNodeFilter('');
      refresh();
      setTimeout(() => setSendOk(false), 2_500);
    } finally {
      setSending(false);
    }
  };

  const handleMarkRead = async (id: number) => {
    await meshDataService.markBbsRead(id);
    refresh();
  };

  const handleDelete = async (id: number) => {
    await meshDataService.deleteBbsMail(id);
    refresh();
  };

  const lookupNodeLabel = (id: string) => {
    const n = nodes.find(nn => nn.id === id);
    if (!n) return id;
    return `${n.shortName || '????'} · ${n.name || id}`;
  };

  if (!localNodeId) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="text-center max-w-md space-y-2 opacity-70">
          <Mail size={36} className="mx-auto text-brand-muted" />
          <h3 className="text-base font-bold uppercase tracking-tight">Mail unavailable</h3>
          <p className="text-xs text-brand-muted">
            Waiting for the local radio to identify itself. Connect a radio in
            Settings, then return here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
      <div className="flex items-center justify-between gap-3 shrink-0">
        <div>
          <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
            <Mail size={20} className="text-brand-accent" />
            BBS Mail
          </h2>
          <p className="text-[10px] text-brand-muted mono-text uppercase tracking-widest">
            Remote senders DM <span className="text-brand-accent">:mail</span> to your node. 30-day retention.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-brand-muted hover:text-brand-accent border border-brand-line hover:border-brand-accent/50 rounded transition-colors disabled:opacity-40"
          title="Refresh inbox and outbox"
        >
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-brand-line shrink-0">
        {[
          { id: 'inbox', label: 'Inbox', count: unread, icon: <InboxIcon size={12} /> },
          { id: 'outbox', label: 'Outbox', count: outbox.length, icon: <OutboxIcon size={12} /> },
          { id: 'compose', label: 'Compose', count: 0, icon: <Send size={12} /> },
          { id: 'users', label: 'Users', count: users.length, icon: <Users size={12} /> },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id as Tab)}
            className={cn(
              'px-3 py-2 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-2',
              tab === t.id
                ? 'border-brand-accent text-brand-accent'
                : 'border-transparent text-brand-muted hover:text-brand-ink'
            )}
          >
            {t.icon}
            {t.label}
            {t.count > 0 && (
              <span className={cn(
                'mono-text text-[10px] px-1.5 py-0.5 rounded-full',
                tab === t.id ? 'bg-brand-accent text-black' : 'bg-brand-warning text-brand-bg'
              )}>
                {t.count > 99 ? '99+' : t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === 'inbox' && (
          <div className="space-y-2">
            {inbox.length === 0 && (
              <div className="text-sm text-brand-muted italic text-center py-12">
                No mail. Remote senders DM <span className="text-brand-accent">:mail</span> to your node to start a thread.
              </div>
            )}
            {inbox.map(m => (
              <div
                key={m.id}
                className={cn(
                  'technical-panel p-3 space-y-1 transition-colors',
                  m.readAt === null && 'border-brand-accent/40 bg-brand-accent/5'
                )}
              >
                <div className="flex items-center justify-between gap-2 text-[10px] mono-text uppercase tracking-widest">
                  <div className="flex items-center gap-2 truncate">
                    <span className="font-bold text-brand-accent">{m.senderShortName}</span>
                    <span className="text-brand-muted truncate">{lookupNodeLabel(m.senderNodeId)}</span>
                  </div>
                  <span className="text-brand-muted shrink-0">{relTime(m.postedAt)}</span>
                </div>
                <p className="text-sm break-words whitespace-pre-wrap">{m.body}</p>
                <div className="flex items-center justify-end gap-2 pt-1">
                  {m.readAt === null && (
                    <button
                      onClick={() => handleMarkRead(m.id)}
                      className="flex items-center gap-1 text-[10px] mono-text uppercase tracking-widest text-brand-muted hover:text-brand-accent transition-colors"
                      title="Mark as read"
                    >
                      <Check size={11} /> Read
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(m.id)}
                    className="flex items-center gap-1 text-[10px] mono-text uppercase tracking-widest text-brand-muted hover:text-brand-error transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={11} /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'outbox' && (
          <div className="space-y-2">
            {outbox.length === 0 && (
              <div className="text-sm text-brand-muted italic text-center py-12">
                Outbox is empty. Compose mail from the Compose tab or via DM.
              </div>
            )}
            {outbox.map(m => (
              <div key={m.id} className="technical-panel p-3 space-y-1">
                <div className="flex items-center justify-between gap-2 text-[10px] mono-text uppercase tracking-widest">
                  <div className="flex items-center gap-2 truncate">
                    <span className="text-brand-muted">→</span>
                    <span className="font-bold text-brand-accent">{lookupNodeLabel(m.recipientNodeId)}</span>
                  </div>
                  <span className="text-brand-muted shrink-0">{relTime(m.postedAt)}</span>
                </div>
                <p className="text-sm break-words whitespace-pre-wrap">{m.body}</p>
                <div className="flex items-center justify-between gap-2 pt-1 text-[10px] mono-text uppercase tracking-widest">
                  <span className={cn(
                    m.readAt ? 'text-brand-accent' : 'text-brand-muted'
                  )}>
                    {m.readAt ? `Read ${relTime(m.readAt)}` : 'Unread by recipient'}
                  </span>
                  <button
                    onClick={() => handleDelete(m.id)}
                    className="flex items-center gap-1 text-brand-muted hover:text-brand-error transition-colors"
                  >
                    <Trash2 size={11} /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'compose' && (
          <div className="max-w-2xl space-y-4">
            <div>
              <div className="flex items-baseline justify-between mb-1">
                <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">
                  To
                </label>
                <span className="text-[9px] mono-text text-brand-muted">
                  Pick a node from the directory
                </span>
              </div>
              <input
                type="text"
                value={nodeFilter}
                onChange={e => setNodeFilter(e.target.value)}
                placeholder="Filter by short name, name, or !hex…"
                className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brand-accent"
              />
              <div className="mt-1 border border-brand-line rounded max-h-48 overflow-y-auto">
                {recipientCandidates.length === 0 && (
                  <div className="p-3 text-xs text-brand-muted italic text-center">No nodes match.</div>
                )}
                {recipientCandidates.map(n => (
                  <button
                    key={n.id}
                    onClick={() => setRecipientId(n.id)}
                    className={cn(
                      'w-full px-2 py-1.5 flex items-center gap-2 text-left text-xs border-b border-brand-line/40 last:border-b-0 transition-colors',
                      recipientId === n.id
                        ? 'bg-brand-accent/10 text-brand-accent'
                        : 'hover:bg-brand-line/30'
                    )}
                  >
                    <span className="mono-text font-bold w-12 shrink-0">{n.shortName || '????'}</span>
                    <span className="flex-1 truncate">{n.name || n.id}</span>
                    <span className="mono-text text-[10px] text-brand-muted shrink-0">{n.id}</span>
                    <span className={cn(
                      'text-[9px] mono-text uppercase shrink-0',
                      n.online ? 'text-brand-accent' : 'text-brand-muted'
                    )}>
                      {n.online ? 'online' : relTime(n.lastSeen)}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-baseline justify-between mb-1">
                <label className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">
                  Body
                </label>
                <span className={cn(
                  'text-[9px] mono-text tracking-widest',
                  body.length >= BODY_CAP && 'text-brand-warning',
                  body.length >= BODY_CAP * 0.8 && body.length < BODY_CAP && 'text-brand-accent',
                  body.length < BODY_CAP * 0.8 && 'text-brand-muted',
                )}>
                  {body.length}/{BODY_CAP}
                </span>
              </div>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value.slice(0, BODY_CAP))}
                placeholder="Up to 200 characters. The recipient gets pushed a notification and reads via :mail R."
                rows={4}
                className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brand-accent resize-none"
              />
            </div>

            {sendError && (
              <div className="px-2 py-1.5 rounded bg-brand-error/10 border border-brand-error/30 text-xs text-brand-error">
                {sendError}
              </div>
            )}
            {sendOk && (
              <div className="px-2 py-1.5 rounded bg-brand-accent/10 border border-brand-accent/30 text-xs text-brand-accent flex items-center gap-2">
                <Check size={12} /> Mail sent and recipient notified.
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => { setRecipientId(''); setBody(''); setNodeFilter(''); setSendError(null); }}
                className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink transition-colors flex items-center gap-1"
                disabled={sending}
              >
                <X size={12} /> Clear
              </button>
              <button
                onClick={handleSend}
                disabled={sending || !recipientId || !body.trim()}
                className="flex items-center gap-2 bg-brand-accent text-black px-4 py-1.5 rounded text-xs font-bold uppercase tracking-widest hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send size={12} />
                {sending ? 'Sending…' : 'Send Mail'}
              </button>
            </div>
          </div>
        )}

        {tab === 'users' && (
          <div className="space-y-3">
            {users.length === 0 ? (
              <div className="text-sm text-brand-muted italic text-center py-12">
                Nobody has used your BBS mail system yet. As remote nodes DM <code className="text-brand-accent">:mail</code> to your node and start sending or receiving, they'll show up here.
              </div>
            ) : (
              <div className="technical-panel overflow-hidden">
                {/* Header row */}
                <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-3 py-2 border-b border-brand-line bg-brand-line/30 text-[10px] uppercase font-bold tracking-widest text-brand-muted">
                  <span>Node</span>
                  <span className="text-right w-16">Last seen</span>
                  <span className="text-right w-12">Sent</span>
                  <span className="text-right w-12">Recv</span>
                  <span className="text-right w-12">Unread</span>
                </div>
                {users.map(u => (
                  <div
                    key={u.nodeId}
                    className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-3 py-2 border-b border-brand-line/40 last:border-b-0 text-xs hover:bg-brand-line/20 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="mono-text font-bold text-brand-accent shrink-0">
                          {u.shortName || u.nodeId.slice(-4)}
                        </span>
                        <span className="text-brand-ink truncate">
                          {u.name || u.nodeId}
                        </span>
                        {u.isLocal && (
                          <span
                            className="text-[9px] mono-text uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-brand-accent/15 text-brand-accent shrink-0"
                            title="This is your local node"
                          >
                            you
                          </span>
                        )}
                      </div>
                      <div className="mono-text text-[10px] text-brand-muted truncate">
                        {u.nodeId}
                      </div>
                    </div>
                    <span className="text-right w-16 text-brand-muted mono-text text-[10px] self-center">
                      {relTime(u.lastActivity)}
                    </span>
                    <span className="text-right w-12 mono-text self-center">
                      {u.sentCount}
                    </span>
                    <span className="text-right w-12 mono-text self-center">
                      {u.receivedCount}
                    </span>
                    <span className={cn(
                      "text-right w-12 mono-text self-center",
                      u.unreadCount > 0 ? "text-brand-warning font-bold" : "text-brand-muted"
                    )}>
                      {u.unreadCount}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-brand-muted leading-snug px-1">
              Distinct nodes that have sent or received mail through this BBS. There's no formal
              registration step — any node on the mesh can use <code className="text-brand-accent">:mail</code> to
              start. Sorted by most recent activity. Counts include both directions of your conversations
              and any <span className="text-brand-error font-bold">WX</span> weather-alert mail to subscribers.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
