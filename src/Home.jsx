import { useState } from "react";
import AddListForm from "./AddListForm.jsx";
import { Header, Footer, TvPreview } from "./Site.jsx";

// Home institucional do DeltaTV. O player web fica em /player (opção, não a página inicial).
const DEVICES = [
  ["Roku", "Roku TV e players"],
  ["Android TV", "Google TV, TV Box"],
  ["Samsung", "Smart TVs Tizen"],
  ["LG", "Smart TVs webOS"],
  ["Navegador", "Computador e celular"],
];

const STEPS = [
  ["Abra o DeltaTV na TV", "O MAC do aparelho aparece na tela inicial. Se preferir, escaneie o QR Code que a TV mostra: o MAC já vai preenchido."],
  ["Cole o link da lista", "Escolha um nome e cole o link M3U que o seu provedor enviou. Ele precisa trazer usuário e senha."],
  ["Volte para a TV", "A lista aparece com o nome que você escolheu. Se o aparelho tem licença, já pode assistir."],
];

export default function Home() {
  const [name, setName] = useState("");
  const initialMac = new URLSearchParams(window.location.search).get("mac") || "";

  return (
    <div className="dl-site">
      <Header home />

      <main>
        <section className="dl-hero">
          <div className="dl-wrap dl-hero__grid">
            <div className="dl-hero__copy">
              <h1>Cole o link.<br />Sua lista aparece na TV.</h1>
              <p className="dl-lead">
                Informe o MAC da TV, dê um nome à lista e cole o link M3U do seu provedor. Não baixamos a lista:
                o DeltaTV só usa o servidor, o usuário e a senha que estão no link.
              </p>
            </div>

            <div className="dl-hero__tv">
              <TvPreview name={name} />
            </div>

            <div className="dl-hero__form" id="adicionar">
              <div className="dl-card">
                <h2>Adicionar uma lista</h2>
                <AddListForm initialMac={initialMac} onName={setName} />
              </div>
            </div>
          </div>
        </section>

        <section className="dl-section" id="como-funciona">
          <div className="dl-wrap">
            <h2 className="dl-h2">Três passos, sem baixar nada</h2>
            <ol className="dl-steps">
              {STEPS.map(([title, text], i) => (
                <li key={title}>
                  <span className="dl-steps__n" aria-hidden="true">{i + 1}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="dl-section dl-section--tint" id="seguranca">
          <div className="dl-wrap dl-split">
            <div>
              <h2 className="dl-h2">O link fica só entre você, o provedor e a sua TV</h2>
              <p className="dl-muted">
                Seu link tem usuário e senha, então tratamos como senha: ele nunca aparece na tela e não é guardado inteiro.
              </p>
            </div>
            <dl className="dl-facts">
              <div><dt>O que lemos</dt><dd>Servidor, usuário e senha. O resto do link é descartado.</dd></div>
              <div><dt>O que guardamos</dt><dd>Esses três dados, cifrados, e o nome que você escolheu.</dd></div>
              <div><dt>O que não fazemos</dt><dd>Não baixamos nem copiamos a lista M3U. O app consulta o provedor direto.</dd></div>
            </dl>
          </div>
        </section>

        <section className="dl-section" id="licenca">
          <div className="dl-wrap">
            <h2 className="dl-h2">E se a TV ainda não tem licença?</h2>
            <p className="dl-muted dl-narrow">
              Você pode adicionar a lista mesmo assim. Ela só funciona com a licença do DeltaTV ativa no aparelho.
            </p>
            <div className="dl-states">
              <div className="dl-state dl-state--ok">
                <h3>Com licença ativa</h3>
                <p>A lista funciona assim que você a adiciona. Abra o DeltaTV e assista.</p>
              </div>
              <div className="dl-state dl-state--wait">
                <h3>Sem licença</h3>
                <p>A lista fica guardada no aparelho e começa a funcionar quando a licença for ativada. Não precisa enviar de novo.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="dl-section dl-section--tint" id="aparelhos">
          <div className="dl-wrap">
            <h2 className="dl-h2">Funciona onde você assiste</h2>
            <ul className="dl-devices">
              {DEVICES.map(([n, s]) => (
                <li key={n}><strong>{n}</strong><span>{s}</span></li>
              ))}
            </ul>
          </div>
        </section>

        <section className="dl-section">
          <div className="dl-wrap">
            <div className="dl-band">
              <div>
                <h2>Prefere assistir no computador?</h2>
                <p>O player web do DeltaTV abre direto no navegador, com o mesmo MAC e a mesma lista.</p>
              </div>
              <a className="dl-btn dl-btn--light" href="/player">Abrir o player web</a>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
