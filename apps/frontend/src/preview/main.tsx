import { createRoot } from 'react-dom/client';
import { Gallery } from './Gallery';

/**
 * Entry point for the design-system preview.
 *
 * The legacy global stylesheet is imported *after* the design system on purpose.
 * That is the adversarial order: whatever the bundler emits, the legacy rules sit
 * later in the cascade here, so anything that still renders correctly is being
 * protected by specificity rather than by luck of ordering. The application loads
 * them the other way round, which is the easier case.
 *
 * style.css is not modified by this import — it is read, not touched.
 */
import '../design-system';
import '../style.css';

const container = document.getElementById('preview-root');

if (container) {
  createRoot(container).render(<Gallery />);
}
