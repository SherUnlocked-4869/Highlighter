'use strict'

// Domain locale table: the pinned-image window (`pin/`).
//
// One file per domain, each file registering all three languages at once
// (layout decision 2026-10-11, Lead; plan §10.3), so this file owns `pin.*`
// alone and never shares a write target with another stream.
//
// The pin window is the one renderer that shipped visible copy without a domain
// table: `#clickThroughTag` renders the click-through state in the overlay.
// The zh-CN column is byte-identical to the pre-migration literal in pin.html
// (plan §10.4-T5), so the migration does not change the visible behaviour.
;(function () {
  const tables = (globalThis.__LOCALES = globalThis.__LOCALES || {})
  const add = (language, entries) => Object.assign((tables[language] = tables[language] || {}), entries)

  add('zh-CN', {
    'pin.click-through.label': '穿透中 · 悬停退出',
    'pin.click-through.title': '鼠标穿透中'
  })

  add('en-US', {
    'pin.click-through.label': 'Click-through · hover to exit',
    'pin.click-through.title': 'Click-through active'
  })

  add('zh-TW', {
    'pin.click-through.label': '穿透中 · 懸停退出',
    'pin.click-through.title': '滑鼠穿透中'
  })
})()
