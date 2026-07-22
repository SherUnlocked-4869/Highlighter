const test = require('node:test')
const assert = require('node:assert/strict')
const { buildTableFromOcr, serializeTable } = require('../capture/recognition-utils')

function block(text, left, top, right, bottom, score = 0.98) {
  return {
    text,
    text_score: score,
    box_points: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom }
    ]
  }
}

test('restores rows and columns from OCR coordinates', () => {
  const result = buildTableFromOcr({
    textBlocks: [
      block('姓名', 10, 10, 55, 30), block('部门', 120, 10, 170, 30), block('工号', 240, 10, 285, 30),
      block('张三', 12, 52, 58, 72), block('研发', 122, 52, 168, 72), block('1001', 238, 52, 286, 72),
      block('李四', 11, 94, 57, 114), block('市场', 121, 94, 169, 114), block('1002', 239, 94, 287, 114)
    ]
  })

  assert.equal(result.rowCount, 3)
  assert.equal(result.columnCount, 3)
  assert.deepEqual(result.rows[1], ['张三', '研发', '1001'])
  assert.match(result.tsv, /张三\t研发\t1001/)
  assert.match(result.markdown, /\| 姓名 \| 部门 \| 工号 \|/)
})

test('keeps blank cells when a row has missing OCR text', () => {
  const result = buildTableFromOcr({
    text_blocks: [
      block('A', 10, 10, 30, 30), block('B', 100, 10, 120, 30), block('C', 200, 10, 220, 30),
      block('1', 10, 50, 30, 70), block('3', 200, 50, 220, 70),
      block('4', 10, 90, 30, 110), block('5', 100, 90, 120, 110), block('6', 200, 90, 220, 110)
    ]
  })

  assert.deepEqual(result.rows[1], ['1', '', '3'])
})

test('escapes CSV and Markdown output', () => {
  const formats = serializeTable([['名称', '备注'], ['A,1', 'x|y'], ['"B"', 'line\nbreak']])
  assert.match(formats.csv, /"A,1",x\|y/)
  assert.match(formats.csv, /"""B"""/)
  assert.match(formats.markdown, /x\\\|y/)
  assert.match(formats.markdown, /line<br>break/)
})
