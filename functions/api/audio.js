export const onRequest = async ({ request, env, ctx }) => {
  const startTime = Date.now()

  try {
    const urlObj = new URL(request.url)
    let target = urlObj.searchParams.get('url')
    
    // 支持 POST 请求的 target 参数
    if (!target && request.method === 'POST') {
      try {
        const body = await request.clone().json()
        target = body.target || body.url
      } catch {
        // 如果 JSON 解析失败，尝试从 URL 参数获取
      }
    }

    if (!target) {
      return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
        status: 400,
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        }
      })
    }

    const cache = caches.default
    const incomingRange = request.headers.get('Range')
    const isRangeRequest = !!incomingRange

    if (isRangeRequest) {
      const preloadCacheKey = new Request(`${target}?preload=1mb`, request)
      const preloadCached = await cache.match(preloadCacheKey)

      if (preloadCached) {
        console.log('Preload cache hit for:', target)
        return new Response(preloadCached.body, {
          status: preloadCached.status,
          statusText: preloadCached.statusText,
          headers: {
            ...Object.fromEntries(preloadCached.headers),
            'X-Cache-Status': 'HIT',
            'X-Processing-Time': `${Date.now() - startTime}ms`,
            'X-Cache-Source': 'Preload'
          }
        })
      }
    }

    const cacheKey = new Request(target, request)
    const cachedResponse = await cache.match(cacheKey)
    if (cachedResponse) {
      console.log('Full cache hit for:', target)
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers: {
          ...Object.fromEntries(cachedResponse.headers),
          'X-Cache-Status': 'HIT',
          'X-Processing-Time': `${Date.now() - startTime}ms`,
          'X-Cache-Source': 'Edge'
        }
      })
    }

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

        // 构建请求选项
        const fetchOptions = {
          redirect: 'follow',
          headers: reqHeaders,
          signal: controller.signal
        }
        
        // 如果是 POST 请求，传递请求体
        if (request.method === 'POST') {
          fetchOptions.method = 'POST'
          fetchOptions.body = request.body
          fetchOptions.headers.set('Content-Type', request.headers.get('content-type') || 'application/json')
        }

        upstream = await fetch(target, fetchOptions)
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
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        }
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

    const processingTime = Date.now() - startTime
    respHeaders.set('X-Processing-Time', `${processingTime}ms`)
    respHeaders.set('X-Request-Type', isRangeRequest ? 'Range' : 'Full')
    respHeaders.set('X-Retries', `${maxRetries}`)
    respHeaders.set('X-Cache-Status', 'MISS')
    respHeaders.set('X-Cache-Source', 'Origin')

    const response = new Response(upstream.body, {
      status: statusCode,
      headers: respHeaders
    })

    if (!isRangeRequest && statusCode === 200) {
      const cacheResponse = response.clone()
      cacheResponse.headers.set(
        'Cache-Control',
        'public, max-age=86400, s-maxage=86400'
      )
      cacheResponse.headers.set('X-Cache-TTL', '86400')

      ctx.waitUntil(
        (async () => {
          try {
            await cache.put(cacheKey, cacheResponse)
            console.log('Cached audio file:', target)
          } catch (err) {
            console.warn('Cache store failed:', err.message || err)
          }
        })()
      )

      ctx.waitUntil(
        (async () => {
          try {
            await new Promise(r => setTimeout(r, 100))
            const preloadHeaders = new Headers(reqHeaders)
            
            // 为移动端Chrome调整预加载大小
            const preloadSize = isMobileChrome ? 1048576 : 2097151 // 1MB for mobile Chrome, 2MB for others
            preloadHeaders.set(`Range`, `bytes=0-${preloadSize - 1}`)
            
            const preloadResponse = await fetch(target, {
              headers: preloadHeaders,
              signal: AbortSignal.timeout(isMobileChrome ? 12000 : 8000)
            })
            
            if (preloadResponse.ok && preloadResponse.status === 206) {
              const preloadCacheKey = new Request(`${target}?preload=${isMobileChrome ? '1mb' : '2mb'}`, request)
              const preloadCacheResponse = preloadResponse.clone()
              preloadCacheResponse.headers.set(
                'Cache-Control',
                'public, max-age=3600'
              )
              preloadCacheResponse.headers.set('X-Preload', isMobileChrome ? '1MB' : '2MB')
              preloadCacheResponse.headers.set('X-Mobile-Optimized', isMobileChrome ? 'true' : 'false')
              preloadCacheResponse.headers.set('X-Chrome-Mobile', isMobileChrome ? 'true' : 'false')
              await cache.put(preloadCacheKey, preloadCacheResponse)
              console.log(`Preloaded ${isMobileChrome ? '1MB' : '2MB'} for ${isMobileChrome ? 'mobile Chrome' : 'standard'} optimization:`, target)
            }
          } catch (err) {
            console.warn('Preload failed:', err.message || err)
          }
        })()
      )
    }

    return response
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'audio proxy error' }), {
      status: 500,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store'
      }
    })
  }
}

export const onRequestOptions = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
      'access-control-allow-headers': 'range, content-type, authorization',
      'cache-control': 'no-store'
    }
  })
}
