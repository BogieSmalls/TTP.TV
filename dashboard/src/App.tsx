import { Routes, Route, Navigate } from 'react-router-dom';
import AppSidebar from './components/sidebar/AppSidebar';
import { ErrorBoundary } from './ui';

// PRODUCE
import Dashboard from './pages/Dashboard';
import Broadcast from './pages/Broadcast';
import Schedule from './pages/Schedule';

// CONFIGURE
import SceneBuilder from './pages/SceneBuilder';
import Racers from './pages/Racers';
import Crops from './pages/Crops';
import Commentary from './pages/Commentary';

// TRAIN
import LearnMode from './pages/LearnMode';
import KnowledgeManager from './pages/KnowledgeManager';
import VisionLab from './pages/VisionLab';

// SYSTEM
import Settings from './pages/Settings';

export default function App() {
  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      <AppSidebar />
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="p-6 min-h-full">
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/broadcast" element={<Broadcast />} />
              <Route path="/broadcast/:tab" element={<Broadcast />} />
              <Route path="/schedule" element={<Schedule />} />
              <Route path="/scene-builder" element={<SceneBuilder />} />
              <Route path="/racers" element={<Racers />} />
              <Route path="/racers/:tab" element={<Racers />} />
              <Route path="/crops" element={<Crops />} />
              <Route path="/crops/:profileId" element={<Crops />} />
              <Route path="/commentary" element={<Commentary />} />
              <Route path="/learn" element={<LearnMode />} />
              <Route path="/knowledge" element={<KnowledgeManager />} />
              <Route path="/vision" element={<VisionLab />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
