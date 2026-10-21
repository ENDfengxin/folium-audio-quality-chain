import { describeReadError, probeAudio } from './probe.mjs';

const MOD_ID = 'audio-quality-chain';
const POLL_MS = 1200;
const MAX_CACHE_ENTRIES = 18;
const FRESH_CONTEXT_GRACE_MS = 1500;

const isChinese = () => /^zh/i.test(document.documentElement.lang || navigator.language || '');
const pick = (zh, en) => (isChinese() ? zh : en);

const formatRate = (rate) => {
    if (!Number.isFinite(rate) || rate <= 0) return '—';
    const khz = rate / 1000;
    return `${khz >= 100 ? khz.toFixed(1) : khz.toFixed(khz % 1 === 0 ? 0 : 1)} kHz`;
};

const formatBitDepth = (bits) => (Number.isFinite(bits) && bits > 0 ? `${bits}-bit` : '—');
const formatChannels = (channels) => {
    if (!Number.isFinite(channels) || channels <= 0) return '—';
    if (channels === 1) return pick('单声道', 'Mono');
    if (channels === 2) return pick('立体声', 'Stereo');
    return `${channels} ch`;
};
const formatBitrate = (bitsPerSecond) => {
    if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '—';
    if (bitsPerSecond >= 1000000) return `${(bitsPerSecond / 1000000).toFixed(2)} Mbps`;
    return `${Math.round(bitsPerSecond / 1000)} kbps`;
};

const sourceLabel = (source) => {
    const labels = {
        netease: '网易云音乐',
        qq: 'QQ 音乐',
        kugou: '酷狗音乐',
        spotify: 'Spotify',
        ytm: 'YouTube Music',
        local: pick('本地文件', 'Local file'),
        navidrome: 'Navidrome',
    };
    return labels[String(source || '').toLowerCase()] || String(source || pick('当前音源', 'Current source'));
};

const cache = new Map();
const cacheKeyFor = (url, duration) => `${url}\u0000${Math.round((Number(duration) || 0) * 10)}`;
const remember = (key, value) => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
};

const base64ToBytes = (base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
};

const readBrowserRange = async (url, start, length) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(url, {
            headers: { Range: `bytes=${start}-${start + length - 1}` },
            credentials: 'include',
            cache: 'force-cache',
            signal: controller.signal,
        });
        if (!response.ok && response.status !== 206) {
            throw new Error(`audio-source-http-${response.status}`);
        }
        const contentRange = response.headers.get('content-range') || '';
        const rangeMatch = /\/(\d+)\s*$/u.exec(contentRange);
        const contentLength = Number(response.headers.get('content-length'));
        const total = rangeMatch
            ? Number(rangeMatch[1])
            : response.status === 200 && Number.isFinite(contentLength) && contentLength > 0
                ? contentLength
                : null;
        const chunks = [];
        let received = 0;
        if (response.body) {
            const body = response.body.getReader();
            for (;;) {
                const { done, value } = await body.read();
                if (done) break;
                if (!value) continue;
                const remaining = length - received;
                if (remaining <= 0) {
                    await body.cancel().catch(() => undefined);
                    break;
                }
                chunks.push(value.subarray(0, Math.min(value.length, remaining)));
                received += chunks[chunks.length - 1].length;
            }
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return { bytes, total, contentType: response.headers.get('content-type') || '' };
    } finally {
        clearTimeout(timeout);
    }
};

const createRangeReader = (folium, url) => async (start, length) => {
    try {
        return await readBrowserRange(url, start, length);
    } catch (browserError) {
        let response;
        try {
            response = await folium.rpc.call('read-audio-range', {
                url,
                start,
                windowSize: length,
            });
        } catch (rpcError) {
            throw new Error(`${browserError?.message || browserError}; ${rpcError?.message || rpcError}`);
        }
        if (!response?.ok) throw new Error(response?.error || 'audio-source-read-failed');
        return {
            bytes: base64ToBytes(response.base64),
            total: response.total,
            contentType: response.contentType || '',
        };
    }
};

const collectAudioElements = (root = document, output = []) => {
    if (!root?.querySelectorAll) return output;
    for (const element of root.querySelectorAll('audio')) {
        if (!output.includes(element)) output.push(element);
    }
    for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) collectAudioElements(element.shadowRoot, output);
    }
    return output;
};

