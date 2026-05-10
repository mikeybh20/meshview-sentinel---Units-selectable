import { Node } from '../types';

export interface MentionMatch {
  /** Text that was matched (e.g. "@OPS" or "@!12345678"). */
  raw: string;
  /** Resolved node, if found in the directory. */
  node?: Node;
}

export interface ParsedMessageSegment {
  type: 'text' | 'mention';
  text: string;
  /** Resolved node for direct mentions (`@shortname` or `@!hex`). */
  node?: Node;
  /**
   * True when the mention is a channel-wide convention (`@everyone`, `@all`,
   * `@channel`) — these don't resolve to a specific node and should always be
   * treated as if every member of the current channel was mentioned.
   * UI-side: render distinct from regular mentions and skip click-to-DM.
   * Notification-side: trigger the "you were mentioned" path for every recipient.
   */
  channelWide?: boolean;
}

const MENTION_RE = /@(![\da-fA-F]{8}|[A-Za-z0-9_-]{1,12})/g;

/** Channel-wide handles. These don't map to any node; they target the whole channel audience. */
const CHANNEL_WIDE_HANDLES = new Set(['everyone', 'all', 'channel']);

/**
 * Split a message body into text + mention segments. Mentions resolve to a
 * node by either short-name (case-insensitive) or `!hex` id, OR to a channel-
 * wide convention (`@everyone`, `@all`, `@channel`). Unknown handles stay as
 * plain text so we don't visually mark random `@`-words as mentions.
 */
export function parseMentions(body: string, nodes: Node[]): ParsedMessageSegment[] {
  if (!body) return [{ type: 'text', text: body }];

  // Build lookup tables for resolution
  const byShort = new Map<string, Node>();
  for (const n of nodes) {
    if (n.shortName) byShort.set(n.shortName.toLowerCase(), n);
  }
  const byId = new Map<string, Node>();
  for (const n of nodes) byId.set(n.id.toLowerCase(), n);

  const segments: ParsedMessageSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(body)) !== null) {
    const handle = match[1];
    const handleLower = handle.toLowerCase();

    let segment: ParsedMessageSegment | null = null;
    if (CHANNEL_WIDE_HANDLES.has(handleLower)) {
      segment = { type: 'mention', text: match[0], channelWide: true };
    } else if (handle.startsWith('!')) {
      const node = byId.get(handleLower);
      if (node) segment = { type: 'mention', text: match[0], node };
    } else {
      const node = byShort.get(handleLower);
      if (node) segment = { type: 'mention', text: match[0], node };
    }

    if (!segment) continue; // unknown — leave as plain text

    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: body.slice(lastIndex, match.index) });
    }
    segments.push(segment);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < body.length) {
    segments.push({ type: 'text', text: body.slice(lastIndex) });
  }

  if (segments.length === 0) {
    return [{ type: 'text', text: body }];
  }
  return segments;
}

/**
 * Returns true if `localNode` should be considered "mentioned" by `body`.
 * Triggers on:
 *   - `@<localShortName>` (case-insensitive)
 *   - `@!<localHexId>`
 *   - `@everyone` / `@all` / `@channel` (channel-wide — every recipient sees themselves as mentioned)
 */
export function isMentioned(body: string, localNode: Node | undefined): boolean {
  if (!body) return false;
  const segments = parseMentions(body, localNode ? [localNode] : []);
  return segments.some(s =>
    s.type === 'mention' && (
      s.channelWide === true ||
      (localNode !== undefined && s.node?.id === localNode.id)
    )
  );
}
