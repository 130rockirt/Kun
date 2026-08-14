import { useEffect, useMemo, useRef, type CSSProperties, type ReactElement } from 'react'
import type { CanvasDocument, Rect, ViewBox } from '../../../design/canvas/canvas-types'
import { PROJECT_DESIGN_MD_PATH } from '../../../design/design-md/design-md-paths'
import type { ProjectDesignMdSyncStatus } from '../../../design/design-md/design-md-types'
import { useProjectDesignSystemStore } from '../../../design/canvas/project-design-system-store'
import {
  buildDesignMdSpecimenModel,
  readableDesignMdTextColor
} from '../../../design/design-md/design-md-specimen-model'
import { parseProjectDesignMd } from '../../../design/design-md/design-md-adapter'
import {
  commitDesignSystemBoardRect,
  defaultDesignSystemBoardRect,
  setDesignSystemBoardRect,
  storedDesignSystemBoardRect,
  translateDesignSystemBoardRect,
  useDesignSystemBoardLayoutStore
} from '../../../design/canvas/design-system-board-layout'

type Props = { workspaceRoot: string; documentKey: string; document: CanvasDocument; viewBox: ViewBox }
type DragState = {
  pointerId: number
  clientX: number
  clientY: number
  origin: Rect
  scaleX: number
  scaleY: number
}

export function shouldRenderDesignSystemBoard(status: ProjectDesignMdSyncStatus): boolean {
  return status !== 'loading' && status !== 'missing'
}

