import { useEffect } from 'react';
import SkyView from './three/SkyView';
import TopBar from './components/TopBar';
import Breadcrumb from './components/Breadcrumb';
import WordPanel from './components/WordPanel';
import ReviewView from './components/ReviewView';
import StatsView from './components/StatsView';
import AssessmentView from './components/AssessmentView';
import BackendBanner from './components/BackendBanner';
import Toast from './components/Toast';
import { useWV } from './store';

export default function App() {
  const init = useWV((s) => s.init);
  const view = useWV((s) => s.view);
  const setView = useWV((s) => s.setView);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="app">
      <SkyView />
      <TopBar />
      <Breadcrumb />
      <WordPanel />
      <BackendBanner />
      <Toast />
      {view === 'review' ? <ReviewView onClose={() => setView('sky')} /> : null}
      {view === 'assessment' ? <AssessmentView onClose={() => setView('sky')} /> : null}
      {view === 'stats' ? <StatsView onClose={() => setView('sky')} /> : null}
    </div>
  );
}
