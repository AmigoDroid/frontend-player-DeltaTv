import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import mpegts from "mpegts.js";
import Hls from "hls.js";

import "./App.css";

import * as licensing from "./licensing.js";

const INITIAL_ITEMS_PER_CATEGORY = 30;
const ITEMS_PER_CATEGORY_STEP = 30;
const DEVICE_MAC_STORAGE_KEY = "iptv-player-device-mac";
const DEVICE_MAC_MODE_STORAGE_KEY = "iptv-player-device-mac-mode";
const listStorageKey = (mac) => `iptv-player-list:${mac}`;

function createSimulatedMac() {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[0] = (bytes[0] & 0xfe) | 0x02;

  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
}

function getStoredDeviceMac() {
  const storedMac = localStorage.getItem(DEVICE_MAC_STORAGE_KEY);
  if (storedMac) return storedMac;

  const simulatedMac = createSimulatedMac();
  localStorage.setItem(DEVICE_MAC_STORAGE_KEY, simulatedMac);
  localStorage.setItem(DEVICE_MAC_MODE_STORAGE_KEY, "simulated");
  return simulatedMac;
}

/* =========================================================
   PLAYER MPEG-TS
========================================================= */

/*
 * Remove query string e hash da URL
 * para conseguir identificar a extensão.
 */
function getExtension(url) {
  if (!url) return "";

  let pathname = url;

  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    pathname = url.split("?")[0].split("#")[0];
  }

  const lastDot = pathname.lastIndexOf(".");

  if (lastDot === -1) {
    return "";
  }

  return pathname.substring(lastDot).toLowerCase();
}

/*
 * Descobre qual player deve ser utilizado.
 */
function detectPlayerType(src, type) {
  const extension = getExtension(src);

  /*
   * Formatos que o <video> consegue reproduzir
   * diretamente.
   */
  if (
    extension === ".mp4" ||
    extension === ".m4v" ||
    extension === ".webm" ||
    extension === ".mov"
  ) {
    return "native";
  }

  /*
   * HLS.
   */
  if (extension === ".m3u8") {
    return "hls";
  }

  /*
   * Arquivo MPEG-TS.
   */
  if (extension === ".ts") {
    return "mpegts";
  }

  /*
   * Se a playlist informou que é canal,
   * tratamos como MPEG-TS.

   * Isso é importante porque muitos servidores IPTV
   * usam URLs sem extensão:
   *
   * http://servidor/live/user/pass/12345
   */
  if (type === "canais") {
    return "mpegts";
  }

  /*
   * Filmes e séries normalmente são arquivos de vídeo.
   */
  if (type === "filmes" || type === "series") {
    return "native";
  }

  /*
   * Fallback.
   *
   * URLs IPTV sem extensão normalmente são MPEG-TS.
   */
  return "mpegts";
}

function getSeriesEpisode(item) {
  const title = item.tvgName || item.title;
  const marker =
    title.match(/\bS(\d{1,3})\s*E(\d{1,4})\b/i) ||
    title.match(/\b(\d{1,3})x(\d{1,4})\b/i);

  if (!marker) {
    return {
      ...item,
      seriesTitle: item.seriesTitle || item.title,
      season: item.season || 1,
      episodeTitle: item.episodeTitle || item.title,
    };
  }

  const prefix = title.slice(0, marker.index).trim();
  const seasonLabel = prefix.match(/\bS\d{1,3}\b/i);
  const seriesTitle = (
    seasonLabel ? prefix.slice(0, seasonLabel.index) : prefix
  )
    .replace(/[\s\-_.:]+$/g, "")
    .trim();

  const episodeTitle = title
    .slice(marker.index + marker[0].length)
    .replace(/^[\s\-_.:]+|[\s\-_.:]+$/g, "")
    .trim();

  return {
    ...item,
    seriesTitle:
      seriesTitle || item.seriesTitle || title.replace(marker[0], "").trim(),
    season: item.season || Number(marker[1]),
    episode: item.episode || Number(marker[2]),
    episodeTitle: item.episodeTitle || episodeTitle || `Episódio ${marker[2]}`,
  };
}

function groupSeries(items) {
  const seriesByTitle = new Map();

  for (const rawItem of items) {
    const item = getSeriesEpisode(rawItem);
    const title = item.seriesTitle || item.title;
    const key = title.trim().toLocaleLowerCase("pt-BR");

    if (!seriesByTitle.has(key)) {
      seriesByTitle.set(key, {
        title,
        srcImage: item.srcImage,
        group: item.group,
        type: "series-group",
        episodes: [],
      });
    }

    seriesByTitle.get(key).episodes.push(item);
  }

  return [...seriesByTitle.values()].map((series) => {
    const episodes = [...series.episodes].sort(
      (a, b) =>
        (a.season || 1) - (b.season || 1) ||
        (a.episode || 0) - (b.episode || 0) ||
        a.title.localeCompare(b.title, "pt-BR", { numeric: true }),
    );

    return { ...series, episodes };
  });
}

