(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.LongCaptureMatcher = api
})(typeof self !== 'undefined' ? self : globalThis, function () {
  function toGrayscale(rgba) {
    const gray = new Uint8Array(Math.floor(rgba.length / 4))
    for (let source = 0, target = 0; source + 3 < rgba.length; source += 4, target++) {
      gray[target] = Math.round(rgba[source] * 0.299 + rgba[source + 1] * 0.587 + rgba[source + 2] * 0.114)
    }
    return gray
  }

  function scoreShift(previous, current, width, height, axis, shift) {
    const amount = Math.abs(shift)
    const horizontal = axis === 'horizontal'
    const axisLength = horizontal ? width : height
    if (!amount || amount >= axisLength) return Number.POSITIVE_INFINITY

    const crossStart = Math.floor((horizontal ? height : width) * 0.06)
    const crossEnd = (horizontal ? height : width) - crossStart
    const alongLength = axisLength - amount
    const alongStep = Math.max(1, Math.floor(alongLength / 180))
    const crossStep = Math.max(1, Math.floor((crossEnd - crossStart) / 48))
    let difference = 0
    let samples = 0

    for (let along = 0; along < alongLength; along += alongStep) {
      const previousAlong = shift > 0 ? along + amount : along
      const currentAlong = shift > 0 ? along : along + amount
      for (let cross = crossStart; cross < crossEnd; cross += crossStep) {
        const previousIndex = horizontal
          ? cross * width + previousAlong
          : previousAlong * width + cross
        const currentIndex = horizontal
          ? cross * width + currentAlong
          : currentAlong * width + cross
        difference += Math.abs(previous[previousIndex] - current[currentIndex])
        samples++
      }
    }
    return samples ? difference / samples : Number.POSITIVE_INFINITY
  }

  function scoreStill(previous, current) {
    const step = Math.max(1, Math.floor(previous.length / 12000))
    let difference = 0
    let samples = 0
    for (let index = 0; index < previous.length; index += step) {
      difference += Math.abs(previous[index] - current[index])
      samples++
    }
    return samples ? difference / samples : 0
  }

  function findBestShift(previous, current, width, height, axis, options = {}) {
    if (!(previous instanceof Uint8Array) || !(current instanceof Uint8Array)) throw new TypeError('帧数据必须是 Uint8Array')
    if (previous.length !== current.length || previous.length !== width * height) throw new RangeError('帧尺寸不一致')
    if (!['vertical', 'horizontal'].includes(axis)) throw new TypeError('不支持的拼接方向')

    const stillScore = scoreStill(previous, current)
    const stillThreshold = Number(options.stillThreshold) || 2.8
    if (stillScore <= stillThreshold) return { status: 'still', shift: 0, score: stillScore, confidence: 1 }

    const axisLength = axis === 'horizontal' ? width : height
    const minimumShift = Math.max(2, Math.floor(axisLength * 0.004))
    const maximumShift = Math.max(minimumShift, Math.floor(axisLength * (Number(options.maxShiftRatio) || 0.82)))
    // The analysis image keeps full resolution along the scroll axis, so each
    // candidate must be checked. Skipping pixels makes text edges miss by one
    // row and can turn an exact match into a high-error candidate.
    const coarseStep = 1
    const candidates = []

    for (const sign of [1, -1]) {
      for (let amount = minimumShift; amount <= maximumShift; amount += coarseStep) {
        candidates.push({ shift: amount * sign, score: scoreShift(previous, current, width, height, axis, amount * sign) })
      }
    }
    candidates.sort((left, right) => left.score - right.score)
    const coarseBest = candidates[0]
    if (!coarseBest) return { status: 'failed', shift: 0, score: Infinity, confidence: 0 }

    const refined = []
    for (let shift = coarseBest.shift - coarseStep; shift <= coarseBest.shift + coarseStep; shift++) {
      if (Math.abs(shift) < minimumShift || Math.abs(shift) > maximumShift) continue
      refined.push({ shift, score: scoreShift(previous, current, width, height, axis, shift) })
    }
    refined.sort((left, right) => left.score - right.score)
    const best = refined[0] || coarseBest
    const second = candidates.find((candidate) => candidate.shift * best.shift < 0 || Math.abs(candidate.shift - best.shift) > Math.max(5, coarseStep * 2))
    const margin = second ? second.score - best.score : 255 - best.score
    const matchThreshold = Number(options.matchThreshold) || 24
    const minimumMargin = Number(options.minimumMargin) || 0.8
    const accepted = best.score <= matchThreshold && margin >= minimumMargin
    const confidence = Math.max(0, Math.min(1, ((matchThreshold - best.score) / matchThreshold) * 0.75 + Math.min(1, margin / 8) * 0.25))

    return {
      status: accepted ? 'matched' : 'failed',
      shift: accepted ? best.shift : 0,
      score: best.score,
      stillScore,
      margin,
      confidence
    }
  }

  return { findBestShift, scoreShift, toGrayscale }
})
