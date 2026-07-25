const MAX_PATCH_BYTES = 256 * 1024
const MAX_ARRAY_ITEMS = 100
const DEFAULT_STRING_LIMIT = 32 * 1024
const STRING_LIMITS = new Map([
  ['apiKey', 512],
  ['customCss', 128 * 1024],
  ['selectionToolbar.prompts.translate', 6000],
  ['selectionToolbar.prompts.explain', 6000]
])
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertValue(value, template, path) {
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) throw new TypeError(`${path} 必须是数组`)
    if (value.length > MAX_ARRAY_ITEMS) throw new RangeError(`${path} 包含的项目过多`)
    return
  }
  if (isPlainObject(template)) {
    if (!isPlainObject(value)) throw new TypeError(`${path} 必须是对象`)
    for (const [key, item] of Object.entries(value)) {
      const itemPath = path ? `${path}.${key}` : key
      if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(template, key)) throw new Error(`不支持的设置项：${itemPath}`)
      assertValue(item, template[key], itemPath)
    }
    return
  }
  if (typeof value !== typeof template) throw new TypeError(`${path} 类型无效`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${path} 必须是有限数字`)
  if (typeof value === 'string') {
    const maximumLength = STRING_LIMITS.get(path) || DEFAULT_STRING_LIMIT
    if (value.length > maximumLength) throw new RangeError(`${path} 内容过长`)
  }
}

function assertSettingsPatch(patch, template) {
  if (!isPlainObject(patch)) throw new TypeError('设置更新必须是对象')
  let serialized
  try {
    serialized = JSON.stringify(patch)
  } catch {
    throw new TypeError('设置更新无法序列化')
  }
  if (Buffer.byteLength(serialized || '') > MAX_PATCH_BYTES) throw new RangeError('设置更新内容过大')
  assertValue(patch, template, '')
  return patch
}

module.exports = {
  assertSettingsPatch,
  isPlainObject
}
