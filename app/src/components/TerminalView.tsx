import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { WebView } from 'react-native-webview';
import { useColors } from '@/theme';

export interface TerminalHandle {
  write(b64: string): void;
  clear(): void;
  focus(): void;
  setCtrl(on: boolean): void;
  sendKey(seq: string): void;
}

type Msg = { type: 'ready' | 'resize'; cols: number; rows: number } | { type: 'input'; data: string } | { type: 'ctrlUsed' };

/** xterm.js in a WebView. Output in via injectJavaScript (fast), input out via postMessage. */
export const TerminalView = forwardRef<TerminalHandle, { onReady: (cols: number, rows: number) => void; onInput: (b64: string) => void; onResize: (cols: number, rows: number) => void; onCtrlUsed: () => void }>(
  function TerminalView({ onReady, onInput, onResize, onCtrlUsed }, ref) {
    const c = useColors();
    const web = useRef<WebView>(null);
    const html = useMemo(
      () => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<style>html,body{margin:0;height:100%;background:${c.codeBg};overflow:hidden}#t{position:absolute;inset:4px 2px 0 6px}</style>
</head><body><div id="t"></div><script>
  const post = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
  const enc = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const dec = (b) => new TextDecoder().decode(Uint8Array.from(atob(b), (x) => x.charCodeAt(0)));
  const term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace', cursorBlink: true, scrollback: 5000,
    theme: { background: '${c.codeBg}', foreground: '${c.text}', cursor: '${c.accent}', selectionBackground: '${c.accentSoft}' } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(document.getElementById('t'));
  let ctrl = false;
  term.onData((d) => {
    if (ctrl && d.length === 1) { const ch = d.toUpperCase().charCodeAt(0); if (ch >= 64 && ch <= 95) d = String.fromCharCode(ch - 64); ctrl = false; post({ type: 'ctrlUsed' }); }
    post({ type: 'input', data: enc(d) });
  });
  const doFit = () => { try { fit.fit(); } catch (e) {} };
  let last = '';
  new ResizeObserver(() => { doFit(); const k = term.cols + 'x' + term.rows; if (k !== last) { last = k; post({ type: 'resize', cols: term.cols, rows: term.rows }); } }).observe(document.body);
  window.__write = (b) => term.write(dec(b));
  window.__clear = () => term.reset();
  window.__focus = () => term.focus();
  window.__ctrl = (on) => { ctrl = on; term.focus(); };
  window.__key = (s) => post({ type: 'input', data: enc(s) });
  document.addEventListener('touchend', () => term.focus());
  doFit(); last = term.cols + 'x' + term.rows; post({ type: 'ready', cols: term.cols, rows: term.rows });
</script></body></html>`,
      [c],
    );

    useImperativeHandle(ref, () => ({
      write: (b64) => web.current?.injectJavaScript(`window.__write(${JSON.stringify(b64)});true;`),
      clear: () => web.current?.injectJavaScript('window.__clear();true;'),
      focus: () => web.current?.injectJavaScript('window.__focus();true;'),
      setCtrl: (on) => web.current?.injectJavaScript(`window.__ctrl(${on});true;`),
      sendKey: (seq) => web.current?.injectJavaScript(`window.__key(${JSON.stringify(seq)});true;`),
    }));

    return (
      <WebView
        ref={web}
        originWhitelist={['*']}
        source={{ html }}
        style={{ flex: 1, backgroundColor: c.codeBg }}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        bounces={false}
        overScrollMode="never"
        onMessage={(e) => {
          let m: Msg;
          try {
            m = JSON.parse(e.nativeEvent.data) as Msg;
          } catch {
            return;
          }
          if (m.type === 'ready') onReady(m.cols, m.rows);
          else if (m.type === 'resize') onResize(m.cols, m.rows);
          else if (m.type === 'input') onInput(m.data);
          else if (m.type === 'ctrlUsed') onCtrlUsed();
        }}
      />
    );
  },
);
