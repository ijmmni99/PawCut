// iOS audio session (Safari 17+). 'playback' plays through the silent switch like a video app, but iOS refuses
// microphone capture in that mode ("AudioSession category is not compatible with audio capture"), so recording
// switches to 'play-and-record' and back afterwards.
type AudioSessionType = 'auto' | 'playback' | 'play-and-record' | 'transient' | 'transient-solo' | 'ambient';
type AudioSessionNavigator = Navigator & { audioSession?: { type: AudioSessionType } };

export function setAudioSession(type: AudioSessionType): void {
  const session = (navigator as AudioSessionNavigator).audioSession;
  if (session) session.type = type;
}
