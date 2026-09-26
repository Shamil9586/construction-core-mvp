import type { Snapshot } from '../types/api';
import type { DataProvider } from './DataProvider';
import { demoInspections, demoObjects, demoWorks } from '../screens/demo/fixtures';

/**
 * Typed mock standing in for the real backend.
 *
 * F5 scope is explicit: "do not yet connect production backend" and "if
 * backend contracts are absent, use typed mocks/providers — do not create
 * fake API contracts". This reuses the exact fixtures the design-system
 * preview already demonstrates C01/O01/W01 with (`screens/demo/fixtures.ts`)
 * — typed against the real backend contract, not a second invented dataset —
 * so the application and the preview never drift apart on what "the demo
 * data" means.
 *
 * `contractors`/`dependencies` are real, required `Snapshot` fields that
 * C01/O01/W01 do not read; empty arrays, not omitted or invented values.
 */
export const mockDataProvider: DataProvider = {
  async getSnapshot(): Promise<Snapshot> {
    return {
      objects: demoObjects,
      works: demoWorks,
      contractors: [],
      dependencies: [],
      inspections: demoInspections,
    };
  },
};