function VideoPlayer({
  src,
  title = "Player",
  type = "canais",
  deviceMac,
  onError,
}) {
  const videoRef = useRef(null);
  const mpegtsPlayerRef = useRef(null);

  const errorCallbackRef = useRef(onError);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /*
   * Canal ao vivo: tenta HLS (.m3u8) primeiro, como o app Roku.
   * Se o HLS falhar (ex.: painel responde 403 para o formato), repete
   * automaticamente a mesma URL em MPEG-TS (.ts). Guarda para qual src
   * o fallback já foi acionado, então trocar de canal volta ao HLS.
   */
  const [tsFallbackFor, setTsFallbackFor] = useState("");
  const effectiveSrc =
    type === "canais" && src && tsFallbackFor === src
      ? src.replace(/\.m3u8(\?|#|$)/i, ".ts$1")
      : src;

  /*
   * Mantém a referência do callback atualizada
   * sem precisar recriar o player toda vez.
   */
  useEffect(() => {
    errorCallbackRef.current = onError;
  }, [onError]);

  /*
   * URL que será efetivamente utilizada pelo navegador.
   *
   * IMPORTANTE:
   *
   * Não usamos diretamente o servidor IPTV.
   *
   * Tudo passa pelo nosso backend:
   *
   * IPTV
   *   ↓
   * Node
   *   ↓
   * React
   */
  const proxyUrl = useMemo(() => {
    if (!effectiveSrc) return "";

    // `src` já é a URL autorizada do gateway de licenciamento (token curto incluído).
    return effectiveSrc;
  }, [effectiveSrc]);

  /*
   * Descobre o tipo do player.
   */
  const playerType = useMemo(() => {
    return detectPlayerType(effectiveSrc, type);
  }, [effectiveSrc, type]);

  /*
   * Função central de erro.
   */
  const handleError = useCallback((message) => {
    const finalMessage =
      message || "Não foi possível reproduzir este conteúdo.";

    console.error("PLAYER ERROR:", finalMessage);

    setError(finalMessage);
    setLoading(false);

    errorCallbackRef.current?.(finalMessage);
  }, []);

  /*
   * Erro do HLS em canal ao vivo: tenta MPEG-TS uma vez antes de desistir.
   */
  const handleHlsFailure = useCallback(
    (message) => {
      if (type === "canais" && src && tsFallbackFor !== src) {
        console.warn("HLS falhou; tentando MPEG-TS (.ts):", message);
        setError("");
        setTsFallbackFor(src);
        return;
      }
      handleError(message);
    },
    [type, src, tsFallbackFor, handleError],
  );

  /*
   * Quando o conteúdo muda:
   *
   * 1. destrói player anterior
   * 2. limpa vídeo
   * 3. cria o player correto
   */
  useEffect(() => {
    let cancelled = false;

    const video = videoRef.current;

    /*
     * Destrói instância anterior do mpegts.js.
     */
    if (mpegtsPlayerRef.current) {
      try {
        mpegtsPlayerRef.current.pause();
        mpegtsPlayerRef.current.unload();
        mpegtsPlayerRef.current.detachMediaElement();
        mpegtsPlayerRef.current.destroy();
      } catch (err) {
        console.warn("Erro ao destruir player MPEG-TS:", err);
      }

      mpegtsPlayerRef.current = null;
    }

    /*
     * Limpa o elemento <video>.
     */
    if (video) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (err) {
        console.warn("Erro ao limpar elemento de vídeo:", err);
      }
    }

    setLoading(true);
    setError("");
    errorCallbackRef.current?.("");

    if (!src || !proxyUrl || !video) {
      setLoading(false);
      return;
    }

    /*
     * ==================================================
     * PLAYER NATIVO
     * ==================================================
     *
     * MP4
     * M4V
     * WEBM
     * MOV
     */
    if (playerType === "native") {
      console.log("PLAYER: NATIVE");
      console.log("SOURCE:", proxyUrl);

      video.src = proxyUrl;

      video.preload = "metadata";

      const handleLoadedMetadata = () => {
        if (cancelled) return;

        console.log("VIDEO METADATA CARREGADA");

        setLoading(false);
      };

      const handleCanPlay = () => {
        if (cancelled) return;

        setLoading(false);

        /*
         * Tenta iniciar automaticamente.
         *
         * Se o navegador bloquear autoplay,
         * os controles continuam disponíveis.
         */
        video.play().catch(() => {
          console.log("Autoplay bloqueado pelo navegador.");
        });
      };

      const handleVideoError = () => {
        if (cancelled) return;

        console.error("ERRO NO VIDEO:", video.error);

        handleError("Não foi possível reproduzir este vídeo.");
      };

      video.addEventListener("loadedmetadata", handleLoadedMetadata);

      video.addEventListener("canplay", handleCanPlay);

      video.addEventListener("error", handleVideoError);

      video.load();

      return () => {
        cancelled = true;

        video.removeEventListener("loadedmetadata", handleLoadedMetadata);

        video.removeEventListener("canplay", handleCanPlay);

        video.removeEventListener("error", handleVideoError);

        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch {
          // Ignora erro de limpeza.
        }
      };
    }

    /*
     * ==================================================
     * HLS
     * ==================================================
     *
     * Ainda não adicionamos hls.js.
     *
     * Safari pode reproduzir HLS nativamente,
     * enquanto Chrome/Edge normalmente precisam
     * de hls.js.
     */
    if (playerType === "hls") {
      console.log("PLAYER: HLS");
      console.log("SOURCE:", proxyUrl);

      /*
       * Chrome/Edge/Firefox (MSE): hls.js.
       */
      if (Hls.isSupported()) {
        // Poucas conexões simultâneas: painéis IPTV costumam limitar por usuário e respondem 403 ao exceder.
        const hls = new Hls({
          lowLatencyMode: false,
          startFragPrefetch: false,
          maxBufferLength: 20,
          maxMaxBufferLength: 30,
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 2,
          fragLoadingMaxRetry: 3,
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled) return;

          setLoading(false);

          video.play().catch(() => {
            console.log("Autoplay HLS bloqueado pelo navegador.");
          });
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled || !data?.fatal) return;

          console.error("HLS ERROR:", data.type, data.details, data.response);

          handleHlsFailure(
            `Não foi possível reproduzir o HLS (${data.details || "erro"}).`,
          );
        });

        hls.loadSource(proxyUrl);
        hls.attachMedia(video);

        return () => {
          cancelled = true;

          try {
            hls.destroy();
          } catch {
            // Ignora.
          }
        };
      }

      /*
       * Safari/iOS: HLS nativo.
       */
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = proxyUrl;

        const handleLoadedMetadata = () => {
          if (cancelled) return;

          setLoading(false);

          video.play().catch(() => {
            console.log("Autoplay HLS bloqueado pelo navegador.");
          });
        };

        const handleVideoError = () => {
          if (cancelled) return;

          handleHlsFailure("Não foi possível reproduzir o HLS.");
        };

        video.addEventListener("loadedmetadata", handleLoadedMetadata);

        video.addEventListener("error", handleVideoError);

        video.load();

        return () => {
          cancelled = true;

          video.removeEventListener("loadedmetadata", handleLoadedMetadata);

          video.removeEventListener("error", handleVideoError);

          try {
            video.pause();
            video.removeAttribute("src");
            video.load();
          } catch {
            // Ignora erro de limpeza.
          }
        };
      }

      handleError("Este navegador não suporta reprodução HLS.");

      return () => {
        cancelled = true;
      };
    }

    /*
     * ==================================================
     * MPEG-TS
     * ==================================================
     */
    if (playerType === "mpegts") {
      console.log("PLAYER: MPEG-TS");
      console.log("SOURCE:", proxyUrl);

      if (!mpegts.isSupported()) {
        handleError("Seu navegador não suporta reprodução MPEG-TS.");

        return () => {
          cancelled = true;
        };
      }

      try {
        const player = mpegts.createPlayer(
          {
            type: "mpegts",

            isLive: type === "canais",

            url: proxyUrl,

            hasAudio: true,

            hasVideo: true,
          },
          {
            /*
             * Mantém o buffer controlado.
             */
            enableStashBuffer: true,

            /*
             * Evita ficar tentando perseguir
             * o atraso do live automaticamente.
             */
            liveBufferLatencyChasing: false,

            /*
             * Buffer inicial menor.
             */
            stashInitialSize: 384,

            /*
             * Mantém o MSE simples.
             */
            lazyLoad: false,

            autoCleanupSourceBuffer: true,

            autoCleanupMaxBackwardDuration: 30,

            autoCleanupMinBackwardDuration: 15,
          },
        );

        mpegtsPlayerRef.current = player;

        const handleMediaInfo = () => {
          if (cancelled) return;

          console.log("MPEG-TS MEDIA INFO RECEIVED");
        };

        const handleMpegtsError = (errorType, errorDetail, errorInfo) => {
          if (cancelled) return;

          console.error("MPEG-TS ERROR:", {
            errorType,
            errorDetail,
            errorInfo,
          });

          handleError(
            `Erro no stream MPEG-TS: ${errorDetail || "erro desconhecido"}`,
          );
        };

        player.on(mpegts.Events.MEDIA_INFO, handleMediaInfo);

        player.on(mpegts.Events.ERROR, handleMpegtsError);

        player.attachMediaElement(video);

        player.load();

        /*
         * Pequeno atraso para garantir que o MSE
         * esteja pronto antes do play.
         */
        const playTimer = setTimeout(() => {
          if (cancelled) return;

          player
            .play()
            .then(() => {
              if (!cancelled) {
                setLoading(false);
              }
            })
            .catch((err) => {
              console.warn("Autoplay MPEG-TS bloqueado:", err);

              /*
               * O stream pode estar carregado mesmo
               * que o autoplay tenha sido bloqueado.
               */
              if (!cancelled) {
                setLoading(false);
              }
            });
        }, 100);

        return () => {
          cancelled = true;

          clearTimeout(playTimer);

          try {
            player.pause();
          } catch {
            // Ignora.
          }

          try {
            player.unload();
          } catch {
            // Ignora.
          }

          try {
            player.detachMediaElement();
          } catch {
            // Ignora.
          }

          try {
            player.destroy();
          } catch {
            // Ignora.
          }

          if (mpegtsPlayerRef.current === player) {
            mpegtsPlayerRef.current = null;
          }
        };
      } catch (err) {
        console.error("ERRO AO CRIAR MPEG-TS PLAYER:", err);

        handleError("Não foi possível iniciar o player MPEG-TS.");

        return () => {
          cancelled = true;
        };
      }
    }

    return () => {
      cancelled = true;
    };
  }, [src, type, proxyUrl, playerType, handleError, handleHlsFailure]);

  /*
   * ==================================================
   * RENDER
   * ==================================================
   */
  return (
    <div
      className="video-player"
      style={{
        position: "relative",
        width: "100%",
        background: "#000",
        overflow: "hidden",
      }}
    >
      <video
        ref={videoRef}
        controls
        playsInline
        autoPlay
        muted={false}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          minHeight: "300px",
          background: "#000",
          objectFit: "contain",
        }}
      />

      {loading && !error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0, 0, 0, 0.45)",
            color: "#fff",
            fontSize: "14px",
            pointerEvents: "none",
          }}
        >
          Carregando {title}...
        </div>
      )}

      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            padding: "20px",
            background: "rgba(0, 0, 0, 0.85)",
            color: "#fff",
            textAlign: "center",
          }}
        >
          <strong>Não foi possível reproduzir</strong>

          <span
            style={{
              maxWidth: "500px",
              opacity: 0.8,
              fontSize: "14px",
            }}
          >
            {error}
          </span>
        </div>
      )}
    </div>
  );
}
/* =========================================================
   CARD
========================================================= */

