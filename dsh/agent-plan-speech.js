import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket, {} from 'ws';
const ASR_ASYNC_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async';
const ASR_FINAL_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream';
const ASR_RESOURCE_ID = 'volc.seedasr.sauc.duration';
const TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional';
const TTS_RESOURCE_ID = 'seed-tts-2.0';
const DEFAULT_TTS_SPEAKER = 'zh_female_vv_uranus_bigtts';
const MAX_TTS_TEXT_CHARS = 10_000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_PCM_BYTES = 30 * 48_000 * 2;
const SEGMENT_MS = 200;
const MESSAGE = {
    clientFull: 0x1,
    clientAudio: 0x2,
    serverFull: 0x9,
    serverError: 0xf,
};
function requestHeader(messageType, flags) {
    return Buffer.from([0x11, (messageType << 4) | flags, 0x11, 0x00]);
}
function framed(messageType, sequence, payload, last = false) {
    const compressed = gzipSync(payload);
    const frame = Buffer.allocUnsafe(12 + compressed.length);
    requestHeader(messageType, last ? 0x3 : 0x1).copy(frame, 0);
    frame.writeInt32BE(last ? -Math.abs(sequence) : sequence, 4);
    frame.writeUInt32BE(compressed.length, 8);
    compressed.copy(frame, 12);
    return frame;
}
function wavPcm16(pcm, sampleRate, channels) {
    const header = Buffer.alloc(44);
    const bytesPerSample = 2;
    const byteRate = sampleRate * channels * bytesPerSample;
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(channels * bytesPerSample, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}
function parseResponse(data) {
    const message = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (message.length < 4)
        throw new Error('Seed ASR returned a truncated protocol header');
    const headerBytes = (message[0] & 0x0f) * 4;
    const messageType = message[1] >> 4;
    const flags = message[1] & 0x0f;
    const serialization = message[2] >> 4;
    const compression = message[2] & 0x0f;
    let offset = headerBytes;
    if ((flags & 0x01) !== 0)
        offset += 4;
    if ((flags & 0x04) !== 0)
        offset += 4;
    let errorCode = 0;
    let payloadSize = 0;
    if (messageType === MESSAGE.serverFull) {
        if (message.length < offset + 4)
            throw new Error('Seed ASR response has no payload size');
        payloadSize = message.readUInt32BE(offset);
        offset += 4;
    }
    else if (messageType === MESSAGE.serverError) {
        if (message.length < offset + 8)
            throw new Error('Seed ASR error response is truncated');
        errorCode = message.readInt32BE(offset);
        payloadSize = message.readUInt32BE(offset + 4);
        offset += 8;
    }
    else {
        return { errorCode, last: (flags & 0x02) !== 0 };
    }
    let payload = message.subarray(offset, offset + payloadSize);
    if (compression === 0x1 && payload.length > 0)
        payload = gunzipSync(payload);
    let decoded;
    if (payload.length > 0) {
        const text = payload.toString('utf8');
        decoded = serialization === 0x1 ? JSON.parse(text) : text;
    }
    return { errorCode, last: (flags & 0x02) !== 0, ...(decoded === undefined ? {} : { payload: decoded }) };
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function textFromPayload(payload) {
    const root = record(payload);
    if (!root)
        return '';
    if (typeof root.text === 'string')
        return root.text.trim();
    const result = record(root.result);
    if (typeof result?.text === 'string')
        return result.text.trim();
    const utterances = Array.isArray(result?.utterances) ? result.utterances : Array.isArray(root.utterances) ? root.utterances : [];
    return utterances.map(item => record(item)?.text).filter((text) => typeof text === 'string').join('').trim();
}
function positiveInteger(value, fallback) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
async function transcribe(input, signal, options) {
    let pcm;
    let sampleRate;
    let channels;
    if (typeof input.request.inputArtifactId === 'string') {
        if (!options.audioArtifacts || typeof options.audioArtifacts.takeInput !== 'function')
            throw new Error('Seed ASR audio artifact store is unavailable');
        const artifact = options.audioArtifacts.takeInput(input.request.inputArtifactId);
        pcm = artifact.pcm;
        sampleRate = artifact.sampleRate;
        channels = artifact.channels;
    }
    else {
        const base64 = typeof input.request.pcm16Base64 === 'string' ? input.request.pcm16Base64 : '';
        if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
            throw new Error('Seed ASR requires a captured audio artifact');
        pcm = Buffer.from(base64, 'base64');
        sampleRate = positiveInteger(input.request.sampleRate, 16_000);
        channels = positiveInteger(input.request.channels, 1);
    }
    if (pcm.length === 0 || pcm.length > MAX_PCM_BYTES || pcm.length % 2 !== 0)
        throw new Error('Seed ASR audio must contain aligned mono PCM of at most 30 seconds');
    if (channels !== 1 || sampleRate < 8_000 || sampleRate > 48_000)
        throw new Error('Seed ASR requires mono PCM at 8kHz–48kHz');
    const apiKey = input.credentials.apiKey;
    if (!apiKey)
        throw new Error('Seed ASR Agent Plan API key is unavailable');
    const finalOnly = input.operation === 'transcribe-file' || input.request.finalOnly === true;
    const endpoint = finalOnly ? options.asrFinalEndpoint ?? ASR_FINAL_ENDPOINT : options.asrAsyncEndpoint ?? ASR_ASYNC_ENDPOINT;
    const requestId = randomUUID();
    const wav = wavPcm16(pcm, sampleRate, channels);
    const chunkBytes = Math.max(1, Math.floor(sampleRate * channels * 2 * SEGMENT_MS / 1000));
    return new Promise((resolve, reject) => {
        let settled = false;
        let providerRequestId = requestId;
        let latestText = '';
        const socket = new WebSocket(endpoint, {
            headers: {
                'X-Api-Key': apiKey,
                'X-Api-Resource-Id': ASR_RESOURCE_ID,
                'X-Api-Request-Id': requestId,
                'X-Api-Connect-Id': requestId,
                'X-Api-Sequence': '-1',
            },
            maxPayload: 10 * 1024 * 1024,
        });
        const cleanup = () => signal.removeEventListener('abort', aborted);
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            socket.close();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const succeed = () => {
            if (settled)
                return;
            if (!latestText)
                return fail(new Error('Seed ASR returned no final text'));
            settled = true;
            cleanup();
            socket.close();
            resolve({ output: { text: latestText }, outputModalities: ['text'], metrics: { providerRequestId } });
        };
        const aborted = () => fail(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted)
            return aborted();
        socket.on('upgrade', response => {
            const logId = response.headers['x-tt-logid'];
            if (typeof logId === 'string' && logId)
                providerRequestId = logId;
        });
        socket.on('error', fail);
        socket.on('close', () => { if (!settled)
            succeed(); });
        socket.on('message', raw => {
            try {
                const response = parseResponse(raw);
                if (response.errorCode !== 0)
                    throw new Error(`Seed ASR failed with provider code ${response.errorCode}`);
                const next = textFromPayload(response.payload);
                if (next)
                    latestText = next;
                if (response.last)
                    succeed();
            }
            catch (error) {
                fail(error);
            }
        });
        socket.on('open', () => {
            try {
                const fullRequest = Buffer.from(JSON.stringify({
                    user: { uid: 'dsh-session-assistant' },
                    audio: { format: 'wav', codec: 'raw', rate: sampleRate, bits: 16, channel: channels },
                    request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: true, show_utterances: true, enable_nonstream: finalOnly },
                }));
                let sequence = 1;
                socket.send(framed(MESSAGE.clientFull, sequence++, fullRequest));
                for (let offset = 0; offset < wav.length; offset += chunkBytes) {
                    const end = Math.min(offset + chunkBytes, wav.length);
                    socket.send(framed(MESSAGE.clientAudio, sequence++, wav.subarray(offset, end), end === wav.length));
                }
            }
            catch (error) {
                fail(error);
            }
        });
    });
}
function boundedText(value, name, max) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > max)
        throw new Error(`Seed TTS ${name} must contain 1–${max} characters`);
    return text;
}
function decodeAudioChunk(value) {
    if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
        throw new Error('Seed TTS returned malformed base64 audio');
    return Buffer.from(value, 'base64');
}
async function synthesize(input, signal, options) {
    const text = boundedText(input.request.text, 'text', MAX_TTS_TEXT_CHARS);
    const speaker = boundedText(input.request.speaker ?? DEFAULT_TTS_SPEAKER, 'speaker', 128);
    const format = input.request.format ?? 'mp3';
    const sampleRate = positiveInteger(input.request.sampleRate, 24000);
    if (format !== 'mp3')
        throw new Error("Seed TTS composed mode currently supports only 'mp3'");
    if (![16000, 24000, 32000, 48000].includes(sampleRate))
        throw new Error('Seed TTS sampleRate is unsupported');
    const apiKey = input.credentials.apiKey;
    if (!apiKey)
        throw new Error('Seed TTS Agent Plan API key is unavailable');
    if (!options.audioArtifacts || typeof options.audioArtifacts.put !== 'function')
        throw new Error('Seed TTS audio artifact store is unavailable');
    const requestId = randomUUID();
    const response = await fetch(options.ttsEndpoint ?? TTS_ENDPOINT, {
        method: 'POST',
        signal,
        headers: {
            'X-Api-Key': apiKey,
            'X-Api-Resource-Id': TTS_RESOURCE_ID,
            'X-Api-Connect-Id': requestId,
            'X-Control-Require-Usage-Tokens-Return': '*',
            'Content-Type': 'application/json',
            'Connection': 'keep-alive',
        },
        body: JSON.stringify({ req_params: { text, speaker, audio_params: { format, sample_rate: sampleRate } } }),
    });
    const providerRequestId = response.headers.get('x-tt-logid') || requestId;
    if (!response.ok || !response.body) {
        const details = (await response.text()).slice(0, 512).replace(/\s+/g, ' ');
        throw new Error(`Seed TTS HTTP ${response.status}${details ? `: ${details}` : ''}`);
    }
    const decoder = new TextDecoder();
    let pending = '';
    let total = 0;
    const chunks = [];
    const acceptLine = line => {
        const value = line.trim();
        if (!value)
            return;
        let message;
        try {
            message = JSON.parse(value);
        }
        catch {
            throw new Error('Seed TTS returned malformed JSON stream data');
        }
        const code = typeof message.code === 'number' ? message.code : 0;
        if (code === 20000000)
            return;
        if (code > 0)
            throw new Error(`Seed TTS failed with provider code ${code}`);
        if (message.data) {
            const chunk = decodeAudioChunk(message.data);
            total += chunk.length;
            if (total > MAX_AUDIO_BYTES)
                throw new Error('Seed TTS audio exceeds 12 MiB');
            chunks.push(chunk);
        }
    };
    for await (const raw of response.body) {
        pending += decoder.decode(raw, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            acceptLine(line);
        }
    }
    pending += decoder.decode();
    if (pending.trim())
        acceptLine(pending);
    if (!total)
        throw new Error('Seed TTS returned no audio data');
    const uri = options.audioArtifacts.put(Buffer.concat(chunks, total), 'audio/mpeg');
    return { output: { uri, mediaType: 'audio/mpeg' }, outputModalities: ['audio'], metrics: { providerRequestId, outputUnits: total } };
}
export function doubaoAgentPlanSpeechAdapter(options = {}) {
    return {
        id: 'doubao-speech-agent-plan',
        available: route => route.registration.model === ASR_RESOURCE_ID && route.registration.task === 'transcription'
            || route.registration.model === TTS_RESOURCE_ID && route.registration.task === 'speech-synthesis' && route.registration.execution === 'request-response',
        invoke: (request, signal) => {
            if (request.route.registration.task === 'transcription')
                return transcribe(request, signal, options);
            if (request.route.registration.task === 'speech-synthesis' && request.operation === 'synthesize')
                return synthesize(request, signal, options);
            throw new Error(`Agent Plan speech operation '${request.operation}' is not implemented`);
        },
    };
}
