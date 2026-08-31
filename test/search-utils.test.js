const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_CATEGORIES,
  normalizeCategoryRule,
  buildQuery,
  planQueries,
  mergeQueryResults,
  splitHighlight,
  naiveHighlight,
  renderHighlighted,
  formatSize,
  formatTime,
  extensionBadge
} = require('../search/search-utils')

test('normalizes bare extension lists into ext: rules and keeps operators', () => {
  assert.equal(normalizeCategoryRule('xls,xlsx；csv'), 'ext:xls;xlsx;csv')
  assert.equal(normalizeCategoryRule('.png,.jpg'), 'ext:png;jpg')
  assert.equal(normalizeCategoryRule('xls, xlsx'), 'xls, xlsx', 'rules containing spaces pass through as custom syntax')
  assert.equal(normalizeCategoryRule('ext:pdf'), 'ext:pdf')
  assert.equal(normalizeCategoryRule('folder:'), 'folder:')
  assert.equal(normalizeCategoryRule('dm:文档'), 'dm:文档')
  assert.equal(normalizeCategoryRule(''), '')
})

test('buildQuery joins keyword and category rule', () => {
  assert.equal(buildQuery('  报告 ', 'ext:pdf'), '报告 ext:pdf')
  assert.equal(buildQuery('报告', ''), '报告')
  assert.equal(buildQuery('', 'ext:pdf'), 'ext:pdf')
  assert.equal(buildQuery('   ', '   '), '')
})

test('planQueries decides between single and dual path-matching queries', () => {
  assert.deepEqual(planQueries('报告', true), [
    { keyword: '报告', matchPath: false },
    { keyword: '报告', matchPath: true }
  ])
  assert.deepEqual(planQueries('D:\\docs 报告', true), [{ keyword: 'D:\\docs 报告', matchPath: true }])
  assert.deepEqual(planQueries('C:/docs', true), [{ keyword: 'C:/docs', matchPath: true }])
  assert.deepEqual(planQueries('报告', false), [{ keyword: '报告', matchPath: false }])
  assert.deepEqual(planQueries('D:\\docs', false), [{ keyword: 'D:\\docs', matchPath: false }])
  assert.deepEqual(planQueries('   ', true), [])
})

test('mergeQueryResults deduplicates by lowercase path and keeps the largest total', () => {
  const merged = mergeQueryResults([
    { total: 3, items: [{ fullPath: 'C:\\A.txt' }, { fullPath: 'C:\\B.txt' }] },
    { total: 5, items: [{ fullPath: 'c:\\a.txt' }, { fullPath: 'C:\\C.txt' }] },
    { total: 9, items: [] }
  ])
  assert.deepEqual(merged.items.map((item) => item.fullPath), ['C:\\A.txt', 'C:\\B.txt', 'C:\\C.txt'])
  assert.equal(merged.total, 9)
  assert.deepEqual(mergeQueryResults([]), { total: 0, items: [] })
  assert.deepEqual(mergeQueryResults([null, { total: 2 }]), { total: 0, items: [] })
})

test('splitHighlight parses star and unit-separator markers with odd-count fallback', () => {
  assert.deepEqual(splitHighlight('*Cargo.toml*'), [
    { text: 'Cargo.toml', match: true }
  ])
  assert.deepEqual(splitHighlight('*Cargo.toml*.orig'), [
    { text: 'Cargo.toml', match: true },
    { text: '.orig', match: false }
  ])
  assert.deepEqual(splitHighlight('\x1Ffoo\x1Fbar'), [
    { text: 'foo', match: true },
    { text: 'bar', match: false }
  ])
  assert.equal(splitHighlight('a*b.txt'), null, 'odd marker count means literal asterisk')
  assert.equal(splitHighlight('plain.txt'), null)
})

test('naiveHighlight marks every keyword term occurrence', () => {
  const segments = naiveHighlight('Quarterly Report 2026.pdf', 'report pdf')
  assert.ok(segments.some((segment) => segment.match && segment.text.toLowerCase() === 'report'))
  assert.ok(segments.some((segment) => segment.match && segment.text.toLowerCase() === 'pdf'))
  assert.equal(naiveHighlight('plain.txt', 'ext:pdf'), null, 'operator terms are ignored')
  assert.equal(naiveHighlight('', 'pdf'), null)
})

test('renderHighlighted escapes html in both marker and naive modes', () => {
  const marked = renderHighlighted('<a>*key*</a>', 'key', '<a>*key*</a>')
  assert.ok(marked.includes('&lt;a&gt;'))
  assert.ok(marked.includes('<mark>key</mark>'))
  const naive = renderHighlighted('<b>report</b>', 'report')
  assert.ok(naive.includes('<mark>report</mark>'))
  assert.ok(naive.includes('&lt;b&gt;'))
  const plain = renderHighlighted('plain', 'missing')
  assert.equal(plain, 'plain')
})

test('formatSize and formatTime produce compact human-readable output', () => {
  assert.equal(formatSize(0), '')
  assert.equal(formatSize(undefined), '')
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(7.3 * 1024 * 1024), '7.3 MB')
  assert.equal(formatSize(2 * 1024 * 1024 * 1024), '2.0 GB')
  assert.equal(formatTime(0), '')
  assert.equal(formatTime(NaN), '')
  assert.match(formatTime(new Date('2026-08-30T22:43:03').getTime()), /^2026-08-30 \d{2}:43$/)
})

test('extensionBadge trims and shortens extensions', () => {
  assert.equal(extensionBadge('pdf'), 'PDF')
  assert.equal(extensionBadge('.docx'), 'DOCX')
  assert.equal(extensionBadge('javascript!'), 'JAVA')
  assert.equal(extensionBadge(''), '?')
})

test('default categories cover the plugin parity set', () => {
  const ids = DEFAULT_CATEGORIES.map((category) => category.id)
  assert.deepEqual(ids, ['all', 'folder', 'excel', 'word', 'ppt', 'pdf', 'image', 'video', 'audio', 'archive'])
})
