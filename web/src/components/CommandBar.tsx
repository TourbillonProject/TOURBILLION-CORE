import { useState } from 'react';
import { runCommand } from '../lib/commands';
import { getState, setState, toast, useStore } from '../lib/store';
import { voice, voiceSupport } from '../voice/voice';
import { sound } from '../audio/sound';
import { Icon } from './icons';

/** Text + push-to-talk voice command input. */
export function CommandBar({ placeholder = 'Command TOURBILLION…' }: { placeholder?: string }) {
  const [text, setText] = useState('');
  const v = useStore((s) => s.voice);

  const submit = (value: string, spoken: boolean) => {
    if (!value.trim()) return;
    setText('');
    void runCommand(value, { spoken });
  };

  const toggleMic = () => {
    if (v.speaking) {
      voice.cancelSpeech();
      setState((s) => ({ voice: { ...s.voice, speaking: false } }));
      return;
    }
    if (v.listening) {
      voice.stopListening();
      return;
    }
    if (!voiceSupport.recognition) {
      toast('warning', 'Voice input unavailable', 'This browser has no speech recognition. On iPad use Safari with Siri & Dictation enabled — or type your command.');
      return;
    }
    sound.play('listen');
    const started = voice.listen({
      onInterim: (t) => {
        setState((s) => ({ voice: { ...s.voice, interim: t, level: 0.65 } }));
        setTimeout(() => setState((s) => ({ voice: { ...s.voice, level: Math.max(0.12, s.voice.level * 0.4) } })), 140);
      },
      onFinal: (t) => submit(t, true),
      onEnd: () => setState((s) => ({ voice: { ...s.voice, listening: false, interim: '', level: 0 } })),
      onError: (m) => {
        sound.play('error');
        toast('warning', 'Voice', m);
      },
    });
    if (started) setState((s) => ({ voice: { ...s.voice, listening: true, interim: '' } }));
  };

  return (
    <div>
      {v.interim && <div className="interim">“{v.interim}”</div>}
      <form
        className="cmdbar"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text, false);
        }}
      >
        <button type="button" className={`mic ${v.listening ? 'on' : ''} ${v.speaking ? 'speaking' : ''}`} onClick={toggleMic} aria-label={v.listening ? 'Stop listening' : v.speaking ? 'Stop speaking' : 'Start voice command'} data-testid="mic">
          <Icon name={v.speaking || v.listening ? 'stop' : 'mic'} size={24} />
        </button>
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={v.listening ? 'Listening…' : placeholder}
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="on"
          aria-label="Command"
          data-testid="command-input"
        />
        <button type="submit" className="btn primary icon" aria-label="Send" disabled={!text.trim()}>
          <Icon name="send" size={20} />
        </button>
      </form>
    </div>
  );
}

export function isVoiceBusy() {
  const v = getState().voice;
  return v.listening || v.speaking;
}
