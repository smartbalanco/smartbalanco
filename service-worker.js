// ============================================================================
// SERVICE WORKER - Smartbalanço PWA
// Responsável por tornar o app instalável e carregar rápido.
// Versão do cache: mude o número quando atualizar os arquivos, para forçar
// os celulares a baixarem a versão nova.
// ============================================================================

const CACHE_NOME = "smartbalanco-v69";

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

  // O index.html é buscado IGNORANDO o cache do navegador (cache: "reload").
  //
  // Por que só ele: o endereço do app.js carrega "?v=N", que muda a cada
  // publicação e por si só derruba o cache. O index.html não tem como carregar
  // isso — é ele que o navegador pede primeiro, sem ninguém para versioná-lo —
  // e o WebView do Android o guardava por minutos. O resultado era o pior tipo
  // de mistura: JavaScript novo rodando sobre HTML velho, em que um botão
  // recém-publicado simplesmente não existia na tela, sem erro nenhum.
  const ehPagina = event.request.mode === "navigate" ||
                   event.request.destination === "document" ||
                   url.endsWith("/") || url.endsWith("index.html");

  // ignoreSearch: o index pede "app.js?v=9", mas no cache ele está como
  // "app.js". Sem isso, o app não abriria offline depois de uma publicação.
  event.respondWith(
    fetch(ehPagina ? new Request(event.request, { cache: "reload" }) : event.request)
      .then((resposta) => {
        // Guarda a página nova para o modo offline. Sem isto, buscar sempre da
        // rede deixaria o app sem index nenhum quando faltasse conexão.
        if (ehPagina && resposta && resposta.ok) {
          const copia = resposta.clone();
          caches.open(CACHE_NOME).then((c) => c.put("./index.html", copia)).catch(() => {});
        }
        return resposta;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
