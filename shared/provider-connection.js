'use strict'

;(function () {
  const presets = [
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses' },
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
    { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
    { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' }
  ]

  function parseProviderBaseUrl(value) {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
        !url.hash && !url.search && !/\/(chat\/completions|responses|models)\/?$/.test(url.pathname) ? url : null
    } catch {
      return null
    }
  }

  function isLoopbackProviderUrl(value) {
    const host = parseProviderBaseUrl(value)?.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  }

  const api = { presets, parseProviderBaseUrl, isLoopbackProviderUrl }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.providerConnection = api
})()
