/** Create the authenticated HTTP boundary used by the management console. */
export function createApiClient({ apiBase, authMode, getToken }) {
  const requestHeaders = (options = {}) => {
    const headers = { accept: options.accept || 'application/json' }
    if (options.json) headers['content-type'] = 'application/json'
    if (options.contentType) headers['content-type'] = options.contentType
    if (authMode === 'same-origin') headers['x-dsh-knowledge-client'] = 'management-web'
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`
    return headers
  }

  const endpoint = path => `${apiBase}/${path.replace(/^\/+/, '')}`

  async function responseError(response) {
    let message = `Запрос не удался (HTTP ${response.status})`
    try {
      const payload = await response.json()
      if (payload?.error) message = payload.error
    } catch {}
    return Object.assign(new Error(message), { status: response.status })
  }

  async function parseJsonResponse(response) {
    const text = await response.text()
    let payload
    if (text) {
      try { payload = JSON.parse(text) } catch { throw new Error('Сервер вернул нераспознанные данные') }
    }
    if (!response.ok) {
      const error = new Error(payload?.error || `Запрос не удался (HTTP ${response.status})`)
      error.status = response.status
      error.code = payload?.code
      error.origin = payload?.origin
      throw error
    }
    return payload
  }

  async function api(path, options = {}) {
    const response = await fetch(endpoint(path), {
      method: options.method || 'GET',
      headers: requestHeaders({ json: options.body !== undefined }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
    return parseJsonResponse(response)
  }

  async function binaryRequest(path, options = {}) {
    const response = await fetch(endpoint(path), {
      method: options.method || 'GET',
      headers: requestHeaders(options),
      body: options.body,
      signal: options.signal,
    })
    if (options.responseType === 'blob') {
      if (!response.ok) throw await responseError(response)
      return response.blob()
    }
    return parseJsonResponse(response)
  }

  function binaryUploadRequest(path, body, options = {}) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest()
      request.open(options.method || 'POST', endpoint(path))
      request.responseType = 'text'
      const headers = requestHeaders(options)
      for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
      request.upload.addEventListener('progress', event => {
        if (event.lengthComputable) options.onProgress?.(event.loaded, event.total)
      })
      request.addEventListener('load', () => {
        let payload
        if (request.responseText) {
          try { payload = JSON.parse(request.responseText) }
          catch { return reject(new Error('Сервер вернул нераспознанные данные')) }
        }
        if (request.status < 200 || request.status >= 300) {
          const error = new Error(payload?.error || `Запрос не удался (HTTP ${request.status})`)
          error.status = request.status
          reject(error)
          return
        }
        resolve(payload)
      })
      request.addEventListener('error', () => reject(new Error('Соединение прервано, проверьте сеть и повторите')))
      request.addEventListener('abort', () => reject(new DOMException('Загрузка отменена', 'AbortError')))
      request.send(body)
    })
  }

  return { api, binaryRequest, binaryUploadRequest }
}
