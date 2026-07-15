// EntityBuilder — 从 Event + Feature 构建 Canonical Entity。
// v7.md: "Event → EntityBuilder → GraphBuilder"
//         "Feature → EntityBuilder → GraphBuilder"
//
// EntityBuilder 是 Event/Feature 与 Graph/Embedding/LLM 之间的唯一桥梁。
// Graph 不再直接读 Event，而是通过 EntityBuilder 获取 Entity。

import type { IDEEvent } from '../store/types.js';
import type {
  CommitRef,
  CompletionEntity,
  EntityBundle,
  FailureEntity,
  FileRef,
  OutcomeMarker,
  PromptEntity,
  SessionEntity,
  ToolInvocationEntity,
  WorkspaceEntity,
} from './types.js';

export class EntityBuilder {
  /**
   * 从一个 session 的事件序列构建 EntityBundle。
   * @param events 该 session 的所有事件（按时间排序）
   * @param featureVersion 可选：关联的 feature 版本号（v7.md #7）
   */
  buildBundle(events: IDEEvent[], featureVersion?: number): EntityBundle | null {
    if (events.length === 0) return null;

    const sessionId = events[0].sessionId;
    const workspaceId = events[0].workspaceId;
    const startTime = events[0].timestamp;
    const endTime = events[events.length - 1].timestamp;

    const session: SessionEntity = {
      id: sessionId,
      workspaceId,
      startTime,
      endTime,
      duration: endTime - startTime,
      featureVersion,
      outcome: 'unknown',
    };

    const workspace = this.buildWorkspace(workspaceId, events);
    const prompts = this.buildPrompts(events, sessionId);
    const completions = this.buildCompletions(events, sessionId);
    const toolInvocations = this.buildToolInvocations(events, sessionId);
    const failures = this.buildFailures(events, sessionId);
    const outcomes = this.buildOutcomes(events, sessionId, completions);
    const files = this.buildFiles(events);
    const commits = this.buildCommits(events, sessionId);
    const promptFileLinks = this.buildPromptFileLinks(events);

    return {
      session,
      workspace,
      prompts,
      completions,
      toolInvocations,
      failures,
      outcomes,
      files,
      commits,
      promptFileLinks,
    };
  }

  private buildWorkspace(workspaceId: string, events: IDEEvent[]): WorkspaceEntity {
    const files = new Set<string>();
    const languages = new Set<string>();
    const dependencies = new Set<string>();
    const branches = new Set<string>();
    let totalLOC = 0;

    for (const e of events) {
      const path = String(e.metadata.path ?? e.metadata.file ?? '');
      if (path) files.add(path);
      const lang = String(e.metadata.language ?? '');
      if (lang) languages.add(lang);
      const branch = String(e.metadata.branch ?? '');
      if (branch) branches.add(branch);
      if (typeof e.metadata.loc === 'number') totalLOC += e.metadata.loc;

      if (e.eventType === 'session_start') {
        const langs = e.metadata.languages;
        if (Array.isArray(langs)) for (const l of langs) languages.add(String(l));
        const deps = e.metadata.dependencies;
        if (Array.isArray(deps)) for (const d of deps) dependencies.add(String(d));
      }
    }

    return {
      id: workspaceId,
      files: Array.from(files),
      languages: Array.from(languages),
      dependencies: Array.from(dependencies),
      branches: Array.from(branches),
      totalLOC,
    };
  }

  private buildPrompts(events: IDEEvent[], sessionId: string): PromptEntity[] {
    const out: PromptEntity[] = [];
    for (const e of events) {
      if (e.eventType !== 'chat') continue;
      const promptId = String(e.metadata.promptId ?? `prompt-${e.id ?? e.timestamp}`);
      out.push({
        id: promptId,
        sessionId,
        tokenCount: Number(e.metadata.tokenCount ?? 0),
        historyLength: Number(e.metadata.historyLength ?? 0),
        retrievedFiles: Number(e.metadata.retrievedFiles ?? 0),
        retrievedSymbols: Number(e.metadata.retrievedSymbols ?? 0),
        contextToken: Number(e.metadata.contextToken ?? e.metadata.tokenCount ?? 0),
        historyToken: Number(e.metadata.historyToken ?? 0),
        timestamp: e.timestamp,
      });
    }
    return out;
  }

  private buildCompletions(events: IDEEvent[], sessionId: string): CompletionEntity[] {
    const out: CompletionEntity[] = [];
    for (const e of events) {
      if (e.eventType !== 'completion') continue;
      const id = `completion:${sessionId}:${e.id ?? e.timestamp}`;
      out.push({
        id,
        sessionId,
        tokenCount: Number(e.metadata.tokenCount ?? 0),
        model: String(e.metadata.model ?? 'unknown'),
        timestamp: e.timestamp,
      });
    }
    return out;
  }

