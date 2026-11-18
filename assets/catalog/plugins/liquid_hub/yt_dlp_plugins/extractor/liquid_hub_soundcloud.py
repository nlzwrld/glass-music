"""Public search metadata only. MIT; bundled exclusively with Liquid Hub."""
from urllib.parse import unquote
from yt_dlp.extractor.soundcloud import SoundcloudBaseIE
from yt_dlp.utils import ExtractorError


__all__ = ['LiquidHubSoundcloudSearchIE', 'LiquidHubSoundcloudPlaylistIE']


class LiquidHubSoundcloudSearchIE(SoundcloudBaseIE):
    IE_NAME = 'liquid-hub:soundcloud:search'
    _VALID_URL = r'(?:liquid-hub|glass)-sc-search:(?P<kind>tracks|users|playlists):(?P<offset>\d{1,3}):(?P<id>.+)$'

    def _real_extract(self, url):
        kind, offset, encoded = self._match_valid_url(url).group('kind', 'offset', 'id')
        query = unquote(encoded)
        offset = int(offset)
        if not query.strip() or len(query.encode('utf-8')) > 800 or offset > 180 or offset % 20:
            raise ExtractorError('Invalid Liquid Hub search', expected=True)
        data = self._call_api(
            self._API_V2_BASE + 'search/' + kind, query,
            query={'q': query, 'limit': 21, 'offset': offset, 'linked_partitioning': 1},
            headers=self._HEADERS)
        entries = []
        for item in (data.get('collection') or [])[:21]:
            user = item if kind == 'users' else item.get('user') or {}
            art = item.get('artwork_url') or user.get('avatar_url')
            mapped_kind = {'tracks': 'track', 'users': 'artist', 'playlists': 'playlist'}[kind]
            entries.append({
                '_type': 'url', 'url': item.get('permalink_url'),
                'id': str(item.get('id', '')), 'title': item.get('title') or user.get('username'),
                'uploader': user.get('username'), 'duration': (item.get('duration') or 0) / 1000,
                'thumbnails': [{'url': art.replace('-large.', '-t500x500.')}] if art else [],
                'liquid_kind': mapped_kind,
                'glass_kind': mapped_kind,
            })
        return self.playlist_result(entries, query, query)


class LiquidHubSoundcloudPlaylistIE(SoundcloudBaseIE):
    IE_NAME = 'liquid-hub:soundcloud:playlist'
    _VALID_URL = r'(?:liquid-hub|glass)-sc-playlist:(?P<id>https://soundcloud\.com/[^/?#]+/sets/[^/?#]+)$'

    def _real_extract(self, url):
        public_url = self._match_id(url)
        data = self._call_api(self._resolv_url(public_url), public_url, headers=self._HEADERS)
        if data.get('sharing') == 'private':
            raise ExtractorError('Private playlist requires an authorized account', expected=True)
        rows = (data.get('tracks') or [])[:1001]
        missing = [str(t['id']) for t in rows if t.get('id') and not t.get('title')]
        extra = {}
        for offset in range(0, len(missing), 50):
            batch = self._call_api(self._API_V2_BASE + 'tracks', public_url,
                query={'ids': ','.join(missing[offset:offset + 50])}, headers=self._HEADERS)
            for item in batch if isinstance(batch, list) else []:
                extra[str(item.get('id'))] = item
        entries = []
        for row in rows:
            row = extra.get(str(row.get('id')), row)
            art = row.get('artwork_url') or (row.get('user') or {}).get('avatar_url')
            entries.append({
                '_type': 'url', 'id': str(row.get('id', '')), 'title': row.get('title'),
                'url': row.get('permalink_url'), 'uploader': (row.get('user') or {}).get('username'),
                'duration': (row.get('duration') or 0) / 1000,
                'thumbnail': art.replace('-large.', '-t500x500.') if art else None,
            })
        return self.playlist_result(entries, str(data.get('id', '')), data.get('title'))