const favKey = (item) =>
  item.seriesId ? `s:${item.seriesId}` : item.srcVideo || `g:${item.title}`;

const toCard = (item) =>
  item.seriesId ? { ...item, type: "series-group", episodes: [] } : item;

function Icon({ name }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  switch (name) {
    case "home":
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <path d="M12 3 2 12h3v8h5v-5h4v5h5v-8h3z" />
        </svg>
      );
    case "tv":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      );
    case "film":
      return (
        <svg {...common}>
          <rect x="3" y="8" width="18" height="12" rx="2" />
          <path d="M3 8l2-4h4l-2 4M10 8l2-4h4l-2 4M17 8l2-4" />
        </svg>
      );
    case "series":
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="13" rx="2" />
          <path d="M8 3l4 4 4-4" />
        </svg>
      );
    case "heart":
      return (
        <svg {...common}>
          <path d="M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z" />
        </svg>
      );
    case "heart-fill":
      return (
        <svg {...common} fill="currentColor">
          <path d="M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z" />
        </svg>
      );
    case "gear":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.400 15a1.700 1.700 0 0 0 .3 1.800l.1.1a2 2 0 1 1-2.800 2.800l-.1-.1a1.700 1.700 0 0 0-1.800-.3 1.700 1.700 0 0 0-1 1.500V21a2 2 0 1 1-4 0v-.1a1.700 1.700 0 0 0-1.100-1.500 1.700 1.700 0 0 0-1.800.3l-.1.1a2 2 0 1 1-2.800-2.800l.1-.1a1.700 1.700 0 0 0 .3-1.800 1.700 1.700 0 0 0-1.500-1H3a2 2 0 1 1 0-4h.1a1.700 1.700 0 0 0 1.500-1.100 1.700 1.700 0 0 0-.3-1.800l-.1-.1a2 2 0 1 1 2.800-2.800l.1.1a1.700 1.700 0 0 0 1.800.3H9a1.700 1.700 0 0 0 1-1.500V3a2 2 0 1 1 4 0v.1a1.700 1.700 0 0 0 1 1.500 1.700 1.700 0 0 0 1.800-.3l.1-.1a2 2 0 1 1 2.800 2.800l-.1.1a1.700 1.700 0 0 0-.3 1.800V9a1.700 1.700 0 0 0 1.500 1H21a2 2 0 1 1 0 4h-.1a1.700 1.700 0 0 0-1.500 1z" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common} width={18} height={18} strokeWidth={2.4}>
          <path d="M9 5l7 7-7 7" />
        </svg>
      );
    case "wifi":
      return (
        <svg {...common} width={24} height={24}>
          <path d="M2 9a15 15 0 0 1 20 0M5 12.500a10.500 10.500 0 0 1 14 0M8.500 16a5.500 5.500 0 0 1 7 0" />
          <circle cx="12" cy="19.500" r="1" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}

const MediaCard = memo(function MediaCard({ item, onSelect, isFav, onFav }) {
  return (
    <article
      className={`card ${item.type}`}
      tabIndex={0}
      onClick={() => onSelect(item)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect(item);
      }}
    >
      <div className="poster">
        {item.srcImage ? (
          <img
            src={item.srcImage}
            alt=""
            loading="lazy"
            decoding="async"
            width="160"
            height="240"
          />
        ) : (
          <div className="no-image">Sem imagem</div>
        )}

        <div className="play">▶</div>

        {onFav && (
          <button
            type="button"
            className={`fav ${isFav ? "on" : ""}`}
            aria-label={
              isFav ? "Remover dos favoritos" : "Adicionar aos favoritos"
            }
            onClick={(e) => {
              e.stopPropagation();
              onFav(item);
            }}
          >
            <Icon name={isFav ? "heart-fill" : "heart"} />
          </button>
        )}
      </div>

      <h3 title={item.title}>{item.title}</h3>
    </article>
  );
});

