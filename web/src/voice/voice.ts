/**
 * Voice: speech recognition (Web Speech API — Safari uses Apple's on-device /
 * Siri dictation) and speech synthesis with a British-English voice.
 *
 * iPadOS realities handled here:
 *  - Recognition needs Siri & Dictation enabled and microphone permission.
 *  - Speech synthesis must first be triggered inside a user gesture.
 *  - Continuous background listening is not possible in a web app; listening
 *    is push-to-talk or "conversation mode" while the app is open.
 */

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string; confidence: number } }> }) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type RecCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): RecCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const voiceSupport = {
  recognition: typeof window !== 'undefined' && !!recognitionCtor(),
  synthesis: typeof window !== 'undefined' && 'speechSynthesis' in window,
};

const PREFERRED_GB = ['Daniel', 'Arthur', 'Oliver', 'Malcolm', 'Google UK English Male', 'Microsoft Ryan', 'Microsoft George', 'Serena', 'Kate'];

export function britishVoices(): SpeechSynthesisVoice[] {
  if (!voiceSupport.synthesis) return [];
  const all = speechSynthesis.getVoices();
  const gb = all.filter((v) => v.lang.replace('_', '-').toLowerCase() === 'en-gb');
  const rank = (v: SpeechSynthesisVoice) => {
    const i = PREFERRED_GB.findIndex((n) => v.name.includes(n));
    return (i === -1 ? 50 : i) - (/(enhanced|premium)/i.test(v.name) ? 5 : 0);
  };
  return gb.sort((a, b) => rank(a) - rank(b));
}

export function pickVoice(name: string | null): SpeechSynthesisVoice | null {
  if (!voiceSupport.synthesis) return null;
  const all = speechSynthesis.getVoices();
  if (name) {
    const v = all.find((x) => x.name === name);
    if (v) return v;
  }
  return britishVoices()[0] ?? all.find((v) => v.lang.toLowerCase().startsWith('en')) ?? null;
}

/** Turns a markdown reply into something pleasant to hear. */
export function speakable(text: string, max = 700): string {
  let t = text
    .replace(/```[\s\S]*?```/g, ' I have put the code on screen. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    t = `${end > 200 ? cut.slice(0, end + 1) : cut} The rest is on screen.`;
  }
  return t;
}

export interface ListenHandlers {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

class VoiceController {
  private rec: SpeechRecognitionLike | null = null;
  private speakingUtterance: SpeechSynthesisUtterance | null = null;
  private primed = false;

  /** Call inside a user gesture to unlock speech synthesis on iOS. */
  prime() {
    if (this.primed || !voiceSupport.synthesis) return;
    this.primed = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
  }

  listen(h: ListenHandlers): boolean {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      h.onError?.('Speech recognition is not available in this browser. On iPad, use Safari with Siri & Dictation enabled, or type instead.');
      return false;
    }
    this.stopListening();
    this.cancelSpeech();
    const rec = new Ctor();
    rec.lang = 'en-GB';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      h.onInterim?.((finalText + ' ' + interim).trim());
    };
    rec.onerror = (e) => {
      const map: Record<string, string> = {
        'not-allowed': 'Microphone permission was denied. Allow it in Settings → Safari → Microphone.',
        'service-not-allowed': 'Speech recognition is unavailable. Enable Siri & Dictation in iPad Settings.',
        'no-speech': 'I did not catch anything.',
        network: 'Speech recognition needs a network connection.',
        aborted: '',
      };
      const msg = map[e.error] ?? `Speech recognition error: ${e.error}`;
      if (msg) h.onError?.(msg);
    };
    rec.onend = () => {
      this.rec = null;
      if (finalText.trim()) h.onFinal(finalText.trim());
      h.onEnd?.();
    };
    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      h.onError?.(err instanceof Error ? err.message : String(err));
      return false;
    }
    return true;
  }

  stopListening() {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
  }

  get listening() {
    return !!this.rec;
  }

  speak(text: string, opts: { voiceName: string | null; rate: number; pitch: number; onStart?: () => void; onEnd?: () => void; onBoundary?: () => void }) {
    if (!voiceSupport.synthesis || !text.trim()) {
      opts.onEnd?.();
      return;
    }
    this.cancelSpeech();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(opts.voiceName);
    if (v) u.voice = v;
    u.lang = v?.lang ?? 'en-GB';
    u.rate = opts.rate;
    u.pitch = opts.pitch;
    u.onstart = () => opts.onStart?.();
    u.onend = () => {
      if (this.speakingUtterance === u) this.speakingUtterance = null;
      opts.onEnd?.();
    };
    u.onerror = () => {
      if (this.speakingUtterance === u) this.speakingUtterance = null;
      opts.onEnd?.();
    };
    u.onboundary = () => opts.onBoundary?.();
    this.speakingUtterance = u;
    speechSynthesis.speak(u);
  }

  cancelSpeech() {
    if (voiceSupport.synthesis && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    this.speakingUtterance = null;
  }

  get speaking() {
    return !!this.speakingUtterance;
  }
}

export const voice = new VoiceController();
