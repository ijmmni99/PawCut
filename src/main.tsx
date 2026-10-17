import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { useAssets, useEditor, usePlayback } from './editor/store';
import { codecProfile } from './engine/codecProfile';
import './index.css';

// Test hook for Playwright runs (engine-test codec profile only).
if (codecProfile.video === 'vp9') {
  Object.assign(window, { __pawcut: { editor: useEditor, assets: useAssets, playback: usePlayback } });
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
