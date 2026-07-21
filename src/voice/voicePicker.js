// AI voice picker — spec §5.
// speechSynthesis voice inventory is device-supplied and varies by phone, so
// we can't assume a specific named voice exists. Selection logic:
//   1. Prefer en-GB voices whose name matches a known female-voice pattern
//   2. Fall back to any en-GB voice
//   3. Fall back to any English voice (surfaces a notice so the user knows)
// The chosen voiceURI is persisted in localStorage; speak.js reads it back.

const STORAGE_KEY = 'frequency.voiceURI';

// Gender isn't a queryable property on SpeechSynthesisVoice, so we maintain
// a small allow-list of known female-voice name patterns across common
// Android/Chrome TTS engines (Google, Microsoft, Apple).
const FEMALE_NAME_PATTERN = /female|serena|kate|amy|emma|joanna|salli|olivia|libby|hazel|zira|susan/i;

export function getVoicesAsync() {
  return new Promise((resolve) => {
    const existing = speechSynthesis.getVoices();
    if (existing && existing.length) {
      resolve(existing);
      return;
    }
    const onChange = () => {
      speechSynthesis.removeEventListener('voiceschanged', onChange);
      resolve(speechSynthesis.getVoices());
    };
    speechSynthesis.addEventListener('voiceschanged', onChange);
    // Some engines never fire the event if voices never load — bail after a beat.
    setTimeout(() => {
      speechSynthesis.removeEventListener('voiceschanged', onChange);
      resolve(speechSynthesis.getVoices());
    }, 1500);
  });
}

export function chooseDefaultVoice(voices) {
  if (!voices || !voices.length) return { voice: null, notice: 'No speech voices are available on this device.' };

  const enGB = voices.filter((v) => /^en-GB/i.test(v.lang));
  const enGBFemale = enGB.find((v) => FEMALE_NAME_PATTERN.test(v.name));
  if (enGBFemale) return { voice: enGBFemale, notice: null };

  if (enGB.length) return { voice: enGB[0], notice: null };

  const anyEnglish = voices.find((v) => /^en/i.test(v.lang)) || voices[0];
  return {
    voice: anyEnglish,
    notice: `No British voice found on this device — using ${anyEnglish.name} instead. More voices may be available under your phone's Settings > Accessibility > Text-to-Speech.`,
  };
}

export function groupVoicesByLanguage(voices) {
  const groups = {};
  for (const v of voices) {
    const key = v.lang || 'Unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(v);
  }
  return groups;
}

export function getStoredVoiceURI() {
  return localStorage.getItem(STORAGE_KEY);
}

export function setStoredVoiceURI(voiceURI) {
  localStorage.setItem(STORAGE_KEY, voiceURI);
}

// Resolves the active voice: stored preference if it still exists on this
// device, otherwise runs the default-selection logic and persists the result.
export async function initVoice() {
  const voices = await getVoicesAsync();
  const storedURI = getStoredVoiceURI();
  if (storedURI) {
    const match = voices.find((v) => v.voiceURI === storedURI);
    if (match) return { voice: match, notice: null, voices };
  }
  const { voice, notice } = chooseDefaultVoice(voices);
  if (voice) setStoredVoiceURI(voice.voiceURI);
  return { voice, notice, voices };
}
