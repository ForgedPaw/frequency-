// speechSynthesis wrapper — applies the stored voice preference to every utterance.

import { getStoredVoiceURI, initVoice } from './voicePicker.js';
import { abortActive } from './recognize.js';

let activeVoice = null;
let onSpeakCallback = null; // (text) => void, used to mirror lines into the transcript log

// Buffer after TTS ends before we start listening again — speechSynthesis's
// 'end' event can fire slightly before the audio has actually finished
// coming out of the speaker, and without this gap the mic catches the tail
// of the DJ's own voice and misreads it as a user utterance.
const POST_SPEECH_GRACE_MS = 200;

export async function setupSpeech() {
  const { voice, notice, voices } = await initVoice();
  activeVoice = voice;
  return { voice, notice, voices };
}

export function setActiveVoiceURI(voiceURI) {
  const voices = speechSynthesis.getVoices();
  const match = voices.find((v) => v.voiceURI === voiceURI);
  if (match) activeVoice = match;
}

export function onSpeak(callback) {
  onSpeakCallback = callback;
}

export function speak(text, onDone) {
  if (onSpeakCallback) onSpeakCallback(text);
  // Never let a recognizer keep listening while we talk — it would just
  // transcribe our own voice.
  abortActive();
  try {
    const u = new SpeechSynthesisUtterance(text);
    if (!activeVoice) {
      const storedURI = getStoredVoiceURI();
      const voices = speechSynthesis.getVoices();
      activeVoice = voices.find((v) => v.voiceURI === storedURI) || null;
    }
    if (activeVoice) u.voice = activeVoice;
    u.rate = 1.02;
    u.pitch = 1.0;

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (onDone) setTimeout(onDone, POST_SPEECH_GRACE_MS);
    };
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) {
    if (onDone) setTimeout(onDone, POST_SPEECH_GRACE_MS);
  }
}

export function testVoice(voice) {
  try {
    const u = new SpeechSynthesisUtterance('Ready for the next question?');
    u.voice = voice;
    u.rate = 1.02;
    u.pitch = 1.0;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) { /* no-op */ }
}
