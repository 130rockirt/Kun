import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesignArtifact } from '../../../../design/design-types'
import { exportDesignPrototypeArtifact } from './canvas-viewport-export'

const createdAt = '2026-08-13T00:00:00.000Z'
const htmlArtifact: DesignArtifact = {
  id: 'checkout',
  kind: 'html',
  title: 'Checkout flow',
  relativePath: '.kun-design/doc/checkout/v1.html',
  createdAt,
  updatedAt: createdAt,
  versions: []
}

afterEach(() => vi.unstubAllGlobals())

describe('exportDesignPrototypeArtifact', () => {
  it('exports the preferred HTML source independently from the static board', async () => {
    const exportDesignPrototype = vi.fn().mockResolvedValue({
      ok: true,
      path: '/tmp/checkout.pdf',
      format: 'pdf',
      exportedAt: createdAt
    })
    vi.stubGlobal('window', { kunGui: { exportDesignPrototype } })

    await exportDesignPrototypeArtifact({
      artifacts: [htmlArtifact],
      preferredArtifactId: htmlArtifact.id,
      workspaceRoot: '/workspace',
      format: 'pdf',
      unavailableMessage: 'unavailable',
      failedMessage: 'failed'
    })

    expect(exportDesignPrototype).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      path: htmlArtifact.relativePath,
      format: 'pdf',
      filename: htmlArtifact.title
    })
  })

  it('fails clearly when there is no HTML prototype to export', async () => {
    await expect(exportDesignPrototypeArtifact({
      artifacts: [],
      preferredArtifactId: null,
      workspaceRoot: '/workspace',
      format: 'html',
      unavailableMessage: 'No prototype',
      failedMessage: 'failed'
    })).rejects.toThrow('No prototype')
  })
})
