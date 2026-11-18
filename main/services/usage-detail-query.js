const { addCost, costPayload } = require('./usage-pricing')
const { addDaysToDayKey } = require('./usage-time')

function toolCategory(name) {
  if (/^mcp[._]/i.test(name)) return 'mcp'
  if (/^(bash|shell|exec_command|shell_command|local_shell_call)$/i.test(name)) return 'shell'
  if (/^(read|read_file|view)$/i.test(name)) return 'read'
  if (/^(edit|apply_patch|multi_edit|multiedit)$/i.test(name)) return 'edit'
  if (/^(write|write_file)$/i.test(name)) return 'write'
  if (/^(grep|rg|search)$/i.test(name)) return 'grep'
  if (/^(glob|find|list_files)$/i.test(name)) return 'glob'
  if (/^(task|spawn_agent|subagent)$/i.test(name)) return 'task'
  return 'other'
}

function aggregateRows(rows, prices, group) {
  const entries = new Map()
  for (const row of rows) {
    const key = group(row)
    let entry = entries.get(key)
    if (!entry) {
      entry = {
        id: row.id, name: row.name, source: row.source, title: row.title, projectName: row.projectName,
        first: row.first, last: row.last, models: [], total_tokens: 0, cached_input_tokens: 0,
        input_tokens: 0, output_tokens: 0, records: 0, activeSeconds: 0
      }
      entries.set(key, entry)
    }
    if (row.first && (!entry.first || row.first < entry.first)) entry.first = row.first
    if (row.last && (!entry.last || row.last > entry.last)) entry.last = row.last
    entry.models.push(row.model)
    entry.total_tokens += row.total_tokens || 0
    entry.cached_input_tokens += row.cached_input_tokens || 0
    entry.input_tokens += (row.input_tokens || 0) + (row.cache_creation_input_tokens || 0)
    entry.output_tokens += row.output_tokens || 0
    entry.records += row.conversation_count || 0
    entry.activeSeconds += row.activeSeconds || 0
    addCost(entry, row, prices)
  }
  return Array.from(entries.values(), (entry) => {
    const { unpriced, ...rest } = entry
    return { ...rest, ...costPayload(entry), models: rest.models.slice(0, 12) }
  })
}

function describeDetails(raw, prices, dayOf) {
  if (!raw) return null
  const projects = aggregateRows(raw.projects.slice(0, 10000), prices, (row) => row.id)
    .sort((left, right) => right.total_tokens - left.total_tokens || left.name.localeCompare(right.name))
  const sessions = aggregateRows(raw.sessions.slice(0, 10000), prices, (row) => row.source + ':' + row.id)
  const rank = (selector) => sessions.slice().sort((left, right) => selector(right) - selector(left) || right.total_tokens - left.total_tokens).slice(0, 100)
  const tokenRank = rank((entry) => entry.total_tokens)
  const amounts = sessions.map((entry) => entry.total_tokens).sort((left, right) => left - right)
  const percentile = (value) => amounts[Math.max(0, Math.ceil(amounts.length * value) - 1)] || 0
  const activities = (kind) => {
    const total = raw.activityTotals.find((entry) => entry.kind === kind)
    return {
      calls: total?.calls || 0, sessions: total?.sessions || 0, count: total?.names || 0,
      top: raw.activities.filter((row) => row.kind === kind).slice(0, 64)
        .map((row) => ({ ...row, category: kind === 'tool' ? toolCategory(row.name) : undefined }))
    }
  }
  const weeks = new Map()
  for (const row of raw.activityHours.slice(0, 10000)) {
    const day = dayOf(row.hour_start)
    const weekday = (new Date(day).getUTCDay() + 6) % 7
    const start = addDaysToDayKey(day, -weekday)
    if (!weeks.has(start)) weeks.set(start, {})
    const group = weeks.get(start)
    const category = toolCategory(row.name)
    group[category] = (group[category] || 0) + row.calls
  }
  const tools = activities('tool')
  const categories = new Map()
  for (const row of raw.activities.filter((item) => item.kind === 'tool')) {
    const category = toolCategory(row.name)
    categories.set(category, (categories.get(category) || 0) + row.calls)
  }
  tools.categories = Array.from(categories, ([name, calls]) => ({ name, calls })).sort((left, right) => right.calls - left.calls)
  tools.weeks = Array.from(weeks, ([start, calls]) => ({ start, calls })).sort((left, right) => left.start.localeCompare(right.start)).slice(-104)
  const status = raw.info.some((item) => item.status === 'pending') ? 'pending' :
    raw.info.some((item) => item.status === 'partial') || [raw.projects, raw.sessions, raw.activityHours].some((rows) => rows.length > 10000) ? 'partial' : 'ready'
  const sessionRanks = [...new Map([...tokenRank, ...rank((entry) => entry.costCny ?? -1), ...rank((entry) => entry.activeSeconds)]
    .map((entry) => [entry.source + ':' + entry.id, entry])).values()]
  return {
    status, projects: projects.slice(0, 250), projectCount: projects.length, sessionCount: sessions.length,
    sessionRanks, median: percentile(.5), p90: percentile(.9),
    activeSeconds: sessions.reduce((sum, entry) => sum + entry.activeSeconds, 0), skills: activities('skill'), tools
  }
}

module.exports = { describeDetails }
