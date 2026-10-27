import { useState } from "react";
import { addPlaylistByUrl, registerExternalDevice, normalizeMacInput } from "./licensing.js";

// Formulário de cadastro de lista, usado na home (/) e na rota /upload/playlist (QR da TV).
//  - "Link da lista": nome + URL completa (o servidor extrai servidor, usuário e senha; nada é baixado);
//  - "Código de parceiro": fluxo anterior (código + usuário + senha).
export const formatMac = (v) => {
  const hex = String(v).replace(/[^0-9a-fA-F]/g, "").toUpperCase().slice(0, 12);
  return hex.match(/.{1,2}/g)?.join(":") ?? "";
};

const looksLikeUrl = (v) => /^https?:\/\/[^\s/]+\.?[^\s]*$/i.test(v.trim());

export default function AddListForm({ initialMac = "", onName, onResult, compact = false }) {
  const [mode, setMode] = useState("url"); // "url" | "partner"
  const [mac, setMac] = useState(() => formatMac(initialMac));
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { tone: "ok" | "wait" | "error", title, text }

  const macOk = !!normalizeMacInput(mac);
  const urlReady = macOk && name.trim() && looksLikeUrl(url);
  const partnerReady = macOk && code.trim() && username.trim() && password;
  const ready = mode === "url" ? urlReady : partnerReady;

  const publish = (r) => {
    setResult(r);
    onResult?.(r);
  };

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setResult(null);
    onResult?.(null);
    try {
      if (mode === "url") {
        const r = await addPlaylistByUrl({ mac, name, url });
        publish(
          r.licensed
            ? {
                tone: "ok",
                title: r.created ? "Lista adicionada" : "Lista atualizada",
                text: `“${r.listName}” já está disponível no dispositivo ${r.mac}. Abra o DeltaTV na TV para assistir.`,
              }
            : {
                tone: "wait",
                title: "Lista salva, aguardando licença",
                text: `“${r.listName}” ficou guardada no dispositivo ${r.mac}, mas só abre depois que a licença do DeltaTV for ativada nele. Não precisa enviar a lista de novo.`,
              },
        );
        setUrl("");
      } else {
        const r = await registerExternalDevice({ mac, code, username, password });
        publish({
          tone: "ok",
          title: r.reused ? "Dados atualizados" : "Dispositivo cadastrado",
          text: `Dispositivo ${r.mac} pronto. Abra o DeltaTV na TV para começar a assistir.`,
        });
        setPassword("");
      }
    } catch (err) {
      publish({ tone: "error", title: "Não foi possível adicionar", text: err.message || "Tente novamente em instantes." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`dl-form${compact ? " dl-form--compact" : ""}`} onSubmit={submit} noValidate>
      <div className="dl-tabs" role="tablist" aria-label="Forma de adicionar a lista">
        {[
          ["url", "Link da lista"],
          ["partner", "Código de parceiro"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            className={mode === id ? "is-on" : ""}
            onClick={() => { setMode(id); setResult(null); onResult?.(null); }}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="dl-field">
        <span>MAC da TV</span>
        <input
          value={mac}
          onChange={(e) => setMac(formatMac(e.target.value))}
          placeholder="00:11:22:33:44:55"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={mac !== "" && !macOk}
        />
        <small>Aparece na tela inicial do DeltaTV, ou escaneie o QR Code da TV.</small>
      </label>

      {mode === "url" ? (
        <>
          <label className="dl-field">
            <span>Nome da lista</span>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); onName?.(e.target.value); }}
              placeholder="Ex.: Sala, Minha lista"
              maxLength={160}
              autoComplete="off"
            />
            <small>É o nome que aparece na TV.</small>
          </label>
          <label className="dl-field">
            <span>Link completo da lista</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://servidor:8080/get.php?username=…&password=…"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={url !== "" && !looksLikeUrl(url)}
            />
            <small>Cole o link M3U que o seu provedor enviou. Nós só lemos servidor, usuário e senha dele.</small>
          </label>
        </>
      ) : (
        <>
          <label className="dl-field">
            <span>Código</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Ex.: 4343" autoComplete="off" />
          </label>
          <div className="dl-row">
            <label className="dl-field">
              <span>Usuário</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </label>
            <label className="dl-field">
              <span>Senha</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
          </div>
        </>
      )}

      <button type="submit" className="dl-btn dl-btn--primary" disabled={!ready || busy}>
        {busy ? "Adicionando…" : mode === "url" ? "Adicionar lista" : "Cadastrar dispositivo"}
      </button>

      {result && (
        <div className={`dl-result dl-result--${result.tone}`} role="status" aria-live="polite">
          <strong>{result.title}</strong>
          <span>{result.text}</span>
        </div>
      )}
    </form>
  );
}
