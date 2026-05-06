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
  node?: Node;
}

const MENTION_RE = /@(![\da-fA-F]{8}|[A-Za-z0-9_-]{1,12})/g;

/**
 * Split a message body into text + mention segments. Mentions resolve to a
 * node by either short-name (case-insensitive) or `!hex` id. Unknown handles
 * stay as plain text so we don't visually mark random `@`-words as mentions.
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
    const node = handle.startsWith('!')
      ? byId.get(handle.toLowerCase())
      : byShort.get(handle.toLowerCase());

    if (!node) continue; // unknown — leave as plain text

    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: body.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'mention', text: match[0], node });
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

/** Returns true if `localNodeId` is mentioned in `body` (by short-name or hex). */
export function isMentioned(body: string, localNode: Node | undefined): boolean {
  if (!localNode || !body) return false;
  const segments = parseMentions(body, [localNode]);
  return segments.some(s => s.type === 'mention' && s.node?.id === localNode.id);
}
