import EmojiPicker, { Theme, EmojiStyle } from 'emoji-picker-react';

interface Props {
  onPick: (emoji: string) => void;
  width?: number;
  height?: number;
}

/**
 * Thin wrapper around `emoji-picker-react` so the heavy library is in its own
 * module. Imported via `React.lazy()` so it's only loaded when the operator
 * actually opens a reaction picker.
 */
export default function ReactionPicker({ onPick, width = 300, height = 350 }: Props) {
  return (
    <EmojiPicker
      theme={Theme.DARK}
      emojiStyle={EmojiStyle.NATIVE}
      width={width}
      height={height}
      searchDisabled={false}
      skinTonesDisabled
      previewConfig={{ showPreview: false }}
      onEmojiClick={(e) => onPick(e.emoji)}
    />
  );
}
