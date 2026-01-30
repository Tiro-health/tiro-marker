/**
 * Lexical Editor Configuration
 */

import { MarkNode } from '@lexical/mark';

export const editorTheme = {
  paragraph: 'editor-paragraph',
  text: {
    bold: 'editor-text-bold',
    italic: 'editor-text-italic',
    underline: 'editor-text-underline',
  },
  mark: 'editor-mark',
};

export const editorConfig = {
  namespace: 'TiroMarkerEditor',
  theme: editorTheme,
  nodes: [MarkNode],
  onError: (error) => {
    console.error('Lexical error:', error);
  },
};
