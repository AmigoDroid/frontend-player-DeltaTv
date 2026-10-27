import { useState } from "react";
import AddListForm from "./AddListForm.jsx";
import { Header, Footer, TvPreview } from "./Site.jsx";

// Rota /upload/playlist — destino do QR Code que o app mostra na TV (…/upload/playlist?mac=AA:BB:…).
// Mesmo formulário da home: link da lista (nome + URL) ou código de parceiro (código + usuário + senha).
export default function UploadPlaylist() {
  const [name, setName] = useState("");
  const initialMac = new URLSearchParams(window.location.search).get("mac") || "";
  return (
    <div className="dl-site">
      <Header />
      <main className="dl-upload">
        <div className="dl-wrap dl-upload__grid">
          <div className="dl-card">
            <h1 className="dl-card__title">Adicionar lista à TV</h1>
            <AddListForm initialMac={initialMac} onName={setName} />
          </div>
          <TvPreview name={name} />
        </div>
      </main>
      <Footer />
    </div>
  );
}