const installAudioEnvironmentTracking = () => {
    const key = '__foliumAudioQualityChainEnvironmentV1';
    if (window[key]) {
        window[key].users += 1;
        return window[key];
    }

    const environments = new Set();
    const tracked = new WeakSet();
    const rememberContext = (context) => {
        if (!context || typeof context.sampleRate !== 'number' || tracked.has(context)) return;
        tracked.add(context);
        environments.add(context);
    };

    const originals = {
        AudioContext: window.AudioContext,
        webkitAudioContext: window.webkitAudioContext,
        connect: window.AudioNode?.prototype?.connect,
        createMediaElementSource: (window.AudioContext || window.webkitAudioContext)?.prototype?.createMediaElementSource,
    };

    const wrapContextConstructor = (NativeContext) => {
        if (typeof NativeContext !== 'function') return NativeContext;
        function TrackedAudioContext(...args) {
            const context = new NativeContext(...args);
            rememberContext(context);
            return context;
        }
        TrackedAudioContext.prototype = NativeContext.prototype;
        Object.setPrototypeOf(TrackedAudioContext, NativeContext);
        return TrackedAudioContext;
    };

    if (originals.AudioContext) window.AudioContext = wrapContextConstructor(originals.AudioContext);
    if (originals.webkitAudioContext) window.webkitAudioContext = wrapContextConstructor(originals.webkitAudioContext);
    if (originals.connect) {
        window.AudioNode.prototype.connect = function trackedAudioConnect(...args) {
            rememberContext(this.context);
            return originals.connect.apply(this, args);
        };
    }
    if (originals.createMediaElementSource) {
        (window.AudioContext || window.webkitAudioContext).prototype.createMediaElementSource = function trackedMediaElementSource(...args) {
            rememberContext(this);
            return originals.createMediaElementSource.apply(this, args);
        };
    }

    let diagnosticContext = null;
    const snapshot = {
        users: 1,
        rememberContext,
        getRate: () => {
            const live = [...environments]
                .filter((context) => context.state !== 'closed')
                .sort((left, right) => right.sampleRate - left.sampleRate);
            if (live[0]) {
                return { rate: live[0].sampleRate, source: 'host', state: live[0].state };
            }
            if (!diagnosticContext || diagnosticContext.state === 'closed') {
                try {
                    diagnosticContext = new originals.AudioContext({ latencyHint: 'playback' });
                } catch {
                    diagnosticContext = null;
                }
            }
            return diagnosticContext
                ? { rate: diagnosticContext.sampleRate, source: 'device', state: diagnosticContext.state }
                : null;
        },
        release: () => {
            snapshot.users -= 1;
            if (snapshot.users > 0) return;
            if (window.AudioContext === wrapContextConstructor.cachedContext) {
                window.AudioContext = originals.AudioContext;
            }
            if (window.AudioNode?.prototype?.connect?.name === 'trackedAudioConnect' && originals.connect) {
                window.AudioNode.prototype.connect = originals.connect;
            }
            const contextConstructor = window.AudioContext || window.webkitAudioContext;
            if (contextConstructor?.prototype?.createMediaElementSource && originals.createMediaElementSource) {
                contextConstructor.prototype.createMediaElementSource = originals.createMediaElementSource;
            }
            void diagnosticContext?.close?.().catch?.(() => undefined);
            delete window[key];
        },
    };
    // Keep the exact wrapper for a safe restore check.
    wrapContextConstructor.cachedContext = window.AudioContext;
    window[key] = snapshot;
    return snapshot;
};

const pickActiveAudio = (snapshot) => {
    const duration = Number(snapshot?.duration) || 0;
    const candidates = collectAudioElements()
        .map((element) => {
            const source = element.currentSrc || element.src || '';
            let score = 0;
            if (!element.paused) score += 100;
            if (!element.ended) score += 8;
            if (Number(element.currentTime) > 0) score += 6;
            if (source) score += 4;
            if (element.readyState >= 2) score += 3;
            if (duration > 0 && Number.isFinite(element.duration)) {
                score += Math.max(0, 16 - Math.abs(element.duration - duration) * 4);
            }
            return { element, source, score };
        })
        .filter((entry) => entry.source)
        .sort((left, right) => right.score - left.score);
    return candidates[0] || null;
};

const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
};

