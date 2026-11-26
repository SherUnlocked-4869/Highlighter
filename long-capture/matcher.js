(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.LongCaptureMatcher = api
})(typeof self !== 'undefined' ? self : globalThis, function () {
  // P1 §6.4 (2026-11-26 review): the old matcher scored every candidate shift with the full
  // sampled 2-D metric, which made a 4K match tens of millions of byte loads per frame and turned
  // the "coarse + fine" block into dead code (the coarse pass already used step 1).
  //
  // Stage 1 now compares a 1-D row/column mean profile instead: it costs O(N) to build and ~720
  // samples per candidate shift, and an exactly aligned frame scores zero on it, so the true
  // shift always ranks among the best coarse candidates. Stage 2 runs the original full 2-D
  // score only inside a narrow window around those peaks, which keeps the decision quality while
  // cutting the sampled work by roughly an order of magnitude.
  const COARSE_PROFILE_SAMPLES = 720
  const FINE_WINDOW = 4
  const MAX_REFINE_CANDIDATES = 8
  // U02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 4.2): a scrolling
  // page usually pins a navigation bar and/or a footer on screen, so two frames of the same
  // page agree inside those bands while the content between them moved. Splicing the next
  // strip without removing the bands repeats the bar once per screen; the detector below
  // measures them so the strip cut can start/stop inside the scrolled content only.
  const STICKY_CROSS_SAMPLES = 48

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

    if (horizontal) {
      const previousOffset = shift > 0 ? amount : 0
      const currentOffset = shift > 0 ? 0 : amount
      for (let cross = crossStart; cross < crossEnd; cross += crossStep) {
        let previousIndex = cross * width + previousOffset
        let currentIndex = cross * width + currentOffset
        for (let along = 0; along < alongLength; along += alongStep) {
          difference += Math.abs(previous[previousIndex] - current[currentIndex])
          previousIndex += alongStep
          currentIndex += alongStep
          samples++
        }
      }
    } else {
      let previousRow = (shift > 0 ? amount : 0) * width
      let currentRow = (shift > 0 ? 0 : amount) * width
      const rowStep = alongStep * width
      for (let along = 0; along < alongLength; along += alongStep) {
        let previousIndex = previousRow + crossStart
        let currentIndex = currentRow + crossStart
        for (let cross = crossStart; cross < crossEnd; cross += crossStep) {
          difference += Math.abs(previous[previousIndex] - current[currentIndex])
          previousIndex += crossStep
          currentIndex += crossStep
          samples++
        }
        previousRow += rowStep
        currentRow += rowStep
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

  // Mean gray value of every row (vertical scrolling) or column (horizontal scrolling).
  function axisProfile(gray, width, height, axis) {
    const horizontal = axis === 'horizontal'
    const length = horizontal ? width : height
    const cross = horizontal ? height : width
    const profile = new Float64Array(length)
    for (let along = 0; along < length; along++) {
      let sum = 0
      if (horizontal) {
        for (let index = along; index < gray.length; index += width) sum += gray[index]
      } else {
        const end = along * width + width
        for (let index = along * width; index < end; index++) sum += gray[index]
      }
      profile[along] = sum / cross
    }
    return profile
  }

  // Coarse 1-D metric: mean absolute difference between the two profiles over the overlapping
  // part. Sampled positions never need to line up across candidates; an exact shift still scores 0.
  function profileShiftScore(previousProfile, currentProfile, axisLength, shift) {
    const amount = Math.abs(shift)
    if (!amount || amount >= axisLength) return Number.POSITIVE_INFINITY
    const alongLength = axisLength - amount
    const stride = Math.max(1, Math.floor(alongLength / COARSE_PROFILE_SAMPLES))
    const previousStart = shift > 0 ? amount : 0
    const currentStart = shift > 0 ? 0 : amount
    let difference = 0
    let samples = 0
    for (let along = 0; along < alongLength; along += stride) {
      difference += Math.abs(previousProfile[previousStart + along] - currentProfile[currentStart + along])
      samples++
    }
    return samples ? difference / samples : Number.POSITIVE_INFINITY
  }

  // The exhaustive scan used to explore positive amounts ascending, then negative amounts
  // ascending, and kept the first shift on a score tie. Sorting candidates by the same order keeps
  // that tie-break, so repeated patterns resolve exactly as before.
  function shiftOrder(shift, minimumShift, maximumShift) {
    if (shift > 0) return shift - minimumShift
    return (maximumShift - minimumShift + 1) + (Math.abs(shift) - minimumShift)
  }

  // Shared argument validation for the frame-pair entry points. Kept as one helper so the
  // detector and the matcher cannot drift (and so the diagnostic text exists once).
  function assertFramePair(previous, current, width, height, axis) {
    if (!(previous instanceof Uint8Array) || !(current instanceof Uint8Array)) throw new TypeError('帧数据必须是 Uint8Array')
    if (previous.length !== current.length || previous.length !== width * height) throw new RangeError('帧尺寸不一致')
    if (!['vertical', 'horizontal'].includes(axis)) throw new TypeError('不支持的拼接方向')
  }

  // One line is "stuck" when the two frames agree on it: a row for vertical scrolling, a
  // column for horizontal scrolling. The mean is taken over the middle 88% of the cross
  // axis because window edges and scrollbars stay noisy even when the band itself is static.
  function stickyLineMask(previous, current, width, height, axis, tolerance) {
    const horizontal = axis === 'horizontal'
    const lineCount = horizontal ? width : height
    const crossCount = horizontal ? height : width
    const crossStart = Math.floor(crossCount * 0.06)
    const crossEnd = crossCount - crossStart
    const crossStep = Math.max(1, Math.floor((crossEnd - crossStart) / STICKY_CROSS_SAMPLES))
    const mask = new Uint8Array(lineCount)
    for (let line = 0; line < lineCount; line++) {
      let difference = 0
      let samples = 0
      for (let cross = crossStart; cross < crossEnd; cross += crossStep) {
        const index = horizontal ? cross * width + line : line * width + cross
        difference += Math.abs(previous[index] - current[index])
        samples++
      }
      mask[line] = samples && difference / samples <= tolerance ? 1 : 0
    }
    return mask
  }

  // Fixed top/bottom (vertical) or left/right (horizontal) bands, as the number of lines at
  // each edge that did not move between the two frames. `start` is top/left, `end` is
  // bottom/right. Cheap: one sampled pass over both axes, no full frame comparison.
  //
  // Identical lines carry no visual difference wherever they come from, so treating a short
  // run of them at an edge as a sticky band can only skip rows that would look the same -
  // never unique page content. A still frame (every line identical) is reported as no bands
  // because the matcher classifies it before that question is meaningful.
  function detectStickyBands(previous, current, width, height, axis = 'vertical', options = {}) {
    assertFramePair(previous, current, width, height, axis)

    const lineCount = axis === 'horizontal' ? width : height
    const tolerance = Number.isFinite(Number(options.tolerance)) ? Math.max(0, Number(options.tolerance)) : 1.5
    const mask = stickyLineMask(previous, current, width, height, axis, tolerance)
    let start = 0
    while (start < lineCount && mask[start]) start++
    let end = 0
    while (end < lineCount && mask[lineCount - 1 - end]) end++
    if (start + end >= lineCount) return { start: 0, end: 0, axis, tolerance }

    const ratio = Number.isFinite(Number(options.maxBandRatio)) ? Number(options.maxBandRatio) : 0.4
    const maxBand = Math.max(1, Math.min(Math.floor(lineCount / 2) - 1, Math.floor(lineCount * ratio)))
    start = Math.min(start, maxBand)
    end = Math.min(end, maxBand)
    // The two runs meet in the middle: there is no measurable content band, so report nothing
    // rather than a pair that would swallow the frame.
    if (start + end > lineCount - 2) return { start: 0, end: 0, axis, tolerance }
    const minBand = Math.max(2, Math.round(Number(options.minBand) || lineCount * 0.004))
    if (start < minBand) start = 0
    if (end < minBand) end = 0
    return { start, end, axis, tolerance }
  }

  function findBestShift(previous, current, width, height, axis, options = {}) {
    assertFramePair(previous, current, width, height, axis)

    const stillScore = scoreStill(previous, current)
    const stillThreshold = Number(options.stillThreshold) || 2.8
    if (stillScore <= stillThreshold) return { status: 'still', shift: 0, score: stillScore, confidence: 1 }

    const axisLength = axis === 'horizontal' ? width : height
    const minimumShift = Math.max(2, Math.floor(axisLength * 0.004))
    const maximumShift = Math.max(minimumShift, Math.floor(axisLength * (Number(options.maxShiftRatio) || 0.82)))

    const previousProfile = axisProfile(previous, width, height, axis)
    const currentProfile = axisProfile(current, width, height, axis)
    const candidates = []
    for (const sign of [1, -1]) {
      for (let amount = minimumShift; amount <= maximumShift; amount++) {
        const shift = amount * sign
        const score = profileShiftScore(previousProfile, currentProfile, axisLength, shift)
        if (!Number.isFinite(score)) continue
        candidates.push({ shift, score, order: shiftOrder(shift, minimumShift, maximumShift) })
      }
    }
    if (!candidates.length) return { status: 'failed', shift: 0, score: Infinity, confidence: 0, evaluatedShifts: 0 }
    candidates.sort((left, right) => (left.score - right.score) || (left.order - right.order))

    // Adjacent coarse peaks share most of their refinement window; one evaluation per shift is
    // enough and keeps `secondScore` honest (it must not see the same shift twice).
    const selected = []
    for (const candidate of candidates) {
      if (selected.length >= MAX_REFINE_CANDIDATES) break
      if (selected.some((entry) => Math.abs(entry.shift - candidate.shift) <= FINE_WINDOW)) continue
      selected.push(candidate)
    }

    const scored = new Set()
    const refined = []
    let evaluatedShifts = 0
    let bestShift = 0
    let bestScore = Number.POSITIVE_INFINITY
    for (const candidate of selected) {
      for (let shift = candidate.shift - FINE_WINDOW; shift <= candidate.shift + FINE_WINDOW; shift++) {
        const amount = Math.abs(shift)
        if (amount < minimumShift || amount > maximumShift || scored.has(shift)) continue
        scored.add(shift)
        const score = scoreShift(previous, current, width, height, axis, shift)
        evaluatedShifts++
        refined.push({ shift, score })
        if (!bestShift || score < bestScore) {
          bestShift = shift
          bestScore = score
        }
      }
    }
    if (!bestShift || !Number.isFinite(bestScore)) {
      return { status: 'failed', shift: 0, score: Infinity, confidence: 0, evaluatedShifts }
    }

    let secondScore = Number.POSITIVE_INFINITY
    for (const entry of refined) {
      if (entry.shift * bestShift >= 0 && Math.abs(entry.shift - bestShift) <= 5) continue
      secondScore = Math.min(secondScore, entry.score)
    }
    const margin = Number.isFinite(secondScore) ? secondScore - bestScore : 255 - bestScore
    const matchThreshold = Number(options.matchThreshold) || 24
    const minimumMargin = Number(options.minimumMargin) || 0.8
    const accepted = bestScore <= matchThreshold && margin >= minimumMargin
    const confidence = Math.max(0, Math.min(1, ((matchThreshold - bestScore) / matchThreshold) * 0.75 + Math.min(1, margin / 8) * 0.25))

    const result = {
      status: accepted ? 'matched' : 'failed',
      shift: accepted ? bestShift : 0,
      score: bestScore,
      stillScore,
      margin,
      confidence,
      // Observable cost witness: the number of full 2-D score evaluations. The old exhaustive
      // scan evaluated every candidate, so tests can assert the refinement really is bounded.
      evaluatedShifts
    }
    // U02: only a genuine scroll can expose fixed bands; 'still' returned earlier and a failed
    // match has no strip to cut, so the sampled detector runs at most once per captured frame.
    if (accepted) result.sticky = detectStickyBands(previous, current, width, height, axis, options.sticky || {})
    return result
  }

  return { findBestShift, detectStickyBands, scoreShift, toGrayscale }
})
