import { describe, expect, it } from 'vitest'
import { materializeProxyRequestBody } from './proxy-fetch'

describe('proxy fetch request bodies', () => {
  it('materializes FormData with a multipart boundary and complete fields', async () => {
    const form = new FormData()
    form.append('chat_id', '123456')
    form.append('document', new Blob(['hello proxy'], { type: 'text/plain' }), 'note.txt')

    const materialized = await materializeProxyRequestBody(form)

    expect(materialized.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(materialized.buffer?.toString()).toContain('name="chat_id"')
    expect(materialized.buffer?.toString()).toContain('123456')
    expect(materialized.buffer?.toString()).toContain('filename="note.txt"')
    expect(materialized.buffer?.toString()).toContain('hello proxy')
  })

  it('preserves Blob content type and bytes', async () => {
    const materialized = await materializeProxyRequestBody(
      new Blob(['telegram'], { type: 'application/octet-stream' })
    )

    expect(materialized.headers).toEqual({ 'content-type': 'application/octet-stream' })
    expect(materialized.buffer?.toString()).toBe('telegram')
  })
})