/* =========================================================
   CATEGORY
========================================================= */

function Category({
  name,
  items,
  visibleCount,
  onShowMore,
  onSelect,
  favs,
  onFav,
}) {
  const visibleItems = items.slice(0, visibleCount);

  const hasMore = visibleCount < items.length;

  return (
    <section className="category">
      <div className="category-header">
        <h2>{name}</h2>

        <span>{items.length.toLocaleString("pt-BR")} itens</span>
      </div>

      <div className="grid">
        {visibleItems.map((item, index) => (
          <MediaCard
            key={`${item.srcVideo}-${index}`}
            item={item}
            onSelect={onSelect}
            isFav={favs.has(favKey(item))}
            onFav={onFav}
          />
        ))}
      </div>

      {hasMore && (
        <button className="show-more" onClick={() => onShowMore(name)}>
          Ver mais ({items.length - visibleCount})
        </button>
      )}
    </section>
  );
}

const HERO_SLIDES = [
  {
    section: "canais",
    kicker: "AO VIVO",
    title: "TV ao vivo",
    text: "Seus canais favoritos, a qualquer hora.",
  },
  {
    section: "filmes",
    kicker: "CINEMA",
    title: "Filmes",
    text: "Do clássico ao lançamento, tudo no seu catálogo.",
  },
  {
    section: "series",
    kicker: "MARATONA",
    title: "Séries",
    text: "Temporadas completas para assistir sem pressa.",
  },
  {
    section: "favoritos",
    kicker: "SEU ESPAÇO",
    title: "Favoritos",
    text: "Tudo o que você mais gosta, a um clique.",
  },
];

const NAV = [
  { id: "inicio", label: "Início", icon: "home" },
  { id: "canais", label: "TV ao vivo", icon: "tv" },
  { id: "filmes", label: "Filmes", icon: "film" },
  { id: "series", label: "Séries", icon: "series" },
  { id: "favoritos", label: "Favoritos", icon: "heart" },
  { id: "config", label: "Configurações", icon: "gear" },
];

/* =========================================================
   APP
========================================================= */

