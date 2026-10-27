// Cliente da API de licenciamento (/api/v1/client).
// Segurança: o servidor revalida o acesso a CADA requisição; o que é guardado aqui são apenas
// tokens de curta duração + refresh token. A URL real da origem nunca precisa ser exposta (modo proxy/espelho).
//
// Novo back-end: um MAC pode ter VÁRIAS listas (uma ativação por parceiro). Cada lista tem as suas próprias
// sessões; aqui guardamos uma sessão por lista e uma "lista atual".
// URL do back-end: VITE_API_URL (definida no build). Só em desenvolvimento (npm run dev) existe um padrão local;
// em produção, sem a variável, o app avisa em vez de chamar um endereço errado.
const ENV_URL = String(import.meta.env.VITE_API_URL || "").trim().replace(/\/+$/, "");
export const API_URL = ENV_URL || (import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:3000` : "");
const BASE = `${API_URL}/api/v1/client`;
const KEY_INSTALL = "iptv-player-installation-id"; // id aleatório (web-<uuid>) da versão anterior
const KEY_IID = "iptv-player-iid:"; // + MAC: installationId usado por este navegador para aquele MAC
const KEY_SESSION = "iptv-player-session";
const LEGACY = "_"; // sessão salva pela versão anterior (sem activationId); é renomeada ao consultar /lists

const macHex = (mac) => String(mac || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();

// installationId deste navegador para o MAC: "webtv-<MAC sem separadores, maiúsculo>", formato que o servidor aceita
// em /register e /register/status (prefixos roku, rokutv, androidtv, samsungtv, lgtv, webtv) e que ele compara pelo MAC.
// Fica gravado por MAC. Navegador que já tinha sessão da versão anterior continua com o id antigo (web-<uuid>), porque
// a ativação dele no servidor está presa a esse id; só instalações novas usam webtv-<MAC>.
export function getInstallationId(mac) {
  const key = `${KEY_IID}${macHex(mac)}`;
  const saved = localStorage.getItem(key);
  if (saved) return saved;
  const legacy = localStorage.getItem(KEY_INSTALL);
  const old = readStore();
  const id = legacy && old && macHex(old.mac) === macHex(mac) ? legacy : `webtv-${macHex(mac)}`;
  localStorage.setItem(key, id);
  return id;
}

async function call(path, { method = "GET", body, token } = {}) {
  if (!API_URL) {
    throw Object.assign(
      new Error("A URL do back-end não está configurada (VITE_API_URL). Defina-a e gere o build de novo."),
      { code: "API_URL_MISSING", status: 0 },
    );
  }
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error("Não foi possível falar com o servidor. Verifique a conexão."), {
      code: "SERVER_UNREACHABLE",
      status: 0,
    });
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || "Não foi possível concluir a operação."), {
      code: data.code,
      status: res.status,
    });
  }
  return data;
}

/* ---------------------------------------------------------------------------
 * Sessões (uma por lista/ativação)
 *   { v: 2, mac, current: <activationId>, sessions: { [activationId]: { accessToken, refreshToken, accessExp } } }
 * ------------------------------------------------------------------------- */
const readStore = () => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY_SESSION));
    if (!s || !s.mac) return null;
    if (s.v === 2 && s.sessions && typeof s.sessions === "object") return s;
    if (s.accessToken) {
      // Formato antigo (uma sessão só).
      return {
        v: 2,
        mac: s.mac,
        current: LEGACY,
        sessions: { [LEGACY]: { accessToken: s.accessToken, refreshToken: s.refreshToken, accessExp: s.accessExp || 0 } },
      };
    }
  } catch { /* storage corrompido: trata como sem sessão */ }
  return null;
};
const writeStore = (s) => localStorage.setItem(KEY_SESSION, JSON.stringify(s));
const storeFor = (mac) => {
  const s = readStore();
  return s && s.mac === mac ? s : null;
};

function putSession(mac, activationId, tokens, { makeCurrent = true } = {}) {
  const s = storeFor(mac) || { v: 2, mac, current: activationId, sessions: {} };
  s.sessions[activationId] = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExp: Date.now() + tokens.expiresIn * 1000,
  };
  if (makeCurrent || !s.current || !s.sessions[s.current]) s.current = activationId;
  writeStore(s);
}

function dropSession(mac, activationId) {
  const s = storeFor(mac);
  if (!s) return;
  delete s.sessions[activationId];
  const rest = Object.keys(s.sessions);
  if (!rest.length) return localStorage.removeItem(KEY_SESSION);
  if (s.current === activationId) s.current = rest[0];
  writeStore(s);
}

function rekeySession(mac, from, to) {
  const s = storeFor(mac);
  if (!s || !s.sessions[from] || from === to) return;
  s.sessions[to] = s.sessions[from];
  delete s.sessions[from];
  if (s.current === from) s.current = to;
  writeStore(s);
}

const noSession = () =>
  Object.assign(new Error("Dispositivo não ativado."), { code: "NO_SESSION", status: 401 });

export const getSession = (mac) => {
  const s = storeFor(mac);
  const cur = s && s.sessions[s.current];
  return cur ? { activationId: s.current, ...cur } : null;
};
export const currentListId = (mac) => storeFor(mac)?.current ?? null;

export const clearSession = () => {
  localStorage.removeItem(KEY_SESSION);
  xtreamCache = null;
  preferMirror.clear();
  cacheClearAll(); // sair/limpar sessão também apaga o catálogo guardado neste navegador
};

// Código de licença individual é longo (LIC-XXXXX-…); código de parceria é curto (4–12 letras/números).
export const isLicenseCode = (code) => code.replace(/[^A-Za-z0-9]/g, "").length > 12;

export async function activate(code, mac, { username = "", password = "" } = {}) {
  const license = isLicenseCode(code);
  const installationId = getInstallationId(mac);
  const body = license
    ? { code: code.trim(), mac, installationId }
    : { code: code.trim(), username, password, mac, installationId };
  const data = await call(`/activate/${license ? "license" : "partner"}`, { method: "POST", body });
  // Ativar outro parceiro no mesmo MAC cria uma NOVA lista; as sessões das demais listas são mantidas.
  putSession(mac, data.activationId, data.tokens);
  xtreamCache = null;
  return data;
}

// Primeiro acesso de um MAC já cadastrado: usa a MESMA rota do app Roku (POST /register, depois /lists).
// Estados devolvidos pelo servidor: configured_partner | configured_playlist (vem com tokens), awaiting_configuration,
// session_required, expired | disabled | deactivated. Sem sessão a conceder, lança NOTHING_TO_CLAIM (404) e o
// App.jsx pede o código de ativação.
const CONFIGURED = new Set(["configured_partner", "configured_playlist", "configured"]);

// Guarda as sessões que o servidor liberou (uma por lista em data.activations[].tokens e/ou a principal em data.tokens).
function storeGranted(mac, data) {
  const status = String(data.status || data.configurationStatus || "");
  let stored = 0;
  // Um MAC pode ter vários parceiros: o servidor pode devolver uma sessão por lista em data.activations[].tokens.
  const acts = Array.isArray(data.activations) ? data.activations : [];
  for (const a of acts) {
    if (a?.activationId && a?.tokens?.accessToken && a?.tokens?.refreshToken && CONFIGURED.has(String(a.status))) {
      putSession(mac, a.activationId, a.tokens, { makeCurrent: stored === 0 });
      stored++;
    }
  }
  // Sessão principal (mesmo formato do Roku: data.tokens + data.activationId).
  if (data.tokens?.accessToken && data.tokens?.refreshToken && CONFIGURED.has(status)) {
    const id = data.activationId || LEGACY;
    putSession(mac, id, data.tokens, { makeCurrent: stored === 0 });
    stored++;
  }
  return stored;
}

export async function claimLegacy(mac) {
  const installationId = getInstallationId(mac);
  let data = await call("/register", { method: "POST", body: { mac, installationId } });
  let stored = storeGranted(mac, data);

  // O /register só registra o aparelho e devolve o token de pareamento: a sessão sai no /register/status (como no app
  // Roku e no Android). Se o MAC já tem lista vinculada, a resposta já traz as sessões; se não, segue sem sessão.
  const registrationToken = data.pairing?.registrationToken;
  if (!stored && registrationToken) {
    try {
      const st = await call("/register/status", { method: "POST", body: { mac, installationId, registrationToken } });
      data = st;
      stored = storeGranted(mac, st);
    } catch (e) {
      if (e.status !== 403 && e.status !== 409) throw e; // token inválido/já usado: segue sem sessão
    }
  }
  if (stored) {
    xtreamCache = null;
    return data;
  }

  const status = String(data.status || data.configurationStatus || "");
  if (status === "expired" || status === "disabled" || status === "deactivated") {
    throw Object.assign(new Error(data.message || "Este dispositivo está bloqueado ou expirado."), {
      code: status.toUpperCase(),
      status: 403,
    });
  }
  // awaiting_configuration / session_required / sem sessão: precisa ativar com o código.
  throw Object.assign(new Error(data.message || "Dispositivo não ativado."), { code: "NOTHING_TO_CLAIM", status: 404 });
}

// Access token da lista indicada (padrão: a atual). Renova com o refresh token quando perto de expirar.
async function accessToken(mac, activationId, force = false) {
  const s = storeFor(mac);
  const id = activationId ?? s?.current;
  const cur = s && id ? s.sessions[id] : null;
  if (!cur) throw noSession();
  if (!force && Date.now() < cur.accessExp - 30_000) return cur.accessToken;
  try {
    const data = await call("/session/refresh", {
      method: "POST",
      body: { refreshToken: cur.refreshToken, installationId: getInstallationId(mac) },
    });
    putSession(mac, id, data.tokens, { makeCurrent: false });
    return data.tokens.accessToken;
  } catch (e) {
    if (e.status === 401) dropSession(mac, id); // sessão revogada/expirada: esta lista exige nova ativação
    throw e;
  }
}

// Chamada autenticada; se o token for recusado (401), renova uma vez e tenta de novo.
async function authed(mac, path, { activationId, ...opts } = {}) {
  let token = await accessToken(mac, activationId);
  try {
    return await call(path, { ...opts, token });
  } catch (e) {
    if (e.status !== 401) throw e;
    token = await accessToken(mac, activationId, true);
    return call(path, { ...opts, token });
  }
}

/* ---------------------------------------------------------------------------
 * Listas do dispositivo (um MAC pode ter vários parceiros)
 * ------------------------------------------------------------------------- */
const sessionOrder = (mac) => {
  const s = storeFor(mac);
  if (!s) return [];
  return [s.current, ...Object.keys(s.sessions).filter((k) => k !== s.current)].filter((k) => s.sessions[k]);
};

// Lista as listas vivas do aparelho. Se a lista atual estiver bloqueada/expirada, usa a sessão de outra lista.
export async function listsOf(mac) {
  let lastErr = noSession();
  for (const id of sessionOrder(mac)) {
    try {
      const data = await authed(mac, "/lists", { activationId: id });
      if (id === LEGACY && data.currentActivationId) rekeySession(mac, LEGACY, data.currentActivationId);
      return {
        currentActivationId: currentListId(mac) ?? data.currentActivationId ?? null,
        lists: Array.isArray(data.lists) ? data.lists : [],
      };
    } catch (e) {
      lastErr = e;
      if (e.status !== 401 && e.status !== 403) throw e;
    }
  }
  throw lastErr;
}

// Passa a usar outra lista do mesmo aparelho (usa a sessão guardada ou pede uma nova ao servidor).
export async function useList(mac, activationId) {
  const s = storeFor(mac);
  if (s?.sessions[activationId]) {
    try {
      await accessToken(mac, activationId);
      const cur = storeFor(mac);
      if (cur) { cur.current = activationId; writeStore(cur); }
      xtreamCache = null;
      return;
    } catch (e) {
      if (e.status !== 401) throw e; // 403 = lista bloqueada/expirada: mostra o motivo
    }
  }
  let lastErr = noSession();
  for (const from of sessionOrder(mac)) {
    if (from === activationId) continue;
    try {
      const data = await authed(mac, `/lists/${activationId}/session`, {
        activationId: from,
        method: "POST",
        body: { installationId: getInstallationId(mac) },
      });
      putSession(mac, activationId, data.tokens);
      xtreamCache = null;
      return;
    } catch (e) {
      lastErr = e;
      if (e.status !== 401) throw e;
    }
  }
  throw lastErr;
}

/* ---------------------------------------------------------------------------
 * Xtream: o backend só entrega a conexão (GET /xtream); catálogo e reprodução vão ao painel
 * (modo redirect) ou à rota espelho do próprio servidor (modo proxy). A configuração fica em cache
 * por no máximo 60 s e é renovada com a sessão da lista.
 * ------------------------------------------------------------------------- */
const XTREAM_TTL_MS = 60_000;
let xtreamCache = null; // { key, at, cfg }
const preferMirror = new Set(); // listas em que o acesso direto ao painel falhou (CORS/http misto) e o espelho funcionou

export const clearXtreamCache = () => { xtreamCache = null; };

const keyOf = (mac) => `${mac}|${currentListId(mac)}`;

async function getXtreamConfig(mac, force = false) {
  const key = keyOf(mac);
  if (!force && xtreamCache && xtreamCache.key === key && Date.now() - xtreamCache.at < XTREAM_TTL_MS) {
    return xtreamCache.cfg;
  }
  const cfg = await authed(mac, "/xtream");
  // Como no Roku (GatewayPath): caminho relativo do servidor vira URL absoluta do back-end.
  if (typeof cfg.baseUrl === "string" && cfg.baseUrl.startsWith("/")) cfg.baseUrl = `${API_URL}${cfg.baseUrl}`;
  if (cfg.mirror && typeof cfg.mirror === "object" && String(cfg.mirror.baseUrl || "").startsWith("/")) {
    cfg.mirror = { ...cfg.mirror, baseUrl: `${API_URL}${cfg.mirror.baseUrl}` };
  }
  xtreamCache = { key, at: Date.now(), cfg };
  return cfg;
}

const trimSlash = (u) => String(u).replace(/\/+$/, "");

// Conexão efetiva: o próprio painel (direto) ou a rota espelho do servidor.
const mirrorOf = (cfg) => (cfg.mirror && typeof cfg.mirror === "object" ? cfg.mirror : null);
const connOf = (cfg, useMirror) => {
  const m = useMirror ? mirrorOf(cfg) : null;
  const src = m || cfg;
  // Em modo proxy o /xtream já devolve a conexão do espelho (mirror: true).
  return { baseUrl: src.baseUrl, username: src.username, password: src.password, isMirror: !!m || cfg.mirror === true };
};

async function xtreamApi(conn, action, params = {}) {
  const qs = new URLSearchParams({ username: conn.username, password: conn.password, action, ...params });
  const url = `${trimSlash(conn.baseUrl)}/player_api.php?${qs}`;
  let unreachable = false;
  let lastStatus = 0;
  let mirrorBody = null;
  // Painéis Xtream respondem 404/5xx ou uma página HTML de forma intermitente: até 3 tentativas, como o app Roku.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(url);
      unreachable = false;
    } catch {
      unreachable = true;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    lastStatus = res.status;
    if (res.ok) {
      const text = (await res.text().catch(() => "")).trim();
      if (text === "null" || text === "false") return [];
      if (text[0] === "[" || text[0] === "{") {
        try {
          const data = JSON.parse(text);
          return Array.isArray(data) ? data : data || [];
        } catch { /* JSON truncado: tenta de novo */ }
      }
    } else if (res.status === 429) {
      // Limite de requisições do provedor/servidor: repetir rápido só piora. Espera (Retry-After ou crescente).
      const wait = Math.min(Number(res.headers.get("retry-after")) * 1000 || attempt * 2000, 8000);
      if (attempt < 3) await new Promise((r) => setTimeout(r, wait));
      continue;
    } else if (conn.isMirror) {
      // A rota espelho responde { code, message } (ex.: ORIGIN_UNAVAILABLE, ORIGIN_ERROR, SESSION_REVOKED).
      const body = await res.json().catch(() => null);
      if (res.status === 401 || res.status === 503) {
        throw Object.assign(new Error(body?.message || "O provedor recusou a consulta."), {
          code: body?.code || "PROVIDER_ERROR",
          status: res.status,
        });
      }
      mirrorBody = body;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 400));
  }
  if (unreachable) {
    throw Object.assign(
      new Error(
        "Não foi possível acessar o provedor pelo navegador (bloqueio de CORS ou conteúdo misto http/https). " +
          "Peça ao administrador para usar o modo proxy nesta lista.",
      ),
      { code: "PROVIDER_UNREACHABLE", status: 502 },
    );
  }
  if (mirrorBody?.code) {
    throw Object.assign(new Error(`${mirrorBody.message || "Falha na origem."} (${mirrorBody.code}, HTTP ${lastStatus})`), {
      code: mirrorBody.code,
      status: 502,
    });
  }
  throw Object.assign(
    new Error(
      lastStatus === 401 || lastStatus === 403
        ? `O provedor recusou o acesso (HTTP ${lastStatus}). Verifique usuário e senha.`
        : "O provedor recusou a consulta.",
    ),
    { code: "PROVIDER_ERROR", status: 502 },
  );
}

// Executa `run(conn, cfg)` com a conexão da lista atual, com os planos B:
//  - painel inacessível pelo navegador -> tenta pela rota espelho do servidor (e lembra);
//  - espelho recusou o token (401)     -> busca a configuração de novo (token novo) e repete uma vez.
async function withProvider(mac, run, force = false) {
  const cfg = await getXtreamConfig(mac, force);
  const key = keyOf(mac);
  const conn = connOf(cfg, preferMirror.has(key));
  try {
    return await run(conn, cfg);
  } catch (e) {
    if (e.code === "PROVIDER_UNREACHABLE" && !conn.isMirror && mirrorOf(cfg)) {
      try {
        const out = await run(connOf(cfg, true), cfg);
        preferMirror.add(key);
        return out;
      } catch (e2) {
        if (e2.status === 401 && !force) {
          // O espelho recusou o token: busca a configuração de novo (token novo) e repete já pelo espelho.
          preferMirror.add(key);
          xtreamCache = null;
          return withProvider(mac, run, true);
        }
        throw e2.code === "PROVIDER_UNREACHABLE" ? e : e2;
      }
    }
    if (e.status === 401 && conn.isMirror && !force) {
      xtreamCache = null;
      return withProvider(mac, run, true);
    }
    throw e;
  }
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const categoryMap = (list) => new Map(asArray(list).map((c) => [String(c.category_id), c.category_name]));
const authOf = (conn) => `${encodeURIComponent(conn.username)}/${encodeURIComponent(conn.password)}`;

/* ---------------------------------------------------------------------------
 * Cache OFFLINE do catálogo (IndexedDB)
 * O catálogo tem dezenas de milhares de itens: não cabe no localStorage (limite ~5 MB), por isso usa IndexedDB.
 * Guarda só dados enxutos (título, grupo, imagem, id) — NUNCA links de reprodução: usuário/senha/token são
 * recolocados a cada abertura com a conexão atual, então um token vencido no cache não quebra a reprodução.
 *  - até FRESH_MS: usa o cache e não consulta o provedor;
 *  - até MAX_STALE_MS: mostra o cache na hora e atualiza em segundo plano (onUpdate);
 *  - sem rede/provedor fora do ar: mostra o cache, por mais velho que seja.
 * ------------------------------------------------------------------------- */
const CACHE_DB = "iptv-catalog-cache";
const CACHE_STORE = "catalogs";
const CACHE_VERSION = 1;
const FRESH_MS = 30 * 60_000; // 30 min
const MAX_STALE_MS = 7 * 24 * 60 * 60_000; // 7 dias

const openCacheDb = () =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("sem IndexedDB"));
    const r = indexedDB.open(CACHE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(CACHE_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function cacheOp(mode, fn) {
  const db = await openCacheDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, mode);
      const req = fn(tx.objectStore(CACHE_STORE));
      tx.oncomplete = () => resolve(req?.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const cacheGet = (key) =>
  cacheOp("readonly", (st) => st.get(key))
    .then((v) => (v && v.v === CACHE_VERSION && Array.isArray(v.items) ? v : null))
    .catch(() => null);
const cacheSet = (key, items) =>
  cacheOp("readwrite", (st) => st.put({ v: CACHE_VERSION, at: Date.now(), items }, key)).catch(() => {}); // cheio/bloqueado: segue sem cache
const cacheClearAll = () => cacheOp("readwrite", (st) => st.clear()).catch(() => {});

const catalogKey = (mac) => `${mac}|${currentListId(mac)}`;

// Monta o link de reprodução com a conexão ATUAL (o cache não guarda links).
const withLink = (c, base, auth) => {
  if (c.type === "canais") c.srcVideo = `${base}/live/${auth}/${c.id}.m3u8`; // HLS primeiro; o player cai para .ts sozinho
  else if (c.type === "filmes") c.srcVideo = `${base}/movie/${auth}/${c.id}.${c.ext || "mp4"}`;
  else c.srcVideo = `series:${c.seriesId}`;
  return c;
};

// Busca o catálogo no provedor: 3 categorias + 3 listas inteiras (uma por tipo). Devolve itens enxutos, sem link.
async function fetchCatalogFresh(conn) {
  // Categorias são pequenas. Uma de cada vez: muitos painéis limitam as conexões simultâneas por usuário.
  const cats = [];
  for (const action of ["get_live_categories", "get_vod_categories", "get_series_categories"]) {
    try {
      cats.push({ status: "fulfilled", value: await xtreamApi(conn, action) });
    } catch (reason) {
      if (reason?.status === 401) throw reason;
      cats.push({ status: "rejected", reason });
    }
  }
  if (cats.every((r) => r.status === "rejected")) throw cats[0].reason;
  const [liveGroups, vodGroups, serGroups] = cats.map((r) => categoryMap(r.status === "fulfilled" ? r.value : []));

  const items = [];
  const errors = [];
  // Uma requisição por TIPO (sem category_id), em sequência; cada resposta vira itens enxutos antes da próxima.
  const loadAll = async (action, build) => {
    try {
      for (const row of asArray(await xtreamApi(conn, action))) items.push(build(row));
    } catch (e) {
      if (e.status === 401) throw e;
      errors.push(e);
    }
  };
  await loadAll("get_live_streams", (c) => ({
    type: "canais", id: c.stream_id, title: c.name,
    group: liveGroups.get(String(c.category_id)) || "Sem categoria", srcImage: c.stream_icon || "",
  }));
  await loadAll("get_vod_streams", (m) => ({
    type: "filmes", id: m.stream_id, ext: m.container_extension || "mp4", title: m.title || m.name,
    group: vodGroups.get(String(m.category_id)) || "Sem categoria", srcImage: m.stream_icon || "",
  }));
  await loadAll("get_series", (s) => ({
    type: "series", seriesId: s.series_id, title: s.title || s.name,
    group: serGroups.get(String(s.category_id)) || "Sem categoria", srcImage: s.cover || "",
  }));

  if (!items.length && errors.length) throw errors[0];
  return { items, complete: errors.length === 0 };
}

/**
 * Carrega o catálogo da lista atual.
 * @param {object} [opts]
 * @param {boolean} [opts.force]      ignora o cache (botão "Atualizar catálogo")
 * @param {(data:object)=>void} [opts.onUpdate]  chamado quando uma atualização em segundo plano termina
 */
export async function loadCatalog(mac, { force = false, onUpdate } = {}) {
  xtreamCache = null; // abertura: sempre confere a autorização no servidor (1 chamada leve a /xtream)
  return withProvider(mac, async (conn, cfg) => {
    const base = trimSlash(conn.baseUrl);
    const auth = authOf(conn);
    const key = catalogKey(mac);
    const result = (items, extra = {}) => ({ items, account: cfg.account, expiresAt: cfg.expiresAt, mode: cfg.mode, ...extra });

    const refresh = async () => {
      const fresh = await fetchCatalogFresh(conn);
      if (fresh.complete && fresh.items.length) await cacheSet(key, fresh.items); // lista incompleta não vira cache
      fresh.items.forEach((c) => withLink(c, base, auth));
      return fresh.items;
    };

    const cached = force ? null : await cacheGet(key);
    const age = cached ? Date.now() - cached.at : Infinity;

    if (cached && age < MAX_STALE_MS) {
      cached.items.forEach((c) => withLink(c, base, auth));
      if (age >= FRESH_MS && onUpdate) {
        refresh().then((items) => onUpdate(result(items, { fromCache: false }))).catch(() => { /* mantém o cache */ });
      }
      return result(cached.items, { fromCache: true, cachedAt: cached.at });
    }

    try {
      return result(await refresh(), { fromCache: false });
    } catch (e) {
      // Sem rede / provedor fora do ar / limite de requisições: usa a cópia guardada, mesmo velha.
      if (e.status !== 401) {
        const old = await cacheGet(key);
        if (old) {
          old.items.forEach((c) => withLink(c, base, auth));
          return result(old.items, { fromCache: true, cachedAt: old.at, offline: true });
        }
      }
      throw e;
    }
  });
}

export async function loadSeriesEpisodes(mac, seriesId) {
  return withProvider(mac, async (conn) => {
    const base = trimSlash(conn.baseUrl);
    const auth = authOf(conn);
    const info = await xtreamApi(conn, "get_series_info", { series_id: seriesId });
    const bySeason = info?.episodes && !Array.isArray(info.episodes) ? info.episodes : {};
    const episodes = [];
    for (const [seasonKey, list] of Object.entries(bySeason)) {
      for (const ep of asArray(list)) {
        const season = Number(ep.season ?? seasonKey) || 1;
        const number = Number(ep.episode_num) || undefined;
        episodes.push({
          type: "series",
          title: ep.title || `Episódio ${number ?? ""}`.trim(),
          episodeTitle: ep.title,
          season,
          episode: number,
          srcImage: ep.info?.movie_image || info?.info?.cover || "",
          srcVideo: `${base}/series/${auth}/${ep.id}.${ep.container_extension || "mp4"}`,
        });
      }
    }
    episodes.sort((a, b) => a.season - b.season || (a.episode || 0) - (b.episode || 0));
    return episodes;
  });
}

// Reprodução direta no provedor (ou pelo espelho); o servidor autoriza a sessão e o status é verificado periodicamente.
export async function getPlayUrl(mac, srcVideo) {
  if (/^https?:\/\//i.test(srcVideo)) {
    await accessToken(mac); // garante sessão válida (renova/limpa se revogada)
    return srcVideo;
  }
  throw Object.assign(new Error("Fonte de vídeo inválida."), { code: "INVALID_SOURCE", status: 400 });
}

// Verificação periódica de status (bloqueio/expiração/revogação) da lista atual.
export async function checkStatus(mac) {
  return authed(mac, "/status");
}

// Cadastra um dispositivo EXTERNO (ex.: Roku) por MAC + código de parceria + usuário/senha do provedor.
// Não guarda sessão neste navegador. O installationId é "roku-" + MAC sem separadores (maiúsculo); o servidor compara instalações pelo MAC e
// ignora o prefixo, então qualquer TV (Roku, Android, Samsung, LG, Web) reconhece o cadastro quando abrir o app. Se o MAC já tem outro parceiro, vira uma lista a mais.
export const normalizeMacInput = (raw) => {
  const hex = String(raw || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return hex.length === 12 ? hex : null;
};

export async function registerExternalDevice({ mac, code, username, password }) {
  const hex = normalizeMacInput(mac);
  if (!hex) throw Object.assign(new Error("MAC inválido. Use 12 caracteres hexadecimais (ex.: D6:41:F4:FF:0A:98)."), { code: "INVALID_MAC", status: 400 });
  const data = await call("/activate/partner", {
    method: "POST",
    body: {
      code: String(code).trim(),
      username: String(username).trim(),
      password,
      mac: hex.match(/.{2}/g).join(":"),
      installationId: `roku-${hex}`,
    },
  });
  // Descarta os tokens de propósito: o navegador não vira esse dispositivo.
  return { mac: hex.match(/.{2}/g).join(":"), expiresAt: data.expiresAt, reused: !!data.reused, kind: data.kind };
}

// Cadastra uma lista pelo LINK M3U completo (sem baixar a lista): o servidor extrai servidor, usuário e senha e a TV mostra o nome informado.
// Sem licença ativa no MAC o cadastro é aceito, mas só passa a valer quando a licença for ativada (resposta `licensed: false`).
export async function addPlaylistByUrl({ mac, name, url }) {
  const hex = normalizeMacInput(mac);
  if (!hex) throw Object.assign(new Error("MAC inválido. Use 12 caracteres hexadecimais (ex.: D6:41:F4:FF:0A:98)."), { code: "INVALID_MAC", status: 400 });
  return call("/playlist/by-url", {
    method: "POST",
    body: { mac: hex.match(/.{2}/g).join(":"), name: String(name).trim(), url: String(url).trim() },
  });
}
