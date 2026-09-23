/**
 * Construction Core design system — public entry point.
 *
 * Importing this module loads the token layer and the type scale. Nothing in the
 * application imports it yet: F0 delivers the foundation only, and wiring it into
 * the shell happens at F3, so the running application is unchanged for now.
 *
 * The design system depends on its tokens and on nothing else — not on services,
 * not on API types, not on view-models, not on formatters, not on domain models
 * or business rules. Components take finished display strings and plain numbers
 * as props; what a value should say is decided in the data chain.
 */

import './tokens/tokens.css';
import './tokens/typography.css';

export * from './tokens';
