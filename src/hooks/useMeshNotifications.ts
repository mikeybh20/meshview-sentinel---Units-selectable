import { useEffect, useRef } from 'react';
import { Node, Message, RadioEvent } from '../types';
import { isMentioned } from '../lib/mentions';

interface Args {
  nodes: Node[];
  messages: Message[];
  events: RadioEvent[];
  localNodeId: string | null;
  activeChatId: string;
  enabled: boolean;
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
  nodes, messages, events, localNodeId, activeChatId, enabled,
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
      // Reactions are noise for notifications — skip
      if (m.isReaction) continue;

      const isDmToMe = !!localNodeId && m.to === localNodeId && m.to !== '!ffffffff';
      const mentioned = !isDmToMe && isMentioned(m.text, localNode);

      if (!isDmToMe && !mentioned) continue;

      // Suppress if the user is already focused on the relevant chat
      if (typeof document !== 'undefined' && document.hasFocus()) {
        if (isDmToMe && activeChatId === m.from) continue;
        // For channel mentions, "active chat" is whichever channel the message
        // landed in — we don't easily know that here, so always notify on
        // mentions even if focused (mentions are higher signal than passive DMs).
      }

      const sender = nodes.find(n => n.id === m.from);
      const senderLabel = sender?.name || m.from;
      const title = isDmToMe ? `DM from ${senderLabel}` : `${senderLabel} mentioned you`;

      try {
        const n = new Notification(title, {
          body: m.text.length > 140 ? `${m.text.slice(0, 140)}...` : m.text,
          tag: isDmToMe ? `dm-${m.from}` : `mention-${m.id}`,
          icon: '/favicon.ico',
        });
        n.onclick = (ev) => {
          ev.preventDefault();
          window.focus();
          // For DMs, jump to the sender's chat. For channel mentions, jump to the channel.
          const target = isDmToMe ? m.from : `chan:0`; // TODO: resolve channel index from m.channel
          window.dispatchEvent(new CustomEvent('mesh:openChat', { detail: { nodeId: target } }));
          n.close();
        };
      } catch {
        // Notifications blocked or constructor failed — nothing to do
      }
    }

    if (messages.length > 0) {
      lastMsgIdRef.current = messages[messages.length - 1].id;
    }
  }, [messages, enabled, nodes, localNodeId, activeChatId]);

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
