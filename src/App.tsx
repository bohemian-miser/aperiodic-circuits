import { useEffect, useState } from 'react';
import { AboutPage } from './pages/AboutPage';
import { BuilderPage } from './pages/BuilderPage';
import { ExplorerPage } from './pages/ExplorerPage';
import { LabPage } from './pages/LabPage';
import { hashFor, useRoute } from './route';
import { subscribe } from './store';

const PAGES = [
  { id: 'explore', label: 'Explorer' },
  { id: 'lab', label: 'Substitution lab' },
  { id: 'build', label: 'Edge builder' },
  { id: 'about', label: 'About' },
] as const;

export function App() {
  const route = useRoute();
  // Re-render when saved rule sets change.
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((t) => t + 1)), []);
  const page = PAGES.some((p) => p.id === route.page) ? route.page : 'explore';

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={hashFor('explore')}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M12 2 21 7v10l-9 5-9-5V7z" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M7.5 4.6C10 9 14 9 16.5 4.6M3 12c4 0 6 3 4.5 7.4M21 12c-4 0-6 3-4.5 7.4" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Aperiodic Circuits
        </a>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={hashFor(p.id)} className={page === p.id ? 'on' : ''}>
              {p.label}
            </a>
          ))}
          <a href="https://github.com/bohemian-miser/aperiodic-circuits" className="ext">
            GitHub
          </a>
        </nav>
      </header>
      {/* Keyed on the page so switching pages re-reads the URL. */}
      {page === 'explore' && <ExplorerPage key="explore" route={route} />}
      {page === 'build' && <BuilderPage key={`build-${route.params.get('t') ?? ''}`} route={route} />}
      {page === 'lab' && <LabPage key="lab" route={route} />}
      {page === 'about' && <AboutPage />}
    </div>
  );
}
