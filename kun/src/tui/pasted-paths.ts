import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_PASTED_PATHS = 8

/**
 * Parse only an explicit path-shaped bracketed paste. Ordinary prose is never
 * interpreted as a file reference, even if it happens to mention a path.
 *
 * This follows the useful intersection of OpenCode and Kimi Code:
 * - Finder / Explorer `file://` values
 * - shell-quoted paths and terminal-escaped spaces
 * - absolute paths plus explicit `./`, `../`, and `~/` paths
 * - NUL or newline separated multi-file clipboard payloads
 */
export function parsePastedFilePaths(
  pastedText: string,
  workspace: string,
  userHome = homedir()
): string[] {
  const normalized = pastedText.replace(/\r\n?/gu, '\n')
  const lines = normalized
    .replaceAll('\0', '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0 || lines.length > MAX_PASTED_PATHS) return []

  const paths: string[] = []
  for (const rawLine of lines) {
    const decoded = decodePastedPath(rawLine, workspace, userHome)
    if (!decoded) return []
    if (!paths.includes(decoded)) paths.push(decoded)
  }
  return paths
}

function decodePastedPath(rawLine: string, workspace: string, userHome: string): string | undefined {
  let value = stripMatchingQuotes(rawLine)
  if (!value) return undefined

  if (value.startsWith('file://')) {
    try {
      return fileURLToPath(value)
    } catch {
      return undefined
    }
  }

  // Terminal "Copy Path" actions commonly escape spaces and punctuation for
  // a POSIX shell. Decode only the harmless one-character quoting form; this
  // parser never evaluates shell syntax or expands environment variables.
  value = value
    .replace(/\\([\\ "'(){}])/gu, '$1')
    .replaceAll('\\[', '[')
    .replaceAll('\\]', ']')
  if (value === '~') return userHome
  if (value.startsWith('~/')) return resolve(userHome, value.slice(2))
  if (isAbsolute(value)) return value
  if (value.startsWith('./') || value.startsWith('../')) return resolve(workspace, value)
  return undefined
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value.at(-1)
  return (first === "'" || first === '"') && last === first
    ? value.slice(1, -1)
    : value
}
