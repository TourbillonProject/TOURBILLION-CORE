import { describe, expect, it } from 'vitest';
import { parseIntent, stripWake } from './intents';

describe('wake phrase', () => {
  it('strips common transcriptions of the wake word', () => {
    expect(stripWake('Tourbillion, open YouTube', 'Tourbillion')).toEqual({ text: 'open YouTube', woke: true });
    expect(stripWake('tour billion open youtube', 'Tourbillion').woke).toBe(true);
    expect(stripWake('Hey Tourbillon: run diagnostics', 'Tourbillion').text).toBe('run diagnostics');
    expect(stripWake('open youtube', 'Tourbillion').woke).toBe(false);
  });
});

describe('intents', () => {
  it('opens YouTube', () => {
    expect(parseIntent('Tourbillion, open YouTube.')).toEqual({ kind: 'youtube', query: null });
    expect(parseIntent('search YouTube for orbital mechanics')).toEqual({ kind: 'youtube', query: 'orbital mechanics' });
    expect(parseIntent('play lo-fi beats on YouTube')).toEqual({ kind: 'youtube', query: 'lo-fi beats' });
  });
  it('runs diagnostics', () => {
    expect(parseIntent('Tourbillion, initiate system diagnostics.')).toEqual({ kind: 'diagnostics' });
  });
  it('routes Spider requests and leaves "this project" ambiguous', () => {
    expect(parseIntent('Tourbillion, ask the Spider to inspect this project')).toEqual({ kind: 'spider_inspect', project: null });
    expect(parseIntent('ask the spider to inspect project atlas')).toEqual({ kind: 'spider_inspect', project: 'atlas' });
  });
  it('routes research and flags ambiguity', () => {
    expect(parseIntent('Tourbillion, research this company')).toEqual({ kind: 'research', target: null });
    expect(parseIntent('research example.com')).toEqual({ kind: 'research', target: 'example.com' });
  });
  it('navigates and opens URLs', () => {
    expect(parseIntent('open the missions')).toEqual({ kind: 'navigate', section: 'missions' });
    expect(parseIntent('go to settings')).toEqual({ kind: 'navigate', section: 'settings' });
    expect(parseIntent('open wikipedia.org')).toEqual({ kind: 'open_url', url: 'https://wikipedia.org' });
  });
  it('passes everything else to Core', () => {
    expect(parseIntent('Tourbillion, prepare a Blender scene with a rotating watch movement')).toEqual({ kind: 'ask', text: 'prepare a Blender scene with a rotating watch movement' });
    expect(parseIntent('stop')).toEqual({ kind: 'stop' });
  });
});
