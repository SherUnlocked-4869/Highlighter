// Device battery readings are pushed by the main process. Visibility here owns
// DOM/IPC subscriptions only; the main window's verified route owns sampling.
const DEVICE_BATTERY_STATUS = new Set(['loading', 'ready', 'partial', 'unavailable', 'paused'])
const DEVICE_BATTERY_KINDS = new Set(['mouse', 'keyboard', 'headphones', 'earbuds', 'controller', 'pen', 'speaker', 'other', 'phone'])
const DEVICE_BATTERY_SOURCES = new Set(['bluetooth', 'gatt', 'logitech', 'razer', 'steelseries', 'hyperx', 'sony', 'apple', 'gaming', 'hid', 'phone-link'])
const DEVICE_BATTERY_PARTS = ['left', 'right', 'case']

let deviceBatteryPage = null

function deviceBatteryDeactivate() {
  deviceBatteryPage?.cleanup()
  deviceBatteryPage = null
}

function deviceBatteryText(key, params) {
  return t(`config.device-battery.${key}`, params)
}

function deviceBatteryElement(tag, className, text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function deviceBatteryAcText(acOnline) {
  return typeof acOnline === 'boolean' ? deviceBatteryText(acOnline ? 'ac-online' : 'ac-offline') : ''
}

function deviceBatteryRing(kind, percent, charging) {
  const ring = deviceBatteryElement('div', 'device-battery-ring')
  ring.setAttribute('aria-hidden', 'true')
  const arc = deviceBatteryElement('span', 'device-battery-arc')
  if (percent > 0) {
    arc.dataset.filled = 'true'
    arc.style.setProperty('--battery-angle', `${percent / 100}turn`)
  }
  const icon = deviceBatteryElement('span', 'svg-icon device-battery-icon')
  icon.dataset.kind = kind
  icon.setAttribute('aria-hidden', 'true')
  ring.append(arc, icon)
  if (charging) {
    const badge = deviceBatteryElement('span', 'device-battery-charge-badge')
    badge.append(deviceBatteryElement('span', 'svg-icon'))
    ring.append(badge)
  }
  return ring
}

function deviceBatteryReading(reading, number, { stale = false, estimated = false, kind, name } = {}) {
  const { percent, charging, acOnline } = reading
  const known = Number.isInteger(percent) && percent >= 0 && percent <= 100
  const group = deviceBatteryElement('div', 'device-battery-reading')
  if (charging === true && !stale) group.dataset.charging = 'true'
  if (kind) group.append(deviceBatteryRing(kind, known ? percent : null, group.dataset.charging === 'true'))
  const label = deviceBatteryElement('span', known ? 'device-battery-percent' : 'device-battery-unknown')
  if (known && kind) {
    for (const part of number.formatToParts(percent / 100)) {
      label.append(deviceBatteryElement('span', part.type === 'percentSign' ? 'device-battery-percent-sign' : '', part.value))
    }
  } else {
    label.textContent = known ? number.format(percent / 100) : deviceBatteryText('not-reported')
  }
  group.append(label)
  if (name) group.append(name)
  const states = []
  if (known) {
    if (estimated) states.push(deviceBatteryText('estimated'))
    if (!stale && percent <= 25) {
      group.dataset.level = percent <= 15 ? 'low' : 'warning'
      states.push(deviceBatteryText(group.dataset.level))
    }
  }
  if (charging === true) states.push(deviceBatteryText('charging'))
  else if (charging === false) states.push(deviceBatteryText('not-charging'))
  const power = deviceBatteryAcText(acOnline)
  if (power) states.push(power)
  if (states.length) group.append(deviceBatteryElement('small', 'device-battery-meta device-battery-status', states.join(' · ')))
  return group
}

function deviceBatteryTileContent(device, number, stale) {
  const kind = DEVICE_BATTERY_KINDS.has(device.kind) ? device.kind : 'other'
  const meta = [deviceBatteryText(DEVICE_BATTERY_SOURCES.has(device.source) ? `source.${device.source}` : `kind.${kind}`)]
  if (stale) meta.push(deviceBatteryText('last-reading'))
  const name = deviceBatteryElement('b', 'device-battery-name')
  // Device names come from the OS. Never interpolate them into HTML or selectors.
  name.append(deviceBatteryElement('bdi', '', device.name || deviceBatteryText('unnamed')))
  const reading = deviceBatteryReading(device, number, { stale, estimated: device.estimated, kind, name })
  reading.append(deviceBatteryElement('small', 'device-battery-meta', meta.join(' · ')))

  const parts = DEVICE_BATTERY_PARTS.map((part) => device.parts?.find((item) => item.part === part)).filter(Boolean)
  if (!parts.length) return [reading]
  const list = deviceBatteryElement('ul', 'device-battery-parts')
  for (const part of parts) {
    const item = deviceBatteryElement('li')
    item.append(
      deviceBatteryElement('span', 'device-battery-meta', deviceBatteryText(`part.${part.part}`)),
      deviceBatteryReading(part, number, { stale, estimated: device.estimated && device.percent === null })
    )
    list.append(item)
  }
  return [reading, list]
}

function renderDeviceBattery() {
  const locale = currentLanguage()
  if (deviceBatteryPage?.locale === locale) return
  deviceBatteryDeactivate()
  view.innerHTML = `<div class="page device-battery-page">
    ${pageHeader(t('config.route.device-battery'), deviceBatteryText('subtitle'), `<button class="button" type="button" id="deviceBatteryRefresh">${iconMarkup('icons/refresh.svg')}<span id="deviceBatteryRefreshLabel">${deviceBatteryText('refresh')}</span></button>`)}
    <p class="device-battery-meta" id="deviceBatteryUpdated"></p>
    <p class="device-battery-feedback" id="deviceBatteryFeedback" role="status"></p>
    <section class="section">
      <h2 class="section-title">${deviceBatteryText('devices')}</h2>
      <div class="card device-battery-panel">
        <p class="device-battery-note" id="deviceBatteryEmpty"></p>
        <ul class="device-battery-grid" id="deviceBatteryDevices"></ul>
      </div>
    </section>
    <section class="section">
      <h2 class="section-title">${deviceBatteryText('system')}</h2>
      <div class="card device-battery-system" id="deviceBatterySystem"></div>
    </section>
    <section class="section">
      <h2 class="section-title">${deviceBatteryText('support-title')}</h2>
      <p class="device-battery-note">${deviceBatteryText('support')}</p>
    </section>
  </div>`
  const refresh = view.querySelector('#deviceBatteryRefresh')
  const refreshLabel = view.querySelector('#deviceBatteryRefreshLabel')
  const updated = view.querySelector('#deviceBatteryUpdated')
  const feedback = view.querySelector('#deviceBatteryFeedback')
  const system = view.querySelector('#deviceBatterySystem')
  const empty = view.querySelector('#deviceBatteryEmpty')
  const list = view.querySelector('#deviceBatteryDevices')
  const api = window.electronAPI
  const hasBridge = ['getDeviceBatterySnapshot', 'onDeviceBatterySnapshot', 'refreshDeviceBattery'].every((method) => typeof api?.[method] === 'function')
  const number = new Intl.NumberFormat(locale, { style: 'percent' })
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' })
  const byName = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
  const tiles = new Map()
  let systemKey
  let session = null

  function renderSnapshot(snapshot, status = snapshot?.status || 'loading') {
    const timestamp = Number.isFinite(snapshot?.updatedAt) && new Date(snapshot.updatedAt)
    const paused = status === 'paused'
    const checked = timestamp && Number.isFinite(timestamp.getTime())
      ? deviceBatteryText('updated-at', { time: dateTime.format(timestamp) })
      : deviceBatteryText('not-checked')
    updated.textContent = paused ? `${checked} · ${deviceBatteryText('paused')}` : checked
    const systemState = snapshot?.system?.state
    const displaySystem = systemState === 'ready' || systemState === 'no-battery'
      ? systemState
      : status === 'loading' || paused ? status : 'system-unavailable'
    const nextSystemKey = JSON.stringify([displaySystem, paused, snapshot?.system])
    if (systemKey !== nextSystemKey) {
      systemKey = nextSystemKey
      system.replaceChildren(displaySystem === 'ready'
        ? deviceBatteryReading(snapshot.system, number, { stale: paused })
        : deviceBatteryElement('p', 'device-battery-note', deviceBatteryText(displaySystem)))
      const note = displaySystem === 'ready' && paused ? deviceBatteryText('last-reading')
        : displaySystem === 'no-battery' ? deviceBatteryAcText(snapshot.system.acOnline) : ''
      if (note) system.append(deviceBatteryElement('p', 'device-battery-note', note))
    }

    const devices = snapshot?.devices || []
    const ids = new Set(devices.map((device) => device.id))
    for (const [id, tile] of tiles) {
      if (ids.has(id)) continue
      tile.node.remove()
      tiles.delete(id)
    }
    // Sort by name and opaque ID so battery updates don't move devices.
    const sorted = devices.slice().sort((a, b) => byName.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    let before = list.firstElementChild
    for (const device of sorted) {
      const stale = paused || device.stale
      const key = JSON.stringify([device, stale])
      let tile = tiles.get(device.id)
      if (!tile) {
        tile = { node: deviceBatteryElement('li', 'device-battery-tile') }
        tiles.set(device.id, tile)
      }
      if (key !== tile.key) {
        tile.node.replaceChildren(...deviceBatteryTileContent(device, number, stale))
        tile.key = key
      }
      if (tile.node !== before) list.insertBefore(tile.node, before)
      before = tile.node.nextElementSibling
    }
    list.hidden = devices.length === 0
    empty.hidden = !list.hidden
    empty.textContent = list.hidden ? deviceBatteryText(status === 'ready' ? 'empty' : status) : ''
  }

  function isActive(active) {
    return session === active && !document.hidden && currentRoute === 'device-battery'
  }

  function announce(key) {
    const text = deviceBatteryText(key)
    if (feedback.textContent !== text) feedback.textContent = text
  }

  function showRefreshing(busy) {
    refresh.setAttribute('aria-disabled', String(!hasBridge || busy))
    refreshLabel.textContent = deviceBatteryText(busy ? 'refreshing' : 'refresh')
  }

  function accept(active, snapshot, announceChange = true) {
    if (!isActive(active)) return false
    if (!Number.isSafeInteger(snapshot?.revision) || !DEVICE_BATTERY_STATUS.has(snapshot.status) || !Array.isArray(snapshot.devices)) return false
    if (active.snapshot && snapshot.revision <= active.snapshot.revision) return true
    const status = snapshot.status
    const issue = status === 'partial' || status === 'unavailable' ? `feedback-${status}`
      : status === 'ready' && snapshot.system?.state === 'unavailable' ? 'system-unavailable' : ''
    const previousIssue = active.issue
    const previousStatus = active.snapshot?.status
    if (issue || status === 'ready') active.issue = issue
    active.snapshot = snapshot
    renderSnapshot(snapshot)
    if (announceChange) {
      if (issue && (issue !== previousIssue || previousStatus === 'loading')) announce(issue)
      else if (!issue && previousIssue && status === 'ready') announce('feedback-recovered')
    }
    return true
  }

  async function start() {
    if (session) return
    if (!hasBridge) {
      renderSnapshot(null, 'unavailable')
      announce('feedback-no-bridge')
      return
    }
    const active = { snapshot: null, issue: '', refreshing: false }
    session = active
    try {
      // Subscribe first; reject an older get/refresh result if a newer revision
      // has already been delivered by the push channel.
      active.unsubscribe = api.onDeviceBatterySnapshot((snapshot) => accept(active, snapshot, !active.refreshing))
      const first = await api.getDeviceBatterySnapshot()
      if (accept(active, first, !active.refreshing)) return
    } catch { /* A failed read must not overwrite an accepted push. */ }
    if (isActive(active) && !active.snapshot) {
      active.issue = 'feedback-unavailable'
      renderSnapshot(null, 'unavailable')
      announce(active.issue)
    }
  }

  async function refreshNow() {
    const active = session
    if (!active || !isActive(active) || active.refreshing) return
    // Disable repeat activation while retaining keyboard focus. Don't replace
    // the button or change the live region to an interstitial loading message.
    active.refreshing = true
    showRefreshing(true)
    feedback.textContent = ''
    try {
      const result = await api.refreshDeviceBattery()
      if (!isActive(active)) return
      if (!accept(active, result?.snapshot, false)) throw new Error('Invalid snapshot')
      switch (result.status) {
        case 'complete': announce(active.issue || 'feedback-refreshed'); break
        case 'partial': announce('feedback-refresh-partial'); break
        case 'paused': announce('feedback-paused'); break
        case 'unavailable': announce('feedback-unavailable'); break
        case 'timeout': announce('feedback-refresh-timeout'); break
        default: throw new Error('Invalid refresh status')
      }
    } catch {
      if (isActive(active)) announce('feedback-refresh-failed')
    } finally {
      if (isActive(active)) {
        active.refreshing = false
        showRefreshing(false)
      }
    }
  }

  function stop() {
    const active = session
    session = null
    active?.unsubscribe?.()
  }

  function syncVisibility() {
    if (document.hidden) {
      stop()
      showRefreshing(false)
      feedback.textContent = ''
      renderSnapshot(null)
    } else void start()
  }

  refresh.setAttribute('aria-disabled', String(!hasBridge))
  refresh.addEventListener('click', refreshNow)
  document.addEventListener('visibilitychange', syncVisibility)
  deviceBatteryPage = {
    locale,
    cleanup() {
      document.removeEventListener('visibilitychange', syncVisibility)
      refresh.removeEventListener('click', refreshNow)
      stop()
      view.replaceChildren()
    }
  }
  renderSnapshot(null)
  if (!document.hidden) void start()
}

window.configRoutes = window.configRoutes || {}
window.configRoutes['renderDeviceBattery'] = renderDeviceBattery
