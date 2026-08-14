import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { KnowledgeOfficeArtifact, KnowledgeSourceFile } from './knowledge-types.js'
import {
  extractPresentationKnowledge,
  extractWordKnowledge,
  type KnowledgeOfficeCliRunner
} from './knowledge-office-cli.js'
import {
  withConvertedLegacyOffice,
  type KnowledgeLegacyOfficeDependencies
} from './knowledge-office-legacy.js'
import {
  officeKnowledgeFormat,
  validateModernOfficeArchive,
  validateOfficeSourceHeader
} from './knowledge-office-source.js'
import { extractSpreadsheetKnowledge } from './knowledge-office-spreadsheet.js'

export type KnowledgeOfficeExtractorDependencies = {
  officeCli?: KnowledgeOfficeCliRunner
  libreOffice?: KnowledgeLegacyOfficeDependencies
}

export class KnowledgeOfficeExtractorRegistry {
  constructor(private dependencies: KnowledgeOfficeExtractorDependencies = {}) {}

  setDependencies(dependencies: KnowledgeOfficeExtractorDependencies): void {
    this.dependencies = dependencies
  }

  supports(file: KnowledgeSourceFile): boolean {
    return officeKnowledgeFormat(file.relativePath) !== null
  }

  async extract(
    file: KnowledgeSourceFile,
    sourceSha256: string,
    signal?: AbortSignal
  ): Promise<KnowledgeOfficeArtifact> {
    if (signal?.aborted) throw abortError()
    const format = officeKnowledgeFormat(file.relativePath)
    if (!format) throw new Error(`Unsupported Office knowledge source: ${file.relativePath}`)
    await validateOfficeSourceHeader(file)
    if (format === 'xls' || format === 'xlsx') {
      if (format === 'xlsx') await validateModernOfficeArchive(file.absolutePath, format)
      return extractSpreadsheetKnowledge(file, format, sourceSha256)
    }
    const officeCli = this.dependencies.officeCli
    if (!officeCli) {
      throw new Error('OfficeCLI is required to index Word and PowerPoint documents')
    }
    if (format === 'docx') {
      await validateModernOfficeArchive(file.absolutePath, format)
      return extractWordKnowledge(file, sourceSha256, format, officeCli, signal)
    }
    if (format === 'pptx') {
      await validateModernOfficeArchive(file.absolutePath, format)
      return extractPresentationKnowledge(file, sourceSha256, format, officeCli, signal)
    }
    return withConvertedLegacyOffice(
      file.absolutePath,
      format,
      this.dependencies.libreOffice ?? {},
      signal,
      async (convertedPath, convertedFormat) => {
        const info = await stat(convertedPath)
        const convertedFile: KnowledgeSourceFile = {
          absolutePath: convertedPath,
          relativePath: basename(convertedPath),
          size: info.size,
          mtimeMs: Math.floor(info.mtimeMs)
        }
        return convertedFormat === 'docx'
          ? extractWordKnowledge(convertedFile, sourceSha256, 'doc', officeCli, signal)
          : extractPresentationKnowledge(convertedFile, sourceSha256, 'ppt', officeCli, signal)
      }
    )
  }
}

function abortError(): Error {
  const error = new Error('Office knowledge extraction was cancelled')
  error.name = 'AbortError'
  return error
}