export default function App() {
  const [deviceMac, setDeviceMac] = useState(getStoredDeviceMac);
  const [macInput, setMacInput] = useState(deviceMac);
  const [macMode, setMacMode] = useState(
    () => localStorage.getItem(DEVICE_MAC_MODE_STORAGE_KEY) || "simulated",
  );
  const [deviceStatus, setDeviceStatus] = useState({
    state: "checking",
    message: "Verificando o dispositivo...",
  });
  const [activationCode, setActivationCode] = useState("");
  const [providerUser, setProviderUser] = useState("");
  const [providerPass, setProviderPass] = useState("");
  const [items, setItems] = useState([]);
  // Um MAC pode ter várias listas (uma por parceiro): `lists` vem de /client/lists.
  const [lists, setLists] = useState([]);
  const [currentListId, setCurrentListId] = useState(null);

  const [loading, setLoading] = useState(true);

  const [selectedItem, setSelectedItem] = useState(null);

  const [selectedSeries, setSelectedSeries] = useState(null);

  const [selectedSeason, setSelectedSeason] = useState(null);

  const [playerError, setPlayerError] = useState("");

  /*
   * Começa em canais
   */

  const [section, setSection] = useState("inicio");

  const [favs, setFavs] = useState(() => {
    try {
      return new Set(
        JSON.parse(localStorage.getItem("iptv-player-favs")) || [],
      );
    } catch {
      return new Set();
    }
  });
  const [playerExpanded, setPlayerExpanded] = useState(false);
  const [artEl, setArtEl] = useState(null);
  const [slot, setSlot] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [previewItem, setPreviewItem] = useState(null);
  const [heroIdx, setHeroIdx] = useState(0);
  const [clock, setClock] = useState(() => new Date());
  const [online, setOnline] = useState(() => navigator.onLine);

  const [search, setSearch] = useState("");

  const [visibleCounts, setVisibleCounts] = useState({});

  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  /* =========================================================
     CARREGAR PLAYLIST
  ========================================================= */

  async function carregarDispositivo(
    mac = deviceMac,
    saveMac = false,
    wantedListId = null,
  ) {
    const requestedMac = mac.trim();
    if (!requestedMac) {
      setDeviceStatus({
        state: "blocked",
        message: "Informe o MAC do dispositivo.",
      });
      return;
    }

    if (saveMac) {
      localStorage.setItem(DEVICE_MAC_STORAGE_KEY, requestedMac);
      localStorage.setItem(DEVICE_MAC_MODE_STORAGE_KEY, "provided");
      setDeviceMac(requestedMac);
      setMacInput(requestedMac);
      setMacMode("provided");
    }

    try {
      setLoading(true);
      setPlayerError("");
      setItems([]);
      setSelectedItem(null);
      setSelectedSeries(null);
      setSelectedSeason(null);
      setVisibleCounts({});
      setDeviceStatus({
        state: "checking",
        message: "Verificando o dispositivo...",
      });

      if (!licensing.getSession(requestedMac)) {
        try {
          await licensing.claimLegacy(requestedMac); // dispositivos migrados do sistema antigo
        } catch (e) {
          if (e.code === "NOTHING_TO_CLAIM" || e.status === 404) {
            setDeviceStatus({
              state: "needs_activation",
              message: "Dispositivo não ativado. Informe o código de ativação.",
            });
            return;
          }
          throw e;
        }
      }

      // Um MAC pode ter VÁRIAS listas (parceiros). Descobre quais existem e escolhe qual abrir:
      // a pedida pelo usuário > a última usada > a atual > a primeira liberada e configurada.
      let info = null;
      try {
        info = await licensing.listsOf(requestedMac);
      } catch (e) {
        if (e.status === 401) throw e;
        // Sem /lists (ou falha passageira): segue com a lista da sessão atual.
      }
      if (info) {
        setLists(info.lists);
        const usable = (l) => l.allowed && l.configured;
        const byId = (id) => info.lists.find((l) => l.activationId === id);
        let target = byId(wantedListId);
        if (!target) {
          target = byId(localStorage.getItem(listStorageKey(requestedMac)));
          if (!target || !usable(target)) target = byId(info.currentActivationId);
          if (!target || !usable(target))
            target = info.lists.find(usable) || target;
        }
        if (!target) {
          setCurrentListId(null);
          setDeviceStatus({
            state: "needs_activation",
            message: "Nenhuma lista neste dispositivo. Informe o código de ativação.",
          });
          return;
        }
        if (target.activationId !== licensing.currentListId(requestedMac)) {
          await licensing.useList(requestedMac, target.activationId);
        }
        setCurrentListId(target.activationId);
        localStorage.setItem(listStorageKey(requestedMac), target.activationId);
        if (!target.allowed) {
          setDeviceStatus({
            state: "blocked",
            message: target.message || "Esta lista não está liberada.",
          });
          return;
        }
        if (!target.configured) {
          setDeviceStatus({
            state: "needs_activation",
            message:
              target.code === "PROVIDER_UNAVAILABLE"
                ? target.message
                : "Esta lista ainda não foi configurada. Informe o código de ativação.",
          });
          return;
        }
      }

      const data = await licensing.loadCatalog(requestedMac);

      const loadedItems = Array.isArray(data.items) ? data.items : [];
      setItems(loadedItems);
      setDeviceStatus({
        state: "active",
        message: `Dispositivo ativado${loadedItems.length ? ` · ${loadedItems.length.toLocaleString("pt-BR")} itens disponíveis` : " · nenhum conteúdo disponível"}.`,
      });
    } catch (e) {
      console.error("Erro ao consultar dispositivo:", e);
      if (e.status === 401 || e.status === 403 || e.status === 409) {
        setDeviceStatus({
          state: e.status === 401 ? "needs_activation" : "blocked",
          message: e.message || "O dispositivo não foi autorizado.",
        });
        return;
      }
      setDeviceStatus({
        state: "error",
        // Erros conhecidos do servidor/provedor trazem uma mensagem clara (ex.: "Serviço indisponível...").
        message:
          e.code && e.message
            ? e.message
            : "Não foi possível consultar o servidor. Verifique a conexão e tente novamente.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function ativarDispositivo(event) {
    event.preventDefault();
    const requestedMac = macInput.trim();
    try {
      setLoading(true);
      const activated = await licensing.activate(activationCode, requestedMac, {
        username: providerUser,
        password: providerPass,
      });
      setActivationCode("");
      setProviderPass("");
      // Abre a lista recém-ativada (o MAC pode ter outras listas de outros parceiros).
      await carregarDispositivo(requestedMac, true, activated.activationId);
    } catch (e) {
      setDeviceStatus({
        state: "blocked",
        message: e.message || "Não foi possível ativar.",
      });
      setLoading(false);
    }
  }

  useEffect(() => {
    carregarDispositivo(deviceMac);
  }, []);

  // Como o stream é direto no provedor, o servidor é consultado a cada 60 s: bloqueio/expiração/revogação encerram o acesso.
  useEffect(() => {
    if (deviceStatus.state !== "active") return undefined;
    const timer = setInterval(async () => {
      try {
        const s = await licensing.checkStatus(deviceMac);
        if (!s.allowed)
          throw Object.assign(
            new Error(s.message || "Dispositivo sem acesso."),
            { status: 403 },
          );
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          setSelectedItem(null);
          setItems([]);
          licensing.clearXtreamCache();
          setDeviceStatus({
            state: e.status === 401 ? "needs_activation" : "blocked",
            message: e.message || "O dispositivo não está mais autorizado.",
          });
        }
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [deviceStatus.state, deviceMac]);

  /* =========================================================
     SELECIONAR ITEM
========================================================= */

  async function selectItem(item) {
    if (item.type === "series-group" && item.seriesId) {
      setPlayerError("");
      setSelectedItem(null);
      setSelectedSeries({ ...item, episodes: [], loadingEpisodes: true });
      try {
        const episodes = await licensing.loadSeriesEpisodes(
          deviceMac,
          item.seriesId,
        );
        setSelectedSeries({ ...item, episodes, loadingEpisodes: false });
        setSelectedSeason(
          episodes.length
            ? Math.min(...episodes.map((e) => e.season || 1))
            : null,
        );
      } catch (e) {
        setSelectedSeries(null);
        setPlayerError(e.message || "Não foi possível carregar os episódios.");
        if (e.status === 401 || e.status === 403)
          carregarDispositivo(deviceMac);
      }
      return;
    }

    if (item.type === "series-group") {
      setSelectedSeries(item);
      setSelectedSeason(
        [...new Set(item.episodes.map((episode) => episode.season || 1))].sort(
          (a, b) => a - b,
        )[0],
      );
      setSelectedItem(null);
      setPlayerError("");
      return;
    }

    setPlayerError("");

    try {
      const playUrl = await licensing.getPlayUrl(deviceMac, item.srcVideo);
      setSelectedItem({ ...item, playUrl });
    } catch (e) {
      setPlayerError(e.message || "Não foi possível autorizar a reprodução.");
      if (e.status === 401 || e.status === 403) carregarDispositivo(deviceMac);
    }
  }

  /* =========================================================
     FECHAR PLAYER
========================================================= */

  function closePlayer() {
    setSelectedItem(null);
    setPlayerExpanded(false);

    setPlayerError("");
  }

  /* =========================================================
     CATEGORIAS
========================================================= */

  const categories = useMemo(() => {
    const groups = new Map();

    for (const item of items) {
      if (item.type !== section) {
        continue;
      }

      const groupName = item.group?.trim() || "Sem categoria";

      if (!groups.has(groupName)) {
        groups.set(groupName, []);
      }

      groups.get(groupName).push(item);
    }

    /*
     * Sem pesquisa
     */

    if (section === "series") {
      const seriesGroups = new Map();

      for (const [group, groupItems] of groups) {
        // Séries Xtream já vêm agrupadas (episódios carregados ao abrir); M3U legado ainda é agrupado por título.
        seriesGroups.set(
          group,
          groupItems.some((i) => i.seriesId)
            ? groupItems.map((i) => ({
                ...i,
                type: "series-group",
                episodes: [],
              }))
            : groupSeries(groupItems),
        );
      }

      if (!deferredSearch) return seriesGroups;

      const filteredSeries = new Map();

      for (const [group, series] of seriesGroups) {
        const matches = series.filter(
          (item) =>
            item.title.toLowerCase().includes(deferredSearch) ||
            item.episodes.some((episode) =>
              episode.title.toLowerCase().includes(deferredSearch),
            ),
        );

        if (matches.length) filteredSeries.set(group, matches);
      }

      return filteredSeries;
    }

    if (!deferredSearch) {
      return groups;
    }

    /*
     * Com pesquisa
     */

    const filtered = new Map();

    for (const [group, groupItems] of groups) {
      const matches = groupItems.filter((item) =>
        String(item.title || "")
          .toLowerCase()
          .includes(deferredSearch),
      );

      if (matches.length) {
        filtered.set(group, matches);
      }
    }

    return filtered;
  }, [items, section, deferredSearch]);

  /* =========================================================
     TROCAR SEÇÃO
========================================================= */

  // Posição do painel de prévia: o player "encaixa" nele sem ser recriado ao expandir/diminuir.
  useEffect(() => {
    if (!artEl) {
      setSlot(null);
      return undefined;
    }
    const measure = () => {
      const r = artEl.getBoundingClientRect();
      setSlot({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(artEl);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [artEl]);

  useEffect(() => {
    if (!playerExpanded) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setPlayerExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playerExpanded]);

  function toggleFav(item) {
    const key = favKey(item);
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem("iptv-player-favs", JSON.stringify([...next]));
      } catch {
        /* sem storage */
      }
      return next;
    });
  }

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 15_000);
    const h = setInterval(
      () => setHeroIdx((i) => (i + 1) % HERO_SLIDES.length),
      6000,
    );
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      clearInterval(t);
      clearInterval(h);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const featured = useMemo(() => {
    const withImg = (type) =>
      items.filter((i) => i.type === type && i.srcImage);
    const mix = [];
    const movies = withImg("filmes");
    const series = withImg("series");
    for (
      let k = 0;
      mix.length < 14 && (k < movies.length || k < series.length);
      k++
    ) {
      if (movies[k]) mix.push(movies[k]);
      if (series[k] && mix.length < 14) mix.push(series[k]);
    }
    return mix.map(toCard);
  }, [items]);

  const favItems = useMemo(
    () => items.filter((i) => favs.has(favKey(i))).map(toCard),
    [items, favs],
  );

  const counts = useMemo(() => {
    const c = { canais: 0, filmes: 0, series: 0 };
    for (const i of items) if (c[i.type] !== undefined) c[i.type]++;
    return c;
  }, [items]);

  function changeSection(nextSection) {
    setSection(nextSection);
    setSelectedCat(null);
    setPreviewItem(null);

    setSelectedSeries(null);

    setSelectedSeason(null);

    setSearch("");

    setVisibleCounts({});
  }

  /* =========================================================
     VER MAIS
========================================================= */

  function showMore(category) {
    setVisibleCounts((prev) => ({
      ...prev,

      [category]:
        (prev[category] || INITIAL_ITEMS_PER_CATEGORY) +
        ITEMS_PER_CATEGORY_STEP,
    }));
  }

  const seriesSeasons = selectedSeries
    ? [
        ...new Set(
          selectedSeries.episodes.map((episode) => episode.season || 1),
        ),
      ].sort((a, b) => a - b)
    : [];

  /* =========================================================
     RENDER
========================================================= */

  const catEntries = useMemo(() => {
    if (!["canais", "filmes", "series"].includes(section)) return [];
    const type = section === "series" ? "series-group" : section;
    const q = deferredSearch;
    const favList = favItems.filter(
      (i) =>
        i.type === type &&
        (!q ||
          String(i.title || "")
            .toLowerCase()
            .includes(q)),
    );
    return [["Favoritos", favList], ...categories.entries()];
  }, [section, categories, favItems, deferredSearch]);

  const activeCat = useMemo(() => {
    if (catEntries.some(([n]) => n === selectedCat)) return selectedCat;
    return (catEntries.find(([n, l]) => n !== "Favoritos" && l.length) ||
      catEntries[0] ||
      [])[0];
  }, [catEntries, selectedCat]);

  const activeList = useMemo(
    () => (catEntries.find(([n]) => n === activeCat) || [, []])[1],
    [catEntries, activeCat],
  );

  const shownPreview =
    activeList.find(
      (i) => favKey(i) === (previewItem && favKey(previewItem)),
    ) ||
    activeList[0] ||
    null;

  const isActive = deviceStatus.state === "active" && items.length > 0;
  const view = isActive ? section : "config";
  const slide = HERO_SLIDES[heroIdx];
  const time = clock.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const showSearch =
    isActive &&
    ["canais", "filmes", "series"].includes(section) &&
    !selectedSeries;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <svg width="42" height="42" viewBox="0 0 42 42" aria-hidden="true">
            <defs>
              <linearGradient id="dg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#6d6bff" />
                <stop offset="1" stopColor="#3b3fd8" />
              </linearGradient>
            </defs>
            <path
              d="M6 5l30 16L6 37z"
              fill="none"
              stroke="url(#dg)"
              strokeWidth="5"
              strokeLinejoin="round"
            />
          </svg>
          <span>
            DELTA <b>TV</b>
          </span>
        </div>

        <nav className="nav" aria-label="Menu principal">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? "active" : ""}
              disabled={!isActive && n.id !== "config"}
              onClick={() => changeSection(n.id)}
            >
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <small>MAC VIRTUAL</small>
          <strong>{deviceMac.toUpperCase()}</strong>
          <em>Delta TV v1.1 • Não vendemos conteúdo</em>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          {showSearch ? (
            <div className="search">
              <input
                type="search"
                placeholder={
                  section === "canais"
                    ? "Pesquisar canais..."
                    : section === "filmes"
                      ? "Pesquisar filmes..."
                      : "Pesquisar séries..."
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          ) : (
            <span />
          )}
          <div className="clock">
            <span className={online ? "" : "offline"}>
              <Icon name="wifi" />
            </span>
            <time>{time}</time>
          </div>
        </div>

        {/* ================= PLAYER ================= */}
        {selectedItem &&
          (() => {
            const docked = !playerExpanded && section === "canais" && !!slot;
            return (
              <section
                className={`player ${playerExpanded ? "expanded" : docked ? "docked" : "pip"}`}
                style={
                  docked
                    ? {
                        top: slot.top,
                        left: slot.left,
                        width: slot.width,
                        height: slot.height,
                      }
                    : undefined
                }
              >
                <div className="player-video">
                  <VideoPlayer
                    src={selectedItem.playUrl}
                    title={selectedItem.title}
                    type={selectedItem.type}
                    deviceMac={deviceMac}
                    onError={(message) => {
                      setPlayerError(message);
                    }}
                  />

                  {playerError && (
                    <div className="player-error">
                      <strong>Não foi possível reproduzir</strong>
                      <p>{playerError}</p>
                    </div>
                  )}

                  <div className="player-bar">
                    <span className="player-bar-title">
                      {selectedItem.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPlayerExpanded((v) => !v)}
                      title={playerExpanded ? "Diminuir (Esc)" : "Expandir"}
                      aria-label={playerExpanded ? "Diminuir" : "Expandir"}
                    >
                      {playerExpanded ? "⤡ Diminuir" : "⤢ Expandir"}
                    </button>
                    <button
                      type="button"
                      onClick={closePlayer}
                      title="Fechar"
                      aria-label="Fechar"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {playerExpanded && (
                  <div className="player-info">
                    {selectedItem.srcImage && (
                      <img
                        src={selectedItem.srcImage}
                        alt=""
                        width="55"
                        height="75"
                      />
                    )}
                    <div className="player-details">
                      <h2>{selectedItem.title}</h2>
                      <p>{selectedItem.group}</p>
                    </div>
                  </div>
                )}
              </section>
            );
          })()}

        {playerError && !selectedItem && (
          <div className="toast-error">{playerError}</div>
        )}

        {/* ================= INÍCIO ================= */}
        {view === "inicio" && (
          <main className="content home">
            <button
              className={`hero hero-${heroIdx}`}
              onClick={() => changeSection(slide.section)}
            >
              <span className="hero-kicker">{slide.kicker}</span>
              <span className="hero-title">{slide.title}</span>
              <span className="hero-text">{slide.text}</span>
              <span className="hero-dots">
                {HERO_SLIDES.map((s, n) => (
                  <i key={s.section} className={n === heroIdx ? "on" : ""} />
                ))}
              </span>
            </button>

            <div className="tiles">
              {[
                {
                  id: "canais",
                  icon: "tv",
                  title: "TV ao vivo",
                  text: "Assista aos canais",
                },
                {
                  id: "filmes",
                  icon: "film",
                  title: "Filmes",
                  text: "Explore o catálogo",
                },
                {
                  id: "series",
                  icon: "series",
                  title: "Séries",
                  text: "Suas séries favoritas",
                },
              ].map((t) => (
                <button
                  key={t.id}
                  className={`tile tile-${t.id}`}
                  onClick={() => changeSection(t.id)}
                >
                  <Icon name={t.icon} />
                  <strong>{t.title}</strong>
                  <span>{t.text}</span>
                  <small>{counts[t.id].toLocaleString("pt-BR")} itens</small>
                  <i className="tile-arrow">
                    <Icon name="chevron" />
                  </i>
                </button>
              ))}
            </div>

            {featured.length > 0 && (
              <section className="featured">
                <div className="featured-head">
                  <h2>Em destaque</h2>
                  <button onClick={() => changeSection("filmes")}>
                    Ver mais <Icon name="chevron" />
                  </button>
                </div>
                <div className="row">
                  {featured.map((item, n) => (
                    <MediaCard
                      key={`${favKey(item)}-${n}`}
                      item={item}
                      onSelect={selectItem}
                      isFav={favs.has(favKey(item))}
                      onFav={toggleFav}
                    />
                  ))}
                </div>
              </section>
            )}
          </main>
        )}

        {/* ================= FAVORITOS ================= */}
        {view === "favoritos" && (
          <main className="content">
            <div className="page-title">
              <h1>Favoritos</h1>
            </div>
            {favItems.length ? (
              <div className="grid">
                {favItems.map((item, n) => (
                  <MediaCard
                    key={`${favKey(item)}-${n}`}
                    item={item}
                    onSelect={selectItem}
                    isFav
                    onFav={toggleFav}
                  />
                ))}
              </div>
            ) : (
              <div className="empty">
                Toque no coração de um canal, filme ou série para salvá-lo aqui.
              </div>
            )}
          </main>
        )}

        {/* ================= CONFIGURAÇÕES / ATIVAÇÃO ================= */}
        {view === "config" && (
          <main className="content config">
            <div className="page-title">
              <h1>{isActive ? "Configurações" : "Ativar dispositivo"}</h1>
            </div>

            <section className="panel">
              <h3>Dispositivo</h3>
              <form
                className="device-check"
                onSubmit={(event) => {
                  event.preventDefault();
                  carregarDispositivo(macInput, true);
                }}
              >
                <input
                  type="text"
                  aria-label="MAC do dispositivo"
                  placeholder="00:11:22:33:44:55"
                  autoComplete="off"
                  value={macInput}
                  onChange={(event) => setMacInput(event.target.value)}
                />
                <button type="submit" disabled={loading}>
                  {loading ? "Verificando..." : "Verificar dispositivo"}
                </button>
              </form>
              <p className="device-note">
                {macMode === "simulated"
                  ? "MAC simulado para desenvolvimento; o navegador não fornece o MAC físico."
                  : "MAC informado manualmente para validação."}
              </p>
              <div
                className={`device-status ${deviceStatus.state}`}
                role="status"
                aria-live="polite"
              >
                {deviceStatus.message}
              </div>
              {lists.length > 1 && (
                <div className="list-picker">
                  <label htmlFor="list-select">Lista</label>
                  <select
                    id="list-select"
                    value={currentListId || ""}
                    disabled={loading}
                    onChange={(event) =>
                      carregarDispositivo(deviceMac, false, event.target.value)
                    }
                  >
                    {lists.map((l, i) => (
                      <option key={l.activationId} value={l.activationId}>
                        {l.listName || `Lista ${i + 1}`}
                        {!l.allowed
                          ? " (bloqueada)"
                          : !l.configured
                            ? " (sem configuração)"
                            : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </section>

            {deviceStatus.state !== "active" &&
              deviceStatus.state !== "checking" && (
                <section className="panel">
                  <h3>Código de ativação</h3>
                  <form
                    className="device-check stack"
                    onSubmit={ativarDispositivo}
                  >
                    <input
                      type="text"
                      aria-label="Código"
                      placeholder="Código (ex.: 4343)"
                      autoComplete="off"
                      value={activationCode}
                      onChange={(event) =>
                        setActivationCode(event.target.value)
                      }
                    />
                    {!licensing.isLicenseCode(activationCode) && (
                      <>
                        <input
                          type="text"
                          aria-label="Usuário"
                          placeholder="Usuário"
                          autoComplete="username"
                          value={providerUser}
                          onChange={(event) =>
                            setProviderUser(event.target.value)
                          }
                        />
                        <input
                          type="password"
                          aria-label="Senha"
                          placeholder="Senha"
                          autoComplete="current-password"
                          value={providerPass}
                          onChange={(event) =>
                            setProviderPass(event.target.value)
                          }
                        />
                      </>
                    )}
                    <button
                      type="submit"
                      disabled={
                        loading ||
                        !activationCode.trim() ||
                        (!licensing.isLicenseCode(activationCode) &&
                          (!providerUser || !providerPass))
                      }
                    >
                      Entrar
                    </button>
                  </form>
                </section>
              )}

            {isActive && (
              <section className="panel">
                <h3>Conteúdo</h3>
                <p className="device-note">
                  {items.length.toLocaleString("pt-BR")} itens carregados ·{" "}
                  {counts.canais.toLocaleString("pt-BR")} canais ·{" "}
                  {counts.filmes.toLocaleString("pt-BR")} filmes ·{" "}
                  {counts.series.toLocaleString("pt-BR")} séries
                </p>
                <button
                  className="secondary"
                  onClick={() => carregarDispositivo(deviceMac)}
                  disabled={loading}
                >
                  Atualizar catálogo
                </button>
              </section>
            )}
          </main>
        )}

        {/* ================= CANAIS / FILMES / SÉRIES ================= */}
        {isActive &&
          ["canais", "filmes", "series"].includes(section) &&
          (selectedSeries ? (
            <main className="content">
              <button
                className="back-to-series"
                onClick={() => {
                  setSelectedSeries(null);
                  setSelectedSeason(null);
                  setSelectedItem(null);
                }}
              >
                ← Voltar para séries
              </button>

              <section className="series-detail">
                <div className="series-heading">
                  {selectedSeries.srcImage && (
                    <img src={selectedSeries.srcImage} alt="" />
                  )}
                  <div>
                    <h2>{selectedSeries.title}</h2>
                    <p>
                      {selectedSeries.loadingEpisodes
                        ? "Carregando episódios..."
                        : `${selectedSeries.episodes.length} episódios · ${seriesSeasons.length} temporadas`}
                    </p>
                  </div>
                </div>

                <div className="season-selector" aria-label="Temporadas">
                  {seriesSeasons.map((season) => (
                    <button
                      key={season}
                      className={selectedSeason === season ? "active" : ""}
                      onClick={() => setSelectedSeason(season)}
                    >
                      Temporada {season}
                    </button>
                  ))}
                </div>

                <div className="episode-list">
                  {selectedSeries.episodes
                    .filter(
                      (episode) => (episode.season || 1) === selectedSeason,
                    )
                    .map((episode, index) => (
                      <button
                        className="episode"
                        key={`${episode.srcVideo}-${index}`}
                        onClick={() => selectItem(episode)}
                      >
                        <span className="episode-number">
                          E
                          {String(episode.episode || index + 1).padStart(
                            2,
                            "0",
                          )}
                        </span>
                        <span className="episode-title">
                          {episode.episodeTitle || episode.title}
                        </span>
                        <span className="episode-play">▶ Assistir</span>
                      </button>
                    ))}
                </div>
              </section>
            </main>
          ) : (
            <main className="content browse">
              <div className="page-title">
                <h1>{NAV.find((n) => n.id === section).label}</h1>
                <p>
                  {activeList.length.toLocaleString("pt-BR")}{" "}
                  {section === "canais"
                    ? "canais"
                    : section === "filmes"
                      ? "filmes"
                      : "séries"}
                </p>
              </div>

              <div className={`browser ${section}`}>
                <ul className="folders" aria-label="Categorias">
                  {catEntries.map(([name, list]) => (
                    <li key={name}>
                      <button
                        className={`folder ${name === activeCat ? "active" : ""} ${name === "Favoritos" ? "fav-folder" : ""}`}
                        onClick={() => {
                          setSelectedCat(name);
                          setPreviewItem(null);
                          setVisibleCounts({});
                        }}
                        title={`${name} (${list.length})`}
                      >
                        <span className="folder-name">{name}</span>
                      </button>
                    </li>
                  ))}
                  {!catEntries.length && (
                    <li className="empty">Nada encontrado.</li>
                  )}
                </ul>

                {section === "canais" ? (
                  <>
                    <ul className="channels" aria-label="Canais">
                      {activeList.map((item, n) => (
                        <li key={`${favKey(item)}-${n}`}>
                          <button
                            className={`channel ${shownPreview && favKey(shownPreview) === favKey(item) ? "active" : ""}`}
                            onClick={() => {
                              setPreviewItem(item);
                              if (selectedItem) selectItem(item); // já assistindo: troca de canal direto
                            }}
                            onDoubleClick={() => selectItem(item)}
                          >
                            <span className="channel-logo">
                              {item.srcImage ? (
                                <img
                                  src={item.srcImage}
                                  alt=""
                                  loading="lazy"
                                />
                              ) : null}
                            </span>
                            <span className="channel-name">{item.title}</span>
                            {favs.has(favKey(item)) && (
                              <span className="channel-fav">♥</span>
                            )}
                          </button>
                        </li>
                      ))}
                      {!activeList.length && (
                        <li className="empty">Nenhum canal nesta pasta.</li>
                      )}
                    </ul>

                    <aside className="preview">
                      {shownPreview ? (
                        <>
                          <div className="preview-art" ref={setArtEl}>
                            {shownPreview.srcImage ? (
                              <img src={shownPreview.srcImage} alt="" />
                            ) : (
                              <div className="no-image">Sem imagem</div>
                            )}
                            <div className="preview-caption">
                              <strong>{shownPreview.title}</strong>
                              <span>{shownPreview.group}</span>
                            </div>
                          </div>
                          <div className="preview-actions">
                            <button
                              className="watch"
                              onClick={() => selectItem(shownPreview)}
                            >
                              ▶ Assistir ao vivo
                            </button>
                            <button
                              className={`fav-btn ${favs.has(favKey(shownPreview)) ? "on" : ""}`}
                              onClick={() => toggleFav(shownPreview)}
                              aria-label="Favoritar"
                            >
                              <Icon
                                name={
                                  favs.has(favKey(shownPreview))
                                    ? "heart-fill"
                                    : "heart"
                                }
                              />
                            </button>
                          </div>
                          <small className="hint">
                            Clique para ver • Assistir ou duplo clique: tocar
                            aqui • ⤢ expandir • ♥ favoritar
                          </small>
                        </>
                      ) : (
                        <div className="empty">Selecione um canal.</div>
                      )}
                    </aside>
                  </>
                ) : (
                  <div className="folder-content">
                    <div className="grid">
                      {activeList
                        .slice(
                          0,
                          visibleCounts[activeCat] ||
                            INITIAL_ITEMS_PER_CATEGORY,
                        )
                        .map((item, n) => (
                          <MediaCard
                            key={`${favKey(item)}-${n}`}
                            item={item}
                            onSelect={selectItem}
                            isFav={favs.has(favKey(item))}
                            onFav={toggleFav}
                          />
                        ))}
                    </div>
                    {activeList.length >
                      (visibleCounts[activeCat] ||
                        INITIAL_ITEMS_PER_CATEGORY) && (
                      <button
                        className="show-more"
                        onClick={() => showMore(activeCat)}
                      >
                        Ver mais (
                        {activeList.length -
                          (visibleCounts[activeCat] ||
                            INITIAL_ITEMS_PER_CATEGORY)}
                        )
                      </button>
                    )}
                    {!activeList.length && (
                      <div className="empty">Nenhum item nesta pasta.</div>
                    )}
                  </div>
                )}
              </div>
            </main>
          ))}
      </div>
    </div>
  );
}
