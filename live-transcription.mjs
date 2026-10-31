import { WebSocket } from 'ws';

const RATE = 48_000; // PCM16, mono, 24 kHz
const FRAME_BYTES = 960;

/** Two isolated ASR streams. Speaker identity comes from the audio socket,
 * never a model's speaker label or the arrival order of Live transcript deltas.
 * PCM is bounded in memory and is never written to disk. */
export async function createChannelTranscriber({ key, onTranscript, onError,
  createSocket = (url, options) => new WebSocket(url, options),
  silenceMs = 600, threshold = 240, maxTurnMs = 15_000, drainMs = 4000,
}) {
  let disposed = false;
  let draining = false;
  const channels = new Map();
  let keywords = [];
  const configuration = () => ({type:'session.update',session:{type:'transcription',audio:{input:{
    format:{type:'audio/pcm',rate:24000},
    transcription:{model:'gpt-live-transcribe',delay:'low',languages:['en'],keywords},turn_detection:null,
  }}}});
  const completedQueue = [];
  function publishCompleted(force = false) {
    const unfinished = [...channels.values()].flatMap(channel => [
      ...(channel.active ? [channel.active.startMs] : []),
      ...channel.awaitingIds.map(item => item.startMs),
      ...[...channel.items.values()].map(item => item.startMs),
    ]);
    const boundary = force ? Infinity : Math.min(Infinity, ...unfinished);
    completedQueue.sort((a,b) => a.start_ms - b.start_ms || (a.role === 'user' ? -1 : 1));
    while (completedQueue.length && completedQueue[0].start_ms < boundary) onTranscript(completedQueue.shift());
  }
  const fail = (code = 'transcription_unavailable',channel) => {
    if (!disposed && !draining) onError(Object.assign(new Error('Channel transcription unavailable.'), {code,channel}));
  };
  const ready = ['user', 'assistant'].map(role => new Promise((resolve, reject) => {
    const socket = createSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${key}` }, maxPayload: 1024 * 1024,
    });
    const channel = { role, socket, ready: false, cursor: 0, carry: Buffer.alloc(0), pre: [],
      active: null, awaitingIds: [], items: new Map(), completed: new Set(), waiters: [], pending: 0 };
    channels.set(role, channel);
    const timer = setTimeout(() => { reject(new Error('Transcription startup timed out.')); socket.terminate(); }, 12_000);
    channel.send = event => {
      if (disposed || socket.readyState !== WebSocket.OPEN) return;
      const data = JSON.stringify(event);
      if (socket.bufferedAmount + Buffer.byteLength(data) > 512 * 1024) { fail(); return; }
      socket.send(data);
    };
    const settle = () => {
      if (!channel.pending) channel.waiters.splice(0).forEach(done => done());
    };
    socket.on('open', () => channel.send(configuration()));
    socket.on('message', raw => {
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.updated') {
          channel.ready = true; clearTimeout(timer); resolve();
        } else if (event.type === 'input_audio_buffer.committed') {
          const interval = channel.awaitingIds.shift();
          if (!interval || typeof event.item_id !== 'string') return fail();
          channel.items.set(event.item_id, interval);
        } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
          if (channel.completed.has(event.item_id)) return;
          const interval = channel.items.get(event.item_id);
          if (!interval || typeof event.transcript !== 'string') return fail();
          channel.completed.add(event.item_id);
          channel.items.delete(event.item_id);
          // Completion is authoritative; incremental hypotheses are never saved
          // or used as durable memory and cannot leak across speaker channels.
          if (event.transcript.trim()) completedQueue.push({
            type: 'channel.transcript', complete: true, role, event_id: `asr:${role}:${event.item_id}`,
            delta: event.transcript, start_ms: interval.startMs, end_ms: interval.endMs,
          });
          channel.pending -= 1; publishCompleted(); settle();
          if (channel.completed.size > 256) channel.completed.delete(channel.completed.values().next().value);
        } else if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') {
          if (!channel.ready) reject(new Error('Transcription configuration rejected.'));
          fail(event.error?.code || 'transcription_unavailable',role);
        }
      } catch { fail(); }
    });
    socket.on('error', () => { clearTimeout(timer); reject(new Error('Transcription connection failed.')); fail(); });
    socket.on('close', () => { clearTimeout(timer); if (!channel.ready) reject(new Error('Transcription connection closed.')); fail(); });
    channel.commit = () => {
      if (!channel.active) return;
      channel.awaitingIds.push({ startMs: channel.active.startMs, endMs: channel.active.lastSpeechMs });
      channel.pending += 1;
      channel.active = null;
      if (channel.pending > 16) return fail();
      channel.send({ type: 'input_audio_buffer.commit' });
    };
    channel.frame = data => {
      const startMs = channel.cursor;
      channel.cursor += data.length / RATE * 1000;
      let energy = 0;
      for (let i = 0; i < data.length; i += 2) energy += data.readInt16LE(i) ** 2;
      const speaking = Math.sqrt(energy / (data.length / 2)) >= threshold;
      if (!channel.active && !speaking) {
        channel.pre.push({ data, startMs });
        if (channel.pre.length > 15) channel.pre.shift();
        return;
      }
      if (!channel.active) {
        channel.active = { startMs: channel.pre[0]?.startMs ?? startMs, lastSpeechMs: channel.cursor };
        for (const part of channel.pre) channel.send({ type: 'input_audio_buffer.append', audio: part.data.toString('base64') });
        channel.pre = [];
      }
      channel.send({ type: 'input_audio_buffer.append', audio: data.toString('base64') });
      if (speaking) channel.active.lastSpeechMs = channel.cursor;
      if (channel.cursor - channel.active.lastSpeechMs >= silenceMs || channel.cursor - channel.active.startMs >= maxTurnMs) channel.commit();
    };
  }));
  function abort() {
    disposed = true;
    for (const channel of channels.values()) {
      channel.socket.terminate(); channel.pre = []; channel.carry = Buffer.alloc(0);
      channel.waiters.splice(0).forEach(done => done());
    }
  }
  try { await Promise.all(ready); } catch (error) { abort(); throw error; }
  return {
    setKeywords(values) {
      const next = [...new Set(values.filter(value => typeof value === 'string' && value.length <= 80 && /^[\p{L} '-]+$/u.test(value)))].slice(0,12);
      if (JSON.stringify(next) === JSON.stringify(keywords) || disposed || draining) return;
      keywords = next;
      for (const channel of channels.values()) channel.send(configuration());
    },
    append(role, bytes, offsetMs) {
      if (disposed || draining || !Buffer.isBuffer(bytes)) return;
      const channel = channels.get(role);
      if (!channel) return;
      // The relay supplies elapsed call time for microphone frames. Muting or
      // a delivery gap must not compress the caller's transcript timeline.
      if (Number.isFinite(offsetMs)) channel.cursor = Math.max(channel.cursor, offsetMs);
      const data = Buffer.concat([channel.carry, bytes]);
      let offset = 0;
      for (; offset + FRAME_BYTES <= data.length; offset += FRAME_BYTES) channel.frame(data.subarray(offset, offset + FRAME_BYTES));
      channel.carry = Buffer.from(data.subarray(offset));
    },
    hasPending(role) { const channel = channels.get(role); return !!(channel?.active || channel?.pending); },
    flush(role) {
      const channel = channels.get(role);
      if (!channel || disposed || draining) return;
      if (channel.carry.length) channel.frame(channel.carry);
      channel.carry = Buffer.alloc(0);
      if (channel.active) {
        channel.send({type:'input_audio_buffer.append',audio:Buffer.alloc(RATE / 5).toString('base64')});
        channel.commit();
      }
    },
    async finish() {
      if (disposed) return;
      draining = true;
      for (const channel of channels.values()) {
        if (channel.carry.length) channel.frame(channel.carry);
        channel.carry = Buffer.alloc(0);
        if (channel.active) {
          // Flush the final syllable even if the caller hangs up without silence.
          channel.send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(RATE / 5).toString('base64') });
          channel.commit();
        }
      }
      let timer;
      await Promise.race([
        Promise.all([...channels.values()].map(channel => channel.pending ? new Promise(resolve => channel.waiters.push(resolve)) : null)),
        new Promise(resolve => { timer = setTimeout(resolve, drainMs); }),
      ]);
      clearTimeout(timer);
      const complete = [...channels.values()].every(channel => !channel.pending);
      publishCompleted(true);
      abort();
      return complete;
    },
    abort,
  };
}
