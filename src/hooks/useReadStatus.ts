import { useEffect, useMemo, useState } from 'react';
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
 */
export function useReadStatus({ messages, channels, localNodeId, activeChatId, markActiveAsRead }: Args) {
  const [readMap, setReadMap] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
  });

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

  return { unreadCounts };
}
