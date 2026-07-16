// pythonExec — 共享的 Python 子进程执行工具
//
// CatBoostTrainer / NaiveBayesModel / LogisticRegressionModel 等通过此模块调用
// Python 脚本，避免重复实现 spawn 逻辑。

import { spawn } from 'node:child_process';
import { resolvePythonExecutable } from './pythonResolver.js';

/**
 * 执行 Python 脚本并返回 stdout（trim 后）。
 * 脚本路径和参数通过 args 传入，Python 可执行文件由 pythonResolver 决定。
 */
export function execPython(scriptPath: string, args: string[] = []): Promise<string> {
  const python = resolvePythonExecutable();
  return execPythonCommand([python, scriptPath, ...args]);
}

/**
 * 执行完整命令（第一个元素是可执行文件），返回 stdout。
 */
export function execPythonCommand(command: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python script failed (${code}): ${stderr || stdout}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });
  });
}
