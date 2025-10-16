const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg', '.opus', '.webm']
const isAudio = (name) => AUDIO_EXTS.some(ext => String(name || '').toLowerCase().endsWith(ext))

function createProxyFetch(proxyUrl, builtinProxyUrl) {
  if (!proxyUrl && !builtinProxyUrl) return fetch
  
  return async (url, options = {}) => {
    if (url.includes('api.github.com') || url.includes('raw.githubusercontent.com')) {
      try {
        const directResponse = await fetch(url, options)
        if (directResponse.ok) {
          return directResponse
        }
        console.log(`[webdav] Direct request failed (${directResponse.status}), trying proxy...`)
      } catch (error) {
        console.log(`[webdav] Direct request error: ${error.message}, trying proxy...`)
      }
      
      // 优先使用内置代理
      if (builtinProxyUrl) {
        try {
          const targetUrl = encodeURIComponent(url)
          const builtinProxiedUrl = `${builtinProxyUrl}?url=${targetUrl}`
          
          const builtinOptions = {
            ...options,
            headers: {
              ...options.headers,
              'X-Target-URL': url,
              'X-Proxy-Type': 'github-webdav'
            }
          }
          
          console.log(`[webdav] Using builtin proxy: ${builtinProxiedUrl}`)
          const builtinResponse = await fetch(builtinProxiedUrl, builtinOptions)
          if (builtinResponse.ok) {
            return builtinResponse
          }
        } catch (error) {
          console.log(`[webdav] Builtin proxy failed: ${error.message}`)
        }
      }
      
      // 回退到自定义代理
      if (proxyUrl) {
        const targetUrl = encodeURIComponent(url)
        const proxiedUrl = `${proxyUrl}?target=${targetUrl}`
        
        const proxyOptions = {
          ...options,
          headers: {
            ...options.headers,
            'X-Target-URL': url,
            'X-Proxy-Type': 'github-webdav'
          }
        }
        
        console.log(`[webdav] Using custom proxy: ${proxiedUrl}`)
        return fetch(proxiedUrl, proxyOptions)
      }
    }
    
    return fetch(url, options)
  }
}

function buildBasicAuth(user, pass) {
  try {
    const bytes = new TextEncoder().encode(`${user}:${pass}`)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return 'Basic ' + btoa(binary)
  } catch {
    return 'Basic ' + btoa(`${user}:${pass}`)
  }
}

function resolveMusicBase(base) {
  const b = String(base || '').replace(/\/+$/g, '')
  return `${b}/music`
}

function joinUrl(base, name) {
  const b = resolveMusicBase(base).replace(/\/+$/g, '')
  const n = encodeURIComponent(name)
  return `${b}/${n}`
}

async function ensureWebdavDir({ baseUrl, user, pass }) {
  const url = resolveMusicBase(baseUrl) + '/'
  
  try {
    const res = await fetch(url, {
      method: 'MKCOL',
      headers: {
        'Authorization': buildBasicAuth(user, pass),
        'Content-Length': '0'
      }
    })

    // 检查各种成功状态码
    if (!(res.status === 201 || res.status === 405 || res.status === 409 || res.status === 301 || res.status === 302)) {
      if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        console.log(`[webdav] MKCOL failed: ${res.status} ${errorText}`)
        // 不抛出错误，继续执行，因为目录可能已经存在
      }
    }
  } catch (error) {
    console.log(`[webdav] MKCOL error: ${error.message}`)
    // 不抛出错误，继续执行
  }
}

async function listGithubMusic({ repoFull, token, branch, path = 'public/music', proxyFetch = fetch }) {
  const [owner, repo] = String(repoFull).split('/')
  const segs = String(path || 'public/music').replace(/^\/+|\/+$/g, '')
  const part = segs ? '/' + segs.split('/').map(encodeURIComponent).join('/') : ''
  const api = `https://api.github.com/repos/${owner}/${repo}/contents${part}?ref=${encodeURIComponent(branch)}`
  const res = await proxyFetch(api, { 
    headers: { 
      'Authorization': `Bearer ${token}`, 
      'Accept': 'application/vnd.github+json', 
      'User-Agent': 'web-music-player/0.1' 
    } 
  })
  if (!res.ok) throw new Error(`GitHub list failed: ${res.status} ${await res.text()}`)
  const items = await res.json()
  return (Array.isArray(items) ? items : []).filter(it => it && it.type === 'file' && isAudio(it.name))
}

