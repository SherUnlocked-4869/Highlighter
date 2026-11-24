// Usage pricing (B07): per-model rates with optional effective dates.
//
// A price row is one *version* of one model's rates, in CNY per one million
// tokens:
//
//   { model, input, cached, output, cachedWrite?, effectiveFrom? }
//
// Compatibility rule (the reason the row is not just extended in place):
//   - a legacy row carries the three rates only. It means "this model has had
//     these rates forever", so it stays the base version and remains byte-for-byte
//     the shape the settings store already holds (assertUsagePrices /
//     normalizeUsagePrices keep accepting and emitting it unchanged);
//   - `effectiveFrom` ('YYYY-MM-DD', a local calendar day in the report's
//     timezone) starts a new version. On and after that day the new rates apply;
//     before it the previous version applies. A day before the first version of a
//     model is *unpriced* (null), never zero.
//   - `cachedWrite` stays optional: without it a cache-write token is charged at
//     the input rate, which is exactly the pre-B07 rule.
//
// Unknown prices are represented by null / null cost everywhere; 0 is a real
// (free) price and must never stand in for "we do not know".

const crypto = require('node:crypto')

const PRICE_KEYS = Object.freeze(['input', 'cached', 'output'])
const OPTIONAL_PRICE_KEYS = Object.freeze(['cachedWrite', 'effectiveFrom'])
const ALLOWED_PRICE_KEYS = new Set(['model', ...PRICE_KEYS, ...OPTIONAL_PRICE_KEYS])
const MAX_MODEL_PRICES = 100
const MAX_RATE = 1000000
// Report-facing constants. The export module copies them into the JSON/CSV so a
// reader can recompute a total without guessing the unit.
const PRICE_SCHEMA_VERSION = 2
const PRICE_CURRENCY = 'CNY'
const PRICE_UNIT = 'CNY per 1M tokens'
const PRICE_STAMP_PREFIX = 'p2-'
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// A day key is a real calendar day, not just a well-shaped string: 2026-02-30
// parses (as March 2nd) but must not become an effective date.
function isDayKey(value) {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value
}

function isValidRate(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_RATE
}

// null / undefined / '' all mean "no effective date" (the legacy row, always
// effective). An unparsable value returns undefined so callers can distinguish
// "absent" from "invalid" and reject the row instead of silently dropping it.
function normalizeEffectiveFrom(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return null
  return isDayKey(trimmed) ? trimmed : undefined
}

function validModelPrice(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  if (typeof row.model !== 'string' || row.model.trim() === '' || row.model.length > 256) return false
  if (/[\x00-\x1f]/.test(row.model)) return false
  if (!PRICE_KEYS.every((key) => isValidRate(row[key]))) return false
  if (row.cachedWrite !== undefined && row.cachedWrite !== null && !isValidRate(row.cachedWrite)) return false
  return normalizeEffectiveFrom(row.effectiveFrom) !== undefined
}

// Identity of one price version: a model can repeat, but (model, effective day)
// must be unique so a day resolves to exactly one rate row.
function priceRowKey(row) {
  const effective = normalizeEffectiveFrom(row && row.effectiveFrom) || ''
  return `${row && row.model}\u0000${effective}`
}

// Keeps a legacy row exactly `{ model, input, cached, output }`: settings and
// its tests compare that object literally. New fields appear only when set.
function normalizeRow(row) {
  const normalized = { model: row.model, input: row.input, cached: row.cached, output: row.output }
  if (Number.isFinite(row.cachedWrite)) normalized.cachedWrite = row.cachedWrite
  const effective = normalizeEffectiveFrom(row.effectiveFrom)
  if (effective) normalized.effectiveFrom = effective
  return normalized
}

function comparePriceRows(left, right) {
  const byModel = left.model.localeCompare(right.model)
  if (byModel !== 0) return byModel
  return (left.effectiveFrom || '').localeCompare(right.effectiveFrom || '')
}

function normalizeUsagePrices(value) {
  const rows = Array.isArray(value) ? value.slice(0, MAX_MODEL_PRICES) : []
  const prices = new Map()
  for (const row of rows) {
    if (!validModelPrice(row)) continue
    const normalized = normalizeRow(row)
    prices.set(priceRowKey(normalized), normalized)
  }
  return [...prices.values()].sort(comparePriceRows)
}

function assertUsagePrices(value) {
  if (!Array.isArray(value) || value.length > MAX_MODEL_PRICES) {
    throw new RangeError(`Usage supports up to ${MAX_MODEL_PRICES} model prices`)
  }
  if (value.some((row) => !validModelPrice(row) || Object.keys(row).some((key) => !ALLOWED_PRICE_KEYS.has(key)))) {
    throw new TypeError('Model prices require input, cache read and output rates between 0 and 1000000')
  }
  if (new Set(value.map(priceRowKey)).size !== value.length) throw new RangeError('Duplicate model price')
}

