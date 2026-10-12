/**
 * Turns the raw Claude stream (SeqEvent[]) into chat items. Pure function, easy to test.
 * Tool results are merged into the card of the tool call they answer.
 */
import type { SeqEvent } from '@protocol';

export type ChatItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; id: string; name: string; input: Record<string, unknown>; result?: { text: string; isError: boolean } }
  | { kind: 'result'; key: string; ok: boolean; durationMs?: number; costUsd?: number; text?: string }
  | { kind: 'notice'; key: string; tone: 'info' | 'warning' | 'danger'; text: string }
  | { kind: 'init'; key: string; model?: string };

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: Block) => (b?.type === 'text' ? (b.text ?? '') : b?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

export function buildChatItems(events: SeqEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolIndex = new Map<string, number>();
  let sawInit = false;

  for (const { seq, event: ev } of events) {
    const key = String(seq);
    const message = (ev as { message?: { content?: unknown } }).message;
    const blocks: Block[] = Array.isArray(message?.content) ? (message!.content as Block[]) : [];

    switch (ev.type) {
      case 'nicode': {
        const sub = ev.subtype as string | undefined;
        const text = typeof ev.text === 'string' ? ev.text : '';
        if (sub === 'user_turn') items.push({ kind: 'user', key, text });
        else if (sub === 'interrupted') items.push({ kind: 'notice', key, tone: 'info', text: 'Stopped' });
        else if (sub === 'process_exit') items.push({ kind: 'notice', key, tone: 'danger', text: text || 'Claude stopped unexpectedly' });
        else if (sub === 'stderr' && text.trim()) items.push({ kind: 'notice', key, tone: 'warning', text });
        break;
      }
      case 'system':
        if (ev.subtype === 'init' && !sawInit) {
          sawInit = true;
          items.push({ kind: 'init', key, model: typeof ev.model === 'string' ? ev.model : undefined });
        }
        break;
      case 'assistant':
        blocks.forEach((b, i) => {
          const k = `${key}.${i}`;
          if (b.type === 'text' && b.text?.trim()) items.push({ kind: 'text', key: k, text: b.text });
          else if (b.type === 'thinking' && (b.thinking ?? b.text)?.trim()) items.push({ kind: 'thinking', key: k, text: b.thinking ?? b.text ?? '' });
          else if (b.type === 'tool_use' && b.id) {
            toolIndex.set(b.id, items.length);
            items.push({ kind: 'tool', key: k, id: b.id, name: b.name ?? 'Tool', input: (b.input as Record<string, unknown>) ?? {} });
          }
        });
        break;
      case 'user':
        for (const b of blocks) {
          if (b.type !== 'tool_result' || !b.tool_use_id) continue;
          const idx = toolIndex.get(b.tool_use_id);
          const item = idx === undefined ? undefined : items[idx];
          if (item?.kind === 'tool') items[idx!] = { ...item, result: { text: contentText(b.content), isError: !!b.is_error } };
        }
        break;
      case 'result': {
        const ok = ev.subtype === 'success' && !ev.is_error;
        items.push({
          kind: 'result',
          key,
          ok,
          durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : undefined,
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
          text: !ok && typeof ev.result === 'string' ? ev.result : undefined,
        });
        break;
      }
      default:
        break; // unknown event types are ignored in the chat view
    }
  }
  return items;
}

/** One-line description of a tool call for its card header. */
export function toolSummary(name: string, input: Record<string, unknown>): { icon: string; title: string; detail: string } {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const file = s('file_path') || s('path') || s('notebook_path');
  const short = (p: string) => p.split(/[\\/]/).slice(-2).join('/');
  switch (name) {
    case 'Bash':
      return { icon: 'terminal-outline', title: s('description') || 'Run command', detail: s('command') };
    case 'Read':
      return { icon: 'document-text-outline', title: 'Read', detail: short(file) };
    case 'Edit':
    case 'MultiEdit':
      return { icon: 'create-outline', title: 'Edit', detail: short(file) };
    case 'Write':
      return { icon: 'document-outline', title: 'Write', detail: short(file) };
    case 'NotebookEdit':
      return { icon: 'create-outline', title: 'Edit notebook', detail: short(file) };
    case 'Glob':
      return { icon: 'search-outline', title: 'Find files', detail: s('pattern') };
    case 'Grep':
      return { icon: 'search-outline', title: 'Search', detail: s('pattern') };
    case 'WebFetch':
      return { icon: 'globe-outline', title: 'Fetch', detail: s('url') };
    case 'WebSearch':
      return { icon: 'globe-outline', title: 'Web search', detail: s('query') };
    case 'TodoWrite':
      return { icon: 'list-outline', title: 'Plan', detail: `${Array.isArray(input.todos) ? input.todos.length : 0} steps` };
    case 'Task':
    case 'Agent':
      return { icon: 'people-outline', title: 'Sub-agent', detail: s('description') || s('prompt').slice(0, 80) };
    default:
      return { icon: 'construct-outline', title: name.replace(/^mcp__\w+__/, ''), detail: '' };
  }
}