export function DesignSystemBoardOverlay({ workspaceRoot, documentKey, document: canvasDocument, viewBox }: Props): ReactElement | null {
  const status = useProjectDesignSystemStore((state) => state.status)
  const design = useProjectDesignSystemStore((state) => state.document)
  const draft = useProjectDesignSystemStore((state) => state.draft)
  const diagnostics = useProjectDesignSystemStore((state) => state.diagnostics)
  const setInspectorOpen = useProjectDesignSystemStore((state) => state.setInspectorOpen)
  const dragRef = useRef<DragState | null>(null)
  const liveRect = useDesignSystemBoardLayoutStore((state) => state.rects[documentKey])
  const initialRect = useMemo(
    () => storedDesignSystemBoardRect(documentKey) ?? defaultDesignSystemBoardRect(canvasDocument, viewBox),
    [canvasDocument, documentKey, viewBox]
  )
  const rect = liveRect ?? initialRect
  useEffect(() => {
    if (!liveRect) setDesignSystemBoardRect(documentKey, initialRect)
  }, [documentKey, initialRect, liveRect])
  const draftParse = useMemo(() => draft?.content ? parseProjectDesignMd(draft.content) : null, [draft?.content])
  if (!design || !shouldRenderDesignSystemBoard(status)) return null
  const displayDesign = draftParse?.ok && draftParse.document ? draftParse.document : design

  const model = buildDesignMdSpecimenModel(displayDesign)
  const colorNames = Object.keys(displayDesign.colors)
  const roles = model.palettes.filter((item) => item.featured).map((item) => item.name)
  const typography = model.typographyNames.slice(0, 3).map((name) => [name, displayDesign.typography[name]] as const)
  const { surface, onSurface, primary, secondary } = model
  const style = { '--ds-surface': surface, '--ds-on-surface': onSurface, '--ds-primary': primary, '--ds-secondary': secondary } as CSSProperties

  const beginDrag = (event: React.PointerEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const svg = event.currentTarget.closest('foreignObject')?.ownerSVGElement
    const bounds = svg?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      origin: rect,
      scaleX: viewBox.width / bounds.width,
      scaleY: viewBox.height / bounds.height
    }
  }
  const moveDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    setDesignSystemBoardRect(documentKey, translateDesignSystemBoardRect(
      drag.origin,
      { x: event.clientX - drag.clientX, y: event.clientY - drag.clientY },
      { x: drag.scaleX, y: drag.scaleY }
    ), { persist: false })
  }
  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    event.stopPropagation()
    dragRef.current = null
    commitDesignSystemBoardRect(documentKey)
  }

  return (
    <foreignObject x={rect.x} y={rect.y} width={rect.width} height={rect.height}>
      <div
        className="h-full w-full cursor-grab touch-none select-none overflow-hidden rounded-[28px] border-[5px] border-indigo-500 bg-[var(--ds-surface)] p-5 text-[var(--ds-on-surface)] shadow-2xl active:cursor-grabbing"
        style={style}
        data-design-system-board
        data-design-system-board-workspace={workspaceRoot}
        title="拖动设计风格板；双击打开设置"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => { event.stopPropagation(); setInspectorOpen(true) }}
      >
        <header
          className="mb-4 flex items-center justify-between"
          data-design-system-board-drag-handle
        >
          <div><div className="text-xl font-semibold">🎨 {displayDesign.name}</div><div className="mt-1 font-mono text-xs opacity-55">{PROJECT_DESIGN_MD_PATH}</div></div>
          <div className="flex items-center gap-2"><span className="text-xs opacity-45">⠿ 拖动</span><span className="rounded-full bg-white/10 px-4 py-2 text-xs">{colorNames.length} colors · {Object.keys(displayDesign.typography).length} type styles</span></div>
        </header>
        {status === 'invalid' ? <div className="mb-3 rounded-xl bg-red-500/15 px-4 py-2 text-xs text-red-200">DESIGN.md 当前无效，继续显示最近一次有效主题。{diagnostics[0]?.message}</div> : null}
        <div className="grid h-[590px] grid-cols-[260px_1fr] gap-4">
          <section className="grid grid-rows-4 gap-3">
            {roles.map((name) => {
              const color = displayDesign.colors[name]
              const hex = color.hex ?? color.raw
              return <div key={name} className="overflow-hidden rounded-2xl border border-white/10" style={{ background: hex, color: readableDesignMdTextColor(hex) }}><div className="flex h-2/3 items-start justify-between p-4 text-sm font-semibold"><span className="capitalize">{name}</span><span className="font-mono">{hex}</span></div><div className="flex h-1/3">{[.15,.3,.45,.6,.75,.9].map((opacity) => <span key={opacity} className="flex-1 bg-black" style={{ opacity: 1-opacity }} />)}</div></div>
            })}
          </section>
          <section className="grid grid-cols-3 grid-rows-3 gap-4">
            {typography.map(([name, type]) => <div key={name} className="rounded-2xl bg-white/[.055] p-5"><div className="flex justify-between text-xs opacity-50"><span>{name}</span><span>{type.fontFamily}</span></div><div className="mt-4 text-7xl leading-none" style={{ fontFamily: type.fontFamily, fontWeight: type.fontWeight }}>Aa</div></div>)}
            <div className="rounded-2xl bg-white/[.055] p-5"><div className="mb-5 text-xs opacity-50">Controls</div><div className="grid grid-cols-2 gap-3"><button className="rounded-lg bg-[var(--ds-primary)] px-4 py-3 text-sm" style={{ color: readableDesignMdTextColor(primary) }}>Primary</button><button className="rounded-lg bg-white/10 px-4 py-3 text-sm">Secondary</button><button className="rounded-lg bg-white/90 px-4 py-3 text-sm text-black">Inverted</button><button className="rounded-lg border border-white/50 px-4 py-3 text-sm">Outlined</button></div></div>
            <div className="rounded-2xl bg-white/[.055] p-5"><div className="mb-5 text-xs opacity-50">Input</div><div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3 text-sm opacity-70">⌕&nbsp;&nbsp; Search</div></div>
            <div className="rounded-2xl bg-white/[.055] p-5"><div className="mb-5 text-xs opacity-50">Progress</div><div className="space-y-3"><div className="h-2 overflow-hidden rounded bg-white/5"><div className="h-full w-3/4 rounded bg-white" /></div><div className="h-2 overflow-hidden rounded bg-white/5"><div className="h-full w-1/2 rounded bg-[var(--ds-secondary)]" /></div><div className="h-2 overflow-hidden rounded bg-white/5"><div className="h-full w-2/3 rounded bg-white/80" /></div></div></div>
            <div className="rounded-2xl bg-white/[.055] p-5"><div className="mb-5 text-xs opacity-50">Navigation</div><div className="flex items-center justify-around rounded-full bg-white/5 p-3"><span className="rounded-full bg-white p-2 text-black">⌂</span><span>⌕</span><span>♙</span></div></div>
            <div className="rounded-2xl bg-white/[.055] p-5"><div className="mb-5 text-xs opacity-50">Spacing & rounded</div><div className="flex flex-wrap gap-3">{Object.entries(displayDesign.rounded).slice(0,4).map(([name, value]) => <span key={name} className="border border-white/30 bg-white/5 px-4 py-3 text-xs" style={{ borderRadius: value.raw }}>{name}</span>)}</div></div>
            <div className="rounded-2xl bg-white/[.055] p-5"><div className="mb-5 text-xs opacity-50">Actions & chips</div><div className="flex gap-3"><span className="rounded-full bg-white p-3 text-black">✎</span><span className="rounded-full bg-[var(--ds-secondary)] p-3" style={{ color: readableDesignMdTextColor(secondary) }}>◇</span><span className="rounded-full bg-white/10 px-4 py-3 text-xs">Label</span></div></div>
          </section>
        </div>
      </div>
    </foreignObject>
  )
}
