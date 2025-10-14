export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const target = req.query.url

    if (!target) {
      return res.status(400).json({ error: 'Missing url parameter' })
    }

    const incomingRange = req.headers.range
    const isRangeRequest = !!incomingRange

    const reqHeaders = new Headers()

    const getUserAgent = (targetUrl) => {
      const url = targetUrl.toLowerCase()

      const userAgents = [

        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',

        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',

        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',

        'Mozilla/5.0 (Linux; Android 14; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      ]
      
      const hash = url.split('').reduce((a, b) => {
        a = ((a << 5) - a) + b.charCodeAt(0)
        return a & a
      }, 0)
      const index = Math.abs(hash) % userAgents.length
      return userAgents[index]
    }
    
    reqHeaders.set('User-Agent', getUserAgent(target))
    reqHeaders.set(
      'Accept',
      'audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/aac,audio/m4a,audio/webm,audio/*,*/*;q=0.9'
    )
    reqHeaders.set('Accept-Encoding', 'identity')
    reqHeaders.set('Connection', 'keep-alive')
    reqHeaders.set('Cache-Control', 'no-cache')
    reqHeaders.set('Accept-Ranges', 'bytes')

    if (incomingRange) {
      reqHeaders.set('Range', incomingRange)
      reqHeaders.set('X-Requested-With', 'Range')
    } else {

      reqHeaders.set('Range', 'bytes=0-1048575')
    }

    try {
      const u = new URL(target)
      reqHeaders.set('Referer', `${u.origin}/`)
      reqHeaders.set('Origin', u.origin)

      if (u.hostname === 'raw.githubusercontent.com') {
        reqHeaders.set('Accept', 'audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/aac,audio/m4a,audio/webm,audio/*,*/*;q=0.9')
        reqHeaders.set('Cache-Control', 'no-cache')
        reqHeaders.set('Pragma', 'no-cache')
      }
    } catch {}

    const maxRetries = 1
    let lastError = null
    let upstream = null

    for (let i = 0; i <= maxRetries; i++) {
      try {
        const controller = new AbortController()

        const isGitHubRaw = target.includes('raw.githubusercontent.com')
        const timeout = isGitHubRaw ? (isRangeRequest ? 10000 : 15000) : (isRangeRequest ? 5000 : 8000)
        const timeoutId = setTimeout(() => controller.abort(), timeout)

        upstream = await fetch(target, {
          redirect: 'follow',
          headers: reqHeaders,
          signal: controller.signal
        })
        clearTimeout(timeoutId)

        if (upstream.ok || (upstream.status >= 200 && upstream.status < 400))
          break
        lastError = new Error(`Upstream ${upstream.status}`)
      } catch (e) {
        lastError = e
      }
      if (i < maxRetries) await new Promise(r => setTimeout(r, 100))
    }

    if (!upstream || !upstream.body || upstream.status >= 400) {
      const status = upstream ? upstream.status : 502
      const msg = lastError?.message || `Upstream ${status}`
      return res.status(status).json({ error: msg })
    }

    const respHeaders = {}
    let ct = upstream.headers.get('content-type') || ''
    const cl = upstream.headers.get('content-length')
    const cr = upstream.headers.get('content-range')
    const ar = upstream.headers.get('accept-ranges') || 'bytes'

    const lowerUrl = target.toLowerCase()
    if (!ct.startsWith('audio/')) {
      if (lowerUrl.endsWith('.mp3')) ct = 'audio/mpeg'
      else if (lowerUrl.endsWith('.wav')) ct = 'audio/wav'
      else if (lowerUrl.endsWith('.ogg')) ct = 'audio/ogg'
      else if (lowerUrl.endsWith('.m4a')) ct = 'audio/mp4'
      else if (lowerUrl.endsWith('.flac')) ct = 'audio/flac'
      else ct = 'application/octet-stream'
    }

    respHeaders['Content-Type'] = ct
    if (cl) respHeaders['Content-Length'] = cl
    if (cr) respHeaders['Content-Range'] = cr
    respHeaders['Accept-Ranges'] = ar

    respHeaders['Cache-Control'] = isRangeRequest 
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=86400, must-revalidate'
    respHeaders['Access-Control-Allow-Origin'] = '*'
    respHeaders['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Accept-Ranges'
    respHeaders['X-Content-Type-Options'] = 'nosniff'

    const isPartial = !!incomingRange && (cr || upstream.status === 206)
    const statusCode = isPartial ? 206 : upstream.status || 200

    res.status(statusCode)
    Object.entries(respHeaders).forEach(([key, value]) => {
      res.setHeader(key, value)
    })

    const reader = upstream.body.getReader()
    
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        res.write(Buffer.from(value))
      }
      
      res.end()
    } catch (error) {
      console.error('Stream error:', error)
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error' })
      }
    }
  } catch (e) {
    console.error('Audio proxy error:', e)
    if (!res.headersSent) {
      res.status(500).json({ error: e.message || 'audio proxy error' })
    }
  }
}
