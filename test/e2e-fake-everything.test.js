const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createFakeEverythingQuery,
  E2E_FAKE_EVERYTHING_ITEMS,
  parseQuery
} = require('../main/services/e2e-fake-everything')

test('parses Everything operators out of a search string', () => {
  assert.deepEqual(parseQuery('report ext:xls;xlsx'), {
    keyword: 'report',
    extensions: ['xls', 'xlsx'],
    folderOnly: false
  })
  assert.deepEqual(parseQuery('Highlighter folder:'), {
    keyword: 'highlighter',
    extensions: [],
    folderOnly: true
  })
  assert.deepEqual(parseQuery(''), { keyword: '', extensions: [], folderOnly: false })
})

test('fake Everything query returns deterministic matches for the search spec', () => {
  const query = createFakeEverythingQuery()

  const json = query({ search: 'package.json', maxResults: 600, sortMode: 'modified-desc' })
  assert.equal(json.items.length, 1)
  assert.equal(json.items[0].name, 'package.json')
  assert.match(json.items[0].fullPath, /package\.json$/)
  assert.equal(json.total, 1)

  const folder = query({ search: 'Highlighter folder:', maxResults: 600, sortMode: 'modified-desc' })
  assert.equal(folder.items.length, 1)
  assert.equal(folder.items[0].extension, '')

  const all = query({ search: '', maxResults: 600, sortMode: 'modified-desc' })
  assert.equal(all.total, E2E_FAKE_EVERYTHING_ITEMS.length)
  assert.equal(all.cached, false)
})

test('fake Everything query honours sort modes and result caps', () => {
  const query = createFakeEverythingQuery()

  const byName = query({ search: '', maxResults: 600, sortMode: 'name-asc' })
  const names = byName.items.map((item) => item.name)
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)))

  const capped = query({ search: '', maxResults: 1, sortMode: 'modified-desc' })
  assert.equal(capped.items.length, 1)
  assert.equal(capped.total, E2E_FAKE_EVERYTHING_ITEMS.length)

  const unmatched = query({ search: 'no-such-file-xyz', maxResults: 600 })
  assert.equal(unmatched.items.length, 0)
  assert.equal(unmatched.total, 0)
})

test('fake Everything corpus is frozen so a spec cannot mutate shared state', () => {
  assert.equal(Object.isFrozen(E2E_FAKE_EVERYTHING_ITEMS), true)
  const query = createFakeEverythingQuery()
  const first = query({ search: 'package.json', maxResults: 600 })
  first.items[0].name = 'mutated'
  const second = query({ search: 'package.json', maxResults: 600 })
  assert.equal(second.items[0].name, 'package.json')
})
