import { useEffect, useMemo, useRef, useState } from 'react';
import { Channel, Message } from '../types';

const STORAGE_KEY = 'mesh.readStatus';

interface Args {
  messages: Message[];
  channels: Channel[];
  localNodeId: string | null;
  activeChatId: string;
  /** When false (e.g. user is on a different tab), don't mark anything read. */
  markActiveAsRead: boolean;
}

/** Map a Message to its chat ID ('chan:N' for channel msgs, '!hex' for DMs). */
function chatIdForMessage(m: Message, channels: Channel[], localNodeId: string | null): string | null {
  // DM addressed to me → chat is the sender
  if (localNodeId && m.to === localNodeId && m.to !== '!ffffffff') {
    return m.from;
  }
  // Channel message — try to find a matching channel by name
  const ch = channels.find(c =>
    c.name === m.channel ||
    (c.role === 'PRIMARY' && (m.channel === 'LongFast' || m.channel === 'Broadcast' || m.channel === ''))
  );
  if (ch) return `chan:${ch.index}`;
  // Fall back to channel-0 for the synthetic primary
  if (m.channel === 'LongFast' || m.channel === 'Broadcast' || !m.channel) return 'chan:0';
  return null;
}

/**
 * Compute per-chat unread counts. Persists last-read timestamps to localStorage.
 * The currently-active chat always shows 0 unread (the user is looking right at it).
 *
 * Also exposes `firstUnreadAt[chatId]` — the lastReadAt value captured the moment
 * the user switched into that chat, frozen for the duration of the visit. The
 * message view uses this to render a "—— New ——" divider that stays put while
 * the user reads, instead of disappearing the moment markActive fires.
 */
export function useReadStatus({ messages, channels, localNodeId, activeChatId, markActiveAsRead }: Args) {
  const [readMap, setReadMap] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
  });
  const [firstUnreadAt, setFirstUnreadAt] = useState<Record<string, number>>({});

  // Keep a live ref of readMap so the chat-switch effect below can read it
  // without re-running every time the map changes.
  const readMapRef = useRef(readMap);
  useEffect(() => { readMapRef.current = readMap; }, [readMap]);

  // On chat switch: snapshot the *pre-switch* lastReadAt for the new chat. This
  // becomes the divider boundary. We only do this once per switch — not on
  // every incoming message — so the divider stays put while the user reads.
  useEffect(() => {
    if (!activeChatId) return;
    const prev = readMapRef.current[activeChatId] || 0;
    setFirstUnreadAt(b => ({ ...b, [activeChatId]: prev }));
  }, [activeChatId]);

  // Mark active chat read whenever the user switches to it (or when on the
  // messages view and new messages arrive — handled by the caller via markActiveAsRead).
  useEffect(() => {
    if (!activeChatId || !markActiveAsRead) return;
    setReadMap(prev => {
      const next = { ...prev, [activeChatId]: Date.now() };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* private mode? */ }
      return next;
    });
  }, [activeChatId, markActiveAsRead, messages.length]);

  const unreadCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const m of messages) {
      if (m.isOwn) continue;
      const chatId = chatIdForMessage(m, channels, localNodeId);
      if (!chatId) continue;
      if (chatId === activeChatId && markActiveAsRead) continue; // active chat → always 0
      const lastRead = readMap[chatId] || 0;
      if (m.timestamp > lastRead) counts[chatId] = (counts[chatId] || 0) + 1;
    }
    return counts;
  }, [messages, channels, localNodeId, activeChatId, markActiveAsRead, readMap]);

  // v2.0 Beta 3: per-radio unread count for the RadioBar pill badges.
  // Same per-chat lastRead semantics as `unreadCounts`, just grouped by
  // m.radioId instead of chat. Operators running multiple radios can see at
  // a glance which radio has fresh traffic without having to click each
  // pill. Messages with no radioId (legacy 1.x rows) are skipped.
  const unreadByRadio = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const m of messages) {
      if (m.isOwn) continue;
      if (!m.radioId) continue;
      const chatId = chatIdForMessage(m, channels, localNodeId);
      if (!chatId) continue;
      if (chatId === activeChatId && markActiveAsRead) continue;
      const lastRead = readMap[chatId] || 0;
      if (m.timestamp > lastRead) counts[m.radioId] = (counts[m.radioId] || 0) + 1;
    }
    return counts;
  }, [messages, channels, localNodeId, activeChatId, markActiveAsRead, readMap]);

  const totalUnread = useMemo(
    () => Object.values(unreadCounts).reduce((a, b) => a + b, 0),
    [unreadCounts]
  );

  return { unreadCounts, unreadByRadio, totalUnread, firstUnreadAt };
}