const createIconButton = (label, onClick) => {
    const button = node('button', 'aq-icon-button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.2-2.4L20 9M4 15l2.7 2.4A7 7 0 0 0 17.9 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    button.addEventListener('click', onClick);
    return button;
};

const tierFor = (info) => {
    if (!info) return pick('待检测', 'Pending');
    const highResolution = info.sampleRate > 48000 || info.bitDepth > 16;
    if (info.lossless === true && highResolution) return 'Hi-Res';
    if (info.lossless === true) return pick('无损', 'Lossless');
    if (info.bitrate >= 256000) return pick('高品质', 'High');
    if (info.bitrate >= 128000) return pick('标准', 'Standard');
    return pick('有损', 'Lossy');
};

export default function activate(folium) {
    if (folium.env.context !== 'main') return undefined;

    const environment = installAudioEnvironmentTracking();

    const tab = folium.registries.playerPanelTabs.register({
        id: 'quality-chain',
        label: { 'zh-CN': '音质链', en: 'Audio chain' },
        order: 560,
        mount(container, ctx) {
            let disposed = false;
            let pollTimer = null;
            let analysisGeneration = 0;
            let currentSource = '';
            let currentState = null;
            const listeners = [];

            if (!container.querySelector?.(':scope > .aq-root')) container.replaceChildren();
            const root = node('div', 'aq-root');
            root.innerHTML = `
                <style>
                    :host, .aq-root { color: inherit; }
                    .aq-root {
                        --aq-line: color-mix(in srgb, currentColor 14%, transparent);
                        --aq-soft: color-mix(in srgb, currentColor 6%, transparent);
                        --aq-softer: color-mix(in srgb, currentColor 3%, transparent);
                        box-sizing: border-box;
                        display: flex;
                        min-height: 100%;
                        flex-direction: column;
                        gap: 12px;
                        padding: 4px 2px 10px;
                        font: inherit;
                    }
                    * { box-sizing: border-box; }
                    .aq-head { display: flex; align-items: flex-start; gap: 10px; }
                    .aq-heading { min-width: 0; flex: 1; }
                    .aq-kicker {
                        margin-bottom: 3px;
                        font-size: 10px;
                        line-height: 14px;
                        letter-spacing: .14em;
                        text-transform: uppercase;
                        opacity: .5;
                    }
                    .aq-song {
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        font-size: 14px;
                        line-height: 20px;
                        font-weight: 650;
                    }
                    .aq-byline {
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        font-size: 11px;
                        line-height: 17px;
                        opacity: .55;
                    }
                    .aq-icon-button {
                        display: grid;
                        width: 28px;
                        height: 28px;
                        flex: 0 0 28px;
                        place-items: center;
                        border: 1px solid var(--aq-line);
                        border-radius: 999px;
                        background: var(--aq-soft);
                        color: inherit;
                        cursor: pointer;
                        opacity: .62;
                        transition: opacity .15s ease, transform .15s ease;
                    }
                    .aq-icon-button:hover { opacity: 1; transform: rotate(12deg); }
                    .aq-hero {
                        position: relative;
                        overflow: hidden;
                        padding: 14px;
                        border: 1px solid var(--aq-line);
                        border-radius: 16px;
                        background:
                            radial-gradient(circle at 100% 0%, color-mix(in srgb, currentColor 10%, transparent), transparent 52%),
                            var(--aq-softer);
                    }
                    .aq-hero::after {
                        content: "";
                        position: absolute;
                        width: 120px;
                        height: 120px;
                        right: -42px;
                        bottom: -70px;
                        border: 1px solid var(--aq-line);
                        border-radius: 50%;
                    }
                    .aq-rate {
                        font-size: 29px;
                        line-height: 1.05;
                        font-weight: 720;
                        letter-spacing: -.035em;
                        font-variant-numeric: tabular-nums;
                    }
                    .aq-summary {
                        display: flex;
                        flex-wrap: wrap;
                        align-items: center;
                        gap: 6px;
                        margin-top: 8px;
                        font-size: 11px;
                        line-height: 18px;
                        color: color-mix(in srgb, currentColor 70%, transparent);
                    }
                    .aq-chip {
                        padding: 2px 7px;
                        border: 1px solid var(--aq-line);
                        border-radius: 999px;
                        background: var(--aq-soft);
                        white-space: nowrap;
                    }
                    .aq-chain {
                        display: grid;
                        grid-template-columns: 1fr;
                        gap: 0;
                        padding: 2px 0;
                    }
                    .aq-stage {
                        position: relative;
                        display: grid;
                        grid-template-columns: 24px minmax(0, 1fr) auto;
                        gap: 9px;
                        align-items: center;
                        min-height: 51px;
                    }
                    .aq-stage:not(:last-child)::after {
                        content: "";
                        position: absolute;
                        left: 11px;
                        top: 34px;
                        bottom: -10px;
                        width: 1px;
                        background: var(--aq-line);
                    }
                    .aq-dot {
                        position: relative;
                        z-index: 1;
                        display: grid;
                        width: 23px;
                        height: 23px;
                        place-items: center;
                        border: 1px solid var(--aq-line);
                        border-radius: 50%;
                        background: var(--aq-soft);
                        font-size: 10px;
                        font-variant-numeric: tabular-nums;
                    }
                    .aq-label { font-size: 10px; line-height: 14px; opacity: .48; }
                    .aq-value {
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        font-size: 12px;
                        line-height: 18px;
                        font-weight: 600;
                    }
                    .aq-detail {
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        font-size: 10px;
                        line-height: 14px;
                        opacity: .5;
                    }
                    .aq-stage-rate {
                        max-width: 86px;
                        text-align: right;
                        font-size: 12px;
                        font-weight: 650;
                        font-variant-numeric: tabular-nums;
                    }
                    .aq-note {
                        display: flex;
                        align-items: flex-start;
                        gap: 6px;
                        padding-top: 9px;
                        border-top: 1px solid var(--aq-line);
                        font-size: 9.5px;
                        line-height: 14px;
                        opacity: .48;
                    }
                    .aq-note-dot {
                        width: 5px;
                        height: 5px;
                        flex: 0 0 5px;
                        margin-top: 4px;
                        border-radius: 50%;
                        background: currentColor;
                    }
                    .aq-loading { animation: aq-pulse 1.15s ease-in-out infinite; }
                    @keyframes aq-pulse { 50% { opacity: .42; } }
                    @media (prefers-reduced-motion: reduce) {
                        .aq-loading { animation: none; }
                        .aq-icon-button { transition: none; }
                    }
                </style>
                <div class="aq-head">
                    <div class="aq-heading">
                        <div class="aq-kicker">Playback signal path</div>
                        <div class="aq-song">—</div>
                        <div class="aq-byline">—</div>
                    </div>
                    <button type="button" class="aq-icon-button" aria-label="重新读取" title="重新读取"></button>
                </div>
                <div class="aq-hero">
                    <div class="aq-rate">—</div>
                    <div class="aq-summary">
                        <span class="aq-chip">—</span>
                        <span class="aq-chip">—</span>
                        <span class="aq-chip">—</span>
                    </div>
                </div>
                <div class="aq-chain">
                    <div class="aq-stage">
                        <span class="aq-dot">1</span>
                        <div><div class="aq-label">来源容器</div><div class="aq-value">—</div><div class="aq-detail">—</div></div>
                        <div class="aq-stage-rate">—</div>
                    </div>
                    <div class="aq-stage">
                        <span class="aq-dot">2</span>
                        <div><div class="aq-label">浏览器解码</div><div class="aq-value">PCM</div><div class="aq-detail">Chromium / FFmpeg</div></div>
                        <div class="aq-stage-rate">—</div>
                    </div>
                    <div class="aq-stage">
                        <span class="aq-dot">3</span>
                        <div><div class="aq-label">设备输出</div><div class="aq-value">AudioContext</div><div class="aq-detail">—</div></div>
                        <div class="aq-stage-rate">—</div>
                    </div>
                </div>
                <div class="aq-note"><span class="aq-note-dot"></span><span class="aq-note-text">读取当前播放器的真实媒体源，不使用平台标称音质。</span></div>
            `;
            container.appendChild(root);

            const refreshButton = root.querySelector('.aq-icon-button');
            refreshButton.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.2-2.4L20 9M4 15l2.7 2.4A7 7 0 0 0 17.9 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

            const songNode = root.querySelector('.aq-song');
            const bylineNode = root.querySelector('.aq-byline');
            const rateNode = root.querySelector('.aq-rate');
            const chips = [...root.querySelectorAll('.aq-summary .aq-chip')];
            const stages = [...root.querySelectorAll('.aq-stage')];
            const note = root.querySelector('.aq-note-text');

            const setStage = (index, label, value, detail, rate) => {
                const stage = stages[index];
                stage.querySelector('.aq-label').textContent = label;
                stage.querySelector('.aq-value').textContent = value;
                stage.querySelector('.aq-detail').textContent = detail;
                stage.querySelector('.aq-stage-rate').textContent = rate;
            };

            const renderSong = (snapshot) => {
                const song = snapshot?.song;
                songNode.textContent = song?.title || pick('没有正在播放的歌曲', 'Nothing playing');
                const parts = [song?.artist, song?.album].filter(Boolean);
                bylineNode.textContent = parts.length > 0 ? parts.join(' · ') : sourceLabel(song?.source);
            };

            const renderLoading = (snapshot, active) => {
                currentState = { snapshot, active, loading: true };
                root.classList.add('aq-loading');
                rateNode.textContent = '…';
                chips.forEach((chip, index) => {
                    chip.textContent = index === 0 ? pick('读取音源', 'Reading source') : '—';
                });
                setStage(0, pick('来源容器', 'Source container'), pick('正在读取文件头', 'Reading container header'), active?.source ? pick('使用当前播放器媒体元素', 'From the active media element') : pick('等待音频元素', 'Waiting for media'), '…');
                setStage(1, pick('浏览器解码', 'Browser decode'), 'PCM', 'Chromium / FFmpeg', '…');
                const output = environment.getRate();
                setStage(2, pick('设备输出', 'Device output'), 'AudioContext', output?.source === 'host' ? pick('播放器音频上下文', 'Host audio context') : pick('设备默认采样率', 'Device default rate'), formatRate(output?.rate));
                note.textContent = pick('正在读取当前播放器的真实媒体源。', 'Reading the active media source from the player.');
            };

            const renderInfo = (snapshot, active, info, output) => {
                currentState = { snapshot, active, info, output, loading: false };
                root.classList.remove('aq-loading');
                const rate = formatRate(info.sampleRate);
                rateNode.textContent = rate;
                chips[0].textContent = tierFor(info);
                chips[1].textContent = info.codec;
                chips[2].textContent = [formatBitDepth(info.bitDepth), formatChannels(info.channels)].filter((value) => value !== '—').join(' · ') || formatBitrate(info.bitrate);

                const sourceDetail = [
                    info.format !== info.codec ? info.format : '',
                    formatBitrate(info.bitrate),
                    info.lossless === true ? pick('无损压缩', 'Lossless') : info.lossless === false ? pick('有损压缩', 'Lossy') : '',
                ].filter(Boolean).join(' · ');
                setStage(0, pick('来源容器', 'Source container'), info.codec, sourceDetail || sourceLabel(snapshot?.song?.source), rate);

                const decodeDetail = [
                    formatBitDepth(info.bitDepth),
                    formatChannels(info.channels),
                    info.decodedSampleRate && info.decodedSampleRate !== info.sampleRate ? `${formatRate(info.decodedSampleRate)} ${pick('内部解码', 'internal decode')}` : '',
                ].filter(Boolean).join(' · ');
                setStage(1, pick('浏览器解码', 'Browser decode'), 'PCM', decodeDetail || 'Chromium / FFmpeg', formatRate(info.decodedSampleRate || info.sampleRate));

                const outputRate = output?.rate || null;
                const resampled = outputRate && info.sampleRate && Math.abs(outputRate - info.sampleRate) > 1;
                setStage(
                    2,
                    pick('设备输出', 'Device output'),
                    'AudioContext',
                    output
                        ? `${output.source === 'host' ? pick('播放器音频上下文', 'Host audio context') : pick('设备默认采样率', 'Device default rate')}${resampled ? ` · ${pick('重采样', 'resampled')}` : ''}`
                        : pick('采样率不可用', 'Rate unavailable'),
                    formatRate(outputRate),
                );

                note.textContent = output?.source === 'host'
                    ? pick('来源采样率读取自容器头；输出采样率来自播放器自身的 Web Audio 上下文。', 'Source rate from the container header; output rate from the host Web Audio context.')
                    : pick('来源采样率读取自容器头；当前仅能确认设备默认输出采样率。', 'Source rate from the container header; only the device default output rate is available.');
            };

            const renderError = (snapshot, active, message) => {
                currentState = { snapshot, active, error: message, loading: false };
                root.classList.remove('aq-loading');
                rateNode.textContent = '—';
                chips[0].textContent = pick('读取失败', 'Unavailable');
                chips[1].textContent = sourceLabel(snapshot?.song?.source);
                chips[2].textContent = '—';
                setStage(0, pick('来源容器', 'Source container'), message, active?.source ? pick('无法读取媒体头', 'Media header unavailable') : pick('等待音频元素', 'Waiting for media'), '—');
                setStage(1, pick('浏览器解码', 'Browser decode'), 'PCM', 'Chromium / FFmpeg', '—');
                const output = environment.getRate();
                setStage(2, pick('设备输出', 'Device output'), 'AudioContext', output ? pick('设备默认采样率', 'Device default rate') : pick('采样率不可用', 'Rate unavailable'), formatRate(output?.rate));
                note.textContent = pick('音源可能受 DRM、CORS 或缓存保护；输出采样率仍可参考。', 'The source may be protected by DRM, CORS or cache rules; the output rate is still informative.');
            };

            const analyze = async (force = false) => {
                if (disposed) return;
                let snapshot;
                try {
                    snapshot = folium.playback.getState();
                } catch (error) {
                    snapshot = null;
                    folium.log.warn('playback snapshot unavailable', error);
                }
                renderSong(snapshot);
                const active = pickActiveAudio(snapshot);
                if (!snapshot?.song) {
                    renderError(snapshot, active, pick('先播放一首歌曲', 'Play a song first'));
                    return;
                }
                if (!active?.source) {
                    renderError(snapshot, active, pick('播放器尚未暴露音源', 'No active media source yet'));
                    return;
                }

                const key = cacheKeyFor(active.source, snapshot.duration);
                if (!force && cache.has(key)) {
                    renderInfo(snapshot, active, cache.get(key), environment.getRate());
                    return;
                }
                if (!force && currentSource === key && currentState?.error) {
                    renderSong(snapshot);
                    return;
                }
                if (!force && currentSource === key && currentState?.loading) return;

                currentSource = key;
                const generation = ++analysisGeneration;
                renderLoading(snapshot, active);
                try {
                    const info = await probeAudio({
                        url: active.source,
                        durationSeconds: Number(snapshot.duration) || null,
                        reader: {
                            read: createRangeReader(folium, active.source),
                        },
                    });
                    if (disposed || generation !== analysisGeneration) return;
                    remember(key, info);
                    renderInfo(snapshot, active, info, environment.getRate());
                } catch (error) {
                    if (disposed || generation !== analysisGeneration) return;
                    folium.log.warn('audio quality probe failed', String(error?.message || error));
                    renderError(snapshot, active, describeReadError(error));
                }
            };

            const mediaListeners = new Map();
            const bindMedia = () => {
                const active = pickActiveAudio(currentState?.snapshot ?? null);
                if (!active?.element || mediaListeners.has(active.element)) return;
                const handler = () => void analyze(true);
                for (const event of ['loadedmetadata', 'durationchange', 'playing', 'loadstart']) {
                    active.element.addEventListener(event, handler);
                }
                mediaListeners.set(active.element, () => {
                    for (const event of ['loadedmetadata', 'durationchange', 'playing', 'loadstart']) {
                        active.element.removeEventListener(event, handler);
                    }
                });
            };

            const onSongChanged = () => {
                currentSource = '';
                void analyze(true);
            };
            listeners.push(folium.events.on('playback.songChanged', onSongChanged));
            listeners.push(folium.events.on('playback.stateChanged', () => void analyze(false)));
            refreshButton.addEventListener('click', () => void analyze(true));

            void analyze(false);
            pollTimer = window.setInterval(() => {
                bindMedia();
                void analyze(false);
            }, POLL_MS);

            return () => {
                disposed = true;
                analysisGeneration += 1;
                if (pollTimer !== null) window.clearInterval(pollTimer);
                listeners.forEach((off) => off());
                mediaListeners.forEach((off) => off());
                root.remove();
            };
        },
    });

    return () => {
        tab.unregister();
        environment.release();
    };
}
