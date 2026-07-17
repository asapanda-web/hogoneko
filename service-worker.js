// 保護ログ用のシンプルなService Worker
// 目的: 同じサイト内の静的ファイル(html/js/css/画像)だけを軽くキャッシュして、
//      電波が不安定な時でもアプリの見た目がすぐ開けるようにする。
// 注意: Firebase(認証・Firestore通信など)や外部サイトへの通信には一切関与しない。

const CACHE_NAME = "hogolog-cache-v1"; // ファイルを大きく更新した時はこの数字を上げてください

const PRECACHE_URLS = [
  "./index.html",
  "./app.html",
  "./guide.html",
  "./style.css",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 同じサイト内のリクエストだけを対象にする(Firebaseなど外部通信には触れない)
  if (url.origin !== self.location.origin) {
    return;
  }
  // GET以外(POSTなど)は素通しする
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
