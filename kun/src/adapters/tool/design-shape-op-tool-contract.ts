export const DESIGN_SHAPE_OP_TOOL_CONTRACT = [
  'Every operation must use the exact renderer ShapeOp field names below; ids must come from the current canvas snapshot.',
  'Update an existing shape with {"op":"update","id":"<shape-id>","patch":{...}}. To change visible text, patch "textContent" (never "text" or "content"). Common patch fields are name, x, y, width, height, textContent, imageUrl, fontSize, fontFamily, fontWeight, fontColor, textAlign, lineHeight, fills, strokes, cornerRadius, opacity, shadows, visible, and locked.',
  'Add a shape with {"op":"add","shape":{"type":"rect|ellipse|text|image|frame|group|arrow|line|draw",...},"parentId"?:"<shape-id>"}. Text shapes use shape.textContent. Rectangular shapes use x/y/width/height; arrow, line, and draw shapes use absolute points.',
  'Delete with {"op":"delete","id":"..."}; move with {"op":"move","ids":[...],"dx":N,"dy":N}; resize with {"op":"resize","id":"...","bounds":{"x":N,"y":N,"width":N,"height":N}}.',
  'Batch matching visual changes with {"op":"set-style","ids":[...],"style":{...}}. Full fills and strokes are required: fill {"type":"solid","color":"#RRGGBB","opacity":1}; stroke {"color":"#RRGGBB","width":1,"opacity":1,"position":"inside"}.',
  'Other supported structural operations include reparent, duplicate, reorder, group, ungroup, auto-layout, align, distribute, stack, grid, bulk-edit, recolor, apply-token, and responsive-reflow. Use their advertised dedicated tool when one exists.'
].join(' ')

export const DESIGN_SHAPE_OP_NAMES = [
  'add',
  'update',
  'delete',
  'reparent',
  'move',
  'resize',
  'align',
  'distribute',
  'add-screen',
  'duplicate',
  'reorder',
  'group',
  'ungroup',
  'set-style',
  'auto-layout',
  'define-token',
  'delete-token',
  'apply-token',
  'define-component',
  'delete-component',
  'set-component-variant',
  'instantiate',
  'instantiate-many',
  'detach',
  'update-component',
  'add-screens',
  'bulk-edit',
  'grid',
  'stack',
  'apply-theme',
  'recolor',
  'responsive-reflow',
  'variant-matrix',
  'design-system-template',
  'lint-design-system'
] as const

export const DESIGN_SHAPE_OP_INPUT_SCHEMA = {
  type: 'object',
  description: DESIGN_SHAPE_OP_TOOL_CONTRACT,
  properties: {
    op: { type: 'string', enum: [...DESIGN_SHAPE_OP_NAMES] },
    id: { type: 'string' },
    ids: { type: 'array', items: { type: 'string' } },
    parentId: { type: 'string' },
    shape: {
      type: 'object',
      description: 'New shape. Visible text must use textContent.',
      additionalProperties: true
    },
    patch: {
      type: 'object',
      description: 'Existing-shape patch. Visible text must use textContent.',
      additionalProperties: true
    }
  },
  required: ['op'],
  additionalProperties: true
} as const
