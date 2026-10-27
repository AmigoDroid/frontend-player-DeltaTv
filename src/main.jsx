import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Home from './Home.jsx';
import UploadPlaylist from './UploadPlaylist.jsx';
import QrCodePage from './QrCode.jsx';
import './App.css';
import './site.css';

// O player (hls.js + mpegts.js) é pesado: só é baixado em /player.
const Player = lazy(() => import('./App.jsx'));

// Roteamento mínimo por caminho (sem dependências extras). Servidor estático com fallback para index.html (serve -s).
const path = window.location.pathname.replace(/\/+$/, '') || '/';
let page = <Home />;
if (path === '/player') {
  page = (
    <Suspense fallback={<div className="dl-boot" role="status">Carregando o player…</div>}>
      <Player />
    </Suspense>
  );
} else if (path === '/upload/playlist') page = <UploadPlaylist />;
else if (path.startsWith('/get_qrcode/')) {
  let mac = path.slice('/get_qrcode/'.length);
  try { mac = decodeURIComponent(mac); } catch { /* mantém o valor cru */ }
  page = <QrCodePage rawMac={mac} />;
}
createRoot(document.getElementById('root')).render(page);
