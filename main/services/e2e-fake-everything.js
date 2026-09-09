// Deterministic Everything stand-in for renderer E2E runs.
//
// The real sidecar needs a populated, elevated NTFS index that hosted CI
// runners cannot provide, so the search-window spec asserts against this
// fixed corpus instead. It is only reachable when HIGHLIGHTER_E2E=1 and
// HIGHLIGHTER_E2E_FAKE_EVERYTHING=1, never in a packaged build.

const FIXED_MODIFIED_AT = Date.UTC(2026, 7, 31, 12, 0, 0)

const E2E_FAKE_EVERYTHING_ITEMS = Object.freeze([
  Object.freeze({
    name: 'package.json',
    path: 'C:\\Projects\\Highlighter',
    fullPath: 'C:\\Projects\\Highlighter\\package.json',
    extension: 'json',
    size: 6492,
    modifiedAt: FIXED_MODIFIED_AT
  }),
  Object.freeze({
    name: 'README.md',
    path: 'C:\\Projects\\Highlighter',
    fullPath: 'C:\\Projects\\Highlighter\\README.md',
    extension: 'md',
    size: 7110,
    modifiedAt: FIXED_MODIFIED_AT
  }),
  Object.freeze({
    name: 'Highlighter',
    path: 'C:\\Projects',
    fullPath: 'C:\\Projects\\Highlighter',
    extension: '',
    size: 0,
    modifiedAt: FIXED_MODIFIED_AT
  })
])

// Everything category rules arrive inline with the keyword (`ext:png;jpg`,
// `folder:`). Split them out so the corpus can honour the same filters.
function parseQuery(search) {
  const tokens = String(search || '').split(/\s+/).filter(Boolean)
  const extensions = []
  let folderOnly = false
  const keywords = []
  for (const token of tokens) {
    if (token === 'folder:') {
      folderOnly = true
      continue
    }
    if (token.toLowerCase().startsWith('ext:')) {
      extensions.push(...token.slice(4).split(/[;,]/).filter(Boolean).map((value) => value.replace(/^\./, '').toLowerCase()))
      continue
    }
    if (token.includes(':') || token.includes('*')) continue
    keywords.push(token)
  }
  return { keyword: keywords.join(' ').trim().toLowerCase(), extensions, folderOnly }
}

function compareItems(sortMode) {
  const byName = (a, b) => a.name.localeCompare(b.name)
  const byPath = (a, b) => a.fullPath.localeCompare(b.fullPath)
  const bySize = (a, b) => a.size - b.size
  const byModified = (a, b) => a.modifiedAt - b.modifiedAt
  switch (sortMode) {
    case 'name-asc': return byName
    case 'name-desc': return (a, b) => byName(b, a)
    case 'path-asc': return byPath
    case 'path-desc': return (a, b) => byPath(b, a)
    case 'size-asc': return bySize
    case 'size-desc': return (a, b) => bySize(b, a)
    case 'modified-asc': return byModified
    default: return (a, b) => byModified(b, a)
  }
}

function createFakeEverythingQuery({ items = E2E_FAKE_EVERYTHING_ITEMS } = {}) {
  const corpus = items.map((item) => ({ ...item }))
  return (params = {}) => {
    const { keyword, extensions, folderOnly } = parseQuery(params.search)
    const matched = corpus.filter((item) => {
      if (folderOnly && item.extension) return false
      if (extensions.length && !extensions.includes(item.extension.toLowerCase())) return false
      if (!keyword) return true
      return item.name.toLowerCase().includes(keyword) || item.fullPath.toLowerCase().includes(keyword)
    })
    const sorted = matched.sort(compareItems(params.sortMode))
    const maxResults = Number(params.maxResults)
    const limited = Number.isFinite(maxResults) && maxResults > 0 ? sorted.slice(0, maxResults) : sorted
    // The real sidecar returns a fresh object per JSON line, so callers may
    // mutate results freely; hand out copies to keep that contract.
    return { total: matched.length, items: limited.map((item) => ({ ...item })), cached: false }
  }
}

module.exports = {
  createFakeEverythingQuery,
  E2E_FAKE_EVERYTHING_ITEMS,
  parseQuery
}
