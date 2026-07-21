// Settings screen: DJ voice picker (grouped by language, radio-style, Test
// voice button per spec §5) and Spotify connect/reconnect. Difficulty lives
// on the landing page now, not here.

import { groupVoicesByLanguage, setStoredVoiceURI } from '../voice/voicePicker.js';
import { setActiveVoiceURI, testVoice } from '../voice/speak.js';
import { isAuthenticated, redirectToAuth, logout as logoutSpotify } from '../spotify/auth.js';

export function createSettings(root, { voices, activeVoiceURI, notice, onClose }) {
  const spotifyConnected = isAuthenticated();

  root.innerHTML = `
    <div class="settings-panel">
      <div class="settings-hdr">
        <span>Settings</span>
        <button class="settings-close" id="settingsClose" aria-label="Close settings">&times;</button>
      </div>
      ${notice ? `<div class="settings-notice">${notice}</div>` : ''}

      <div class="settings-section">
        <div class="settings-label">Spotify</div>
        ${spotifyConnected
          ? '<button class="skip-btn" id="reconnectSpotifyBtn">Reconnect Spotify</button>'
          : '<button class="start-btn spotify stacked-btn" id="connectSpotifyBtn">Connect Spotify</button>'}
      </div>

      <div class="settings-section">
        <div class="settings-label">DJ Voice</div>
        <div class="voice-list" id="voiceList"></div>
      </div>
    </div>
  `;

  const voiceListEl = root.querySelector('#voiceList');
  const groups = groupVoicesByLanguage(voices);
  const sortedLangs = Object.keys(groups).sort((a, b) => {
    // Surface British English first, since it's the default preference.
    if (a.startsWith('en-GB')) return -1;
    if (b.startsWith('en-GB')) return 1;
    return a.localeCompare(b);
  });

  for (const lang of sortedLangs) {
    const groupEl = document.createElement('div');
    groupEl.className = 'voice-group';
    groupEl.innerHTML = `<div class="voice-group-lang">${lang}</div>`;
    for (const voice of groups[lang]) {
      const row = document.createElement('div');
      row.className = 'voice-row';
      row.innerHTML = `
        <label class="voice-radio">
          <input type="radio" name="voice" value="${voice.voiceURI}" ${voice.voiceURI === activeVoiceURI ? 'checked' : ''}/>
          <span>${voice.name}</span>
        </label>
        <button class="voice-test-btn" data-uri="${voice.voiceURI}">Test voice</button>
      `;
      groupEl.appendChild(row);
    }
    voiceListEl.appendChild(groupEl);
  }

  voiceListEl.addEventListener('change', (e) => {
    const input = e.target.closest('input[name="voice"]');
    if (!input) return;
    setStoredVoiceURI(input.value);
    setActiveVoiceURI(input.value);
  });

  voiceListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.voice-test-btn');
    if (!btn) return;
    const voice = voices.find((v) => v.voiceURI === btn.dataset.uri);
    if (voice) testVoice(voice);
  });

  root.querySelector('#settingsClose').addEventListener('click', () => {
    if (onClose) onClose();
  });

  if (spotifyConnected) {
    root.querySelector('#reconnectSpotifyBtn').addEventListener('click', () => {
      logoutSpotify();
      window.location.href = '/';
    });
  } else {
    root.querySelector('#connectSpotifyBtn').addEventListener('click', () => {
      redirectToAuth();
    });
  }
}
