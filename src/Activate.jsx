import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Header, Footer } from "./Site.jsx";
import { formatMac } from "./AddListForm.jsx";
import { createLicensePix, getLicenseOffer, getLicensePix, normalizeMacInput } from "./licensing.js";

// Rota /ativar — o cliente informa o MAC da TV e o e-mail, paga a licença anual via Pix e o dispositivo é ativado sozinho.
// O valor e o produto vêm do servidor; aqui só mostramos o QR, conferimos o pagamento (polling) e damos o próximo passo.
const KEY = "dl-pix-charge";
const money = (cents) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
const FINAL = new Set(["paid", "expired", "cancelled", "failed", "refunded", "review"]);

function useCountdown(expiresAt) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  return `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
}

function QrImage({ charge }) {
  const [src, setSrc] = useState(charge.qrCodeBase64 ? `data:image/png;base64,${charge.qrCodeBase64}` : "");
  useEffect(() => {
    if (charge.qrCodeBase64 || !charge.qrCode) return;
    QRCode.toDataURL(charge.qrCode, { width: 320, margin: 1 }).then(setSrc).catch(() => setSrc(""));
  }, [charge.qrCode, charge.qrCodeBase64]);
  return src ? <img className="dl-pix__qr" src={src} alt="QR Code do Pix" width="240" height="240" /> : <div className="dl-pix__qr dl-pix__qr--empty" />;
}

function PixPay({ charge }) {
  const left = useCountdown(charge.expiresAt);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(charge.qrCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* sem permissão da área de transferência: o campo abaixo permite copiar à mão */ }
  };
  return (
    <div className="dl-pix">
      <QrImage charge={charge} />
      <div className="dl-pix__info">
        <p className="dl-pix__amount">{money(charge.amountCents)}</p>
        <p className="dl-muted">Licença anual do DeltaTV para a TV <b className="dl-mono">{charge.mac}</b></p>
        <p className="dl-pix__timer" role="timer" aria-live="off">Expira em <b>{left}</b></p>
        <ol className="dl-pix__how">
          <li>Abra o app do seu banco e escolha <b>Pix → Ler QR Code</b> (ou “Pix copia e cola”).</li>
          <li>Confirme o valor e pague.</li>
          <li>Esta página detecta o pagamento sozinha e ativa a TV.</li>
        </ol>
        <label className="dl-field">
          <span>Pix copia e cola</span>
          <input readOnly value={charge.qrCode || ""} onFocus={(e) => e.target.select()} spellCheck={false} />
        </label>
        <button type="button" className="dl-btn dl-btn--primary" onClick={copy}>{copied ? "Código copiado!" : "Copiar código Pix"}</button>
      </div>
    </div>
  );
}

export default function Activate() {
  const [offer, setOffer] = useState(null); // { enabled, months, priceCents }
  const [offerError, setOfferError] = useState("");
  const [mac, setMac] = useState(() => formatMac(new URLSearchParams(window.location.search).get("mac") || ""));
  const [email, setEmail] = useState("");
  const [accepted, setAccepted] = useState(false); // ciência de que o DeltaTV é só um player
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [charge, setCharge] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    getLicenseOffer().then(setOffer).catch((e) => setOfferError(e.message || "Não foi possível carregar o valor da licença."));
    // Retoma o Pix aberto antes de recarregar a página.
    const saved = sessionStorage.getItem(KEY);
    if (saved) {
      getLicensePix(saved)
        .then((c) => { if (c.status === "pending" || c.status === "paid" || c.status === "review") setCharge(c); else sessionStorage.removeItem(KEY); })
        .catch(() => sessionStorage.removeItem(KEY));
    }
  }, []);

  // Confere o pagamento a cada 5 s enquanto o Pix está pendente.
  useEffect(() => {
    clearInterval(timer.current);
    if (!charge || FINAL.has(charge.status)) return undefined;
    timer.current = setInterval(async () => {
      try {
        const c = await getLicensePix(charge.id);
        setCharge((old) => (old && old.id === c.id ? { ...c, qrCode: c.qrCode ?? old.qrCode, qrCodeBase64: c.qrCodeBase64 ?? old.qrCodeBase64 } : old));
        if (FINAL.has(c.status) && c.status !== "paid" && c.status !== "review") sessionStorage.removeItem(KEY);
      } catch { /* falha de rede momentânea: tenta de novo no próximo ciclo */ }
    }, 5000);
    return () => clearInterval(timer.current);
  }, [charge?.id, charge?.status]);

  const macOk = !!normalizeMacInput(mac);
  const ready = macOk && looksLikeEmail(email) && accepted && offer?.enabled;
  const price = useMemo(() => (offer?.priceCents ? money(offer.priceCents) : ""), [offer]);

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const c = await createLicensePix({ mac, email });
      sessionStorage.setItem(KEY, c.id);
      setCharge(c);
    } catch (err) {
      setError(err.message || "Não foi possível gerar o Pix. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  function again() {
    sessionStorage.removeItem(KEY);
    setAccepted(false);
    setCharge(null);
    setError("");
  }

  const body = () => {
    if (charge?.status === "paid") {
      return (
        <div className="dl-result dl-result--ok" role="status">
          <strong>Pagamento confirmado — TV ativada!</strong>
          <span>A licença anual do DeltaTV já está ativa na TV {charge.mac}. Abra o DeltaTV nela para continuar.</span>
          <a className="dl-btn dl-btn--primary dl-btn--sm dl-pix__next" href={`/upload/playlist?mac=${encodeURIComponent(charge.mac)}`}>Adicionar minha lista</a>
        </div>
      );
    }
    if (charge?.status === "review") {
      return (
        <div className="dl-result dl-result--wait" role="status">
          <strong>Pagamento recebido, ativação em conferência</strong>
          <span>Recebemos o seu Pix, mas a ativação precisa de uma conferência da nossa equipe. Guarde este código para o suporte: {charge.id.slice(0, 8)}.</span>
        </div>
      );
    }
    if (charge && charge.status !== "pending") {
      return (
        <div className="dl-form">
          <div className="dl-result dl-result--error" role="status">
            <strong>{charge.status === "expired" ? "O Pix expirou" : "Este Pix não está mais disponível"}</strong>
            <span>Nenhum valor foi cobrado. Gere um novo Pix para continuar.</span>
          </div>
          <button type="button" className="dl-btn dl-btn--primary" onClick={again}>Gerar novo Pix</button>
        </div>
      );
    }
    if (charge) {
      return (
        <>
          <PixPay charge={charge} />
          <button type="button" className="dl-linkbtn" onClick={again}>Cancelar e voltar</button>
        </>
      );
    }
    return (
      <form className="dl-form" onSubmit={submit} noValidate>
        <label className="dl-field">
          <span>MAC da TV</span>
          <input
            value={mac} onChange={(e) => setMac(formatMac(e.target.value))} placeholder="00:11:22:33:44:55"
            autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-invalid={mac !== "" && !macOk}
          />
          <small>Aparece na tela inicial do DeltaTV. Abra o app na TV antes de pagar.</small>
        </label>
        <label className="dl-field">
          <span>Seu e-mail</span>
          <input
            type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@exemplo.com"
            autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} aria-invalid={email !== "" && !looksLikeEmail(email)}
          />
          <small>Usado só para o recibo do pagamento e para o suporte.</small>
        </label>
        <label className="dl-consent">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>
            <strong>Estou ciente de que o DeltaTV é apenas um player (aplicativo reprodutor).</strong>{" "}
            Ele <b>não fornece, não vende e não inclui nenhum conteúdo</b> (canais, filmes ou séries). A licença anual libera apenas o uso do aplicativo,
            e eu preciso ter a minha própria lista, de uma fonte legítima.
          </span>
        </label>
        <button type="submit" className="dl-btn dl-btn--primary" disabled={!ready || busy}>
          {busy ? "Gerando Pix…" : price ? `Pagar ${price} com Pix` : "Pagar com Pix"}
        </button>
        {error && (
          <div className="dl-result dl-result--error" role="alert">
            <strong>Não foi possível gerar o Pix</strong>
            <span>{error}</span>
          </div>
        )}
      </form>
    );
  };

  return (
    <div className="dl-site">
      <Header />
      <main className="dl-upload">
        <div className="dl-wrap dl-upload__grid">
          <div className="dl-card">
            <h1 className="dl-card__title">Ativar o DeltaTV na sua TV</h1>
            {offerError && <div className="dl-result dl-result--error" role="alert"><strong>Indisponível</strong><span>{offerError}</span></div>}
            {offer && !offer.enabled && (
              <div className="dl-result dl-result--wait" role="status">
                <strong>Compra online indisponível no momento</strong>
                <span>Tente novamente mais tarde ou fale com o seu fornecedor.</span>
              </div>
            )}
            {(!offer || offer.enabled) && !offerError && body()}
          </div>

          <aside className="dl-pitch">
            <h2 className="dl-h2">Licença anual</h2>
            <p className="dl-price">{price || "—"}<small> / 12 meses</small></p>
            <ul className="dl-checks">
              <li>Pagamento por Pix, confirmado em segundos.</li>
              <li>A TV é ativada automaticamente, sem código para digitar.</li>
              <li>Se você já enviou a lista pelo site, ela passa a funcionar na hora.</li>
              <li>Vale para 1 aparelho. Você pode renovar quando vencer.</li>
            </ul>
            <p className="dl-muted"><b>O DeltaTV é apenas um player e não fornece nenhum conteúdo.</b> Você usa a sua própria lista.</p>
          </aside>
        </div>
      </main>
      <Footer />
    </div>
  );
}