export default async function handler(req, res) {
  // 设置CORS头
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const { action, cursor, limit } = req.body
    const repoFull = process.env.GIT_REPO
    const token = process.env.GIT_TOKEN
    const branch = process.env.GIT_BRANCH || 'main'
    const wUrl = process.env.WEBDAV_URL
    const wUser = process.env.WEBDAV_USER
    const wPass = process.env.WEBDAV_PASS
    const proxyUrl = process.env.GIT_URL
    const builtinProxyUrl = '/api/audio'
    const proxyFetch = createProxyFetch(proxyUrl, builtinProxyUrl)

    if (!repoFull || !token) {
      return res.status(500).json({ error: 'Server not configured: GIT_REPO/GIT_TOKEN missing' })
    }
    if (!wUrl || !wUser || !wPass) {
      return res.status(500).json({ error: 'Server not configured: WEBDAV_URL/WEBDAV_USER/WEBDAV_PASS missing' })
    }

    if (action === 'upload') {
      await ensureWebdavDir({ baseUrl: wUrl, user: wUser, pass: wPass })
      const files = await listGithubMusic({ repoFull, token, branch, proxyFetch })
      if (!files.length) {
        return res.status(200).json({ ok: true, total: 0, uploaded: 0, message: 'No audio files in repo' })
      }

      let existingNames = []
      try {
        const url = resolveMusicBase(wUrl).replace(/\/+$/g, '') + '/'
        const res = await fetch(url, {
          method: 'PROPFIND',
          headers: {
            'Depth': '1',
            'Authorization': buildBasicAuth(wUser, wPass)
          }
        })
        if (res.ok) {
          const text = await res.text()
          const hrefs = Array.from(text.matchAll(/<\s*[^:>]*:?href\s*>\s*([^<]+)\s*<\s*\/\s*[^:>]*:?href\s*>/ig)).map(m => m[1])
          try {
            const base = new URL(url)
            for (const h of hrefs) {
              try {
                const u = new URL(h, base)
                const pathname = decodeURIComponent(u.pathname)
                const segs = pathname.split('/').filter(Boolean)
                const last = segs.pop() || ''
                if (last && isAudio(last)) existingNames.push(last)
              } catch {}
            }
          } catch {}
        }
      } catch {}
      
      const existingSet = new Set(existingNames || [])
      const start = Math.max(0, Number(cursor) || 0)
      const step = Math.max(1, Math.min(Number(limit) || 3, 10))
      const slice = files.slice(start, start + step)
      let done = 0
      let skipped = 0
      const errors = []
      
      for (const f of slice) {
        const name = f.name
        try {
          if (existingSet.has(name)) {
            skipped++
            continue
          }
          const downloadUrl = f.download_url || `https://raw.githubusercontent.com/${repoFull}/${encodeURIComponent(branch)}/public/music/${encodeURIComponent(name)}`
          const rawRes = await proxyFetch(downloadUrl, { 
            headers: { 
              'User-Agent': 'web-music-player/0.1', 
              'Accept': 'application/octet-stream' 
            } 
          })
          if (!rawRes.ok) {
            const t = await rawRes.text().catch(() => '')
            throw new Error(`Fetch file failed: ${rawRes.status} ${t}`)
          }
          const buf = new Uint8Array(await rawRes.arrayBuffer())

          const url = joinUrl(wUrl, name)
          const putRes = await fetch(url, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Authorization': buildBasicAuth(wUser, wPass),
              'Overwrite': 'T'
            },
            body: buf
          })
          if (!putRes.ok) throw new Error(`WebDAV PUT failed: ${putRes.status} ${await putRes.text()}`)
          done++
        } catch (e) {
          errors.push({ file: name, error: e && e.message ? e.message : String(e) })
        }
      }
      
      const nextCursor = (start + step) < files.length ? (start + step) : null
      const processed = slice.length
      const status = errors.length === processed ? 500 : (errors.length ? 207 : 200)
      res.status(status).json({ 
        ok: errors.length === 0, 
        total: files.length, 
        processed, 
        uploaded: done, 
        skipped, 
        nextCursor, 
        errors 
      })
    } else if (action === 'restore') {
      // 实现WebDAV恢复功能：从WebDAV下载文件并上传到GitHub
      await ensureWebdavDir({ baseUrl: wUrl, user: wUser, pass: wPass })
      
      // 获取WebDAV中的文件列表
      let webdavFiles = []
      try {
        const baseUrl = resolveMusicBase(wUrl)
        const url = baseUrl.replace(/\/+$/g, '') + '/'
        
        // 首先尝试使用 PROPFIND 方法
        let res = await fetch(url, {
          method: 'PROPFIND',
          headers: {
            'Depth': '1',
            'Authorization': buildBasicAuth(wUser, wPass),
            'Content-Type': 'application/xml'
          }
        })
        
        // 如果 PROPFIND 失败，尝试使用 GET 方法检查目录
        if (!res.ok && res.status === 405) {
          console.log('[webdav] PROPFIND not supported, trying alternative method')
          // 尝试直接访问目录，看是否返回目录列表
          res = await fetch(url, {
            method: 'GET',
            headers: {
              'Authorization': buildBasicAuth(wUser, wPass)
            }
          })
        }
        
        // 如果还是失败，尝试使用 OPTIONS 方法检查支持的方法
        if (!res.ok && res.status === 405) {
          console.log('[webdav] GET also failed, checking supported methods')
          const optionsRes = await fetch(url, {
            method: 'OPTIONS',
            headers: {
              'Authorization': buildBasicAuth(wUser, wPass)
            }
          })
          console.log('[webdav] OPTIONS response:', optionsRes.status, optionsRes.headers.get('Allow'))
        }
        
        if (res.ok) {
          const text = await res.text()
          console.log('[webdav] WebDAV response:', text.substring(0, 500))
          
          // 解析 XML 响应中的 href
          const hrefs = Array.from(text.matchAll(/<\s*[^:>]*:?href\s*>\s*([^<]+)\s*<\s*\/\s*[^:>]*:?href\s*>/ig)).map(m => m[1])
          try {
            const base = new URL(url)
            for (const h of hrefs) {
              try {
                const u = new URL(h, base)
                const pathname = decodeURIComponent(u.pathname)
                const segs = pathname.split('/').filter(Boolean)
                const last = segs.pop() || ''
                if (last && isAudio(last)) {
                  webdavFiles.push({ name: last, download_url: u.toString() })
                }
              } catch {}
            }
          } catch {}
        } else {
          console.log('[webdav] WebDAV list failed:', res.status, await res.text().catch(() => ''))
        }
      } catch (error) {
        console.log('[webdav] WebDAV list error:', error.message)
      }
      
      // 如果无法获取 WebDAV 文件列表，尝试从 GitHub 获取文件列表并检查 WebDAV 中是否存在
      if (!webdavFiles.length) {
        console.log('[webdav] No files found via WebDAV listing, trying alternative approach')
        try {
          const githubFiles = await listGithubMusic({ repoFull, token, branch, proxyFetch })
          console.log(`[webdav] Found ${githubFiles.length} files in GitHub repo`)
          
          // 检查这些文件是否在 WebDAV 中存在
          for (const file of githubFiles.slice(0, 10)) { // 限制检查前10个文件
            try {
              const webdavUrl = joinUrl(wUrl, file.name)
              const checkRes = await fetch(webdavUrl, {
                method: 'HEAD',
                headers: {
                  'Authorization': buildBasicAuth(wUser, wPass)
                }
              })
              if (checkRes.ok) {
                webdavFiles.push({ name: file.name, download_url: webdavUrl })
              }
            } catch {}
          }
        } catch (error) {
          console.log('[webdav] Alternative approach failed:', error.message)
        }
      }
      
      if (!webdavFiles.length) {
        return res.status(200).json({ ok: true, total: 0, restored: 0, message: 'No audio files found in WebDAV' })
      }
      
      // 获取GitHub仓库中现有的文件列表
      let existingNames = []
      try {
        const files = await listGithubMusic({ repoFull, token, branch, proxyFetch })
        existingNames = files.map(f => f.name)
      } catch {}
      
      const existingSet = new Set(existingNames || [])
      const start = Math.max(0, Number(cursor) || 0)
      const step = Math.max(1, Math.min(Number(limit) || 3, 10))
      const slice = webdavFiles.slice(start, start + step)
      let done = 0
      let skipped = 0
      const errors = []
      
      for (const f of slice) {
        const name = f.name
        try {
          if (existingSet.has(name)) {
            skipped++
            continue
          }
          
          // 从WebDAV下载文件
          const downloadRes = await fetch(f.download_url, {
            headers: {
              'Authorization': buildBasicAuth(wUser, wPass),
              'User-Agent': 'web-music-player/0.1'
            }
          })
          if (!downloadRes.ok) {
            throw new Error(`WebDAV download failed: ${downloadRes.status}`)
          }
          const buf = new Uint8Array(await downloadRes.arrayBuffer())
          
          // 上传到GitHub
          const content = Buffer.from(buf).toString('base64')
          const uploadUrl = `https://api.github.com/repos/${repoFull}/contents/public/music/${encodeURIComponent(name)}`
          const uploadRes = await proxyFetch(uploadUrl, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'web-music-player/0.1',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              message: `Add ${name} via WebDAV restore`,
              content: content,
              branch: branch
            })
          })
          
          if (!uploadRes.ok) {
            const errorText = await uploadRes.text()
            throw new Error(`GitHub upload failed: ${uploadRes.status} ${errorText}`)
          }
          
          done++
        } catch (e) {
          errors.push({ file: name, error: e && e.message ? e.message : String(e) })
        }
      }
      
      const nextCursor = (start + step) < webdavFiles.length ? (start + step) : null
      const processed = slice.length
      const status = errors.length === processed ? 500 : (errors.length ? 207 : 200)
      res.status(status).json({ 
        ok: errors.length === 0, 
        total: webdavFiles.length, 
        processed, 
        restored: done, 
        skipped, 
        nextCursor, 
        errors 
      })
    } else {
      res.status(400).json({ error: 'Unknown action' })
    }
  } catch (e) {
    console.error('WebDAV error:', e)
    res.status(500).json({ error: e.message || 'webdav error' })
  }
}
