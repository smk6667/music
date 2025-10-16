export function onRequest(context) {
  const { request, env } = context
  
  // 设置CORS头
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Cache-Control': 'no-store'
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
      status: 405, 
      headers: { ...corsHeaders, 'content-type': 'application/json' } 
    })
  }

  return handleAudioProxy(request, env, corsHeaders)
}

async function handleAudioProxy(request, env, corsHeaders) {
  try {
    const url = new URL(request.url)
    const target = url.searchParams.get('url')

    if (!target) {
      return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
        status: 400,
        headers: { ...corsHeaders, 'content-type': 'application/json' }
      })
    }

    const incomingRange = request.headers.get('Range')
    const isRangeRequest = !!incomingRange

    const reqHeaders = new Headers()
    
    // 检测是否为移动端Chrome请求
    const userAgent = request.headers.get('user-agent') || ''
    const isMobileChrome = /Android.*Chrome/i.test(userAgent)
    const isChrome = /Chrome/i.test(userAgent)
    
    if (isMobileChrome) {
      // 为移动端Chrome使用更兼容的User-Agent
      reqHeaders.set(
        'User-Agent',
        'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36'
      )
    } else if (isChrome) {
      // 为桌面Chrome使用标准User-Agent
      reqHeaders.set(
        'User-Agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Safari/537.36'
      )
    } else {
      // 默认iOS Safari User-Agent
      reqHeaders.set(
        'User-Agent',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      )
    }
    
    reqHeaders.set(
      'Accept',
      'audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/aac,audio/m4a,audio/webm,audio/*,*/*;q=0.9'
    )
    reqHeaders.set('Accept-Encoding', 'identity')
    reqHeaders.set('Connection', 'keep-alive')
    reqHeaders.set('Cache-Control', 'no-cache')
    reqHeaders.set('Accept-Ranges', 'bytes')
    reqHeaders.set('Range', 'bytes=0-')
    
    // 为移动端Chrome添加额外的请求头
    if (isMobileChrome) {
      reqHeaders.set('X-Requested-With', 'XMLHttpRequest')
      reqHeaders.set('Sec-Fetch-Dest', 'audio')
      reqHeaders.set('Sec-Fetch-Mode', 'cors')
      reqHeaders.set('Sec-Fetch-Site', 'cross-site')
      reqHeaders.set('DNT', '1')
      reqHeaders.set('Upgrade-Insecure-Requests', '1')
    }

    if (incomingRange) {
      reqHeaders.set('Range', incomingRange)
      reqHeaders.set('X-Requested-With', 'Range')
    }

    try {
      const u = new URL(target)
      reqHeaders.set('Referer', `${u.origin}/`)
      reqHeaders.set('Origin', u.origin)
    } catch {}

    const maxRetries = isMobileChrome ? 2 : 1 // 移动端Chrome增加重试次数
    let lastError = null
    let upstream = null

    for (let i = 0; i <= maxRetries; i++) {
      try {
        const controller = new AbortController()
        // 为移动端Chrome增加超时时间
        const timeout = isMobileChrome ? 
          (isRangeRequest ? 15000 : 20000) : 
          (isRangeRequest ? 10000 : 15000)
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
        console.warn(`Proxy attempt ${i + 1} failed: ${upstream.status}`)
      } catch (e) {
        lastError = e
        console.warn(`Proxy attempt ${i + 1} failed:`, e.message)
      }
      if (i < maxRetries) {
        // 移动端Chrome需要更长的重试间隔
        const retryDelay = isMobileChrome ? 500 : 100
        await new Promise(r => setTimeout(r, retryDelay))
      }
    }

    if (!upstream || !upstream.body || upstream.status >= 400) {
      const status = upstream ? upstream.status : 502
      const msg = lastError?.message || `Upstream ${status}`
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { ...corsHeaders, 'content-type': 'application/json' }
      })
    }

    const respHeaders = new Headers()
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

    respHeaders.set('Content-Type', ct)
    if (cl) respHeaders.set('Content-Length', cl)
    if (cr) respHeaders.set('Content-Range', cr)
    respHeaders.set('Accept-Ranges', ar)
    respHeaders.set('Cache-Control', 'public, max-age=7200, must-revalidate')
    respHeaders.set('Access-Control-Allow-Origin', '*')
    respHeaders.set(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges'
    )
    respHeaders.set('X-Content-Type-Options', 'nosniff')
    
    // 为移动端Chrome添加特定的响应头
    if (isMobileChrome) {
      respHeaders.set('X-Chrome-Mobile', 'true')
      respHeaders.set('X-Mobile-Optimized', 'true')
      respHeaders.set('X-Audio-Streaming', 'enabled')
      respHeaders.set('X-Range-Support', 'bytes')
    }

    const isPartial = !!incomingRange && (cr || upstream.status === 206)
    const statusCode = isPartial ? 206 : upstream.status || 200

    return new Response(upstream.body, {
      status: statusCode,
      headers: respHeaders
    })
  } catch (e) {
    console.error('Audio proxy error:', e)
    return new Response(JSON.stringify({ error: e.message || 'audio proxy error' }), {
      status: 500,
      headers: { ...corsHeaders, 'content-type': 'application/json' }
    })
  }
}
