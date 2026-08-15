const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const configDirectory = path.join(root, 'config')
const html = fs.readFileSync(path.join(configDirectory, 'config.html'), 'utf8')
const script = fs.readFileSync(path.join(configDirectory, 'config.js'), 'utf8')
const css = fs.readFileSync(path.join(configDirectory, 'config.css'), 'utf8')

function assertIconExists(iconPath) {
  assert.equal(
    fs.existsSync(path.resolve(configDirectory, iconPath)),
    true,
    `${iconPath} should exist`
  )
}

test('main navigation and titlebar use local SVG icons', () => {
  const navigationIcons = [...html.matchAll(/class="svg-icon nav-icon" style="--icon:url\('([^']+\.svg)'\)"/g)]
    .map((match) => match[1])
  const titlebarIcons = [...html.matchAll(/class="svg-icon" style="--icon:url\('(\.\.\/capture\/icons\/(?:line|close)\.svg)'\)"/g)]
    .map((match) => match[1])

  assert.equal(navigationIcons.length, 13)
  assert.deepEqual(titlebarIcons, ['../capture/icons/line.svg', '../capture/icons/close.svg'])
  for (const iconPath of [...navigationIcons, ...titlebarIcons]) assertIconExists(iconPath)
})

test('quick functions and hotkey settings share SVG-backed function metadata', () => {
  const functionIcons = [...script.matchAll(/\['[^']+',\s*'[^']+',\s*'([^']+\.svg)',\s*'[^']*'\]/g)]
    .map((match) => match[1])

  assert.equal(functionIcons.length, 21)
  for (const iconPath of functionIcons) assertIconExists(iconPath)
  assert.match(script, /function iconMarkup\(iconPath\)/)
  assert.match(script, /renderHome\(\)[\s\S]*iconMarkup\(icon\)/)
  assert.match(script, /renderHotkeySettings\(\)[\s\S]*iconMarkup\(icon\)/)
})

test('config SVG icons inherit their surrounding UI color', () => {
  assert.match(css, /\.svg-icon\{[^}]*background:currentColor/)
  assert.match(css, /-webkit-mask:var\(--icon\) center\/contain no-repeat/)
})
