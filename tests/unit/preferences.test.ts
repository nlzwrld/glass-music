import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setPreferencesFromUI, useApp } from '../../src/stores/app';
import { defaults, type Preferences, type Snapshot } from '../../shared/types';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function snapshot(preferences: Preferences): Snapshot {
  return { tracks: [], playlists: [], likes: [], history: [], preferences };
}

function installWrites(writes: ReturnType<typeof deferred<Preferences>>[], recovered: Preferences) {
  let index = 0;
  const preferences = vi.fn((_value: Preferences) => writes[index++]!.promise);
  const bootstrap = vi.fn(async () => snapshot(recovered));
  vi.stubGlobal('window', { glass: { preferences, bootstrap } });
  return { preferences, bootstrap };
}

beforeEach(() => {
  useApp.setState({
    data: snapshot({ ...defaults }),
    queue: [],
    index: -1,
    probeLyrics: vi.fn(async () => true),
    toast: '',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('does not let a volume snapshot reactivate a revoked consent', async () => {
  const initial = { ...defaults, onlineConsent: true, catalogConsent: true };
  useApp.setState({ data: snapshot(initial) });
  const writes = [deferred<Preferences>(), deferred<Preferences>()];
  const { preferences, bootstrap } = installWrites(writes, initial);

  const revoking = useApp
    .getState()
    .setPreferences({ onlineConsent: false, catalogConsent: false });
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(1));
  const sliding = useApp.getState().setPreferences({ volume: 22 });

  expect(useApp.getState().data.preferences.onlineConsent).toBe(true);
  expect(useApp.getState().data.preferences.volume).toBe(22);
  writes[0]!.resolve(preferences.mock.calls[0]![0]);
  await revoking;
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(2));

  expect(preferences.mock.calls[1]![0]).toMatchObject({
    onlineConsent: false,
    catalogConsent: false,
    volume: 22,
  });
  expect(useApp.getState().data.preferences).toMatchObject({
    onlineConsent: false,
    volume: 22,
  });
  writes[1]!.resolve(preferences.mock.calls[1]![0]);
  await sliding;
  expect(bootstrap).not.toHaveBeenCalled();
  expect(useApp.getState().probeLyrics).toHaveBeenCalledTimes(1);
});

it('keeps a volume patch made while consent activation is pending', async () => {
  const initial = { ...defaults, onlineConsent: false, catalogConsent: false };
  const writes = [deferred<Preferences>(), deferred<Preferences>()];
  const { preferences } = installWrites(writes, initial);

  const activating = useApp
    .getState()
    .setPreferences({ onlineConsent: true, catalogConsent: true });
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(1));
  const sliding = useApp.getState().setPreferences({ volume: 31 });
  expect(useApp.getState().data.preferences).toMatchObject({
    onlineConsent: false,
    volume: 31,
  });

  writes[0]!.resolve(preferences.mock.calls[0]![0]);
  await activating;
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(2));
  expect(preferences.mock.calls[1]![0]).toMatchObject({
    onlineConsent: true,
    catalogConsent: true,
    volume: 31,
  });
  expect(useApp.getState().data.preferences).toMatchObject({
    onlineConsent: true,
    volume: 31,
  });
  writes[1]!.resolve(preferences.mock.calls[1]![0]);
  await sliding;
});

it('keeps an earlier volume patch when consent activation is queued afterwards', async () => {
  const initial = { ...defaults, onlineConsent: false, catalogConsent: false };
  const writes = [deferred<Preferences>(), deferred<Preferences>()];
  const { preferences } = installWrites(writes, initial);

  const sliding = useApp.getState().setPreferences({ volume: 37 });
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(1));
  const activating = useApp
    .getState()
    .setPreferences({ onlineConsent: true, catalogConsent: true });
  expect(useApp.getState().data.preferences).toMatchObject({
    onlineConsent: false,
    volume: 37,
  });

  writes[0]!.resolve(preferences.mock.calls[0]![0]);
  await sliding;
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(2));
  expect(preferences.mock.calls[1]![0]).toMatchObject({
    onlineConsent: true,
    catalogConsent: true,
    volume: 37,
  });
  expect(useApp.getState().data.preferences.onlineConsent).toBe(false);

  writes[1]!.resolve(preferences.mock.calls[1]![0]);
  await activating;
  expect(useApp.getState().data.preferences).toMatchObject({
    onlineConsent: true,
    volume: 37,
  });
  expect(useApp.getState().probeLyrics).toHaveBeenCalledTimes(1);
});

it('serializes successive slider patches without dropping intermediate values', async () => {
  const initial = { ...defaults };
  const writes = [deferred<Preferences>(), deferred<Preferences>(), deferred<Preferences>()];
  const { preferences } = installWrites(writes, initial);

  const first = useApp.getState().setPreferences({ volume: 10 });
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(1));
  const second = useApp.getState().setPreferences({ volume: 20 });
  const third = useApp.getState().setPreferences({ volume: 30 });
  expect(useApp.getState().data.preferences.volume).toBe(30);
  expect(preferences.mock.calls[0]![0].volume).toBe(10);

  writes[0]!.resolve(preferences.mock.calls[0]![0]);
  await first;
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(2));
  expect(preferences.mock.calls[1]![0].volume).toBe(20);
  expect(useApp.getState().data.preferences.volume).toBe(30);

  writes[1]!.resolve(preferences.mock.calls[1]![0]);
  await second;
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(3));
  expect(preferences.mock.calls[2]![0].volume).toBe(30);

  writes[2]!.resolve(preferences.mock.calls[2]![0]);
  await third;
  expect(useApp.getState().data.preferences.volume).toBe(30);
});

it('recovers a failed write without erasing a later patch and rejects its caller', async () => {
  const initial = { ...defaults, volume: 65 };
  const writes = [deferred<Preferences>(), deferred<Preferences>()];
  const { preferences, bootstrap } = installWrites(writes, initial);

  const first = useApp.getState().setPreferences({ volume: 10 });
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(1));
  const second = useApp.getState().setPreferences({ volume: 20 });
  const rejection = expect(first).rejects.toThrow('disco cheio');

  writes[0]!.reject(new Error('disco cheio'));
  await rejection;
  await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(2));

  expect(bootstrap).toHaveBeenCalledTimes(1);
  expect(useApp.getState().data.preferences.volume).toBe(20);
  expect(preferences.mock.calls[1]![0].volume).toBe(20);
  writes[1]!.resolve(preferences.mock.calls[1]![0]);
  await second;
  expect(useApp.getState().data.preferences.volume).toBe(20);
});

it('handles fire-and-forget UI failures without an unhandled rejection', async () => {
  const initial = { ...defaults };
  const write = deferred<Preferences>();
  const { preferences, bootstrap } = installWrites([write], initial);
  const unhandled = vi.fn();
  const onUnhandled = (reason: unknown) => unhandled(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    setPreferencesFromUI({ volume: 12 });
    await vi.waitFor(() => expect(preferences).toHaveBeenCalledTimes(1));
    write.reject(new Error('falha de escrita na UI'));
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(1));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(unhandled).not.toHaveBeenCalled();
    expect(useApp.getState().toast).toBe('falha de escrita na UI');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
