'use strict'
const DEFAULT_CLIPBOARD = Object.freeze({ enabled: false, paused: false, captureText: true, captureImages: true,
  historyLimit: 500, retentionDays: 30, maxPayloadMiB: 256, maxDiskMiB: 384, maxThumbnailMiB: 64, releaseAfterMs: 60000, excludedApps: [] })
const LIMITS = { historyLimit: [100, 5000], retentionDays: [1, 365], maxPayloadMiB: [64, 1024], maxDiskMiB: [128, 2048], maxThumbnailMiB: [16, 256] }
function assertClipboardSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('剪贴板设置无效')
  for (const key of ['enabled', 'paused', 'captureText', 'captureImages']) if (typeof value[key] !== 'boolean') throw new TypeError(`clipboard.${key} 必须是布尔值`)
  for (const [key, [min, max]] of Object.entries(LIMITS)) if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new RangeError(`clipboard.${key} 超出范围 ${min}–${max}`)
  if (value.maxDiskMiB < value.maxPayloadMiB + value.maxThumbnailMiB + 64) throw new RangeError('剪贴板磁盘上限至少为原件上限 + 缩略图上限 + 64 MiB')
  if (![0, 60000, 300000].includes(value.releaseAfterMs)) throw new RangeError('剪贴板面板释放时间无效')
  if (!Array.isArray(value.excludedApps) || value.excludedApps.length > 100 || new Set(value.excludedApps).size !== value.excludedApps.length || value.excludedApps.some((s) => typeof s !== 'string' || s.length > 128 || !/^[^\\/:\0]+\.exe$/.test(s) || s !== s.toLowerCase())) throw new TypeError('排除应用须为不重复的小写 .exe 文件名')
  return value
}
function normalizeClipboardSettings(value) {
  try { return { ...assertClipboardSettings(value), excludedApps: [...value.excludedApps] } }
  catch { return { ...DEFAULT_CLIPBOARD, excludedApps: [] } }
}
function nativeRules(value) { const { enabled, paused, releaseAfterMs, ...rules } = assertClipboardSettings(value); return rules }
module.exports = { DEFAULT_CLIPBOARD, assertClipboardSettings, normalizeClipboardSettings, nativeRules }
