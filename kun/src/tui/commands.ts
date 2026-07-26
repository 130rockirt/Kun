import type { SlashCommand } from '@earendil-works/pi-tui'
import type { TuiKeyAction } from './keymap.js'

export type TuiCommandDefinition = {
  id: string
  title: string
  category: 'Global' | 'Session' | 'Model' | 'Display' | 'Workspace'
  slash?: string
  keyAction?: TuiKeyAction
  argumentRequired?: boolean
  available: boolean
}

export type TuiCommand =
  | { kind: 'help' }
  | { kind: 'threads'; search?: string }
  | { kind: 'new'; title?: string }
  | { kind: 'open'; threadId: string }
  | { kind: 'rename'; title: string }
  | { kind: 'archive' }
  | { kind: 'fork'; title?: string }
  | { kind: 'compact' }
  | { kind: 'connect' }
  | { kind: 'model' }
  | { kind: 'reasoning' }
  | { kind: 'mouse'; action?: string }
  | { kind: 'variants' }
  | { kind: 'status' }
  | { kind: 'copy' }
  | { kind: 'export'; path?: string }
  | { kind: 'details' }
  | { kind: 'permission' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'init'; instructions?: string }
  | { kind: 'mcp' }
  | { kind: 'timeline'; query?: string }
  | { kind: 'jump'; target?: string }
  | { kind: 'subagents' }
  | { kind: 'tasks' }
  | { kind: 'plan'; action?: string }
  | { kind: 'goal'; action?: string }
  | { kind: 'skills'; query?: string }
  | { kind: 'skill'; name: string; prompt?: string }
  | { kind: 'editor'; initial?: string }
  | { kind: 'add-dir'; path: string }
  | { kind: 'btw'; question: string }
  | { kind: 'context' }
  | { kind: 'queue' }
  | { kind: 'quit' }
  | { kind: 'usage'; usage: string }
  | { kind: 'unknown'; name: string }

export const TUI_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'sessions', description: 'Search, resume, pin, or delete sessions', argumentHint: '[search]' },
  { name: 'resume', description: 'Alias for /sessions', argumentHint: '[search]' },
  { name: 'continue', description: 'Alias for /sessions', argumentHint: '[search]' },
  { name: 'threads', description: 'Compatibility alias for /sessions', argumentHint: '[search]' },
  { name: 'new', description: 'Create a terminal session', argumentHint: '[title]' },
  { name: 'clear', description: 'Alias for /new', argumentHint: '[title]' },
  { name: 'open', description: 'Open a session by id', argumentHint: '<session-id>' },
  { name: 'rename', description: 'Rename the active session', argumentHint: '<title>' },
  { name: 'title', description: 'Alias for /rename', argumentHint: '<title>' },
  { name: 'archive', description: 'Archive the active session' },
  { name: 'fork', description: 'Fork the active session', argumentHint: '[title]' },
  { name: 'compact', description: 'Compact the active conversation' },
  { name: 'summarize', description: 'Alias for /compact' },
  { name: 'connect', description: 'Configure a shared model connection' },
  { name: 'provider', description: 'Alias for /connect' },
  { name: 'model', description: 'Select the shared provider and model' },
  { name: 'models', description: 'Alias for /model' },
  { name: 'variants', description: 'Choose the model reasoning effort' },
  { name: 'thinking', description: 'Expand or collapse accumulated reasoning text' },
  { name: 'reasoning', description: 'Compatibility alias for /thinking' },
  { name: 'mouse', description: 'Toggle Pointer mode for clickable transcript rows', argumentHint: '[on|off]' },
  { name: 'status', description: 'Show session, model, workspace, permissions, and connection' },
  { name: 'copy', description: 'Copy the last Kun response' },
  { name: 'export', description: 'Export the active session as Markdown', argumentHint: '[path]' },
  { name: 'details', description: 'Expand or collapse tool details' },
  { name: 'permission', description: 'Choose approval and sandbox policies' },
  { name: 'undo', description: 'Undo the last user turn in a preserved branch' },
  { name: 'redo', description: 'Move to the next preserved branch when available' },
  { name: 'init', description: 'Analyze the project and create or update AGENTS.md', argumentHint: '[guidance]' },
  { name: 'mcp', description: 'Show shared MCP server and tool status' },
  { name: 'timeline', description: 'Browse turns and fork at a turn', argumentHint: '[search]' },
  { name: 'jump', description: 'Jump to a numbered or matching turn', argumentHint: '[target]' },
  { name: 'subagents', description: 'Browse and open delegated child sessions' },
  { name: 'tasks', description: 'Show plan tasks, subagents, and background shells' },
  { name: 'plan', description: 'View or change plan mode', argumentHint: '[plan|agent]' },
  { name: 'goal', description: 'View or manage the persistent goal', argumentHint: '[objective|pause|resume|clear]' },
  { name: 'skills', description: 'Browse workspace-visible skills', argumentHint: '[search]' },
  { name: 'editor', description: 'Edit the composer in VISUAL or EDITOR', argumentHint: '[draft]' },
  { name: 'add-dir', description: 'Add a persisted workspace root', argumentHint: '<path>' },
  { name: 'btw', description: 'Ask a question in a side session', argumentHint: '<question>' },
  { name: 'context', description: 'Show token and context usage' },
  { name: 'queue', description: 'Show queued steer messages' },
  { name: 'help', description: 'Show TUI help' },
  { name: 'quit', description: 'Exit the TUI' },
  { name: 'q', description: 'Alias for /quit' }
]

