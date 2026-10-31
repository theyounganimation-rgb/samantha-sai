// Background filtering otherwise selects ElevenLabs' more sensitive default.
// Keep the original short endpoint. Continued speech cancels and restarts a
// pending reply instead of adding a thinking-pause delay to every response.
export function transcriptionURL() {
  const url=new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  url.search=new URLSearchParams({
    model_id:'scribe_v2_realtime',audio_format:'pcm_16000',commit_strategy:'vad',
    vad_threshold:'0.65',vad_silence_threshold_secs:'0.7',
    min_speech_duration_ms:'250',min_silence_duration_ms:'150',
    language_code:'en',filter_background_audio:'true'
  }).toString();
  return url;
}
