const ascii = (bytes, start, length) => {
    if (start < 0 || start + length > bytes.length) return '';
    return String.fromCharCode(...bytes.subarray(start, start + length));
};

const u16be = (bytes, offset) => {
    if (offset + 2 > bytes.length) return null;
    return (bytes[offset] << 8) | bytes[offset + 1];
};

const u24be = (bytes, offset) => {
    if (offset + 3 > bytes.length) return null;
    return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
};

const u32be = (bytes, offset) => {
    if (offset + 4 > bytes.length) return null;
    return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
};

const u16le = (bytes, offset) => {
    if (offset + 2 > bytes.length) return null;
    return bytes[offset] | (bytes[offset + 1] << 8);
};

const u32le = (bytes, offset) => {
    if (offset + 4 > bytes.length) return null;
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000)) >>> 0;
};

const u64be = (bytes, offset) => {
    const high = u32be(bytes, offset);
    const low = u32be(bytes, offset + 4);
    return high === null || low === null ? null : high * 0x100000000 + low;
};

const findAscii = (bytes, value, from = 0) => {
    const needle = Array.from(value, (character) => character.charCodeAt(0));
    const limit = bytes.length - needle.length;
    for (let offset = from; offset <= limit; offset += 1) {
        let matched = true;
        for (let index = 0; index < needle.length; index += 1) {
            if (bytes[offset + index] !== needle[index]) {
                matched = false;
                break;
            }
        }
        if (matched) return offset;
    }
    return -1;
};

const formatFromUrl = (url) => {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        const extension = pathname.includes('.') ? pathname.slice(pathname.lastIndexOf('.') + 1) : '';
        return {
            mp3: 'MP3',
            flac: 'FLAC',
            m4a: 'M4A',
            mp4: 'MP4',
            aac: 'AAC',
            ogg: 'OGG',
            opus: 'Opus',
            wav: 'WAV',
            wave: 'WAV',
            aiff: 'AIFF',
            aif: 'AIFF',
        }[extension] || '';
    } catch {
        return '';
    }
};

const parseFlac = (bytes) => {
    if (ascii(bytes, 0, 4) !== 'fLaC') return null;
    let offset = 4;
    while (offset + 4 <= bytes.length) {
        const header = bytes[offset];
        const type = header & 0x7f;
        const length = u24be(bytes, offset + 1);
        offset += 4;
        if (length === null || offset + length > bytes.length) return null;
        if (type !== 0 || length < 18) {
            if (header & 0x80) break;
            offset += length;
            continue;
        }
        const streamInfo = bytes.subarray(offset, offset + length);
        const sampleRate = (streamInfo[10] << 12) | (streamInfo[11] << 4) | (streamInfo[12] >> 4);
        const channels = ((streamInfo[12] >> 1) & 0x07) + 1;
        const bitDepth = (((streamInfo[12] & 0x01) << 4) | (streamInfo[13] >> 4)) + 1;
        return {
            format: 'FLAC',
            codec: 'FLAC',
            sampleRate,
            bitDepth,
            channels,
            lossless: true,
        };
    }
    return null;
};

const MP3_BITRATES = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const parseMpegOrAdtsFrame = (bytes, start = 0) => {
    const limit = Math.min(bytes.length - 4, start + 512 * 1024);
    for (let offset = start; offset <= limit; offset += 1) {
        if (bytes[offset] !== 0xff) continue;
        const header = u32be(bytes, offset);
        if (header === null) continue;

        const adts = ((header >>> 16) & 0xfff6) === 0xfff0;
        if (adts) {
            const sampleRateIndex = (header >>> 10) & 0x0f;
            const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
            const sampleRate = rates[sampleRateIndex];
            if (!sampleRate) continue;
            return {
                format: 'AAC',
                codec: 'AAC',
                sampleRate,
                channels: ((header >>> 6) & 0x07) || null,
                bitDepth: null,
                lossless: false,
            };
        }

        const versionBits = (header >>> 19) & 0x03;
        const layerBits = (header >>> 17) & 0x03;
        const bitrateIndex = (header >>> 12) & 0x0f;
        const sampleRateIndex = (header >>> 10) & 0x03;
        if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) continue;
        const mpeg1 = versionBits === 3;
        const divisor = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 4;
        const rates = [44100 / divisor, 48000 / divisor, 32000 / divisor];
        const table = MP3_BITRATES[mpeg1 ? 1 : 2];
        const bitrate = table?.[bitrateIndex];
        if (!bitrate || !rates[sampleRateIndex]) continue;
        return {
            format: 'MP3',
            codec: layerBits === 1 ? 'MP3' : 'MPEG audio',
            sampleRate: Math.round(rates[sampleRateIndex]),
            bitrate: bitrate * 1000,
            channels: ((header >>> 6) & 0x03) === 3 ? 1 : 2,
            bitDepth: null,
            lossless: false,
        };
    }
    return null;
};

