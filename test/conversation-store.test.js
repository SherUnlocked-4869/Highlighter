const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ConversationStore } = require('../main/services/conversation-store')

function createStore(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-store-'))
  const settings = { selectionToolbar: { conversation: { persist: true } } }
  const store = new ConversationStore({
    directory,
    getSettings: () => settings,
    ...overrides
  })
  return {
    directory,
    settings,
    store,
    files: () => fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort(),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  }
}

function snapshot(savedAt, overrides = {}) {
  return { savedAt, actionId: 'translate', source: 'source', firstResult: 'result', history: [], ...overrides }
}

test('a conversation keeps one file that grows instead of a file per round', async () => {
  const context = createStore()
  try {
    const id = 'conv-12345678'
    await context.store.save(snapshot(1000, { id, history: [] }))
    await context.store.save(snapshot(2000, { id, history: [{ question: 'q', answer: 'a' }] }))
    assert.deepEqual(context.files(), [`${id}.json`])
    const saved = context.store.latest()
    assert.equal(saved.history.length, 1)
    assert.equal(saved.savedAt, 2000)
    // A different conversation is a different file.
    await context.store.save(snapshot(3000, { id: 'conv-87654321' }))
    assert.equal(context.files().length, 2)
    // An unusable id still saves, under a generated name.
    await context.store.save(snapshot(4000, { id: '../escape' }))
    assert.equal(context.files().length, 3)
    assert.ok(context.files().every((name) => name.endsWith('.json') && !name.includes('..')))
  } finally {
    context.cleanup()
  }
})

test('nothing is written while saving is switched off', async () => {
  const context = createStore()
  try {
    context.settings.selectionToolbar.conversation.persist = false
    assert.equal(await context.store.save(snapshot(1)), false)
    assert.deepEqual(context.files(), [])
    assert.equal(context.store.isEnabled(), false)
    assert.equal(context.store.latest(), null)
  } finally {
    context.cleanup()
  }
})

test('saves are readable, newest first, and atomic enough to parse', async () => {
  const context = createStore()
  try {
    assert.equal(await context.store.save(snapshot(1000, { firstResult: '第一个' })), true)
    assert.equal(await context.store.save(snapshot(2000, { firstResult: '第二个' })), true)
    assert.equal(context.files().length, 2)
    assert.equal(context.store.latest().firstResult, '第二个')
    for (const name of context.files()) {
      const parsed = JSON.parse(fs.readFileSync(path.join(context.directory, name), 'utf8'))
      assert.equal(parsed.schemaVersion, 1)
      assert.ok(Number.isFinite(parsed.savedAt))
    }
  } finally {
    context.cleanup()
  }
})

test('retention keeps the newest entries and deletes the rest', async () => {
  const context = createStore({ maxEntries: 2 })
  try {
    for (const at of [1, 2, 3, 4]) await context.store.save(snapshot(at))
    assert.equal(context.files().length, 2)
    assert.equal(context.store.latest().savedAt, 4)
    assert.deepEqual(context.store.entries().map((entry) => entry.snapshot.savedAt), [4, 3])
  } finally {
    context.cleanup()
  }
})

test('clear removes only the files this store wrote', async () => {
  const context = createStore()
  try {
    await context.store.save(snapshot(1))
    fs.writeFileSync(path.join(context.directory, 'notes.txt'), 'keep me', 'utf8')
    fs.mkdirSync(path.join(context.directory, 'subdir'), { recursive: true })
    fs.writeFileSync(path.join(context.directory, 'subdir', 'inner.json'), '{}', 'utf8')
    assert.equal(context.store.clear(), 1)
    assert.deepEqual(fs.readdirSync(context.directory).sort(), ['notes.txt', 'subdir'])
  } finally {
    context.cleanup()
  }
})

test('broken, missing and hand-edited files are survived', async () => {
  const context = createStore()
  try {
    assert.deepEqual(context.store.entries(), [])
    assert.equal(context.store.latest(), null)
    assert.equal(context.store.trim(), 0)
    assert.equal(context.store.clear(), 0)

    fs.writeFileSync(path.join(context.directory, 'broken.json'), '{ not json', 'utf8')
    fs.writeFileSync(path.join(context.directory, 'nosavetime.json'), JSON.stringify({ source: 'x' }), 'utf8')
    assert.deepEqual(context.store.entries(), [])

    // A valid file written by hand still counts as a conversation.
    fs.writeFileSync(path.join(context.directory, 'hand.json'), JSON.stringify(snapshot(5)), 'utf8')
    assert.equal(context.store.latest().savedAt, 5)

    // A failing write is reported, not thrown: the conversation on screen must
    // survive a store problem.
    const failing = createStore({ writeJson: async () => { throw new Error('disk on fire') } })
    try {
      assert.equal(await failing.store.save(snapshot(1)), false)
      assert.deepEqual(failing.files(), [])
    } finally {
      failing.cleanup()
    }
  } finally {
    context.cleanup()
  }
})

test('requires an absolute directory and a settings reader', () => {
  assert.throws(() => new ConversationStore({ directory: 'relative', getSettings: () => ({}) }), /absolute/)
  assert.throws(() => new ConversationStore({ directory: path.resolve('x') }), /getSettings/)
})
