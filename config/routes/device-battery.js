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

function deviceBatteryReading(reading, number, stale = false, estimated = false) {
  const { percent, charging, acOnline } = reading
  const known = Number.isInteger(percent) && percent >= 0 && percent <= 100
  const group = deviceBatteryElement('div', 'device-battery-reading')
  const label = deviceBatteryElement('span', 'device-battery-percent', known ? number.format(percent / 100) : deviceBatteryText('not-reported'))
  group.append(label)
  const states = []
  if (known) {
    const track = deviceBatteryElement('span', 'device-battery-track')
    track.setAttribute('aria-hidden', 'true')
    const fill = deviceBatteryElement('i')
    fill.style.inlineSize = `${percent}%`
    track.append(fill)
    group.append(track)
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
  if (states.length) group.append(deviceBatteryElement('small', 'device-battery-meta', states.join(' · ')))
  return group
}

function deviceBatteryRowContent(device, number, stale) {
  const kind = DEVICE_BATTERY_KINDS.has(device.kind) ? device.kind : 'other'
  const meta = [deviceBatteryText(`kind.${kind}`)]
  if (DEVICE_BATTERY_SOURCES.has(device.source)) meta.push(deviceBatteryText(`source.${device.source}`))
  if (stale) meta.push(deviceBatteryText('last-reading'))
  const label = deviceBatteryElement('div', 'form-label')
  const name = deviceBatteryElement('b')
  // Device names come from the OS. Never interpolate them into HTML or selectors.
  name.append(deviceBatteryElement('bdi', '', device.name || deviceBatteryText('unnamed')))
  label.append(name, deviceBatteryElement('small', '', meta.join(' · ')))
  const icon = deviceBatteryElement('span', 'svg-icon device-battery-icon')
  icon.dataset.kind = kind
  icon.setAttribute('aria-hidden', 'true')
  const identity = deviceBatteryElement('div', 'device-battery-identity')
  identity.append(icon, label)

  const parts = DEVICE_BATTERY_PARTS.map((part) => device.parts?.find((item) => item.part === part)).filter(Boolean)
  const readings = deviceBatteryElement('div', 'device-battery-readings')
  if (!parts.length || device.percent !== null || device.charging !== null) {
    readings.append(deviceBatteryReading(device, number, stale, device.estimated))
  }
  if (parts.length) {
    const list = deviceBatteryElement('ul', 'device-battery-parts')
    for (const part of parts) {
      const item = deviceBatteryElement('li')
      item.append(
        deviceBatteryElement('span', 'device-battery-meta', deviceBatteryText(`part.${part.part}`)),
        deviceBatteryReading(part, number, stale, device.estimated)
      )
      list.append(item)
    }
    readings.append(list)
  }
  return [identity, readings]
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
      <h2 class="section-title">${deviceBatteryText('system')}</h2>
      <div class="card device-battery-system" id="deviceBatterySystem"></div>
    </section>
    <section class="section">
      <h2 class="section-title">${deviceBatteryText('devices')}</h2>
      <div class="card form-card">
        <p class="device-battery-note" id="deviceBatteryEmpty"></p>
        <ul class="device-battery-list" id="deviceBatteryDevices"></ul>
      </div>
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
  const rows = new Map()
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
        ? deviceBatteryReading(snapshot.system, number, paused)
        : deviceBatteryElement('p', 'device-battery-note', deviceBatteryText(displaySystem)))
      const note = displaySystem === 'ready' && paused ? deviceBatteryText('last-reading')
        : displaySystem === 'no-battery' ? deviceBatteryAcText(snapshot.system.acOnline) : ''
      if (note) system.append(deviceBatteryElement('p', 'device-battery-note', note))
    }

    const devices = snapshot?.devices || []
    const ids = new Set(devices.map((device) => device.id))
    for (const [id, row] of rows) {
      if (ids.has(id)) continue
      row.node.remove()
      rows.delete(id)
    }
    // Names and opaque IDs, not battery levels, determine the order. Keep
    // unchanged rows in the DOM so routine readings don't rebuild the list.
    const sorted = devices.slice().sort((a, b) => byName.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    let before = list.firstElementChild
    for (const device of sorted) {
      const stale = paused || device.stale
      const key = JSON.stringify([device, stale])
      let row = rows.get(device.id)
      if (!row) {
        row = { node: deviceBatteryElement('li', 'form-row device-battery-row') }
        rows.set(device.id, row)
      }
      if (key !== row.key) {
        row.node.replaceChildren(...deviceBatteryRowContent(device, number, stale))
        row.key = key
      }
      if (row.node !== before) list.insertBefore(row.node, before)
      before = row.node.nextElementSibling
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
