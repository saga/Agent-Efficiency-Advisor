import fs from 'node:fs';
import path from 'node:path';

export function resolvePythonExecutable(): string {
  // 1. Respect explicit environment override
  if (process.env.AEA_PYTHON) return path.resolve(process.env.AEA_PYTHON);

  // 2. Prefer project-local uv venv
  const venvNames = ['.venv', 'venv'];
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const exeName = process.platform === 'win32' ? 'python.exe' : 'python';

  for (const venv of venvNames) {
    const candidate = path.resolve(process.cwd(), venv, binDir, exeName);
    if (fs.existsSync(candidate)) return candidate;
  }

  // 3. Fallback to system python3 / python
  return process.platform === 'win32' ? 'python' : 'python3';
}
