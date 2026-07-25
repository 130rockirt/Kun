const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.astro',
  '.bash',
  '.c',
  '.cc',
  '.cjs',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.dart',
  '.env',
  '.fish',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.less',
  '.lock',
  '.log',
  '.md',
  '.mdx',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sass',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.swift',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh'
])

const TEXT_PREVIEW_NAMES = new Set([
  '.env',
  '.gitignore',
  'dockerfile',
  'makefile',
  'package-lock.json',
  'pnpm-lock.yaml',
  'readme'
])

const RASTER_IMAGE_PREVIEW_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp'
])

const PDF_PREVIEW_EXTENSIONS = new Set(['.pdf'])
const OFFICE_PREVIEW_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])
const AUDIO_PREVIEW_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.wav'])
const VIDEO_PREVIEW_EXTENSIONS = new Set(['.m4v', '.mov', '.mp4', '.ogv', '.webm'])

export type WorkspaceFilePreviewKind =
  | 'text'
  | 'markdown'
  | 'json'
  | 'html'
  | 'svg'
  | 'image'
  | 'pdf'
  | 'office'
  | 'audio'
  | 'video'
  | 'unsupported'

function basename(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? path
}

function extension(path: string): string {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

export function isWorkspaceTextPreviewPath(path: string): boolean {
  const name = basename(path).toLowerCase()
  if (TEXT_PREVIEW_NAMES.has(name)) return true
  const ext = extension(path)
  return Boolean(ext && TEXT_PREVIEW_EXTENSIONS.has(ext))
}

export function isWorkspaceRasterImagePreviewPath(path: string): boolean {
  const ext = extension(path)
  return Boolean(ext && RASTER_IMAGE_PREVIEW_EXTENSIONS.has(ext))
}

export function workspaceFilePreviewKind(path: string): WorkspaceFilePreviewKind {
  const ext = extension(path)
  if (ext === '.md' || ext === '.mdx') return 'markdown'
  if (ext === '.json') return 'json'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.svg') return 'svg'
  if (RASTER_IMAGE_PREVIEW_EXTENSIONS.has(ext)) return 'image'
  if (PDF_PREVIEW_EXTENSIONS.has(ext)) return 'pdf'
  if (OFFICE_PREVIEW_EXTENSIONS.has(ext)) return 'office'
  if (AUDIO_PREVIEW_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_PREVIEW_EXTENSIONS.has(ext)) return 'video'
  if (isWorkspaceTextPreviewPath(path)) return 'text'
  return 'unsupported'
}

export function isWorkspacePreviewPath(path: string): boolean {
  return workspaceFilePreviewKind(path) !== 'unsupported'
}

export function workspaceFileKindLabel(path: string): string {
  const kind = workspaceFilePreviewKind(path)
  if (kind === 'markdown') return 'MD'
  if (kind === 'json') return 'JSON'
  if (kind === 'html') return 'HTML'
  if (kind === 'svg') return 'SVG'
  if (kind === 'image') return 'IMG'
  if (kind === 'pdf') return 'PDF'
  if (kind === 'office') return extension(path).slice(1).toUpperCase()
  if (kind === 'audio') return 'AUD'
  if (kind === 'video') return 'VID'
  if (kind === 'text') {
    const ext = extension(path).slice(1).toUpperCase()
    return ext.slice(0, 4) || 'TXT'
  }
  const ext = extension(path).slice(1).toUpperCase()
  return ext.slice(0, 4) || 'FILE'
}
