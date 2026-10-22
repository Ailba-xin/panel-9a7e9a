// Q币余额表 独立版 Service Worker
// 网络优先：联网时永远用最新页面（这样我在 GitHub 上一更新，手机打开就是新版）；
// 断网时回退到缓存，至少还能看到上次的数据。
var CACHE = 'qbstd-v1';
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var u = e.request.url;
  if (u.indexOf('api.unipay.qq.com') >= 0) return;   // 腾讯接口不缓存
  e.respondWith(
    fetch(e.request).then(function (r) {
      var cp = r.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, cp); });
      return r;
    }).catch(function () { return caches.match(e.request); })
  );
});