// Cliente da API de licenciamento (/api/v1/client).
// Segurança: o servidor revalida o acesso a CADA requisição; o que é guardado aqui são apenas
// tokens de curta duração + refresh token. A URL real da origem nunca chega ao navegador.
const API_URL = import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:3000`;
const BASE = `${API_URL}/api/v1/client`;
const KEY_INSTALL = "iptv-player-installation-id";
const KEY_SESSION = "iptv-player-session";

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
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || "Não foi possível concluir a operação."), {
      code: data.code,
      status: res.status,
    });
  }
  return data;
}

const readSession = () => {
  try { return JSON.parse(localStorage.getItem(KEY_SESSION)); } catch { return null; }
};
const saveSession = (mac, tokens) =>
  localStorage.setItem(
    KEY_SESSION,
    JSON.stringify({ mac, ...tokens, accessExp: Date.now() + tokens.expiresIn * 1000 }),
  );

export const getSession = (mac) => {
  const s = readSession();
  return s && s.mac === mac ? s : null;
};
export const clearSession = () => { localStorage.removeItem(KEY_SESSION); xtreamCache = null; };

// Código de licença individual é longo (LIC-XXXXX-…); código de parceria é curto (4–12 letras/números).
export const isLicenseCode = (code) => code.replace(/[^A-Za-z0-9]/g, "").length > 12;

export async function activate(code, mac, { username = "", password = "" } = {}) {
  const license = isLicenseCode(code);
  const body = license
    ? { code: code.trim(), mac, installationId: getInstallationId() }
    : { code: code.trim(), username, password, mac, installationId: getInstallationId() };
  const data = await call(`/activate/${license ? "license" : "partner"}`, { method: "POST", body });
  saveSession(mac, data.tokens);
  return data;
}

// Migração: dispositivos do sistema antigo reivindicam a ativação existente (primeiro acesso).
export async function claimLegacy(mac) {
  const data = await call("/claim", { method: "POST", body: { mac, installationId: getInstallationId() } });
  saveSession(mac, data.tokens);
  return data;
}

async function accessToken(mac) {
  const s = getSession(mac);
  if (!s) throw Object.assign(new Error("Dispositivo não ativado."), { code: "NO_SESSION", status: 401 });
  if (Date.now() < s.accessExp - 30_000) return s.accessToken;
  try {
    const data = await call("/session/refresh", {
      method: "POST",
      body: { refreshToken: s.refreshToken, installationId: getInstallationId() },
    });
    saveSession(mac, data.tokens);
    return data.tokens.accessToken;
  } catch (e) {
    if (e.status === 401) clearSession(); // sessão revogada/expirada: exige nova ativação
    throw e;
  }
}

/* ---------------------------------------------------------------------------
 * Xtream: o backend só entrega a conexão (GET /xtream); catálogo e reprodução vão direto ao painel.
 * A configuração fica em cache por no máximo 60 s e é renovada com a sessão do dispositivo.
 * ------------------------------------------------------------------------- */
const XTREAM_TTL_MS = 60_000;
let xtreamCache = null; // { mac, at, cfg }

export const clearXtreamCache = () => { xtreamCache = null; };

async function getXtreamConfig(mac, force = false) {
  if (!force && xtreamCache && xtreamCache.mac === mac && Date.now() - xtreamCache.at < XTREAM_TTL_MS) {
    return xtreamCache.cfg;
  }
  const token = await accessToken(mac);
  const cfg = await call("/xtream", { token });
  xtreamCache = { mac, at: Date.now(), cfg };
  return cfg;
}

const trimSlash = (u) => String(u).replace(/\/+$/, "");

async function xtreamApi(cfg, action, params = {}) {
  const qs = new URLSearchParams({ username: cfg.username, password: cfg.password, action, ...params });
  let res;
  try {
    res = await fetch(`${trimSlash(cfg.baseUrl)}/player_api.php?${qs}`);
  } catch {
    throw Object.assign(
      new Error("Não foi possível acessar o provedor (bloqueio de CORS ou conteúdo misto http/https)."),
      { code: "PROVIDER_UNREACHABLE", status: 502 },
    );
  }
  if (!res.ok) {
    throw Object.assign(new Error("O provedor recusou a consulta."), { code: "PROVIDER_ERROR", status: 502 });
  }
  const data = await res.json().catch(() => null);
  return Array.isArray(data) ? data : data || [];
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const categoryMap = (list) => new Map(asArray(list).map((c) => [String(c.category_id), c.category_name]));

export async function loadCatalog(mac) {
  const cfg = await getXtreamConfig(mac, true); // abertura/atualização: sempre confere a autorização no servidor
  const base = trimSlash(cfg.baseUrl);
  const auth = `${encodeURIComponent(cfg.username)}/${encodeURIComponent(cfg.password)}`;

  const results = await Promise.allSettled([
    xtreamApi(cfg, "get_live_categories"),
    xtreamApi(cfg, "get_live_streams"),
    xtreamApi(cfg, "get_vod_categories"),
    xtreamApi(cfg, "get_vod_streams"),
    xtreamApi(cfg, "get_series_categories"),
    xtreamApi(cfg, "get_series"),
  ]);
  if (results.every((r) => r.status === "rejected")) throw results[0].reason;
  const [liveCats, live, vodCats, vod, serCats, series] = results.map((r) => (r.status === "fulfilled" ? r.value : []));

  const liveGroups = categoryMap(liveCats);
  const vodGroups = categoryMap(vodCats);
  const serGroups = categoryMap(serCats);
  const items = [];

  for (const c of asArray(live)) {
    items.push({
      type: "canais",
      title: c.name,
      group: liveGroups.get(String(c.category_id)) || "Sem categoria",
      srcImage: c.stream_icon || "",
      srcVideo: `${base}/live/${auth}/${c.stream_id}.ts`,
    });
  }
  for (const m of asArray(vod)) {
    items.push({
      type: "filmes",
      title: m.title || m.name,
      group: vodGroups.get(String(m.category_id)) || "Sem categoria",
      srcImage: m.stream_icon || "",
      srcVideo: `${base}/movie/${auth}/${m.stream_id}.${m.container_extension || "mp4"}`,
    });
  }
  // Séries: só a lista; temporadas/episódios chegam sob demanda (loadSeriesEpisodes).
  for (const s of asArray(series)) {
    items.push({
      type: "series",
      seriesId: s.series_id,
      title: s.title || s.name,
      group: serGroups.get(String(s.category_id)) || "Sem categoria",
      srcImage: s.cover || "",
      srcVideo: `series:${s.series_id}`,
    });
  }
  return { items, account: cfg.account, expiresAt: cfg.expiresAt };
}

export async function loadSeriesEpisodes(mac, seriesId) {
  const cfg = await getXtreamConfig(mac);
  const base = trimSlash(cfg.baseUrl);
  const auth = `${encodeURIComponent(cfg.username)}/${encodeURIComponent(cfg.password)}`;
  const info = await xtreamApi(cfg, "get_series_info", { series_id: seriesId });
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
}

// Reprodução direta no provedor (URL Xtream); o servidor só autoriza a sessão e o status é verificado periodicamente.
export async function getPlayUrl(mac, srcVideo) {
  if (/^https?:\/\//i.test(srcVideo)) {
    await accessToken(mac); // garante sessão válida (renova/limpa se revogada)
    return srcVideo;
  }
  throw Object.assign(new Error("Fonte de vídeo inválida."), { code: "INVALID_SOURCE", status: 400 });
}

// Verificação periódica de status (bloqueio/expiração/revogação).
export async function checkStatus(mac) {
  const token = await accessToken(mac);
  return call("/status", { token });
}

// Cadastra um dispositivo EXTERNO (ex.: Roku) por MAC + código de parceria + usuário/senha do provedor.
// Não guarda sessão neste navegador. O installationId segue o padrão do Roku ("roku-" + MAC sem separadores, maiúsculo),
// então a TV reconhece o cadastro quando abrir o app.
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
