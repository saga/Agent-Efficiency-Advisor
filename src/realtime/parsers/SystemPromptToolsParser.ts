// SystemPromptToolsParser — 解析 debug-logs/{sessionId}/system_prompt_*.json
//                           和 tools_*.json
//
// system_prompt_*.json: Copilot 的完整系统提示文本(含 skills、agents、
//   parallel_tool_use_instructions、final_answer_instructions 等)。
// tools_*.json: 当前会话可用的 60+ 工具定义(文件操作、浏览器、终端、memory、
//   Python/Pylance、VS Code API、search、task、subagent、web fetch)。
//
// 价值:把 tool_call 事件映射到工具类别,构建"工具类别分布"特征;
//      识别"昂贵工具模式"(浏览器自动化 + multi_tool_use)。

import fs from 'node:fs';
import type {
  SkillDefinition,
  SubagentDefinition,
  SystemPromptAndTools,
  ToolCategory,
  ToolDefinition,
} from './types.js';

const TOOL_CATEGORY_RULES: Array<{ category: ToolCategory; patterns: RegExp[] }> = [
  {
    category: 'file',
    patterns: [
      /^create_file$/i,
      /^create_directory$/i,
      /^read_file$/i,
      /^replace_string_in_file$/i,
      /^multi_replace_string_in_file$/i,
      /^file_search$/i,
      /^grep_search$/i,
      /^list_dir$/i,
      /^get_errors$/i,
    ],
  },
  {
    category: 'browser',
    patterns: [
      /^open_browser_page$/i,
      /^click_element$/i,
      /^drag_element$/i,
      /^hover_element$/i,
      /^read_page$/i,
      /^screenshot_page$/i,
      /^type_in_page$/i,
      /^navigate_page$/i,
      /^run_playwright_code$/i,
      /^handle_dialog$/i,
    ],
  },
  {
    category: 'terminal',
    patterns: [/^run_in_terminal$/i, /^send_to_terminal$/i, /^get_terminal_output$/i, /^kill_terminal$/i, /^terminal_last_command$/i, /^terminal_selection$/i],
  },
  {
    category: 'memory',
    patterns: [/^memory$/i, /^resolve_memory_file_uri$/i],
  },
  {
    category: 'search',
    patterns: [/^semantic_search$/i, /^grep_search$/i, /^file_search$/i, /^github_repo$/i, /^github_text_search$/i],
  },
  {
    category: 'python',
    patterns: [/^configure_python_environment$/i, /^get_python_environment_details$/i, /^get_python_executable_details$/i, /^install_python_packages$/i, /^mcp_provides_tool_pylance/i],
  },
  {
    category: 'vscode',
    patterns: [/^run_vscode_command$/i, /^vscode_/i, /^get_vscode_api$/i, /^install_extension$/i, /^vscode_searchExtensions/i, /^get_errors$/i, /^create_and_run_task$/i, /^get_task_output$/i],
  },
  {
    category: 'task',
    patterns: [/^manage_todo_list$/i, /^create_and_run_task$/i, /^get_task_output$/i],
  },
  {
    category: 'subagent',
    patterns: [/^runSubagent$/i],
  },
  {
    category: 'web',
    patterns: [/^fetch_webpage$/i],
  },
  {
    category: 'notebook',
    patterns: [/^create_new_jupyter_notebook$/i, /^edit_notebook_file$/i, /^read_notebook_cell_output$/i, /^run_notebook_cell$/i, /^copilot_getNotebookSummary$/i],
  },
  {
    category: 'mcp',
    patterns: [/^mcp_provides_tool/i],
  },
];

const EMPTY_CATEGORY_COUNTS: Record<ToolCategory, number> = {
  file: 0,
  browser: 0,
  terminal: 0,
  memory: 0,
  search: 0,
  python: 0,
  vscode: 0,
  task: 0,
  subagent: 0,
  web: 0,
  notebook: 0,
  mcp: 0,
  unknown: 0,
};

