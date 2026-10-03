// Speech-to-text. The words are made by the phone's own speech service (Apple's on an iPhone, Google's on Android), so the AUDIO leaves
// the phone while you speak, and nothing else does. What the words mean is decided in src/model/speech.js. Typing into the box, or
// the keyboard's microphone key, works even where this does not.
const Recognizer = () => window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechSupported = () => Boolean(Recognizer());

// Starts listening. onText(textSoFar, isFinal) as words come in; onDone() when it stops; onError(code) on a problem.
// Returns {stop}.
export function listen({ lang, onText, onDone, onError }) {
  const rec = new (Recognizer())();
  rec.lang = lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  rec.onresult = (e) => { const r = [...e.results]; onText(r.map((x) => x[0].transcript).join(" ").trim(), r[r.length - 1].isFinal); };
  rec.onerror = (e) => onError(e.error);
  rec.onend = onDone;
  rec.start();
  return { stop: () => rec.stop() };
}
