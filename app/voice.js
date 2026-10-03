// Speech-to-text. The words are made by the phone's own speech service (Apple's on an iPhone, Google's on Android), so the AUDIO leaves
// the phone while you speak, and nothing else does. What the words mean is decided in src/model/speech.js. Typing into the box, or
// the keyboard's microphone key, works even where this does not.
const Recognizer = () => window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechSupported = () => Boolean(Recognizer());

const IDLE_MS = 8000, MAX_MS = 60000;   // stop after this long with no new words, or in all

// Starts listening and KEEPS listening: many phones end one recognition after about a second of quiet, so it is restarted and the
// words are joined, until you tap stop, or nothing new is heard for IDLE_MS, or MAX_MS have passed.
// onText(textSoFar) as words come in; onDone() when it has really stopped; onError(code) on a problem that ends it. Returns {stop}.
export function listen({ lang, onText, onDone, onError, startText = "" }) {
  let stopped = false, rec = null, base = startText.trim(), current = base, idle = null;
  const began = Date.now();
  const finish = () => { if (stopped === "done") return; stopped = "done"; clearTimeout(idle); onDone(); };
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => { stopped = true; try { rec?.stop(); } catch { finish(); } }, IDLE_MS); };
  const begin = () => {
    rec = new (Recognizer())();
    rec.lang = lang; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const heard = [...e.results].map((x) => x[0].transcript).join(" ").trim();
      current = (base + " " + heard).trim();
      onText(current); bump();
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;   // quiet, or we stopped it: the end handler decides
      stopped = true; onError(e.error);
    };
    rec.onend = () => {
      base = current;   // what was heard so far stays; the next round adds to it
      if (stopped || Date.now() - began > MAX_MS) { finish(); return; }
      setTimeout(() => { if (!stopped) { try { begin(); } catch { finish(); } } }, 120);
    };
    rec.start();
  };
  begin(); bump();
  return { stop: () => { stopped = true; try { rec?.stop(); } catch { finish(); } } };
}
