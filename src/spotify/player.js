// Web Playback SDK wrapper — real play/pause/skip control over full tracks
// (Premium), replacing the iframe embed workaround from the prototype.
//
// Track-end detection: we deliberately don't infer "ended" from the SDK's
// player_state_changed events. Spotify reports transient buffering/pause
// states in ways that are indistinguishable from real end-of-track (this hit
// us in practice — playback was being treated as "ended" seconds in). Since
// we already know the track's duration from the Spotify search result, a
// plain timer is simpler and deterministic.

import { getAccessToken } from './auth.js';

let player = null;
let deviceId = null;
let onTrackEndCallback = null;
let endTimer = null;

function loadSdkScript() {
  return new Promise((resolve) => {
    if (window.Spotify) { resolve(window.Spotify); return; }
    window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify);
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    document.head.appendChild(script);
  });
}

export async function initPlayer() {
  if (player) return player; // guard against a second device fighting the first
  const Spotify = await loadSdkScript();
  player = new Spotify.Player({
    name: 'Frequency',
    getOAuthToken: async (cb) => cb(await getAccessToken()),
    volume: 0.85,
  });

  player.addListener('ready', ({ device_id }) => { deviceId = device_id; });
  player.addListener('not_ready', () => { deviceId = null; });

  await player.connect();
  return player;
}

export function onTrackEnd(callback) {
  onTrackEndCallback = callback;
}

async function waitForDevice(timeoutMs = 8000) {
  const start = Date.now();
  while (!deviceId) {
    if (Date.now() - start > timeoutMs) throw new Error('Spotify playback device did not become ready in time.');
    await new Promise((r) => setTimeout(r, 200));
  }
  return deviceId;
}

export async function play(track) {
  clearTimeout(endTimer);
  const device = await waitForDevice();
  const token = await getAccessToken();
  const resp = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${device}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [track.uri] }),
  });
  if (!resp.ok && resp.status !== 204) throw new Error(`Spotify playback failed: ${resp.status}`);

  const durationMs = track.durationMs || 180000; // fallback ~3min if missing
  endTimer = setTimeout(() => {
    if (onTrackEndCallback) onTrackEndCallback();
  }, durationMs + 800); // small buffer past the exact duration
}

// Name That Tune mode: play only a short clip of the track, then explicitly
// pause (Spotify keeps playing past `ms` otherwise — there's no server-side
// clip endpoint, so this is a client-side timer + pause). `positionMs` lets
// a hint resume from where the previous clip left off (e.g. play ms:5000
// starting at positionMs:8000) instead of restarting from the top.
export async function playSample(track, ms = 8000, positionMs = 0) {
  clearTimeout(endTimer);
  const device = await waitForDevice();
  const token = await getAccessToken();
  const resp = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${device}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [track.uri], position_ms: positionMs }),
  });
  if (!resp.ok && resp.status !== 204) throw new Error(`Spotify playback failed: ${resp.status}`);

  endTimer = setTimeout(async () => {
    try { await player.pause(); } catch (e) { /* no-op */ }
    if (onTrackEndCallback) onTrackEndCallback();
  }, ms);
}

export async function pause() {
  clearTimeout(endTimer);
  if (!player) return;
  try { await player.pause(); } catch (e) { /* no-op */ }
}

export function isReady() {
  return !!deviceId;
}
