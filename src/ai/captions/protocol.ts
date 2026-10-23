// Messages between the main thread and the transcription worker.

export type CaptionLanguage = 'auto' | 'english' | 'malay' | 'chinese';

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
  /** 'base' for real use; 'tiny' keeps automated tests quick. */
  model: 'base' | 'tiny';
};

export type TimedWord = { text: string; start: number; end: number };

export type TranscribeEvent =
  | { type: 'progress'; stage: 'download' | 'audio' | 'transcribe'; progress: number }
  | { type: 'done'; words: TimedWord[] }
  | { type: 'error'; message: string };
