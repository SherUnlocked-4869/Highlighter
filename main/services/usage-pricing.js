const PRICE_KEYS = ['input', 'cached', 'output']
const MAX_MODEL_PRICES = 100

function validModelPrice(row) {
  return row && typeof row.model === 'string' && row.model.trim() !== '' && row.model.length <= 256 &&
    !/[\x00-\x1f]/.test(row.model) && PRICE_KEYS.every((key) => Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= 1000000)
}

function normalizeUsagePrices(value) {
  const rows = Array.isArray(value) ? value.slice(0, MAX_MODEL_PRICES) : []
  const prices = new Map()
  for (const row of rows) if (validModelPrice(row)) prices.set(row.model, { model: row.model, input: row.input, cached: row.cached, output: row.output })
  return [...prices.values()].sort((left, right) => left.model.localeCompare(right.model))
}

function assertUsagePrices(value) {
  if (!Array.isArray(value) || value.length > MAX_MODEL_PRICES) throw new RangeError('Usage supports up to 100 model prices')
  if (value.some((row) => !validModelPrice(row) || Object.keys(row).some((key) => key !== 'model' && !PRICE_KEYS.includes(key)))) {
    throw new TypeError('Model prices require input, cache read and output rates between 0 and 1000000')
  }
  if (new Set(value.map((row) => row.model)).size !== value.length) throw new RangeError('Duplicate model price')
}

function modelCost(row, prices) {
  const price = prices.get(row.model)
  if (!price) return null
  return ((Number(row.input_tokens || 0) + Number(row.cache_creation_input_tokens || 0)) * price.input +
    Number(row.cached_input_tokens || 0) * price.cached + Number(row.output_tokens || 0) * price.output) / 1000000
}

function addCost(target, row, prices) {
  if (!(row.total_tokens || row.billable_total_tokens)) return
  const cost = modelCost(row, prices)
  if (cost === null) {
    if (!target.unpriced) target.unpriced = new Set()
    target.unpriced.add(row.model)
  } else target.costCny = (target.costCny ?? 0) + cost
}

function costPayload(target) {
  return { costCny: target.costCny ?? null, unpricedModels: target.unpriced?.size || 0 }
}

module.exports = { assertUsagePrices, normalizeUsagePrices, modelCost, addCost, costPayload }
