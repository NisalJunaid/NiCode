import * as WebBrowser from 'expo-web-browser';
import { memo } from 'react';
import MarkdownDisplay from 'react-native-markdown-display';
import { font, radius, space, useColors } from '@/theme';

/** Claude's replies: markdown with code blocks styled for small screens. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const c = useColors();
  return (
    <MarkdownDisplay
      onLinkPress={(url) => {
        void WebBrowser.openBrowserAsync(url);
        return false;
      }}
      style={{
        body: { color: c.text, fontSize: font.size.md, lineHeight: 22 },
        paragraph: { marginTop: 0, marginBottom: space.sm },
        heading1: { fontSize: font.size.xl, fontWeight: '700', marginTop: space.sm, marginBottom: space.sm, color: c.text },
        heading2: { fontSize: font.size.lg, fontWeight: '700', marginTop: space.sm, marginBottom: space.xs, color: c.text },
        heading3: { fontSize: font.size.md, fontWeight: '700', marginTop: space.sm, marginBottom: space.xs, color: c.text },
        strong: { fontWeight: '700' },
        link: { color: c.accent },
        bullet_list: { marginBottom: space.sm },
        ordered_list: { marginBottom: space.sm },
        list_item: { marginBottom: 2 },
        code_inline: { fontFamily: font.mono, fontSize: 13, backgroundColor: c.surface2, color: c.text, borderRadius: 4, paddingHorizontal: 4 },
        code_block: { fontFamily: font.mono, fontSize: 12, backgroundColor: c.codeBg, color: c.text, borderRadius: radius.md, padding: space.md, borderWidth: 0 },
        fence: { fontFamily: font.mono, fontSize: 12, backgroundColor: c.codeBg, color: c.text, borderRadius: radius.md, padding: space.md, borderWidth: 0, marginBottom: space.sm },
        blockquote: { backgroundColor: c.surface2, borderLeftColor: c.accent, borderLeftWidth: 3, paddingHorizontal: space.md, marginBottom: space.sm },
        hr: { backgroundColor: c.border, marginVertical: space.md },
        table: { borderColor: c.border, marginBottom: space.sm },
        th: { padding: 6, borderColor: c.border },
        td: { padding: 6, borderColor: c.border },
        tr: { borderColor: c.border },
      }}
    >
      {text}
    </MarkdownDisplay>
  );
});
