'use strict'

const client = require('./client')
const { createAiProtocolAdapter, AI_PROTOCOLS } = require('../ai-protocol-adapters')
const { AI_PROTOCOLS: AI_PROTOCOL_LIST } = require('../ai-providers')

const SUPPORTED_PROTOCOLS = new Set(AI_PROTOCOL_LIST || AI_PROTOCOLS || ['openai-chat', 'openai-responses'])

function resolveProtocolAdapter(config, openaiClient) {
  if (!config || typeof config !== 'object') {
    throw new Error('resolveProtocolAdapter requires a provider/model config')
  }
  const protocol = String(config.protocol || 'openai-chat')
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error(`Unsupported AI protocol: ${protocol}`)
  }
  return createAiProtocolAdapter({ ...config, protocol }, openaiClient)
}

function listSupportedProtocols() {
  return [...SUPPORTED_PROTOCOLS]
}

module.exports = {
  ...client,
  resolveProtocolAdapter,
  listSupportedProtocols
}
