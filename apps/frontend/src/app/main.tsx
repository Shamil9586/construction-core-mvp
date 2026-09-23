import { createRoot } from 'react-dom/client';
import { App } from './App';

/**
 * Entry point for the F5 application composition.
 *
 * Loads only the design system and this entry's own host-page reset — no
 * antd (nothing under design-system/screens/view-models depends on it) and
 * no legacy style.css (this entry never mounts legacy markup, so there is
 * nothing for it to leak into).
 */
import '../design-system';
import './app.css';

const container = document.getElementById('app-root');

if (container) {
  createRoot(container).render(<App />);
}
