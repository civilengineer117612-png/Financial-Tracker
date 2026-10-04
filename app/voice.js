// Speech-to-text. The words are made by the phone's own speech service (Apple's on an iPhone, Google's on Android), so the AUDIO leaves
// the phone while you speak, and nothing else does. What the words mean is decided in src/model/speech.js. Typing into the box, or
// the keyboard's microphone key, works even where this does not.
const Recognizer = () => window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechSupported = () => Boolean(Recognizer());

// Which language to listen for first: Filipino if the phone is set to it, else English (Philippines). The speech services cannot work out the
// language by themselves, so the app tries the other one on the next tap when it could not catch anything (see `other`).
export const firstLanguage = () => ((navigator.languages ?? [navigator.language ?? ""]).some((l) => /^(fil|tl)\b/i.test(l)) ? "fil-PH" : "en-PH");
export const other = (lang) => (lang === "fil-PH" ? "en-PH" : "fil-PH");

// Listens ONCE for one sentence. A phone's speech service opens the microphone, hears you, and closes it when you pause; opening it again
// and again made the microphone flicker and lose words, so this does not restart it: tap again for more.
// onText(textSoFar) as words come in (what was in the box before is kept in front); onDone({heard, confidence}) when it has stopped
// (confidence 0..1, or null when the service gives none); onError(code) on a problem that ends it. Returns {stop}.
export function listen({ lang, onText, onDone, onError, startText = "" }) {
  const base = startText.trim();
  let rec = null, ended = false, heard = "", confidence = null, failed = false;
  const finish = () => { if (ended) return; ended = true; if (!failed) onDone({ heard: heard.length > 0, confidence }); };
  rec = new (Recognizer())();
  rec.lang = lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const parts = [...e.results];
    heard = parts.map((x) => x[0].transcript).join(" ").trim();
    const last = parts[parts.length - 1]?.[0];
    confidence = typeof last?.confidence === "number" && last.confidence > 0 ? last.confidence : confidence;
    onText((base + " " + heard).trim());
  };
  rec.onerror = (e) => {
    if (e.error === "aborted") return;   // we stopped it
    if (e.error === "no-speech") return;   // quiet: the end handler reports that nothing was heard
    failed = true; onError(e.error);
  };
  rec.onend = finish;
  rec.start();
  return { stop: () => { try { rec.stop(); } catch { finish(); } } };
}
