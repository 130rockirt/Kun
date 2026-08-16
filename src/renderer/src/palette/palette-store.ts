import { create } from 'zustand'

type CommandPaletteStoreState = {
  open: boolean
  openPalette: () => void
  closePalette: () => void
}

/**
 * Minimal renderer-owned state slice for the palette overlay. Opening is
 * idempotent so a repeated chord never resets an in-progress query.
 */
export const useCommandPaletteStore = create<CommandPaletteStoreState>((set) => ({
  open: false,
  openPalette: () => set({ open: true }),
  closePalette: () => set({ open: false })
}))