const readSyncSafe = (bytes, offset) => (
    ((bytes[offset] & 0x7f) << 21)
    | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7)
    | (bytes[offset + 3] & 0x7f)
);

const parseWav = (bytes) => {
    if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return null;
    let offset = 12;
    let result = null;
    while (offset + 8 <= bytes.length) {
        const id = ascii(bytes, offset, 4);
        const size = u32le(bytes, offset + 4);
        if (size === null) break;
        if (id === 'fmt ' && offset + 8 + Math.min(size, 40) <= bytes.length) {
            const data = bytes.subarray(offset + 8, offset + 8 + size);
            const formatTag = u16le(data, 0);
            const channels = u16le(data, 2);
            const sampleRate = u32le(data, 4);
            const bitDepth = u16le(data, 14);
            const codecs = {
                1: 'PCM',
                3: 'IEEE Float',
                6: 'A-law',
                7: 'μ-law',
                0xfffe: 'PCM (extensible)',
            };
            result = {
                format: 'WAV',
                codec: codecs[formatTag] || `WAV 0x${Number(formatTag).toString(16)}`,
                sampleRate,
                channels,
                bitDepth,
                bitrate: sampleRate && channels && bitDepth ? sampleRate * channels * bitDepth : null,
                lossless: formatTag === 1 || formatTag === 3 || formatTag === 0xfffe,
            };
        } else if (id === 'data' && result) {
            return result;
        }
        offset += 8 + size + (size & 1);
    }
    return result;
};

const readExtendedFloat = (bytes, offset) => {
    if (offset + 10 > bytes.length) return null;
    const exponentWord = u16be(bytes, offset);
    const sign = exponentWord & 0x8000 ? -1 : 1;
    const exponent = exponentWord & 0x7fff;
    const highMantissa = u32be(bytes, offset + 2);
    const lowMantissa = u32be(bytes, offset + 6);
    if (exponent === 0 && highMantissa === 0 && lowMantissa === 0) return 0;
    if (exponent === 0x7fff) return sign * Infinity;
    return sign * (highMantissa * 0x100000000 + lowMantissa) * (2 ** (exponent - 16383 - 63));
};

const parseAiff = (bytes) => {
    if (ascii(bytes, 0, 4) !== 'FORM' || !['AIFF', 'AIFC'].includes(ascii(bytes, 8, 4))) return null;
    const container = ascii(bytes, 8, 4);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const id = ascii(bytes, offset, 4);
        const size = u32be(bytes, offset + 4);
        if (size === null) break;
        if (id === 'COMM' && offset + 8 + Math.min(size, 40) <= bytes.length) {
            const data = bytes.subarray(offset + 8, offset + 8 + size);
            const channels = u16be(data, 0);
            const sampleRate = Math.round(readExtendedFloat(data, 8));
            const bitDepth = u16be(data, 6);
            return {
                format: container,
                codec: ascii(data, 18, 4) || 'PCM',
                sampleRate: Number.isFinite(sampleRate) ? sampleRate : null,
                channels,
                bitDepth,
                bitrate: sampleRate && channels && bitDepth ? Math.round(sampleRate * channels * bitDepth) : null,
                lossless: true,
            };
        }
        offset += 8 + size + (size & 1);
    }
    return null;
};