/**
 * Semantic actions shared by the command palette, help, leader hints, and key
 * dispatcher. Slash autocomplete includes the aliases above, while every
 * executable product action has one canonical entry here.
 */
export const TUI_COMMAND_DEFINITIONS: readonly TuiCommandDefinition[] = [
  { id: 'command_list', title: 'Open command palette', category: 'Global', keyAction: 'command_list', available: true },
  { id: 'sessions', title: 'Switch session', category: 'Session', slash: 'sessions', keyAction: 'session_list', available: true },
  { id: 'new', title: 'New session', category: 'Session', slash: 'new', keyAction: 'session_new', available: true },
  { id: 'open', title: 'Open session by ID', category: 'Session', slash: 'open', argumentRequired: true, available: true },
  { id: 'timeline', title: 'Open timeline', category: 'Session', slash: 'timeline', keyAction: 'session_timeline', available: true },
  { id: 'jump', title: 'Jump to a turn', category: 'Session', slash: 'jump', available: true },
  { id: 'rename', title: 'Rename session', category: 'Session', slash: 'rename', keyAction: 'session_rename', argumentRequired: true, available: true },
  { id: 'archive', title: 'Archive session', category: 'Session', slash: 'archive', available: true },
  { id: 'fork', title: 'Fork session', category: 'Session', slash: 'fork', available: true },
  { id: 'compact', title: 'Compact session', category: 'Session', slash: 'compact', keyAction: 'session_compact', available: true },
  { id: 'export', title: 'Export Markdown', category: 'Session', slash: 'export', keyAction: 'session_export', available: true },
  { id: 'status', title: 'Show status', category: 'Session', slash: 'status', keyAction: 'session_status', available: true },
  { id: 'copy', title: 'Copy last Kun response', category: 'Session', slash: 'copy', keyAction: 'messages_copy', available: true },
  { id: 'undo', title: 'Undo in a safe branch', category: 'Session', slash: 'undo', keyAction: 'session_undo', available: true },
  { id: 'redo', title: 'Redo to preserved branch', category: 'Session', slash: 'redo', keyAction: 'session_redo', available: true },
  { id: 'connect', title: 'Connect model provider', category: 'Model', slash: 'connect', available: true },
  { id: 'model', title: 'Select model', category: 'Model', slash: 'model', keyAction: 'model_list', available: true },
  { id: 'variants', title: 'Select reasoning effort', category: 'Model', slash: 'variants', keyAction: 'variant_cycle', available: true },
  { id: 'thinking', title: 'Expand or collapse Thinking', category: 'Display', slash: 'thinking', keyAction: 'thinking_toggle', available: true },
  { id: 'mouse', title: 'Toggle Pointer mode', category: 'Display', slash: 'mouse', keyAction: 'pointer_mode_toggle', available: true },
  { id: 'details', title: 'Toggle tool details', category: 'Display', slash: 'details', keyAction: 'tool_details_toggle', available: true },
  { id: 'permission', title: 'Change permissions', category: 'Session', slash: 'permission', available: true },
  { id: 'plan', title: 'Agent/Plan mode', category: 'Session', slash: 'plan', keyAction: 'agent_list', available: true },
  { id: 'subagents', title: 'Browse subagent sessions', category: 'Session', slash: 'subagents', available: true },
  { id: 'tasks', title: 'Show tasks', category: 'Session', slash: 'tasks', available: true },
  { id: 'goal', title: 'Manage persistent goal', category: 'Session', slash: 'goal', available: true },
  { id: 'queue', title: 'Show queued guidance', category: 'Session', slash: 'queue', available: true },
  { id: 'skills', title: 'Browse skills', category: 'Workspace', slash: 'skills', available: true },
  { id: 'mcp', title: 'Show MCP status', category: 'Workspace', slash: 'mcp', available: true },
  { id: 'init', title: 'Initialize workspace instructions', category: 'Workspace', slash: 'init', available: true },
  { id: 'editor', title: 'Open external editor', category: 'Workspace', slash: 'editor', keyAction: 'input_editor', available: true },
  { id: 'steer', title: 'Steer the running turn', category: 'Session', keyAction: 'input_steer', available: true },
  { id: 'add-dir', title: 'Add workspace directory', category: 'Workspace', slash: 'add-dir', argumentRequired: true, available: true },
  { id: 'btw', title: 'Ask a side question', category: 'Session', slash: 'btw', argumentRequired: true, available: true },
  { id: 'context', title: 'Show token context', category: 'Session', slash: 'context', available: true },
  { id: 'help', title: 'Open help', category: 'Global', slash: 'help', available: true },
  { id: 'quit', title: 'Exit TUI', category: 'Global', slash: 'quit', keyAction: 'app_exit', available: true }
]