  private buildToolInvocations(events: IDEEvent[], sessionId: string): ToolInvocationEntity[] {
    const out: ToolInvocationEntity[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      if (!['run_test', 'terminal', 'tool_call', 'commit'].includes(e.eventType)) continue;
      const toolName = String(e.metadata.toolName ?? e.eventType);
      const dedupKey = `${toolName}@${sessionId}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      let toolKind: ToolInvocationEntity['toolKind'] = 'other';
      if (e.eventType === 'terminal' || toolName.includes('terminal') || toolName.includes('bash')) toolKind = 'terminal';
      else if (e.eventType === 'commit' || toolName.includes('git')) toolKind = 'git';
      else if (toolName.includes('mcp')) toolKind = 'mcp';
      else if (e.eventType === 'run_test' || toolName.includes('test')) toolKind = 'test';
      else if (e.eventType === 'read_file' || e.eventType === 'edit' || toolName.includes('file')) toolKind = 'filesystem';

      out.push({
        id: dedupKey,
        sessionId,
        toolName,
        toolKind,
        timestamp: e.timestamp,
        success: typeof e.metadata.success === 'boolean' ? e.metadata.success : undefined,
      });
    }
    return out;
  }

  private buildFailures(events: IDEEvent[], sessionId: string): FailureEntity[] {
    const out: FailureEntity[] = [];
    const types = events.map((e) => e.eventType);

    let burstStart = -1, burstLen = 0;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'retry') {
        if (burstStart < 0) burstStart = i;
        burstLen++;
      } else {
        if (burstLen >= 3 && burstStart >= 0) {
          out.push({
            id: `failure:${sessionId}:retry_burst:${burstStart}`,
            sessionId,
            failureType: 'retry_loop',
            confidence: 0.7,
            evidence: [`consecutive retries=${burstLen} at event #${burstStart}`],
            timestamp: events[burstStart].timestamp,
          });
        }
        burstStart = -1;
        burstLen = 0;
      }
    }
    if (burstLen >= 3 && burstStart >= 0) {
      out.push({
        id: `failure:${sessionId}:retry_burst:${burstStart}`,
        sessionId,
        failureType: 'retry_loop',
        confidence: 0.7,
        evidence: [`consecutive retries=${burstLen} at event #${burstStart}`],
        timestamp: events[burstStart].timestamp,
      });
    }

    const hasAccept = types.includes('accept');
    if (types[types.length - 1] === 'reject' && !hasAccept) {
      out.push({
        id: `failure:${sessionId}:user_cancel:${events.length - 1}`,
        sessionId,
        failureType: 'user_cancel',
        confidence: 0.8,
        evidence: ['session ends with reject, no accepts'],
        timestamp: events[events.length - 1].timestamp,
      });
    }

    return out;
  }

  /**
   * 构建 accept/reject/retry 时序标记，并关联到最近的 completion。
   */
  private buildOutcomes(events: IDEEvent[], sessionId: string, completions: CompletionEntity[]): OutcomeMarker[] {
    const out: OutcomeMarker[] = [];
    let completionIdx = -1;
    for (const ev of events) {
      if (ev.eventType === 'completion') {
        completionIdx++;
        continue;
      }
      if (ev.eventType === 'accept' || ev.eventType === 'reject' || ev.eventType === 'retry') {
        const completionId = completionIdx >= 0 ? completions[completionIdx]?.id : undefined;
        out.push({
          kind: ev.eventType,
          completionId,
          timestamp: ev.timestamp,
          eventRef: ev.id,
        });
      }
    }
    return out;
  }

  private buildFiles(events: IDEEvent[]): FileRef[] {
    const out: FileRef[] = [];
    for (const e of events) {
      if (e.eventType !== 'read_file') continue;
      out.push({
        path: String(e.metadata.path ?? 'unknown'),
        timestamp: e.timestamp,
      });
    }
    return out;
  }

  private buildCommits(events: IDEEvent[], sessionId: string): CommitRef[] {
    const out: CommitRef[] = [];
    for (const e of events) {
      if (e.eventType !== 'commit') continue;
      out.push({
        branch: String(e.metadata.branch ?? 'unknown'),
        author: String(e.metadata.author ?? 'unknown'),
        timestamp: e.timestamp,
        eventRef: e.id,
      });
    }
    return out;
  }

  /**
   * 构建 chat 事件与之前 read_file 的关联（用于 prompt_file 边）。
   */
  private buildPromptFileLinks(events: IDEEvent[]): { promptId: string; files: string[]; timestamp: number }[] {
    const out: { promptId: string; files: string[]; timestamp: number }[] = [];
    let buffered: string[] = [];
    for (const e of events) {
      if (e.eventType === 'read_file') {
        buffered.push(String(e.metadata.path ?? 'unknown'));
      } else if (e.eventType === 'chat') {
        const promptId = String(e.metadata.promptId ?? `prompt-${e.id ?? e.timestamp}`);
        out.push({ promptId, files: buffered, timestamp: e.timestamp });
        buffered = [];
      }
    }
    return out;
  }
}
