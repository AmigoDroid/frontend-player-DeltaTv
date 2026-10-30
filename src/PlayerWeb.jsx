import { lazy, Suspense, useState } from "react";
import { Header, Footer } from "./Site.jsx";
import * as licensing from "./licensing.js";

// O player (hls.js + mpegts.js) é pesado: só é baixado depois do login.
const Player = lazy(() => import("./App.jsx"));

// Rota /player — Player Web SEPARADO, licenciado como os apps de TV. O cliente entra com o código de 2 letras + 6 números
// (ex.: AB123456) que o revendedor gerou no painel dele. Não há MAC para digitar nem código de parceria/usuário/senha:
// a lista, a licença e o modo de entrega (ao vivo via proxy, filmes e séries via redirect, ajustável no painel) já vêm do servidor.
const formatTyping = (raw) => {
  const c = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const letters = c.replace(/[^A-Z]/g, "").slice(0, 2);
  // Depois das 2 letras só entram números.
  const digits = c.slice(letters.length).replace(/[^0-9]/g, "").slice(0, 6);
  return letters + digits;
};

function CodeLogin({ onLogged }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ok = licensing.WEB_CODE_RE.test(code);

  const submit = async (e) => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError("");
    try {
      onLogged(await licensing.webLogin(code));
    } catch (err) {
      setError(err.message || "Não foi possível entrar.");
      setBusy(false);
    }
  };

  return (
    <div className="dl-site">
      <Header />
      <main className="dl-upload">
        <div className="dl-wrap dl-upload__grid">
          <div className="dl-card">
            <h1 className="dl-card__title">Player Web</h1>
            <p className="dl-muted">Digite o código de acesso que o seu fornecedor te passou.</p>
            <form className="dl-form" onSubmit={submit} noValidate>
              <label className="dl-field">
                <span>Código de acesso</span>
                <input
                  value={code}
                  onChange={(e) => setCode(formatTyping(e.target.value))}
                  placeholder="AB123456"
                  maxLength={8}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  inputMode="text"
                  aria-invalid={code !== "" && !ok}
                  className="dl-mono"
                />
                <small>2 letras e 6 números. O código é do seu fornecedor, não é o MAC da TV.</small>
              </label>
              <button type="submit" className="dl-btn dl-btn--primary" disabled={!ok || busy}>
                {busy ? "Entrando…" : "Entrar"}
              </button>
              {error && (
                <div className="dl-result dl-result--error" role="alert">
                  <strong>Não foi possível entrar</strong>
                  <span>{error}</span>
                </div>
              )}
            </form>
          </div>
          <aside className="dl-pitch">
            <h2 className="dl-h2">Sem TV? Sem problema.</h2>
            <ul className="dl-checks">
              <li>Assista no computador, tablet ou celular, direto no navegador.</li>
              <li>Cada código vale para uma lista e tem prazo, como o aplicativo de TV.</li>
              <li>Não achou o código? Peça ao seu fornecedor.</li>
            </ul>
            <p className="dl-muted"><b>O DeltaTV é apenas um player e não fornece nenhum conteúdo.</b></p>
          </aside>
        </div>
      </main>
      <Footer />
    </div>
  );
}

export default function PlayerWeb() {
  const [access, setAccess] = useState(() => licensing.getWebAccess());
  const logout = () => {
    licensing.webLogout();
    setAccess(null);
  };
  if (!access) return <CodeLogin onLogged={setAccess} />;
  return (
    <Suspense fallback={<div className="dl-boot" role="status">Carregando o player…</div>}>
      <Player webAccess={access} onWebLogout={logout} />
    </Suspense>
  );
}