export class SystemPromptToolsParser {
  /**
   * 解析一个 debug-logs/{sessionId}/ 目录下的 system_prompt_*.json 和 tools_*.json。
   * @param debugLogDir debug-logs/{sessionId}/ 目录路径
   * @param sessionId 会话 ID
   */
  parseDir(debugLogDir: string, sessionId: string): SystemPromptAndTools {
    let systemPromptText = '';
    const tools: ToolDefinition[] = [];
    let skills: SkillDefinition[] = [];
    let subagents: SubagentDefinition[] = [];

    // 解析 system_prompt_*.json
    const promptFiles = fs
      .readdirSync(debugLogDir)
      .filter((f) => /^system_prompt_\d+\.json$/.test(f))
      .sort();
    for (const f of promptFiles) {
      const raw = fs.readFileSync(`${debugLogDir}/${f}`, 'utf-8');
      try {
        const parsed = JSON.parse(raw) as { content?: string };
        // content 是一个 JSON 字符串: [{type:"text","content":"..."}]
        if (parsed.content) {
          try {
            const inner = JSON.parse(parsed.content) as Array<{ type: string; content: string }>;
            for (const item of inner) {
              if (item.type === 'text' && item.content) {
                systemPromptText += item.content + '\n';
                // 从系统提示文本中提取 skills 和 agents
                skills = this.extractSkills(item.content, skills);
                subagents = this.extractSubagents(item.content, subagents);
              }
            }
          } catch {
            // content 不是 JSON,直接当文本
            systemPromptText += parsed.content + '\n';
          }
        }
      } catch {
        // 忽略解析失败
      }
    }

    // 解析 tools_*.json
    const toolFiles = fs
      .readdirSync(debugLogDir)
      .filter((f) => /^tools_\d+\.json$/.test(f))
      .sort();
    for (const f of toolFiles) {
      const raw = fs.readFileSync(`${debugLogDir}/${f}`, 'utf-8');
      try {
        const parsed = JSON.parse(raw) as { content?: string };
        if (parsed.content) {
          try {
            const inner = JSON.parse(parsed.content) as Array<Record<string, unknown>>;
            for (const toolDef of inner) {
              const name = String(toolDef.name ?? '');
              if (name) {
                tools.push({
                  name,
                  description: String(toolDef.description ?? ''),
                  category: this.categorizeTool(name),
                  raw: toolDef,
                });
              }
            }
          } catch {
            // 忽略
          }
        }
      } catch {
        // 忽略
      }
    }

    const toolCategoryCounts = { ...EMPTY_CATEGORY_COUNTS };
    for (const t of tools) {
      toolCategoryCounts[t.category]++;
    }

    return {
      sessionId,
      systemPromptText: systemPromptText.trim(),
      tools,
      skills,
      subagents,
      toolCategoryCounts,
    };
  }

  private categorizeTool(name: string): ToolCategory {
    for (const rule of TOOL_CATEGORY_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(name)) return rule.category;
      }
    }
    return 'unknown';
  }

  /**
   * 从系统提示文本中提取 <skill> 块。
   * 格式:
   *   <skill>
   *   <name>chronicle</name>
   *   <description>...</description>
   *   <file>/path/to/SKILL.md</file>
   *   </skill>
   */
  private extractSkills(text: string, existing: SkillDefinition[]): SkillDefinition[] {
    const result = [...existing];
    const skillRegex = /<skill>\s*<name>([^<]+)<\/name>\s*<description>([^<]*)<\/description>\s*(?:<file>([^<]+)<\/file>)?\s*<\/skill>/g;
    let match: RegExpExecArray | null;
    while ((match = skillRegex.exec(text)) !== null) {
      const name = match[1].trim();
      if (!result.find((s) => s.name === name)) {
        result.push({
          name,
          description: match[2].trim(),
          file: match[3]?.trim(),
        });
      }
    }
    return result;
  }

  /**
   * 从系统提示文本中提取 <agent> 块。
   * 格式:
   *   <agent>
   *   <name>Explore</name>
   *   <description>...</description>
   *   <argumentHint>...</argumentHint>
   *   </agent>
   */
  private extractSubagents(text: string, existing: SubagentDefinition[]): SubagentDefinition[] {
    const result = [...existing];
    const agentRegex = /<agent>\s*<name>([^<]+)<\/name>\s*(?:<description>([^<]*)<\/description>)?\s*(?:<argumentHint>([^<]*)<\/argumentHint>)?\s*<\/agent>/g;
    let match: RegExpExecArray | null;
    while ((match = agentRegex.exec(text)) !== null) {
      const name = match[1].trim();
      if (!result.find((a) => a.name === name)) {
        result.push({
          name,
          description: match[2]?.trim(),
          argumentHint: match[3]?.trim(),
        });
      }
    }
    return result;
  }
}
