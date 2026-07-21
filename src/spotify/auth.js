// Spotify Authorization Code + PKCE — no client secret, no backend.
// See spec §4. Client ID comes from VITE_SPOTIFY_CLIENT_ID at build/dev time.

const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
const SCOPES = ['streaming', 'user-read-email', 'user-read-private', 'user-modify-playback-state', 'user-library-read'].join(' ');
const REDIRECT_URI = `${window.location.origin}/callback`;

const LS_ACCESS_TOKEN = 'frequency.spotify.access_token';
const LS_REFRESH_TOKEN = 'frequency.spotify.refresh_token';
const LS_EXPIRES_AT = 'frequency.spotify.expires_at';
const SS_CODE_VERIFIER = 'frequency.spotify.code_verifier';

function isConfigured() {
  return !!CLIENT_ID;
}

function base64urlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier() {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64urlEncode(new Uint8Array(digest));
}

export async function redirectToAuth() {
  if (!isConfigured()) throw new Error('Spotify Client ID is not configured (VITE_SPOTIFY_CLIENT_ID).');
  const verifier = generateCodeVerifier();
  sessionStorage.setItem(SS_CODE_VERIFIER, verifier);
  const challenge = await generateCodeChallenge(verifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

function persistTokens({ access_token, refresh_token, expires_in }) {
  localStorage.setItem(LS_ACCESS_TOKEN, access_token);
  if (refresh_token) localStorage.setItem(LS_REFRESH_TOKEN, refresh_token);
  localStorage.setItem(LS_EXPIRES_AT, String(Date.now() + expires_in * 1000));
}

// Call on the /callback route once Spotify redirects back with ?code=...
export async function handleAuthCallback(code) {
  const verifier = sessionStorage.getItem(SS_CODE_VERIFIER);
  if (!verifier) throw new Error('Missing PKCE code verifier — auth flow must restart.');

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) throw new Error(`Spotify token exchange failed: ${resp.status}`);
  const data = await resp.json();
  persistTokens(data);
  sessionStorage.removeItem(SS_CODE_VERIFIER);
  return data;
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem(LS_REFRESH_TOKEN);
  if (!refreshToken) throw new Error('No refresh token available — re-authentication required.');

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) throw new Error(`Spotify token refresh failed: ${resp.status}`);
  const data = await resp.json();
  persistTokens(data);
  return data.access_token;
}

export function isAuthenticated() {
  return !!localStorage.getItem(LS_REFRESH_TOKEN);
}

export function logout() {
  localStorage.removeItem(LS_ACCESS_TOKEN);
  localStorage.removeItem(LS_REFRESH_TOKEN);
  localStorage.removeItem(LS_EXPIRES_AT);
}

// Returns a valid access token, refreshing it first if it's expired/near-expiry.
export async function getAccessToken() {
  const expiresAt = Number(localStorage.getItem(LS_EXPIRES_AT) || 0);
  const token = localStorage.getItem(LS_ACCESS_TOKEN);
  if (token && Date.now() < expiresAt - 30_000) return token;
  return refreshAccessToken();
}

export { isConfigured as isSpotifyConfigured };
