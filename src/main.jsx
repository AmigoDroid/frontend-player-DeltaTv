import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Home from './Home.jsx';
import UploadPlaylist from './UploadPlaylist.jsx';
import Activate from './Activate.jsx';
import QrCodePage from './QrCode.jsx';
import './App.css';
import './site.css';

// /player = Player Web separado (login pelo código do revendedor). O player antigo (MAC simulado + código de parceria) só
// existe em desenvolvimento/laboratório: VITE_PLAYER_LEGACY=true o liga em /player/legado. Em produção fica desligado,
// senão qualquer pessoa com código de parceria + usuário/senha contornaria o licenciamento do Player Web.
const PlayerWeb = lazy(() => import('./PlayerWeb.jsx'));
const LegacyPlayer = lazy(() => import('./App.jsx'));
const LEGACY = import.meta.env.VITE_PLAYER_LEGACY === 'true';

// Roteamento mínimo por caminho (sem dependências extras). Servidor estático com fallback para index.html (serve -s).
const path = window.location.pathname.replace(/\/+$/, '') || '/';
let page = <Home />;
if (path === '/player') {
  page = (
    <Suspense fallback={<div className="dl-boot" role="status">Carregando o player…</div>}>
      <PlayerWeb />
    </Suspense>
  );
} else if (LEGACY && path === '/player/legado') {
  page = (
    <Suspense fallback={<div className="dl-boot" role="status">Carregando o player…</div>}>
      <LegacyPlayer />
    </Suspense>
  );
} else if (path === '/upload/playlist') page = <UploadPlaylist />;
else if (path === '/ativar') page = <Activate />;
else if (path.startsWith('/get_qrcode/')) {
  let mac = path.slice('/get_qrcode/'.length);
  try { mac = decodeURIComponent(mac); } catch { /* mantém o valor cru */ }
  page = <QrCodePage rawMac={mac} />;
}
createRoot(document.getElementById('root')).render(page);
