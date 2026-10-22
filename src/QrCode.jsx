import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import "./App.css";
import { normalizeMacInput } from "./licensing.js";

// Rota /get_qrcode/{mac}: gera o QR que leva a /upload/playlist?mac={mac}, com o ícone do Delta TV no centro.
const SIZE = 640;

function drawLogo(ctx) {
  const box = SIZE * 0.22;
  const x = (SIZE - box) / 2;
  const y = (SIZE - box) / 2;
  const r = box * 0.22;
  // base branca (o QR usa correção de erro H, que tolera esse recorte central)
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.roundRect(x - 8, y - 8, box + 16, box + 16, r + 6);
  ctx.fill();
  // fundo azul-escuro do ícone
  const g = ctx.createLinearGradient(x, y, x + box, y + box);
  g.addColorStop(0, "#151b4a");
  g.addColorStop(1, "#0c1030");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x, y, box, box, r);
  ctx.fill();
  // triângulo "play" vazado (mesmo desenho da logo)
  const k = box / 42;
  ctx.strokeStyle = "#6d6bff";
  ctx.lineWidth = 5 * k * 0.8;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x + 11 * k, y + 9 * k);
  ctx.lineTo(x + 34 * k, y + 21 * k);
  ctx.lineTo(x + 11 * k, y + 33 * k);
  ctx.closePath();
  ctx.stroke();
}

export default function QrCodePage({ rawMac }) {
  const canvasRef = useRef(null);
  const [img, setImg] = useState("");
  const [error, setError] = useState("");
  const hex = normalizeMacInput(rawMac);
  const mac = hex ? hex.match(/.{2}/g).join(":") : "";
  const link = mac ? `${window.location.origin}/upload/playlist?mac=${encodeURIComponent(mac)}` : "";

  useEffect(() => {
    if (!link) {
      setError("MAC inválido. Use 12 caracteres hexadecimais, ex.: /get_qrcode/D6:41:F4:FF:0A:98");
      return;
    }
    const canvas = canvasRef.current;
    QRCode.toCanvas(canvas, link, {
      errorCorrectionLevel: "H",
      width: SIZE,
      margin: 2,
      color: { dark: "#0c1030", light: "#ffffff" },
    })
      .then(() => {
        drawLogo(canvas.getContext("2d"));
        setImg(canvas.toDataURL("image/png"));
      })
      .catch(() => setError("Não foi possível gerar o QR Code."));
  }, [link]);

  return (
    <div className="upload-page">
      <div className="panel upload-card qr-card">
        <div className="brand upload-brand">
          <svg width="38" height="38" viewBox="0 0 42 42" aria-hidden="true">
            <path d="M6 5l30 16L6 37z" fill="none" stroke="#6d6bff" strokeWidth="5" strokeLinejoin="round" />
          </svg>
          <span>DELTA <b>TV</b></span>
        </div>
        <h1>Cadastrar dispositivo</h1>
        {error ? (
          <div className="device-status blocked">{error}</div>
        ) : (
          <>
            <p className="device-note">Escaneie com o celular para cadastrar o MAC <strong>{mac}</strong>.</p>
            <canvas ref={canvasRef} style={{ display: "none" }} />
            {img && <img className="qr-img" src={img} alt={`QR Code para cadastrar ${mac}`} />}
            <a className="watch qr-dl" href={img} download={`qrcode-${hex}.png`}>Baixar imagem</a>
            <small className="hint" style={{ wordBreak: "break-all" }}>{link}</small>
          </>
        )}
        {error && <canvas ref={canvasRef} style={{ display: "none" }} />}
      </div>
    </div>
  );
}
