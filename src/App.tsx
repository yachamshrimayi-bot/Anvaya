import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom';
import Home from './pages/Home';

// Heavy pages load on demand; the engine itself is shared.
const Workbench = lazy(() => import('./pages/Workbench'));
const Benchmark = lazy(() => import('./pages/Benchmark'));

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function Loading() {
  return (
    <div className="page" style={{ display: 'grid', placeItems: 'center', minHeight: '80vh' }}>
      <div className="pill">
        <span className="dot" /> Booting the fleet…
      </div>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <ScrollTop />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/workbench" element={<Workbench />} />
          <Route path="/benchmark" element={<Benchmark />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </Suspense>
    </HashRouter>
  );
}
