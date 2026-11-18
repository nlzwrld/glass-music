import { describe, expect, it } from 'vitest';
import {
  artworkUrl,
  brokerUrl,
  credentialLoginSchema,
  credentialSchema,
  jamRequestSchema,
  librarySchema,
  officialUrl,
  pkceAuthorizeSchema,
  preferencesSchema,
  purgeSensitiveWebStorage,
  trackSchema,
} from '../../shared/validation';
import { defaults } from '../../shared/types';
import { validNext } from '../../server/broker';

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

describe('Security boundaries & Zero-Trust contracts', () => {
  it('allows only official HTTPS destinations, blocking shell URLs, credentials and lookalike hosts', () => {
    [
      'file:///C:/Windows/system32/cmd.exe',
      'javascript:alert(1)',
      'https://youtube.com.attacker.example/x',
      'https://youtube.com@attacker.example/',
      'http://youtube.com/',
      'https://youtube.com:444/',
    ].forEach(u => expect(officialUrl(u)).toBe(false));
    expect(officialUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE')).toBe(true);
  });

  it('rejects arbitrary cover fetches and unsafe broker origins', () => {
    expect(artworkUrl('https://127.0.0.1/secret')).toBe(false);
    expect(artworkUrl('https://i.ytimg.com/vi/x/hqdefault.jpg')).toBe(true);
    expect(brokerUrl('http://192.168.0.1')).toBe(false);
    expect(brokerUrl('https://a:b@host')).toBe(false);
    expect(brokerUrl('http://127.0.0.1:8787')).toBe(true);
    expect(credentialSchema.safeParse({ brokerUrl: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('validates message shape, identity and duplicate-free names at the boundary', () => {
    expect(librarySchema.safeParse({ action: 'create', name: '   ' }).success).toBe(false);
    expect(librarySchema.safeParse({ action: 'execute', code: 'process.exit()' }).success).toBe(
      false,
    );
    expect(
      trackSchema.safeParse({
        id: 'youtube:other',
        source: 'youtube',
        sourceId: 'M7lc1UVf-VE',
        kind: 'track',
        title: 'x',
        artist: 'y',
        duration: 0,
        addedAt: 0,
      }).success,
    ).toBe(false);
  });

  it('does not accept untrusted API pagination destinations', () => {
    expect(() => validNext('https://evil.example/tracks', 'tracks')).toThrow();
    expect(() => validNext('https://api.soundcloud.com/users', 'tracks')).toThrow();
    expect(validNext('https://api.soundcloud.com/tracks?cursor=abc', 'tracks').hostname).toBe(
      'api.soundcloud.com',
    );
  });

  it('rejects unknown/extra fields across strict IPC, Auth and JAM schemas', () => {
    const validTrack = {
      id: 'youtube:M7lc1UVf-VE',
      source: 'youtube' as const,
      sourceId: 'M7lc1UVf-VE',
      kind: 'track' as const,
      title: 'Valid Song',
      artist: 'Valid Artist',
      duration: 180,
      addedAt: 1000,
    };
    expect(trackSchema.safeParse(validTrack).success).toBe(true);
    expect(trackSchema.safeParse({ ...validTrack, isAdmin: true }).success).toBe(false);

    expect(preferencesSchema.safeParse(defaults).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...defaults, injectedToken: 'secret' }).success).toBe(
      false,
    );

    expect(
      librarySchema.safeParse({ action: 'create', name: 'Playlist A', extra: 123 }).success,
    ).toBe(false);

    expect(
      jamRequestSchema.safeParse({ action: 'create', name: 'Host', pollutedField: 'x' }).success,
    ).toBe(false);

    expect(
      pkceAuthorizeSchema.safeParse({
        response_type: 'code',
        client_id: 'liquid-hub-desktop',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        unexpected: '1',
      }).success,
    ).toBe(false);

    expect(
      credentialLoginSchema.safeParse({
        username: 'alice',
        password: 'ValidPassword123!',
        client_id: 'liquid-hub-desktop',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        admin: true,
      }).success,
    ).toBe(false);
  });

  it('purges sensitive tokens and JWTs from Web Storage while preserving safe UI settings', () => {
    const fakeJwt =
      'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJlX2J5dGVz';
    const local = createMemoryStorage({
      'glass-optics-v3': '{"preset":"Apple Music"}',
      access_token: 'leaked-access-token',
      refreshToken: 'leaked-refresh-token',
      'cached-ui-state': fakeJwt,
    });
    const session = createMemoryStorage({
      oauth_secret: 'leaked-secret',
      harmless_flag: '1',
    });

    const purged = purgeSensitiveWebStorage([local, session]);
    expect(purged).toEqual([
      'access_token',
      'refreshToken',
      'cached-ui-state',
      'oauth_secret',
    ]);
    expect(local.dump()).toEqual({ 'glass-optics-v3': '{"preset":"Apple Music"}' });
    expect(session.dump()).toEqual({ harmless_flag: '1' });
  });
});
