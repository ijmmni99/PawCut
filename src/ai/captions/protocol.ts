// Messages between the main thread and the transcription worker.

/** Captions are Malay-only (the owner's audience); fixing the language also stops Whisper guessing wrong. */
export type CaptionLanguage = 'malay';

/** One stretch of speech to transcribe: a source file window placed on the timeline. */
export type SpeechSource = {
  /** OPFS path of the audio/video file (proxy for video clips, library file for voiceovers). */
  path: string;
  inSec: number;
  outSec: number;
  /** Timeline time of `inSec`, and the playback speed (timeline = start + (source − inSec) / speed). */
  timelineStart: number;
  speed: number;
};

export type TranscribeRequest = {
  type: 'transcribe';
  sources: SpeechSource[];
  language: CaptionLanguage;
  /** 'base' = Fast, 'small' = Best quality; 'tiny' keeps automated tests quick. */
  model: 'base' | 'small' | 'tiny';
  /** Vocabulary hint for Whisper ("prompt"): names and the English words mixed into the Malay. */
  prompt?: string;
};

export type TimedWord = { text: string; start: number; end: number };

export type TranscribeEvent =
  | { type: 'progress'; stage: 'download' | 'audio' | 'transcribe'; progress: number }
  | { type: 'done'; words: TimedWord[] }
  | { type: 'error'; message: string };
