'use strict'

// B01 (plan item 05): the capture domain's private clipboard writer.
//
// The capture domain is constructed BEFORE the clipboard domain, so this is a resolver at
// call time rather than a captured instance. The writer encodes the image once and hands
// the PNG to the clipboard domain's native publication, which is the only private path:
// there is no fallback to Electron's plain write here or in the caller.
//
// It always RESOLVES a receipt. A thrown error would be indistinguishable from "not
// attempted" and the capture domain would have nothing to report in the UI.

// The clipboard domain registers its native publication here when it is constructed. The
// registry exists because the capture domain is built BEFORE it and main.js is at a hard
// line ceiling: no assembly line is needed for this one seam. Unregistering on dispose
// keeps a stale publisher from outliving its window.
let registeredPublisher = null

function registerClipboardPublisher(publisher) {
  registeredPublisher = typeof publisher === 'function' ? publisher : null
  return () => {
    if (registeredPublisher === publisher) registeredPublisher = null
  }
}

function createClipboardImageWriter({ getClipboardDomain = null, log = () => {} } = {}) {
  const resolveDomain = typeof getClipboardDomain === 'function'
    ? getClipboardDomain
    : () => (registeredPublisher ? { publishImage: registeredPublisher } : null)
  return async function writeClipboardImage(image, options = {}) {
    let domain = null
    try {
      domain = resolveDomain()
    } catch (error) {
      log('Clipboard domain unavailable:', error?.message || error)
      return { ok: false, code: 'native-writer-unavailable' }
    }
    if (!domain || typeof domain.publishImage !== 'function') {
      return { ok: false, code: 'native-writer-unavailable' }
    }
    let png = null
    try {
      png = typeof image?.toPNG === 'function' ? image.toPNG() : null
    } catch (error) {
      log('Clipboard PNG encode failed:', error?.message || error)
      return { ok: false, code: 'IMAGE_ENCODE_FAILED' }
    }
    if (!png || !png.length) return { ok: false, code: 'IMAGE_EMPTY' }
    return domain.publishImage({ png, private: options.private !== false })
  }
}

module.exports = { createClipboardImageWriter, registerClipboardPublisher, resetClipboardPublisher: () => registerClipboardPublisher(null) }