const parseOgg = (bytes) => {
    if (ascii(bytes, 0, 4) !== 'OggS') return null;
    const opus = findAscii(bytes, 'OpusHead');
    if (opus >= 0) {
        return {
            format: 'Ogg',
            codec: 'Opus',
            sampleRate: u32le(bytes, opus + 12),
            decodedSampleRate: 48000,
            channels: bytes[opus + 9] || null,
            bitDepth: null,
            lossless: false,
        };
    }
    const vorbis = findAscii(bytes, 'vorbis');
    if (vorbis >= 0) {
        return {
            format: 'Ogg',
            codec: 'Vorbis',
            sampleRate: u32le(bytes, vorbis + 12),
            channels: bytes[vorbis + 11] || null,
            bitDepth: null,
            lossless: false,
        };
    }
    return null;
};

const boxType = (bytes, offset) => ascii(bytes, offset + 4, 4);

const parseMp4AudioEntry = (bytes, typeOffset) => {
    const type = ascii(bytes, typeOffset, 4);
    if (!['mp4a', 'alac', 'fLaC', 'Opus', 'ac-3', 'ec-3', 'enca'].includes(type)) return null;
    const channels = u16be(bytes, typeOffset + 16);
    const bitDepth = u16be(bytes, typeOffset + 18);
    const sampleRateFixed = u32be(bytes, typeOffset + 24);
    const sampleRate = sampleRateFixed ? sampleRateFixed / 65536 : null;
    const codecs = {
        mp4a: 'AAC',
        alac: 'ALAC',
        fLaC: 'FLAC',
        Opus: 'Opus',
        'ac-3': 'AC-3',
        'ec-3': 'E-AC-3',
        enca: 'Encrypted audio',
    };
    return {
        format: 'MP4',
        codec: codecs[type],
        sampleRate: sampleRate && Number.isFinite(sampleRate) ? Math.round(sampleRate) : null,
        decodedSampleRate: type === 'Opus' ? 48000 : null,
        channels: channels || null,
        bitDepth: ['alac', 'fLaC'].includes(type) ? bitDepth || null : null,
        lossless: type === 'alac' || type === 'fLaC',
    };
};

const parseStsd = (bytes) => {
    const stsd = findAscii(bytes, 'stsd');
    if (stsd < 4) return null;
    const entryStart = stsd + 12;
    if (entryStart + 36 > bytes.length) return null;
    return parseMp4AudioEntry(bytes, entryStart + 4);
};

