'use strict'

// P2-06 follow-up (docs/reviews/2026-11-28-d7923ac-fix-delivery-review.md finding 9):
// the two-source shortcut merge must pair the control bar and the global hook in physical-press
// ORDER. The first fix paired each arriving entry with its NEAREST candidate from the other
// source, which a complete double report can defeat: two physical Ctrl+Z presses at 1000/1090 ms
// seen by the control bar at 1110/1200 ms (each 110 ms late) used to pair 1090 with 1110 and
// leave 1000/1200 as two singles, turning two presses into THREE capsules. One-to-one order
// preserving pairing keeps the two pairs.

const test = require('node:test')
const assert = require('node:assert/strict')

const { mergeKeystrokeSources } = require('../main/domains/record')

const BASE = 1_764_300_000_000
const at = (offset, combo = 'Ctrl+Z') => ({ at: BASE + offset, combo })

test('P2-06 follow-up: two complete dual-reported presses stay two events (nearest pairing gave three)', () => {
  const controlBar = [at(1110), at(1200)]
  const global = [at(1000), at(1090)]
  assert.deepEqual(mergeKeystrokeSources(controlBar, global), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1090, combo: 'Ctrl+Z' }
  ])
})

test('P2-06 follow-up: a single-source rapid double press is never deduped', () => {
  assert.deepEqual(mergeKeystrokeSources([at(1000), at(1090)], []), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1090, combo: 'Ctrl+Z' }
  ])
  assert.deepEqual(mergeKeystrokeSources([], [at(1000), at(1090)]), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1090, combo: 'Ctrl+Z' }
  ])
})

test('P2-06 follow-up: when one source misses a report the other report is kept (two presses, one pair)', () => {
  // The control bar only saw the first press; the global hook saw both.
  assert.deepEqual(mergeKeystrokeSources([at(1110)], [at(1000), at(1090)]), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1090, combo: 'Ctrl+Z' }
  ])
  // The global hook missed the second press instead: the unpaired control-bar report survives.
  assert.deepEqual(mergeKeystrokeSources([at(1000), at(1090)], [at(1005)]), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1090, combo: 'Ctrl+Z' }
  ])
})

test('P2-06 follow-up: pairing preserves order and never crosses two same-label sequences', () => {
  // control 1000 and 1100, global 1090 and 1110. Order-preserving matching pairs 1000-1090 and
  // 1100-1110; a nearest/crossing pairing would pair 1000 with 1110 and 1100 with 1090.
  assert.deepEqual(mergeKeystrokeSources([at(1000), at(1100)], [at(1090), at(1110)]), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1100, combo: 'Ctrl+Z' }
  ])
})

test('P2-06 follow-up: the 120 ms window still decides whether a pair exists', () => {
  assert.equal(mergeKeystrokeSources([at(120)], [at(0)]).length, 1, 'exactly 120 ms apart pairs')
  assert.deepEqual(mergeKeystrokeSources([at(121)], [at(0)]), [
    { at: BASE + 0, combo: 'Ctrl+Z' },
    { at: BASE + 121, combo: 'Ctrl+Z' }
  ], '121 ms apart stays two reports')
})

test('P2-06 follow-up: different combos never pair and one-to-one still bounds each source', () => {
  assert.deepEqual(mergeKeystrokeSources(
    [at(1000, 'Ctrl+Z'), at(1010, 'Ctrl+Y')],
    [at(1005, 'Ctrl+Z'), at(1015, 'Ctrl+Y')]
  ), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1010, combo: 'Ctrl+Y' }
  ])
  // One control-bar report can absorb only one global report even when several are in range.
  assert.equal(mergeKeystrokeSources([at(1000)], [at(1005), at(1090)]).length, 2)
  // The output stays time-ascending regardless of input array order and source identity.
  assert.deepEqual(mergeKeystrokeSources([at(1500), at(1000)], [at(1300)]), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1300, combo: 'Ctrl+Z' },
    { at: BASE + 1500, combo: 'Ctrl+Z' }
  ])
})
