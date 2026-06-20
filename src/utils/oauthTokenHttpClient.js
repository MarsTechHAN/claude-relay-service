const axios = require('axios')
const fs = require('fs')
const { spawn } = require('child_process')
const logger = require('./logger')

const STATUS_MARKER = '\n__CRS_OAUTH_HTTP_STATUS__:'

function fileExists(path) {
  try {
    return !!path && fs.existsSync(path)
  } catch {
    return false
  }
}

function resolveCurlImpersonateCommand() {
  const configured =
    process.env.CLAUDE_OAUTH_CURL_IMPERSONATE || process.env.CLAUDE_OAUTH_CURL_PATH || ''
  if (configured.trim()) {
    return configured.trim()
  }

  if (process.env.CLAUDE_OAUTH_USE_CURL_IMPERSONATE !== 'true') {
    return ''
  }

  const candidates = [
    '/tmp/curl-impersonate/curl_chrome116',
    '/usr/local/bin/curl_chrome116',
    '/usr/bin/curl_chrome116',
    '/usr/local/bin/curl-impersonate-chrome',
    '/usr/bin/curl-impersonate-chrome'
  ]

  return candidates.find(fileExists) || ''
}

function resolveCurlCaBundle() {
  const configured = process.env.CLAUDE_OAUTH_CURL_CA_BUNDLE || ''
  if (configured.trim()) {
    return configured.trim()
  }

  const candidates = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt']

  return candidates.find(fileExists) || ''
}

function parseJsonBody(body) {
  if (!body) {
    return null
  }

  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function createAxiosLikeError(message, response) {
  const error = new Error(message)
  error.response = response
  return error
}

async function postWithCurlImpersonate(url, data, axiosConfig = {}) {
  const command = resolveCurlImpersonateCommand()
  if (!command) {
    return null
  }

  const timeoutMs = Number(axiosConfig.timeout) || 30000
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const args = ['-sS', '-X', 'POST', url, '--max-time', String(timeoutSeconds)]
  const caBundle = resolveCurlCaBundle()

  if (caBundle) {
    args.push('--cacert', caBundle)
  }

  for (const [key, value] of Object.entries(axiosConfig.headers || {})) {
    if (value !== undefined && value !== null && `${value}` !== '') {
      args.push('-H', `${key}: ${value}`)
    }
  }

  args.push('--data-binary', '@-', '-o', '-', '-w', `${STATUS_MARKER}%{http_code}`)

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code, signal) => {
      const markerIndex = stdout.lastIndexOf(STATUS_MARKER)
      if (markerIndex === -1) {
        const error = new Error(
          `curl-impersonate OAuth request failed before HTTP response (code=${code}, signal=${signal || 'none'}): ${stderr.trim()}`
        )
        error.code = code
        reject(error)
        return
      }

      const rawBody = stdout.slice(0, markerIndex)
      const status = Number(stdout.slice(markerIndex + STATUS_MARKER.length).trim())
      const response = {
        status,
        statusText: '',
        headers: {},
        data: parseJsonBody(rawBody),
        config: axiosConfig,
        request: { transport: 'curl-impersonate' }
      }

      if (status >= 200 && status < 300) {
        resolve(response)
        return
      }

      reject(createAxiosLikeError(`Request failed with status code ${status}`, response))
    })

    child.stdin.end(JSON.stringify(data))
  })
}

async function postOAuthTokenRequest(url, data, axiosConfig = {}) {
  const command = resolveCurlImpersonateCommand()
  if (command) {
    try {
      logger.debug('🔐 Using curl-impersonate for Claude OAuth token request', { command })
      return await postWithCurlImpersonate(url, data, axiosConfig)
    } catch (error) {
      if (error.response) {
        throw error
      }
      logger.warn(
        `⚠️ curl-impersonate OAuth request failed before HTTP response, falling back to axios: ${error.message}`
      )
    }
  }

  return await axios.post(url, data, axiosConfig)
}

module.exports = {
  postOAuthTokenRequest,
  resolveCurlImpersonateCommand
}
