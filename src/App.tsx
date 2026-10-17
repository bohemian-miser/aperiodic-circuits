import { useEffect, useState } from 'react';
import { AboutPage } from './pages/AboutPage';
import { BuilderPage } from './pages/BuilderPage';
import { ExplorerPage } from './pages/ExplorerPage';
import { LabPage } from './pages/LabPage';
import { hashFor, useRoute } from './route';
import { subscribe } from './store';

const PAGES = [
  { id: 'explore', label: 'Explorer', short: 'Explorer' },
  { id: 'lab', label: 'Substitution lab', short: 'Lab' },
  { id: 'build', label: 'Edge builder', short: 'Builder' },
  { id: 'about', label: 'About', short: 'About' },
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
          <span className="brand-name">Aperiodic Circuits</span>
        </a>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={hashFor(p.id)} className={page === p.id ? 'on' : ''}>
              <span className="long">{p.label}</span>
              <span className="short">{p.short}</span>
            </a>
          ))}
          <a href="https://github.com/bohemian-miser/aperiodic-circuits" className="ext" title="Source on GitHub" aria-label="Source on GitHub">
            <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
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
