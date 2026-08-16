const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  THUMBNAIL_SCHEME,
  createHistoryThumbHandler,
  thumbnailIdFromUrl
} = require('../main/services/history-thumb-protocol')

function createHandler({
  thumbnailPath = '',
  resolveThumbnail = async () => thumbnailPath,
  directories = []
} = {}) {
  const historyService = { ensureThumbnail: resolveThumbnail }
  return createHistoryThumbHandler({
    historyService,
    historyDirectories: () => directories,
    log: () => {}
  })
}

test('extracts and validates thumbnail ids from urls', () => {
  assert.equal(thumbnailIdFromUrl('historythumb://1700000000000-abc123'), '1700000000000-abc123')
  assert.equal(thumbnailIdFromUrl('historythumb://UPPERCASE'), '')
  assert.equal(thumbnailIdFromUrl('historythumb://../secrets'), '')
  assert.equal(thumbnailIdFromUrl('historythumb://'), '')
  assert.equal(thumbnailIdFromUrl('not a url'), '')
})

test('streams thumbnails only from inside the history directories', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-thumb-'))
  try {
    const thumbnailPath = path.join(directory, '1700000000000-abc123-thumb.png')
    fs.writeFileSync(thumbnailPath, 'thumb')
    const handler = createHandler({
      resolveThumbnail: async () => thumbnailPath,
      directories: [directory]
    })

    const ok = await handler({ url: `${THUMBNAIL_SCHEME}://1700000000000-abc123` })
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('content-type'), 'image/png')
    assert.equal(await ok.text(), 'thumb')

    const invalid = await handler({ url: `${THUMBNAIL_SCHEME}://..%2Fescape` })
    assert.equal(invalid.status, 400)

    const missing = await createHandler({ resolveThumbnail: async () => '' })(
      { url: `${THUMBNAIL_SCHEME}://1700000000000-missing` }
    )
    assert.equal(missing.status, 404)

    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-outside-'))
    try {
      const outsidePath = path.join(outsideDirectory, 'escaped-thumb.png')
      fs.writeFileSync(outsidePath, 'secret')
      const forbidden = await createHandler({
        resolveThumbnail: async () => outsidePath,
        directories: [directory]
      })({ url: `${THUMBNAIL_SCHEME}://1700000000000-abc123` })
      assert.equal(forbidden.status, 403)
    } finally {
      fs.rmSync(outsideDirectory, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
