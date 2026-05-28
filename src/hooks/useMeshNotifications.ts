import { useEffect, useRef } from 'react';
import { Channel, Node, Message, RadioEvent } from '../types';
import { isMentioned } from '../lib/mentions';

interface Args {
  nodes: Node[];
  messages: Message[];
  events: RadioEvent[];
  channels: Channel[];
  localNodeId: string | null;
  activeChatId: string;
  enabled: boolean;
}

/**
 * Resolve a Message's channel string (e.g. "LongFast", "Channel 2", "") to its
 * "chan:N" id. Matches the resolution rules used by useReadStatus.
 */
function chatIdForChannelMessage(m: Message, channels: Channel[]): string {
  const ch = channels.find(c =>
    c.name === m.channel ||
    (c.role === 'PRIMARY' && (m.channel === 'LongFast' || m.channel === 'Broadcast' || m.channel === ''))
  );
  if (ch) return `chan:${ch.index}`;
  // Synthetic primary fallback (matches the rest of the app)
  if (m.channel === 'LongFast' || m.channel === 'Broadcast' || !m.channel) return 'chan:0';
  // Last-resort: try parsing "Channel N"
  const match = m.channel.match(/Channel (\d+)/);
  if (match) return `chan:${match[1]}`;
  return 'chan:0';
}

/**
 * Fires browser notifications for new mesh activity:
 *   - inbound DMs addressed to the local node (when window unfocused or chat not active)
 *   - NODE_LOST events for favorited nodes
 *
 * Clicking a DM notification dispatches a `mesh:openChat` window event so the
 * app can switch to the messages tab with that node selected.
 */
export function useMeshNotifications({
  nodes, messages, events, channels, localNodeId, activeChatId, enabled,
}: Args) {
  // Track high-water marks so we only notify on items that arrived after the
  // hook started. Without these, every reload would replay the entire history.
  const lastMsgIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);

  // Initialize watermarks on first render that has data.
  useEffect(() => {
    if (initializedRef.current) return;
    if (messages.length === 0 && events.length === 0) return;
    lastMsgIdRef.current = messages.length > 0 ? messages[messages.length - 1].id : null;
    lastEventIdRef.current = events.length > 0 ? events[0].id : null; // events are unshifted (newest first)
    initializedRef.current = true;
  }, [messages, events]);

  // New messages → DM notifications
  useEffect(() => {
    if (!enabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!initializedRef.current) return;

    const lastIdx = lastMsgIdRef.current
      ? messages.findIndex(m => m.id === lastMsgIdRef.current)
      : -1;
    const newOnes = lastIdx >= 0 ? messages.slice(lastIdx + 1) : (lastMsgIdRef.current ? [] : messages);

    const localNode = localNodeId ? nodes.find(n => n.id === localNodeId) : undefined;

    for (const m of newOnes) {
      if (m.isOwn) continue;
      // Reactions are noise for notifications — skip the explicit ones first.
      if (m.isReaction) continue;
      // Belt-and-suspenders for the edge case where the bridge fails to set
      // `isReaction` (firmware variant emitting `Data.emoji` differently, or
      // parser miss): treat short reply-attached messages with no whitespace
      // as if they were a reaction. A 1–8 character no-space body that
      // references another message is overwhelmingly an emoji tap-back, not
      // an intentional micro-reply, and notifying for those is precisely the
      // failure mode the ROADMAP rough-edges entry documents.
      if (typeof m.replyTo === 'number' && m.replyTo > 0) {
        const compact = (m.text ?? '').trim();
        if (compact.length > 0 && compact.length <= 8 && !/\s/.test(compact)) continue;
      }

      const isDmToMe = !!localNodeId && m.to === localNodeId && m.to !== '!ffffffff';
      const mentioned = !isDmToMe && isMentioned(m.text, localNode);

      if (!isDmToMe && !mentioned) continue;

      // Pre-resolve the click-target chat id so we can use it for both
      // focus suppression and the notification's onclick handler.
      const targetChatId = isDmToMe ? m.from : chatIdForChannelMessage(m, channels);

      // Suppress if the user is already focused on the chat where the
      // message landed — for DMs that's the sender's chat, for channel
      // mentions that's the resolved chan:N.
      if (typeof document !== 'undefined' && document.hasFocus() && activeChatId === targetChatId) {
        continue;
      }

      const sender = nodes.find(n => n.id === m.from);
      const senderLabel = sender?.name || m.from;
      const title = isDmToMe ? `DM from ${senderLabel}` : `${senderLabel} mentioned you`;
      // For mentions, prefix the body with the channel so the user has context
      const body = isDmToMe
        ? m.text
        : `[${m.channel || 'channel'}] ${m.text}`;

      try {
        const n = new Notification(title, {
          body: body.length > 140 ? `${body.slice(0, 140)}...` : body,
          tag: isDmToMe ? `dm-${m.from}` : `mention-${m.id}`,
          icon: '/favicon.ico',
        });
        n.onclick = (ev) => {
          ev.preventDefault();
          window.focus();
          window.dispatchEvent(new CustomEvent('mesh:openChat', { detail: { nodeId: targetChatId } }));
          n.close();
        };
      } catch {
        // Notifications blocked or constructor failed — nothing to do
      }
    }

    if (messages.length > 0) {
      lastMsgIdRef.current = messages[messages.length - 1].id;
    }
  }, [messages, enabled, nodes, channels, localNodeId, activeChatId]);

  // New events → NODE_LOST for favorites
  useEffect(() => {
    if (!enabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!initializedRef.current) return;

    const lastIdx = lastEventIdRef.current
      ? events.findIndex(e => e.id === lastEventIdRef.current)
      : -1;
    // events are newest-first, so "new" events sit at indices [0, lastIdx)
    const newOnes = lastIdx >= 0 ? events.slice(0, lastIdx) : (lastEventIdRef.current ? [] : events);

    for (const e of newOnes) {
      // v2.0 Beta 2: favorites now emit a dedicated OUTAGE event (covering
      // both "went silent" and "back online"); the event text already carries
      // the ⚠/✓ marker so we surface it directly. NODE_LOST stays handled too
      // for back-compat with any favorite still on the old path.
      if (e.type === 'OUTAGE') {
        const node = nodes.find(n => n.id === e.nodeId);
        try {
          new Notification(node?.name ? `${node.name} — radio status` : 'Radio status', {
            body: e.details,
            tag: `outage-${e.nodeId}`,
            icon: '/favicon.ico',
          });
        } catch { /* noop */ }
        continue;
      }
      if (e.type !== 'NODE_LOST') continue;
      const node = nodes.find(n => n.id === e.nodeId);
      if (!node?.favorite) continue;

      try {
        new Notification(`${node.name} went offline`, {
          body: e.details,
          tag: `lost-${node.id}`,
          icon: '/favicon.ico',
        });
      } catch { /* noop */ }
    }

    if (events.length > 0) {
      lastEventIdRef.current = events[0].id;
    }
  }, [events, enabled, nodes]);
}
