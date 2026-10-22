import { useState } from "react";
import "./App.css";
import { registerExternalDevice, normalizeMacInput } from "./licensing.js";

// Rota /upload/playlist — cadastro de dispositivo externo (MAC + código + usuário + senha).
const formatMac = (v) => {
  const hex = String(v).replace(/[^0-9a-fA-F]/g, "").toUpperCase().slice(0, 12);
  return hex.match(/.{1,2}/g)?.join(":") ?? "";
};

export default function UploadPlaylist() {
  const [mac, setMac] = useState(() => formatMac(new URLSearchParams(window.location.search).get("mac") || ""));
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, message }

  const ready = normalizeMacInput(mac) && code.trim() && username.trim() && password;

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await registerExternalDevice({ mac, code, username, password });
      setResult({
        ok: true,
        message: `${r.reused ? "Dispositivo já cadastrado — dados atualizados" : "Dispositivo cadastrado"}: ${r.mac}. Abra o app na TV para começar a assistir.`,
      });
      setPassword("");
    } catch (err) {
      setResult({ ok: false, message: err.message || "Não foi possível cadastrar o dispositivo." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="upload-page">
      <form className="panel upload-card" onSubmit={submit}>
        <div className="brand upload-brand">
          <svg width="38" height="38" viewBox="0 0 42 42" aria-hidden="true">
            <path d="M6 5l30 16L6 37z" fill="none" stroke="#6d6bff" strokeWidth="5" strokeLinejoin="round" />
          </svg>
          <span>DELTA <b>TV</b></span>
        </div>
        <h1>Cadastrar dispositivo</h1>
        <p className="device-note">Informe o MAC exibido na TV, o código de parceria e o usuário e senha da lista.</p>

        <label>
          MAC do dispositivo
          <input
            value={mac}
            onChange={(e) => setMac(formatMac(e.target.value))}
            placeholder="00:11:22:33:44:55"
            autoComplete="off"
            inputMode="text"
          />
        </label>
        <label>
          Código
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Ex.: 4343" autoComplete="off" />
        </label>
        <label>
          Usuário
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <label>
          Senha
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>

        <button type="submit" className="watch" disabled={!ready || busy}>
          {busy ? "Cadastrando..." : "Cadastrar dispositivo"}
        </button>

        {result && (
          <div className={`device-status ${result.ok ? "active" : "blocked"}`} role="status" aria-live="polite">
            {result.message}
          </div>
        )}
      </form>
    </div>
  );
}
