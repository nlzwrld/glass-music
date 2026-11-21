import { afterEach, expect, it, vi } from 'vitest';
import { defaults } from '../../shared/types';
import { shouldCheckAutomatically, useUpdateNotice } from '../../src/lib/updates';

afterEach(() => {
  vi.unstubAllGlobals();
  useUpdateNotice.setState({ availableVersion: '', dismissedVersion: '', installing: false });
});

it('does not schedule automatic checks when auto-update is disabled', () => {
  const online = { ...defaults, onlineConsent: true, onboardingDone: true, autoUpdate: false };
  expect(shouldCheckAutomatically(true, online)).toBe(false);
  expect(shouldCheckAutomatically(true, { ...online, autoUpdate: true })).toBe(true);
  expect(shouldCheckAutomatically(false, { ...online, autoUpdate: true })).toBe(false);
  expect(shouldCheckAutomatically(true, { ...online, autoUpdate: true, onlineConsent: false })).toBe(false);
});

it('keeps manual update installation available when automatic checks are disabled', async () => {
  const updateStatus = vi.fn(async () => ({ available: true, configured: true }));
  vi.stubGlobal('window', { glass: { updateStatus } });
  useUpdateNotice.setState({ installing: false });
  expect(defaults.autoUpdate).toBe(true);
  expect(shouldCheckAutomatically(true, { ...defaults, autoUpdate: false })).toBe(false);

  await useUpdateNotice.getState().installNow();

  expect(updateStatus).toHaveBeenCalledWith(true);
  expect(useUpdateNotice.getState().installing).toBe(true);
});
