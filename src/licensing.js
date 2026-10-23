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
const KEY_INSTALL = "iptv-player-installation-id";
const KEY_SESSION = "iptv-player-session";
const LEGACY = "_"; // sessão salva pela versão anterior (sem activationId); é renomeada ao consultar /lists

export function getInstallationId() {
  let id = localStorage.getItem(KEY_INSTALL);
  if (!id) {
    id = `web-${typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}`;
    localStorage.setItem(KEY_INSTALL, id);
  }
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
};

// Código de licença individual é longo (LIC-XXXXX-…); código de parceria é curto (4–12 letras/números).
export const isLicenseCode = (code) => code.replace(/[^A-Za-z0-9]/g, "").length > 12;

export async function activate(code, mac, { username = "", password = "" } = {}) {
  const license = isLicenseCode(code);
  const body = license
    ? { code: code.trim(), mac, installationId: getInstallationId() }
    : { code: code.trim(), username, password, mac, installationId: getInstallationId() };
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

export async function claimLegacy(mac) {
  const data = await call("/register", { method: "POST", body: { mac, installationId: getInstallationId() } });
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
  if (stored) {
    xtreamCache = null;
    return data;
  }

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
      body: { refreshToken: cur.refreshToken, installationId: getInstallationId() },
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
        body: { installationId: getInstallationId() },
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
    } else if (conn.isMirror && (res.status === 401 || res.status === 503)) {
      // A rota espelho responde 401 (sessão encerrada) / 503 (serviço indisponível) com { code, message }.
      const body = await res.json().catch(() => null);
      throw Object.assign(new Error(body?.message || "O provedor recusou a consulta."), {
        code: body?.code || "PROVIDER_ERROR",
        status: res.status,
      });
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

export async function loadCatalog(mac) {
  // abertura/atualização: sempre confere a autorização no servidor
  xtreamCache = null;
  return withProvider(mac, async (conn, cfg) => {
    const base = trimSlash(conn.baseUrl);
    const auth = authOf(conn);

    // Categorias são pequenas: em paralelo. Se TODAS falharem, o erro sobe (e o plano B de withProvider entra).
    const cats = await Promise.allSettled([
      xtreamApi(conn, "get_live_categories"),
      xtreamApi(conn, "get_vod_categories"),
      xtreamApi(conn, "get_series_categories"),
    ]);
    if (cats.every((r) => r.status === "rejected")) throw cats[0].reason;
    const authFail = cats.find((r) => r.status === "rejected" && r.reason?.status === 401);
    if (authFail) throw authFail.reason;
    const [liveGroups, vodGroups, serGroups] = cats.map((r) => categoryMap(r.status === "fulfilled" ? r.value : []));

    const items = [];
    const errors = [];
    // Como no app Roku: uma categoria por vez (?category_id=...), nunca a lista inteira de dezenas de MB.
    // 4 categorias em paralelo; cada resposta vira itens enxutos e é descartada.
    const step = async (action, groups, build) => {
      const ids = [...groups.keys()];
      let next = 0;
      let failed = 0;
      let firstErr = null;
      const worker = async () => {
        while (next < ids.length) {
          const id = ids[next++];
          try {
            const raw = asArray(await xtreamApi(conn, action, { category_id: id }));
            for (const row of raw) items.push(build(row));
          } catch (e) {
            if (e.status === 401) throw e;
            failed++;
            firstErr = firstErr || e;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
      if (ids.length && failed === ids.length) errors.push(firstErr);
    };

    await step("get_live_streams", liveGroups, (c) => ({
      type: "canais",
      title: c.name,
      group: liveGroups.get(String(c.category_id)) || "Sem categoria",
      srcImage: c.stream_icon || "",
      srcVideo: `${base}/live/${auth}/${c.stream_id}.ts`,
    }));
    await step("get_vod_streams", vodGroups, (m) => ({
      type: "filmes",
      title: m.title || m.name,
      group: vodGroups.get(String(m.category_id)) || "Sem categoria",
      srcImage: m.stream_icon || "",
      srcVideo: `${base}/movie/${auth}/${m.stream_id}.${m.container_extension || "mp4"}`,
    }));
    // Séries: só a lista; temporadas/episódios chegam sob demanda (loadSeriesEpisodes).
    await step("get_series", serGroups, (s) => ({
      type: "series",
      seriesId: s.series_id,
      title: s.title || s.name,
      group: serGroups.get(String(s.category_id)) || "Sem categoria",
      srcImage: s.cover || "",
      srcVideo: `series:${s.series_id}`,
    }));

    if (!items.length && errors.length) throw errors[0];
    return { items, account: cfg.account, expiresAt: cfg.expiresAt, mode: cfg.mode };
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
// Não guarda sessão neste navegador. O installationId segue o padrão do Roku ("roku-" + MAC sem separadores, maiúsculo),
// então a TV reconhece o cadastro quando abrir o app. Se o MAC já tem outro parceiro, vira uma lista a mais.
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
