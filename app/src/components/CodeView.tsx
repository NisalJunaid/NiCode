import { useMemo } from 'react';
import { WebView } from 'react-native-webview';
import { useColors, useIsDark } from '@/theme';

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json',
  php: 'php', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp',
  cs: 'csharp', css: 'css', scss: 'scss', html: 'xml', vue: 'xml', xml: 'xml', svg: 'xml', md: 'markdown', yml: 'yaml', yaml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', toml: 'ini', ini: 'ini', env: 'bash', dockerfile: 'dockerfile', blade: 'xml',
};

export function languageFor(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name.startsWith('.env')) return 'bash';
  if (name.endsWith('.blade.php')) return 'xml';
  return LANG[name.split('.').pop() ?? ''] ?? 'plaintext';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Read-only code view with syntax highlighting and line numbers (highlight.js in a WebView).
 * Scrolls both ways, supports pinch-free reading via wrap toggle, and jumps to a line.
 */
export function CodeView({ code, path, line, wrap }: { code: string; path: string; line?: number; wrap: boolean }) {
  const c = useColors();
  const dark = useIsDark();
  const html = useMemo(() => {
    const lang = languageFor(path);
    const lines = code.split('\n');
    const nums = lines.map((_, i) => `<span id="L${i + 1}">${i + 1}</span>`).join('\n');
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=3">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/styles/${dark ? 'github-dark' : 'github'}.min.css">
<script src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js"></script>
<style>
  html,body{margin:0;background:${c.codeBg};color:${c.text};}
  .wrap{display:flex;font:12.5px/1.55 ui-monospace,Menlo,monospace;}
  .nums{padding:12px 8px 40px 10px;text-align:right;color:${c.textFaint};user-select:none;white-space:pre;border-right:1px solid ${c.border};}
  .nums span.hl{color:${c.accent};font-weight:700}
  pre{margin:0;padding:12px 12px 40px;flex:1;min-width:0;${wrap ? 'white-space:pre-wrap;word-break:break-word;' : 'white-space:pre;overflow-x:auto;'}}
  code.hljs{background:transparent;padding:0}
</style></head><body>
<div class="wrap"><div class="nums">${nums}</div><pre><code class="language-${lang}">${escapeHtml(code)}</code></pre></div>
<script>
  try { hljs.highlightAll(); } catch (e) {}
  ${line ? `var el=document.getElementById('L${line}'); if(el){el.className='hl'; window.scrollTo(0, Math.max(0, el.offsetTop - 120));}` : ''}
</script></body></html>`;
  }, [code, path, line, wrap, dark, c]);

  return <WebView originWhitelist={['*']} source={{ html }} style={{ flex: 1, backgroundColor: c.codeBg }} setSupportMultipleWindows={false} />;
}
