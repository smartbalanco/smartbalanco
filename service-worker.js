// ============================================================================
// SERVICE WORKER - Smartbalanço PWA
// Responsável por tornar o app instalável e carregar rápido.
// Versão do cache: mude o número quando atualizar os arquivos, para forçar
// os celulares a baixarem a versão nova.
// ============================================================================

const CACHE_NOME = "smartbalanco-v18";

// Arquivos que fazem o "esqueleto" do app funcionar mesmo offline.
const ARQUIVOS_ESSENCIAIS = [
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// Instalação: guarda os arquivos essenciais no cache do aparelho.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NOME).then((cache) => cache.addAll(ARQUIVOS_ESSENCIAIS))
  );
  self.skipWaiting();
});

// Ativação: limpa caches antigos de versões anteriores.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((chaves) =>
      Promise.all(
        chaves.filter((c) => c !== CACHE_NOME).map((c) => caches.delete(c))
      )
    )
  );
  self.clients.claim();
});

// Ao buscar algo:
// - Requisições ao servidor do Apps Script (dados) SEMPRE vão pela rede
//   (nunca do cache, pra não mostrar dado velho).
// - Arquivos do próprio app: tenta rede, se falhar usa o cache (offline).
self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Não intercepta chamadas ao Google (Apps Script, login) — deixa passar direto.
  if (url.includes("script.google.com") || url.includes("googleapis.com") || url.includes("accounts.google.com") || url.includes("gstatic.com")) {
    return;
  }

  // ignoreSearch: o index pede "app.js?v=9", mas no cache ele está como
  // "app.js". Sem isso, o app não abriria offline depois de uma publicação.
  event.respondWith(
    fetch(event.request)
      .then((resposta) => resposta)
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
