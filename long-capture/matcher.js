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

  function average(values) {
    if (!values.length) return Number.POSITIVE_INFINITY
    return values.reduce((total, value) => total + value, 0) / values.length
  }

  function measureShift(previous, current, width, height, axis, shift, options = {}) {
    const amount = Math.abs(shift)
    const horizontal = axis === 'horizontal'
    const axisLength = horizontal ? width : height
    if (!amount || amount >= axisLength) {
      return { score: Number.POSITIVE_INFINITY, coverage: 0, longestRun: 0, rows: 0 }
    }

    const crossStart = Math.floor((horizontal ? height : width) * 0.06)
    const crossEnd = (horizontal ? height : width) - crossStart
    const alongLength = axisLength - amount
    const alongStep = Math.max(1, Math.floor(alongLength / 180))
    const crossStep = Math.max(1, Math.floor((crossEnd - crossStart) / 48))
    const rowScores = []

    for (let along = 0; along < alongLength; along += alongStep) {
      const previousAlong = shift > 0 ? along + amount : along
      const currentAlong = shift > 0 ? along : along + amount
      let difference = 0
      let samples = 0
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
      if (samples) rowScores.push(difference / samples)
    }

    const rowMatchThreshold = Number(options.rowMatchThreshold) || 28
    const inliers = []
    let longestRun = 0
    let currentRun = 0
    for (const score of rowScores) {
      if (score <= rowMatchThreshold) {
        inliers.push(score)
        currentRun++
        longestRun = Math.max(longestRun, currentRun)
      } else {
        currentRun = 0
      }
    }
    const coverage = rowScores.length ? inliers.length / rowScores.length : 0
    const inlierScore = average(inliers)
    const coveragePenalty = (1 - coverage) * (Number(options.coveragePenalty) || 10)
    return {
      score: Number.isFinite(inlierScore) ? inlierScore + coveragePenalty : Number.POSITIVE_INFINITY,
      coverage,
      longestRun: rowScores.length ? longestRun / rowScores.length : 0,
      rows: rowScores.length
    }
  }

  function scoreShift(previous, current, width, height, axis, shift, options = {}) {
    return measureShift(previous, current, width, height, axis, shift, options).score
  }

  function measureStill(previous, current, options = {}) {
    const step = Math.max(1, Math.floor(previous.length / 12000))
    const differences = []
    const changedThreshold = Number(options.stillChangedThreshold) || 5
    let changed = 0
    for (let index = 0; index < previous.length; index += step) {
      const difference = Math.abs(previous[index] - current[index])
      differences.push(difference)
      if (difference > changedThreshold) changed++
    }
    if (!differences.length) return { score: 0, changedRatio: 0 }
    differences.sort((left, right) => left - right)
    const retained = differences.slice(0, Math.max(1, Math.ceil(differences.length * 0.85)))
    return {
      score: average(retained),
      changedRatio: changed / differences.length
    }
  }

  function scoreStill(previous, current, options = {}) {
    return measureStill(previous, current, options).score
  }

  function findBestShift(previous, current, width, height, axis, options = {}) {
    if (!(previous instanceof Uint8Array) || !(current instanceof Uint8Array)) throw new TypeError('帧数据必须是 Uint8Array')
    if (previous.length !== current.length || previous.length !== width * height) throw new RangeError('帧尺寸不一致')
    if (!['vertical', 'horizontal'].includes(axis)) throw new TypeError('不支持的拼接方向')

    const still = measureStill(previous, current, options)
    const stillScore = still.score
    const stillThreshold = Number(options.stillThreshold) || 2.8
    const stillChangedRatio = Number(options.stillChangedRatio) || 0.12
    const hardStillChangedRatio = Number(options.hardStillChangedRatio) || 0.015
    if (stillScore <= stillThreshold && still.changedRatio <= hardStillChangedRatio) {
      return {
        status: 'still',
        shift: 0,
        score: stillScore,
        changedRatio: still.changedRatio,
        confidence: 1
      }
    }

    const axisLength = axis === 'horizontal' ? width : height
    const minimumShift = Math.max(2, Math.floor(axisLength * 0.004))
    const maximumShift = Math.max(minimumShift, Math.floor(axisLength * (Number(options.maxShiftRatio) || 0.82)))
    // The analysis image keeps full resolution along the scroll axis, so each
    // candidate must be checked. Skipping pixels makes text edges miss by one
    // row and can turn an exact match into a high-error candidate.
    const coarseStep = 1
    const candidates = []
    const direction = options.direction === 'forward'
      ? [1]
      : options.direction === 'reverse'
        ? [-1]
        : [1, -1]

    for (const sign of direction) {
      for (let amount = minimumShift; amount <= maximumShift; amount += coarseStep) {
        const shift = amount * sign
        candidates.push({ shift, ...measureShift(previous, current, width, height, axis, shift, options) })
      }
    }
    candidates.sort((left, right) => left.score - right.score)
    const coarseBest = candidates[0]
    if (!coarseBest) return { status: 'failed', shift: 0, score: Infinity, confidence: 0 }

    const refined = []
    for (let shift = coarseBest.shift - coarseStep; shift <= coarseBest.shift + coarseStep; shift++) {
      if (Math.abs(shift) < minimumShift || Math.abs(shift) > maximumShift) continue
      if (!direction.includes(Math.sign(shift))) continue
      refined.push({ shift, ...measureShift(previous, current, width, height, axis, shift, options) })
    }
    refined.sort((left, right) => left.score - right.score)
    const best = refined[0] || coarseBest
    const second = candidates.find((candidate) => candidate.shift * best.shift < 0 || Math.abs(candidate.shift - best.shift) > Math.max(5, coarseStep * 2))
    const margin = second ? second.score - best.score : 255 - best.score
    const matchThreshold = Number(options.matchThreshold) || 24
    const minimumMargin = Number(options.minimumMargin) || 0.8
    const minimumCoverage = Number(options.minimumCoverage) || 0.28
    const minimumRun = Number(options.minimumRun) || 0.16
    const accepted = best.score <= matchThreshold &&
      best.coverage >= minimumCoverage &&
      best.longestRun >= minimumRun &&
      margin >= minimumMargin
    const confidence = Math.max(0, Math.min(1,
      ((matchThreshold - best.score) / matchThreshold) * 0.55 +
      Math.min(1, margin / 8) * 0.2 +
      Math.min(1, best.coverage / 0.75) * 0.15 +
      Math.min(1, best.longestRun / 0.55) * 0.1
    ))

    if (!accepted && stillScore <= stillThreshold && still.changedRatio <= stillChangedRatio) {
      return {
        status: 'still',
        shift: 0,
        candidateShift: best.shift,
        score: stillScore,
        stillScore,
        changedRatio: still.changedRatio,
        margin,
        coverage: best.coverage,
        longestRun: best.longestRun,
        confidence: 1
      }
    }

    return {
      status: accepted ? 'matched' : 'failed',
      shift: accepted ? best.shift : 0,
      candidateShift: best.shift,
      secondShift: second?.shift || 0,
      score: best.score,
      stillScore,
      changedRatio: still.changedRatio,
      margin,
      coverage: best.coverage,
      longestRun: best.longestRun,
      confidence
    }
  }

  return { findBestShift, measureShift, measureStill, scoreShift, scoreStill, toGrayscale }
})
