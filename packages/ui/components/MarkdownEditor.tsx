import React from 'react';
import {
  MarkdownEditor as PackagedMarkdownEditor,
  type MarkdownEditorHandle,
} from '@plannotator/markdown-editor';
import '@plannotator/markdown-editor/themes/plannotator.css';
import { useTheme } from './ThemeProvider';

export type { MarkdownEditorHandle };

/* Grid-mode card utilities stay here (not in the package): they're Plannotator
   design-system Tailwind classes, and this file is @source-scanned. */
const GRID_CARD_CLASSES = 'px-5 md:px-8 lg:px-10 xl:px-12 shadow-xl border border-border/50';

interface MarkdownEditorProps {
  /** Initial markdown. Read at mount only — the editor owns the text after that.
      Read the current text via editorHandleRef.current.getMarkdown(). */
  markdown: string;
  /** Identity key; change to remount with new content. */
  documentId: string;
  editorHandleRef: React.MutableRefObject<MarkdownEditorHandle | null>;
  onMarkdownChange?: (markdown: string) => void;
  onLinkClick?: (url: string) => void;
  /** Mirrors the Viewer card's outer maxWidth so toggling view<->edit doesn't jump. */
  maxWidth?: number | null;
  gridEnabled?: boolean;
}

/* Theme-bridging shim around @plannotator/markdown-editor. App.tsx renders its
   ThemeProvider inside its own JSX, so the resolved color mode must be read
   from a component beneath the provider — here — and passed down as a prop. */
export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({ gridEnabled, ...props }) => {
  const { resolvedMode } = useTheme();
  return (
    <PackagedMarkdownEditor
      {...props}
      mode={resolvedMode}
      cardClassName={gridEnabled ? GRID_CARD_CLASSES : undefined}
    />
  );
};
