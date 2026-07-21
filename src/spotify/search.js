// Direct browser calls to Spotify's own /v1/search — no MCP proxy needed,
// since this app has its own Spotify credentials (spec §4.5).

import { getAccessToken } from './auth.js';

// Excludes live recordings, remasters, demos, and other alternate cuts from
// category search results. These often lack a real, well-known music video
// or distinct backstory, which was producing weak, circular trivia
// questions ("this is a live recording — what kind of performance is it?").
// Not applied to "My Spotify" library results — those are the user's own
// explicit choices, not something to second-guess.
const ALTERNATE_VERSION_PATTERN = /[-([]\s*(?:\d{4}\s*)?(live|remaster(ed)?|demo|acoustic|instrumental|karaoke|mono|single version|radio edit|extended|remix)\b/i;

// Spotify's search endpoint rejects offset+limit combinations past ~1000.
const MAX_SEARCH_OFFSET = 990;

// Extracts everything we need straight from Spotify's own track object —
// ground truth from the catalog, not something the model has to recall.
// Images are ordered largest-first by Spotify; index 1 is a mid-size (~300px)
// cover, good for in-app display without loading the full-res version.
function mapTrack(t) {
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artist: t.artists.map((a) => a.name).join(', '),
    durationMs: t.duration_ms,
    album: t.album?.name || null,
    year: t.album?.release_date ? t.album.release_date.slice(0, 4) : null,
    albumArt: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
    popularity: typeof t.popularity === 'number' ? t.popularity : null,
  };
}

export async function searchTracks(query, { limit = 10, offset = 0 } = {}) {
  const token = await getAccessToken();
  const params = new URLSearchParams({ q: query, type: 'track', limit: String(limit), offset: String(offset) });
  const resp = await fetch(`https://api.spotify.com/v1/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Spotify search failed: ${resp.status}`);
  const data = await resp.json();
  const items = data.tracks?.items || [];
  return items
    .filter((t) => t.is_playable !== false
      && !ALTERNATE_VERSION_PATTERN.test(t.name)
      // Compilation albums ("80's Rock Anthems", "Now That's What I Call...")
      // repackage old songs under a NEW release date — the compilation's
      // assembly date, not the song's actual release. That surfaced as
      // "released in 2026" for a decades-old track once we started
      // revealing album/year data, so these are excluded outright.
      && t.album?.album_type !== 'compilation')
    .map(mapTrack);
}

function contentKey(track) {
  // Same song often exists under multiple track IDs (remaster, deluxe
  // edition, compilation appearance) — dedupe by name+artist too, not just
  // ID, so the same song can't end up in the queue twice with near-identical
  // trivia questions.
  return `${track.name.toLowerCase().trim()}::${track.artist.toLowerCase().trim()}`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A category round used to be capped at a fixed queue size (originally
// ported from the prototype's arbitrary "6-8 tracks"). Instead, this
// supplier pages forward through Spotify search results on demand — each
// next(n) call drains an internal buffer and, once low, fetches the next
// page from each search query (advancing that query's own offset) rather
// than re-fetching the same first page. It only reports exhausted once a
// full pass across every query adds zero new unique tracks — i.e. the
// category's catalog is genuinely drained, not just "reached some count."
export function createCategorySupplier(searchQueries) {
  const offsets = searchQueries.map(() => 0);
  const seenIds = new Set();
  const seenContent = new Set();
  let buffer = [];
  let exhausted = false;

  // Spotify's search endpoint rejects limit values above 10 with a 400
  // "Invalid limit" error — confirmed empirically (both 20 and 50 fail
  // identically) despite docs suggesting 50 is the max. 10 is the real
  // ceiling. To still reach past an artist's single most-streamed album
  // (search ranks by popularity, so a shallow page is dominated by it),
  // each fetchMore() pulls several limit:10 pages per query instead of
  // one bigger page.
  const PAGE_LIMIT = 10;
  const PAGES_PER_FETCH = 3;

  async function fetchMore() {
    if (exhausted) return;
    let addedAny = false;
    let anySucceeded = false;
    let lastError = null;
    for (let i = 0; i < searchQueries.length; i++) {
      for (let page = 0; page < PAGES_PER_FETCH; page++) {
        if (offsets[i] > MAX_SEARCH_OFFSET) break;
        let results;
        try {
          results = await searchTracks(searchQueries[i], { limit: PAGE_LIMIT, offset: offsets[i] });
          anySucceeded = true;
        } catch (e) {
          lastError = e; // try the other queries/pages before giving up
          break;
        }
        offsets[i] += PAGE_LIMIT;
        for (const t of results) {
          if (seenIds.has(t.id)) continue;
          const key = contentKey(t);
          if (seenContent.has(key)) continue;
          seenIds.add(t.id);
          seenContent.add(key);
          buffer.push(t);
          addedAny = true;
        }
        if (results.length < PAGE_LIMIT) break; // this query is drained, no point paging further right now
      }
    }
    // Every query failing outright (network blip, auth timing, rate limit)
    // is not the same thing as a genuinely exhausted catalog — surface the
    // real error instead of silently reporting "no tracks found."
    if (!anySucceeded && lastError) throw lastError;
    if (!addedAny) exhausted = true;
  }

  return {
    async next(n) {
      while (buffer.length < n && !exhausted) {
        await fetchMore();
      }
      const batch = shuffle(buffer).slice(0, n);
      const takenIds = new Set(batch.map((t) => t.id));
      buffer = buffer.filter((t) => !takenIds.has(t.id));
      return batch;
    },
    isExhausted() {
      return exhausted && buffer.length === 0;
    },
  };
}

// "My Spotify" category — pages through the user's own Liked Songs instead
// of a keyword search. Requires the user-library-read scope.
export function createLibrarySupplier() {
  let offset = 0;
  let total = null;
  const seenContent = new Set();
  let buffer = [];
  let exhausted = false;

  async function fetchMore() {
    if (exhausted) return;
    const token = await getAccessToken();
    const params = new URLSearchParams({ limit: '50', offset: String(offset) });
    const resp = await fetch(`https://api.spotify.com/v1/me/tracks?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`Spotify library fetch failed: ${resp.status}`);
    const data = await resp.json();
    total = data.total;
    offset += 50;
    const items = data.items || [];
    for (const item of items) {
      const t = item.track;
      if (!t || t.is_playable === false) continue;
      const mapped = mapTrack(t);
      const key = contentKey(mapped);
      if (seenContent.has(key)) continue;
      seenContent.add(key);
      buffer.push(mapped);
    }
    if (!items.length || (total !== null && offset >= total)) exhausted = true;
  }

  return {
    async next(n) {
      while (buffer.length < n && !exhausted) {
        await fetchMore();
      }
      const batch = shuffle(buffer).slice(0, n);
      const takenIds = new Set(batch.map((t) => t.id));
      buffer = buffer.filter((t) => !takenIds.has(t.id));
      return batch;
    },
    isExhausted() {
      return exhausted && buffer.length === 0;
    },
  };
}
