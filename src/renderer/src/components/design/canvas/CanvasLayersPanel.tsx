import { memo, useCallback, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Square,
  Circle,
  Type,
  Image,
  Frame,
  Group,
  ArrowUpRight,
  Slash,
  Pencil,
  Trash2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { deleteCanvasLayers } from '../../../design/canvas/canvas-layer-actions'
import { flattenCanvasLayerRows } from '../../../design/canvas/canvas-layer-tree'
import { useCanvasShapeStore } from '../../../design/canvas/canvas-shape-store'
import { useCanvasSelectionStore } from '../../../design/canvas/canvas-selection-store'
import type { CanvasShape, ShapeType } from '../../../design/canvas/canvas-types'

const TYPE_ICONS: Record<ShapeType, typeof Square> = {
  rect: Square,
  ellipse: Circle,
  text: Type,
  image: Image,
  frame: Frame,
  group: Group,
  arrow: ArrowUpRight,
  line: Slash,
  draw: Pencil
}

function LayerRow({
  shape,
  depth,
  hasChildren,
  collapsed,
  onToggleCollapsed,
  labels
}: {
  shape: CanvasShape
  depth: number
  hasChildren: boolean
  collapsed: boolean
  onToggleCollapsed: (id: string) => void
  labels: {
    collapse: string
    visibility: string
    lock: string
    delete: string
  }
}) {
  const selectedIds = useCanvasSelectionStore((s) => s.selectedIds)
  const select = useCanvasSelectionStore((s) => s.select)
  const toggle = useCanvasSelectionStore((s) => s.toggle)
  const updateShape = useCanvasShapeStore((s) => s.updateShape)

  const selected = selectedIds.has(shape.id)
  const Icon = TYPE_ICONS[shape.type] ?? Square
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')

  return (
    <div
      className={`flex items-center gap-1 px-1 py-0.5 cursor-pointer rounded text-[12px] transition-colors ${
        selected
          ? 'bg-blue-100 dark:bg-blue-900/30'
          : 'hover:bg-gray-100 dark:hover:bg-white/5'
      }`}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      onClick={(e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) toggle(shape.id)
        else select([shape.id])
      }}
      onDoubleClick={() => {
        setDraft(shape.name)
        setRenaming(true)
      }}
    >
      {hasChildren ? (
        <button
          type="button"
          title={labels.collapse}
          aria-label={labels.collapse}
          aria-expanded={!collapsed}
          className="shrink-0 p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          onClick={(e) => {
            e.stopPropagation()
            onToggleCollapsed(shape.id)
          }}
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3" strokeWidth={1.8} />
          ) : (
            <ChevronDown className="h-3 w-3" strokeWidth={1.8} />
          )}
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}
      <Icon className="h-3 w-3 shrink-0 text-gray-400" strokeWidth={1.5} />
      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            updateShape(shape.id, { name: draft })
            setRenaming(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              updateShape(shape.id, { name: draft })
              setRenaming(false)
            }
            if (e.key === 'Escape') setRenaming(false)
          }}
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300">
          {shape.name}
        </span>
      )}
      <button
        type="button"
        title={labels.visibility}
        aria-label={labels.visibility}
        aria-pressed={shape.visible}
        className="shrink-0 p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        onClick={(e) => {
          e.stopPropagation()
          updateShape(shape.id, { visible: !shape.visible })
        }}
      >
        {shape.visible ? (
          <Eye className="h-3 w-3" strokeWidth={1.5} />
        ) : (
          <EyeOff className="h-3 w-3" strokeWidth={1.5} />
        )}
      </button>
      <button
        type="button"
        title={labels.lock}
        aria-label={labels.lock}
        aria-pressed={shape.locked}
        className="shrink-0 p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        onClick={(e) => {
          e.stopPropagation()
          updateShape(shape.id, { locked: !shape.locked })
        }}
      >
        {shape.locked ? (
          <Lock className="h-3 w-3" strokeWidth={1.5} />
        ) : (
          <Unlock className="h-3 w-3" strokeWidth={1.5} />
        )}
      </button>
      <button
        type="button"
        title={labels.delete}
        aria-label={labels.delete}
        className="shrink-0 p-0.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
        onClick={(e) => {
          e.stopPropagation()
          deleteCanvasLayers([shape.id])
        }}
      >
        <Trash2 className="h-3 w-3" strokeWidth={1.5} />
      </button>
    </div>
  )
}

function CanvasLayersPanelInner() {
  const document = useCanvasShapeStore((s) => s.document)
  const { t } = useTranslation('common')
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())

  const rows = useMemo(
    () => flattenCanvasLayerRows(document, collapsedIds),
    [document, collapsedIds]
  )
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const root = document.objects[document.rootId]
  if (!root) return null

  return (
    <div className="flex flex-col gap-0.5 px-1 py-1">
      {rows.map((row) => {
        const child = document.objects[row.id]
        if (!child) return null
        return (
          <LayerRow
            key={row.id}
            shape={child}
            depth={row.depth}
            hasChildren={row.hasChildren}
            collapsed={row.collapsed}
            onToggleCollapsed={toggleCollapsed}
            labels={{
              collapse: t(row.collapsed ? 'canvasLayerExpand' : 'canvasLayerCollapse'),
              visibility: t(child.visible ? 'canvasLayerHide' : 'canvasLayerShow'),
              lock: t(child.locked ? 'canvasLayerUnlock' : 'canvasLayerLock'),
              delete: t('canvasLayerDelete')
            }}
          />
        )
      })}
      {rows.length === 0 && (
        <div className="px-2 py-3 text-center text-[12px] text-gray-400">
          {t('canvasLayersEmpty')}
        </div>
      )}
    </div>
  )
}

export const CanvasLayersPanel = memo(CanvasLayersPanelInner)
