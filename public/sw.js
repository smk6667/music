const CACHE_NAME = 'music-v1';
const STATIC_CACHE = [
  '/',
  '/index.html',
  '/manifest.json'
];

const IMAGE_CACHE = [
  '/images/logo.webp',
  '/images/background.webp',
  '/images/cd.webp',
  '/images/cd_tou.webp'
];

const API_CACHE = 'api-cache-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      // 缓存静态资源
      caches.open(CACHE_NAME).then(cache => {
        return Promise.allSettled(
          STATIC_CACHE.map(url => 
            cache.add(url).catch(err => {
              console.warn(`静态资源缓存失败: ${url}`, err);
              return null;
            })
          )
        );
      }),
      // 缓存图片资源（可选，失败不影响安装）
      caches.open(CACHE_NAME).then(cache => {
        return Promise.allSettled(
          IMAGE_CACHE.map(url => 
            cache.add(url).catch(err => {
              console.warn(`图片资源缓存失败: ${url}`, err);
              return null;
            })
          )
        );
      })
    ])
    .then(() => {
      console.log('Service Worker 安装完成');
      self.skipWaiting();
    })
    .catch(err => {
      console.error('Service Worker 安装失败:', err);
      self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME && cacheName !== API_CACHE) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;

  if (request.destination === 'audio' ||
      url.pathname.includes('.mp3') ||
      url.pathname.includes('.flac') ||
      url.pathname.includes('.wav') ||
      url.pathname.includes('.m4a') ||
      url.pathname.includes('.ogg') ||
      request.headers.has('range')) {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      caches.open(API_CACHE).then(cache => {
        return cache.match(request).then(response => {
          if (response) return response;
          return fetch(request).then(fetchResponse => {
            if (fetchResponse.ok && fetchResponse.status === 200) {
              const responseToCache = fetchResponse.clone();
              cache.put(request, responseToCache);
            }
            return fetchResponse;
          }).catch(() => cache.match(request));
        });
      })
    );
    return;
  }

  if (request.destination === 'document' ||
      ['style', 'script', 'image'].includes(request.destination)) {
    event.respondWith(
      caches.match(request).then(response => {
        if (response) return response;
        return fetch(request).then(fetchResponse => {
          if (fetchResponse.ok) {
            const responseToCache = fetchResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseToCache));
          }
          return fetchResponse;
        }).catch(() => {
          if (request.destination === 'document') {
            return caches.match('/index.html');
          }
          return new Response('资源加载失败', { status: 404 });
        });
      })
    );
  }
});
