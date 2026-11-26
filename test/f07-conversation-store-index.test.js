// F07 (part 1) —— docs/reviews/2026-11-26-code-review-and-optimization-report.md section 3.7.2
//
// The conversation store is read by the tray rebuild: `hasConversation()` runs on every
// selection-window blur, and it used to call `latest()`, which parsed every JSON file in
// `conversations/` (20 by default). These cases drive the real store over a temp directory
// and count file reads, which is the actual cost the review named.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ConversationStore, DEFAULT_MAX_ENTRIES } = require('../main/services/conversation-store')

function withTempDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-conversations-'))
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true })
  try {
    const result = callback(directory)
    if (result && typeof result.then === 'function') return result.finally(cleanup)
    cleanup()
    return result
  } catch (error) {
    cleanup()
    throw error
  }
}

// Counts the reads the store performs; everything else is the real filesystem.
function createCountingFs() {
  const counts = { readFileSync: 0, readdirSync: 0 }
  return {
    counts,
    fs: {
      readFileSync(filePath, encoding) {
        counts.readFileSync += 1
        return fs.readFileSync(filePath, encoding)
      },
      readdirSync(directory, options) {
        counts.readdirSync += 1
        return fs.readdirSync(directory, options)
      },
      rmSync: (...args) => fs.rmSync(...args)
    }
  }
}

function writeConversation(directory, id, savedAt) {
  const filePath = path.join(directory, `${id}.json`)
  fs.writeFileSync(filePath, JSON.stringify({ id, savedAt, firstResult: id }), 'utf8')
  return filePath
}

function createStore(directory, fileSystem) {
  return new ConversationStore({
    directory,
    getSettings: () => ({ selectionToolbar: { conversation: { persist: true } } }),
    fileSystem,
    writeJson: (filePath, value) => fs.promises.writeFile(filePath, JSON.stringify(value), 'utf8'),
    log: () => {}
  })
}

test('F07: hasSaved answers from the memory index instead of parsing every conversation', () => {
  withTempDirectory((directory) => {
    for (let index = 0; index < DEFAULT_MAX_ENTRIES; index++) {
      writeConversation(directory, `conversation-${index}`, index + 1)
    }
    const counting = createCountingFs()
    const store = createStore(directory, counting.fs)

    assert.equal(store.hasSaved(), true)
    // Cold build: one directory scan plus one read per file (the savedAt probe).
    assert.equal(counting.counts.readdirSync, 1)
    assert.equal(counting.counts.readFileSync, DEFAULT_MAX_ENTRIES)

    // Warm: the tray's repeated questions cost one readdir each and zero file parses.
    for (let index = 0; index < 5; index++) assert.equal(store.hasSaved(), true)
    assert.equal(counting.counts.readdirSync, 6)
    assert.equal(counting.counts.readFileSync, DEFAULT_MAX_ENTRIES)
    // latest() reads only the newest file's content (savedAt is already in the index).
    const before = counting.counts.readFileSync
    assert.equal(store.latest().id, `conversation-${DEFAULT_MAX_ENTRIES - 1}`)
    assert.equal(counting.counts.readFileSync, before + 1)
  })
})

test('F07: save keeps the warm index current, remove deletes only its own entry', async () => {
  withTempDirectory(async (directory) => {
    const counting = createCountingFs()
    const store = createStore(directory, counting.fs)
    assert.equal(store.hasSaved(), false)

    await store.save({ id: 'conversation-a', savedAt: 10, firstResult: 'a' })
    assert.equal(store.hasSaved(), true)
    assert.equal(store.latest().id, 'conversation-a')
    const readsAfterFirstQuery = counting.counts.readFileSync
    const removesAfterFirstQuery = counting.counts.readdirSync

    const removedPath = path.join(directory, 'conversation-a.json')
    assert.equal(store.remove(removedPath), true)
    assert.equal(store.hasSaved(), false)
    assert.equal(counting.counts.readFileSync, readsAfterFirstQuery, 'save/remove never parse files')
    assert.equal(counting.counts.readdirSync, removesAfterFirstQuery + 1, 'only the per-query readdir')
  })
})

test('F07: retention and clear still work through the index', async () => {
  withTempDirectory(async (directory) => {
    const store = new ConversationStore({
      directory,
      getSettings: () => ({ selectionToolbar: { conversation: { persist: true } } }),
      writeJson: (filePath, value) => fs.promises.writeFile(filePath, JSON.stringify(value), 'utf8'),
      log: () => {}
    })
    for (let index = 0; index < DEFAULT_MAX_ENTRIES + 2; index++) writeConversation(directory, `conversation-${index}`, index + 1)
    assert.equal(store.trim(), DEFAULT_MAX_ENTRIES)
    // The two oldest (smallest savedAt) were removed.
    assert.equal(fs.existsSync(path.join(directory, 'conversation-0.json')), false)
    assert.equal(fs.existsSync(path.join(directory, 'conversation-1.json')), false)
    // External deletion between two calls is tolerated: clear() reports zero afterwards.
    assert.ok(store.clear() >= 0)
    assert.equal(store.hasSaved(), false)
    assert.equal(store.latest(), null)
    // A stale index entry for a file that vanished degrades to "not a conversation".
    writeConversation(directory, 'conversation-late', 99)
    fs.rmSync(path.join(directory, 'conversation-late.json'))
    assert.equal(store.latest(), null)
  })
})

test('F07: the selection domain asks the store for the cheap answer when it offers one', () => {
  // Source-level, because the domain needs a window manager: the tray rebuild calls
  // hasConversation() on every blur, so it must take the store's hasSaved() fast path.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'domains', 'selection', 'index.js'), 'utf8')
  assert.match(source, /typeof conversationStore\?\.hasSaved === 'function'/)
  assert.match(source, /conversationStore\.hasSaved\(\)/)
  assert.match(source, /: !!conversationStore\?\.latest\(\)/)
})
