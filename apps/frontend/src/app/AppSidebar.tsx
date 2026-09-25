import { useLocation, useNavigate } from 'react-router-dom';
import { Sidebar, typeClass, type NavItem } from '../design-system';
import { ROUTE_PATHS } from './routePaths';
import { RuntimeFooter } from './RuntimeFooter';

/**
 * The routing adapter `Sidebar`'s own doc comment asks for: "a screen — or a
 * thin routing adapter above it — owns the mapping from `key` to a URL and
 * supplies both props from `useLocation`/`useNavigate`, so this component
 * never needs to change when the router does." This is that adapter —
 * `Sidebar` itself stays exactly as F3 shipped it, with no router dependency.
 *
 * One item, `company`, because that is the one top-level destination F5
 * actually routes (C01). Object/work screens are drill-down, reached from
 * C01/O01, not separate sidebar sections — inventing more items here would
 * be navigation for sections this phase does not implement.
 *
 * F7: the footer is no longer the fixed «F5 · типизированные демо-данные»,
 * which stayed on screen even over real backend data. `RuntimeFooter` states
 * the data source this build actually uses and, when a session exists, whose
 * it is and the action that ends it — through the same `footer` slot, so
 * `Sidebar` is unchanged.
 */
const NAV_ITEMS: NavItem[] = [{ key: 'company', label: 'Портфель' }];

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();

  // /company and every /object/... route (O01, W01) are all part of the one
  // portfolio section this sidebar represents — none of them get their own item.
  const activeKey =
    location.pathname === ROUTE_PATHS.company || location.pathname.startsWith('/object/')
      ? 'company'
      : '';

  return (
    <Sidebar
      brand={<span className={typeClass('ui-strong')}>Contour</span>}
      caption="ПРОИЗВОДСТВЕННЫЙ КОНТРОЛЬ"
      items={NAV_ITEMS}
      activeKey={activeKey}
      onNavigate={(key) => {
        if (key === 'company') navigate(ROUTE_PATHS.company);
      }}
      footer={<RuntimeFooter />}
    />
  );
}