// Stable short stamp of one price table. It is the "price table version" the
// export carries: two exports with the same rates and effective dates share it,
// and any rate/date edit changes it, which is also what invalidates the query
// LRU (usage-query.js compares this value).
function priceVersionStamp(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .map((row) => [
      row.model,
      row.input,
      row.cached,
      Number.isFinite(row.cachedWrite) ? row.cachedWrite : null,
      row.output,
      normalizeEffectiveFrom(row.effectiveFrom) || null
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const digest = crypto.createHash('sha1').update(JSON.stringify(list)).digest('hex').slice(0, 12)
  return `${PRICE_STAMP_PREFIX}${digest}`
}

// Legacy ("three rates, always effective") rows -> explicit versioned rows.
// Nothing is lost and no history changes: the migrated row keeps its rates and
// says so explicitly with effectiveFrom: null instead of relying on absence.
function migrateUsagePrices(value) {
  const rows = normalizeUsagePrices(value).map((row) => ({
    model: row.model,
    input: row.input,
    cached: row.cached,
    cachedWrite: Number.isFinite(row.cachedWrite) ? row.cachedWrite : null,
    output: row.output,
    effectiveFrom: normalizeEffectiveFrom(row.effectiveFrom) || null
  }))
  return {
    schemaVersion: PRICE_SCHEMA_VERSION,
    unit: PRICE_UNIT,
    currency: PRICE_CURRENCY,
    rows,
    migrated: rows.filter((row) => row.effectiveFrom === null).length
  }
}

// A price table index over the normalized versions:
//   get(model)            latest version (legacy callers asking "is it priced?")
//   priceFor(model, day)  the version in force on `day` (null = unknown)
// `versioned` tells the query layer whether it must fold buckets per local day
// (only a table with effective dates needs that extra pass).
function createPriceTable(value) {
  const rows = normalizeUsagePrices(value)
  const byModel = new Map()
  for (const row of rows) {
    const list = byModel.get(row.model)
    if (list) list.push(row)
    else byModel.set(row.model, [row])
  }
  for (const list of byModel.values()) {
    list.sort((left, right) => (left.effectiveFrom || '').localeCompare(right.effectiveFrom || ''))
  }
  const version = rows.length > 0 ? priceVersionStamp(rows) : null
  const versioned = rows.some((row) => Boolean(row.effectiveFrom))
  const cacheWriteMode = rows.some((row) => Number.isFinite(row.cachedWrite)) ? 'explicit' : 'input'

  function get(model) {
    const list = byModel.get(model)
    return list ? list[list.length - 1] : undefined
  }

  function priceFor(model, day) {
    const list = byModel.get(model)
    if (!list) return null
    if (!day) return list[list.length - 1]
    let chosen = null
    for (const row of list) {
      if (!row.effectiveFrom) chosen = row
      else if (row.effectiveFrom <= day) chosen = row
      else break
    }
    return chosen
  }

  return {
    rows,
    size: rows.length,
    version,
    versioned,
    currency: PRICE_CURRENCY,
    unit: PRICE_UNIT,
    cacheWriteMode,
    byModel,
    get,
    has: (model) => byModel.has(model),
    modelNames: () => [...byModel.keys()].sort(),
    priceFor
  }
}

// Accepts a price table, a Map(model -> row) or the normalized array so older
// call sites (and the detail query) keep working unchanged.
function lookupPrice(prices, model, day) {
  if (!prices) return null
  if (typeof prices.priceFor === 'function') return prices.priceFor(model, day) || null
  if (prices instanceof Map) return prices.get(model) || null
  if (Array.isArray(prices)) {
    const table = createPriceTable(prices)
    return table.priceFor(model, day)
  }
  const row = typeof prices.get === 'function' ? prices.get(model) : null
  return row || null
}

function modelCost(row, prices, day = null) {
  const price = lookupPrice(prices, row && row.model, day)
  if (!price) return null
  const inputTokens = Number(row.input_tokens || 0)
  const cacheWriteTokens = Number(row.cache_creation_input_tokens || 0)
  // Cache writes are charged at their own rate when the row has one; otherwise
  // the pre-B07 rule (input rate) applies bit-for-bit.
  const cacheWriteRate = Number.isFinite(price.cachedWrite) ? price.cachedWrite : price.input
  return (inputTokens * price.input +
    cacheWriteTokens * cacheWriteRate +
    Number(row.cached_input_tokens || 0) * price.cached +
    Number(row.output_tokens || 0) * price.output) / 1000000
}

function addCost(target, row, prices, day = null) {
  if (!(row.total_tokens || row.billable_total_tokens)) return
  const cost = modelCost(row, prices, day)
  if (cost === null) {
    if (!target.unpriced) target.unpriced = new Set()
    target.unpriced.add(row.model)
  } else target.costCny = (target.costCny ?? 0) + cost
}

function costPayload(target) {
  return { costCny: target.costCny ?? null, unpricedModels: target.unpriced?.size || 0 }
}

module.exports = {
  MAX_MODEL_PRICES,
  PRICE_CURRENCY,
  PRICE_KEYS,
  PRICE_SCHEMA_VERSION,
  PRICE_UNIT,
  addCost,
  assertUsagePrices,
  costPayload,
  createPriceTable,
  isDayKey,
  migrateUsagePrices,
  modelCost,
  normalizeEffectiveFrom,
  normalizeUsagePrices,
  priceRowKey,
  priceVersionStamp,
  validModelPrice
}