const walkMp4Boxes = (bytes, start, end, visitor, depth = 0, budget = { count: 0 }) => {
    let offset = start;
    while (offset + 8 <= end && offset + 8 <= bytes.length && budget.count < 600) {
        budget.count += 1;
        let size = u32be(bytes, offset);
        const type = boxType(bytes, offset);
        let headerSize = 8;
        if (size === 1) {
            size = u64be(bytes, offset + 8);
            headerSize = 16;
        } else if (size === 0) {
            size = end - offset;
        }
        if (!size || size < headerSize) break;
        const boxEnd = Math.min(end, offset + size);
        const found = visitor(type, offset, headerSize, boxEnd, depth);
        if (found) return found;
        if (depth < 9 && ['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'meta', 'ilst', 'dinf', 'sinf', 'schi'].includes(type)) {
            const childStart = offset + headerSize + (type === 'meta' ? 4 : 0);
            const foundInside = walkMp4Boxes(bytes, childStart, boxEnd, visitor, depth + 1, budget);
            if (foundInside) return foundInside;
        }
        offset += size;
    }
    return null;
};

const probeMp4 = async (reader) => {
    let offset = 0;
    const initial = await reader.read(0, 64 * 1024);
    let total = initial.total;
    let parseEnd = initial.bytes.length;
    const scanned = new Set();

    const readFullBox = async (boxOffset, size, maxBytes) => {
        if (scanned.has(boxOffset)) return null;
        scanned.add(boxOffset);
        if (size > maxBytes) return null;
        const chunk = await reader.read(boxOffset, size);
        return chunk.bytes.length >= Math.min(size, 16) ? chunk.bytes : null;
    };

    while (offset + 16 <= parseEnd && scanned.size < 32) {
        const header = await reader.read(offset, 16);
        const bytes = header.bytes;
        if (bytes.length < 8) break;
        let size = u32be(bytes, 0);
        const type = ascii(bytes, 4, 4);
        let headerSize = 8;
        if (size === 1) {
            size = u64be(bytes, 8);
            headerSize = 16;
        } else if (size === 0) {
            size = total !== null ? total - offset : null;
        }
        if (!size || size < headerSize) break;
        if (['moov', 'moof', 'meta'].includes(type) && size <= 16 * 1024 * 1024) {
            const box = await readFullBox(offset, size, 16 * 1024 * 1024);
            if (box) {
                const audio = walkMp4Boxes(box, 0, Math.min(size, box.length), (currentType) => {
                    return currentType === 'stsd' ? true : null;
                });
                // The visitor above only tells us a sample-description box exists.
                const parsed = parseStsd(box);
                if (parsed) return parsed;
            }
        }
        if (!Number.isFinite(size) || size <= 0) break;
        offset += size;
    }
    return null;
};

const parseId3AndMpeg = async (reader, bytes) => {
    let start = 0;
    if (ascii(bytes, 0, 3) === 'ID3' && bytes.length >= 10) {
        start = 10 + readSyncSafe(bytes, 6) + ((bytes[5] & 0x10) ? 10 : 0);
        if (start >= bytes.length) {
            const afterTag = await reader.read(start, 512 * 1024);
            return parseMpegOrAdtsFrame(afterTag.bytes, 0);
        }
    }
    return parseMpegOrAdtsFrame(bytes, start);
};

const detectByMagic = (bytes) => {
    if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';
    if (ascii(bytes, 0, 4) === 'OggS') return 'ogg';
    if (ascii(bytes, 0, 4) === 'RIFF') return 'wav';
    if (ascii(bytes, 0, 4) === 'FORM') return 'aiff';
    if (ascii(bytes, 4, 4) === 'ftyp') return 'mp4';
    if (ascii(bytes, 0, 3) === 'ID3') return 'mpeg';
    const mpeg = parseMpegOrAdtsFrame(bytes);
    if (mpeg) return 'mpeg';
    return '';
};

const normalizeResult = (result, fallbackFormat, total, durationSeconds) => {
    if (!result) return null;
    const sampleRate = Number(result.sampleRate) || null;
    const channels = Number(result.channels) || null;
    const bitDepth = Number(result.bitDepth) || null;
    const fileBitrate = total && durationSeconds > 0 ? (total * 8) / durationSeconds : null;
    return {
        format: result.format || fallbackFormat || '未知',
        codec: result.codec || fallbackFormat || '未知编码',
        sampleRate,
        decodedSampleRate: Number(result.decodedSampleRate) || sampleRate,
        channels,
        bitDepth,
        bitrate: Number(result.bitrate) || fileBitrate || null,
        lossless: typeof result.lossless === 'boolean' ? result.lossless : null,
        containerBytes: total || null,
    };
};

/**
 * `reader.read(start, length)` returns { bytes, total, contentType }.
 * It lives outside this module so browser and Node reads can be combined.
 */
export const probeAudio = async ({ url, durationSeconds, reader }) => {
    const first = await reader.read(0, 1024 * 1024);
    const bytes = first.bytes;
    if (!bytes || bytes.length === 0) throw new Error('empty-audio-source');

    const kind = detectByMagic(bytes);
    let result = null;
    if (kind === 'flac') result = parseFlac(bytes);
    else if (kind === 'wav') result = parseWav(bytes);
    else if (kind === 'aiff') result = parseAiff(bytes);
    else if (kind === 'ogg') result = parseOgg(bytes);
    else if (kind === 'mp4') result = await probeMp4(reader);
    else if (kind === 'mpeg') result = await parseId3AndMpeg(reader, bytes);

    const fallbackFormat = formatFromUrl(url);
    if (!result && fallbackFormat === 'MP3') result = parseMpegOrAdtsFrame(bytes);
    const normalized = normalizeResult(result, fallbackFormat, first.total, durationSeconds);
    if (!normalized) throw new Error('audio-header-not-recognised');
    if (!normalized.sampleRate) throw new Error('sample-rate-not-found');
    return normalized;
};

export const describeReadError = (error) => {
    const code = String(error?.message || error || '');
    if (code.includes('permission') || code.includes('cors') || code.includes('Failed to fetch')) {
        return '音源读取受限';
    }
    if (code.includes('not-recognised')) return '未识别音频容器';
    if (code.includes('sample-rate-not-found')) return '容器未提供采样率';
    if (code.includes('empty-audio-source')) return '当前音源尚未就绪';
    return code || '读取音源失败';
};