export function parseTuiCommand(text: string): TuiCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const space = trimmed.indexOf(' ')
  const name = (space < 0 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase()
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim()
  switch (name) {
    case 'help': return { kind: 'help' }
    case 'threads':
    case 'sessions':
    case 'resume':
    case 'continue':
    case 'search': return { kind: 'threads', ...(rest ? { search: rest } : {}) }
    case 'clear':
    case 'new': return { kind: 'new', ...(rest ? { title: rest } : {}) }
    case 'open': return rest ? { kind: 'open', threadId: rest } : { kind: 'usage', usage: '/open <session-id>' }
    case 'title':
    case 'rename': return rest ? { kind: 'rename', title: rest } : { kind: 'usage', usage: '/rename <title>' }
    case 'archive': return { kind: 'archive' }
    case 'fork': return { kind: 'fork', ...(rest ? { title: rest } : {}) }
    case 'summarize':
    case 'compact': return { kind: 'compact' }
    case 'provider':
    case 'connect': return { kind: 'connect' }
    case 'models':
    case 'model': return { kind: 'model' }
    case 'thinking':
    case 'reasoning': return { kind: 'reasoning' }
    case 'mouse': return { kind: 'mouse', ...(rest ? { action: rest } : {}) }
    case 'variants': return { kind: 'variants' }
    case 'status': return { kind: 'status' }
    case 'copy': return { kind: 'copy' }
    case 'export': return { kind: 'export', ...(rest ? { path: rest } : {}) }
    case 'details': return { kind: 'details' }
    case 'permission':
    case 'permissions': return { kind: 'permission' }
    case 'undo': return { kind: 'undo' }
    case 'redo': return { kind: 'redo' }
    case 'init': return { kind: 'init', ...(rest ? { instructions: rest } : {}) }
    case 'mcp': return { kind: 'mcp' }
    case 'timeline': return { kind: 'timeline', ...(rest ? { query: rest } : {}) }
    case 'jump': return { kind: 'jump', ...(rest ? { target: rest } : {}) }
    case 'subagents': return { kind: 'subagents' }
    case 'tasks': return { kind: 'tasks' }
    case 'plan': return { kind: 'plan', ...(rest ? { action: rest } : {}) }
    case 'goal': return { kind: 'goal', ...(rest ? { action: rest } : {}) }
    case 'skills': return { kind: 'skills', ...(rest ? { query: rest } : {}) }
    case 'editor': return { kind: 'editor', ...(rest ? { initial: rest } : {}) }
    case 'add-dir': return rest
      ? { kind: 'add-dir', path: rest }
      : { kind: 'usage', usage: '/add-dir <path>' }
    case 'btw': return rest
      ? { kind: 'btw', question: rest }
      : { kind: 'usage', usage: '/btw <question>' }
    case 'context': return { kind: 'context' }
    case 'queue': return { kind: 'queue' }
    case 'q':
    case 'exit':
    case 'quit': return { kind: 'quit' }
    default: {
      if (name.startsWith('skill:')) {
        const skillName = name.slice('skill:'.length).trim()
        return skillName
          ? { kind: 'skill', name: skillName, ...(rest ? { prompt: rest } : {}) }
          : { kind: 'usage', usage: '/skill:<name> [prompt]' }
      }
      return { kind: 'unknown', name }
    }
  }
}
