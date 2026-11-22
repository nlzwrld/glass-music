import React from 'react';
import './lib/native';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import DetachedJam from './app/DetachedJam';
import DetachedLyrics from './app/DetachedLyrics';
import './styles/app.css';
import './styles/optics-v3.css';
import './styles/design-system.css';
import './styles/appearance-global.css';
import './styles/playlists.css';
import './styles/settings-topics.css';
import './styles/liquid-glass-ios.css';
import './styles/matte-design-system.css';

const view = new URLSearchParams(location.search).get('view');
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {view === 'lyrics' ? <DetachedLyrics /> : view === 'jam' ? <DetachedJam /> : <App />}
  </React.StrictMode>,
);
