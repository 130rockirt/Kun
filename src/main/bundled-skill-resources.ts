import { app } from 'electron'
import { join, resolve } from 'node:path'

export function bundledSkillsDirectory(options?: {
  isPackaged?: boolean
  resourcesPath?: string
  appRoot?: string
}): string {
  const isPackaged = options?.isPackaged ?? app.isPackaged
  if (isPackaged) {
    return join(options?.resourcesPath ?? process.resourcesPath, 'bundled-skills')
  }
  return resolve(options?.appRoot ?? app.getAppPath(), 'resources', 'bundled-skills')
}
