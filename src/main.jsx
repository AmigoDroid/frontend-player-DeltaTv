import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import UploadPlaylist from './UploadPlaylist.jsx';
import QrCodePage from './QrCode.jsx';
import './App.css';

// Roteamento mínimo por caminho (sem dependências extras).
const path = window.location.pathname.replace(/\/+$/, '');
let page = <App />;
if (path === '/upload/playlist') page = <UploadPlaylist />;
else if (path.startsWith('/get_qrcode/')) {
  let mac = path.slice('/get_qrcode/'.length);
  try { mac = decodeURIComponent(mac); } catch { /* mantém o valor cru */ }
  page = <QrCodePage rawMac={mac} />;
}
createRoot(document.getElementById('root')).render(page);
