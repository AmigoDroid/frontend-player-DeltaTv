// Peças compartilhadas do site institucional: logo, cabeçalho, rodapé e a TV de pré-visualização.

export function Logo({ size = 34 }) {
  return (
    <span className="dl-logo">
      <svg width={size} height={size} viewBox="0 0 42 42" aria-hidden="true">
        <rect width="42" height="42" rx="10" fill="#0c1030" />
        <path d="M13 9.5l22 11.5-22 11.5z" fill="none" stroke="#6d6bff" strokeWidth="4.5" strokeLinejoin="round" />
      </svg>
      <span>Delta<b>TV</b></span>
    </span>
  );
}

export function Header({ home = false }) {
  const to = (hash) => (home ? hash : `/${hash}`);
  return (
    <header className="dl-header">
      <div className="dl-wrap dl-header__in">
        <a href="/" className="dl-header__brand" aria-label="Delta TV, página inicial"><Logo /></a>
        <nav className="dl-nav" aria-label="Principal">
          <a href={to("#como-funciona")}>Como funciona</a>
          <a href={to("#licenca")}>Licença</a>
          <a href={to("#aparelhos")}>Aparelhos</a>
          <a href="/player">Player web</a>
        </nav>
        <a className="dl-btn dl-btn--primary dl-btn--sm" href={to("#adicionar")}>Adicionar lista</a>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="dl-footer">
      <div className="dl-wrap dl-footer__in">
        <Logo size={28} />
        <p>© {new Date().getFullYear()} DeltaTV. O DeltaTV é um aplicativo player e não fornece conteúdo.</p>
        <a href="/player">Abrir o player web</a>
      </div>
    </footer>
  );
}

/** TV desenhada em CSS: mostra o nome da lista exatamente como o cliente o verá no aparelho. */
export function TvPreview({ name }) {
  const shown = name.trim();
  const clock = "20:45";
  return (
    <figure className="dl-tv" aria-label="Pré-visualização da TV">
      <div className="dl-tv__bezel">
        <div className="dl-tv__screen">
          <div className="dl-tv__top">
            <Logo size={22} />
            <span>{clock}</span>
          </div>
          <div className="dl-tv__body">
            <span className="dl-tv__label">Sua lista</span>
            <strong className={`dl-tv__name${shown ? "" : " is-empty"}`}>{shown || "Nome da lista"}</strong>
            <span className="dl-tv__cta">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5l9 5.5-9 5.5z" fill="currentColor" /></svg>
              Abrir
            </span>
          </div>
          <div className="dl-tv__row" aria-hidden="true">
            <i>Ao vivo</i><i>Filmes</i><i>Séries</i>
          </div>
        </div>
      </div>
      <div className="dl-tv__stand" aria-hidden="true" />
      <figcaption>É assim que o nome aparece no DeltaTV.</figcaption>
    </figure>
  );
}
