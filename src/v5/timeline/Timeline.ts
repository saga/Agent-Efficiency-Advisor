// Agent Timeline: render a DevTools-like timeline of phases and events.

import type { RuntimeSnapshot, TimelineEntry } from '../runtime/types.js';

export function buildTimeline(snapshot: RuntimeSnapshot): TimelineEntry[] {
  return snapshot.events.map((event, i) => {
    const transition = snapshot.transitions.find((t) => t.event.id === event.id);
    return {
      timestamp: event.timestamp,
      phase: phaseAtTransition(snapshot, i),
      event,
      annotation: transition ? `${transition.from} → ${transition.to}` : undefined,
    };
  });
}

function phaseAtTransition(snapshot: RuntimeSnapshot, eventIndex: number): import('../runtime/types.js').AgentPhase {
  let phase: import('../runtime/types.js').AgentPhase = 'Idle';
  let consumed = 0;
  for (const transition of snapshot.transitions) {
    const idx = snapshot.events.findIndex((e) => e.id === transition.event.id);
    if (idx <= eventIndex) {
      phase = transition.to;
    }
  }
  return phase;
}

export function renderTimeline(snapshot: RuntimeSnapshot, width = 50): string {
  const entries = buildTimeline(snapshot);
  if (entries.length === 0) return '(empty timeline)';

  const start = entries[0].timestamp;
  const end = entries[entries.length - 1].timestamp;
  const span = Math.max(end - start, 1);

  const lines: string[] = ['─── Agent Timeline ───'];
  const phaseColors: Record<string, string> = {
    Idle: '·',
    Planning: 'P',
    Thinking: 'T',
    CallingTool: 'C',
    WaitingTool: 'W',
    Editing: 'E',
    Reviewing: 'R',
    Finished: 'F',
    Failed: 'X',
  };

  let bar = '';
  for (const entry of entries) {
    const pos = Math.floor(((entry.timestamp - start) / span) * width);
    while (bar.length <= pos) bar += ' ';
    bar += phaseColors[entry.phase] ?? '?';
  }

  lines.push(bar);
  lines.push('');

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const annot = entry.annotation ? `  [${entry.annotation}]` : '';
    const summary = summarizeEvent(entry.event);
    lines.push(`${time}  ${entry.phase.padEnd(12)} ${summary}${annot}`);
  }

  return lines.join('\n');
}

function summarizeEvent(event: import('../runtime/types.js').RuntimeEvent): string {
  switch (event.type) {
    case 'session_start':
      return `session start (limit=${event.payload.modelLimit ?? 'default'})`;
    case 'llm_request':
      return `llm prompt=${event.payload.promptTokens} completion=${event.payload.completionTokens} model=${event.payload.model ?? '?'}`;
    case 'tool_call':
      return `tool=${event.payload.tool} success=${event.payload.success ?? true}`;
    case 'edit':
      return `edit ${event.payload.file} (${event.payload.diffLines} lines)`;
    case 'session_end':
      return 'session end';
    case 'error':
      return `error: ${event.payload.message ?? 'unknown'}`;
    default:
      return event.type;
  }
}
