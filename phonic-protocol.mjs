// Isolated Phonic STS protocol primitives. No network or SAI runtime wiring.
export const MAX_PCM16_BYTES = 1280; // 40 ms at 16 kHz mono
export function splitInputAudio(input) {
  const bytes = Buffer.from(input);
  if (bytes.length % 2) throw new Error('PCM input must contain whole 16-bit samples');
  const result = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_PCM16_BYTES) {
    result.push({type: 'audio_chunk', audio: bytes.subarray(offset, offset + MAX_PCM16_BYTES).toString('base64')});
  }
  return result;
}
export function phonicConfig({prompt, voice = 'sabrina', tools = []}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A live Samantha context is required');
  return {type: 'config', model: 'phonic-1', system_prompt: prompt, voice_id: voice,
    input_format: 'pcm_16000', output_format: 'pcm_24000', generate_welcome_message: false,
    stream_ahead_of_real_time: false, no_input_end_conversation_sec: 600, tools};
}
export function websocketTool(name, description, properties, required, timeout = 12000) {
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 180000) throw new Error('Invalid tool timeout');
  return {type: 'custom_websocket', tool_schema: {type: 'function', function: {name, description,
    parameters: {type: 'object', properties, required, additionalProperties: false}, strict: true}},
    execution_mode: 'sync', require_speech_before_tool_call: false, tool_call_output_timeout_ms: timeout};
}
