import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { DocsModal } from './Docs';

export function Nav({ right }: { right?: React.ReactNode }) {
  const nav = useNavigate();
  const [docs, setDocs] = useState(false);
  return (
    <header className="nav">
      <NavLink to="/" className="logo" aria-label="ANVAYA home">
        <span className="logo-mark">A</span>
        ANVAYA
      </NavLink>
      <nav className="nav-links">
        <NavLink to="/" end>
          Home
        </NavLink>
        <NavLink to="/workbench">Workbench</NavLink>
        <NavLink to="/benchmark">Benchmark</NavLink>
        <a href="#docs" onClick={(e) => (e.preventDefault(), setDocs(true))}>
          Docs &amp; math
        </a>
      </nav>
      {right ?? (
        <button className="btn" onClick={() => nav('/workbench')}>
          Launch Workbench
        </button>
      )}
      <DocsModal open={docs} onClose={() => setDocs(false)} />
    </header>
  );
}
