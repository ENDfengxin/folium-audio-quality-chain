'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const MAX_RANGE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;

const clampRange = (windowSize, position, start) => {
    const safeStart = Number.isFinite(Number(start)) ? Math.max(0, Math.floor(Number(start))) : 0;
    const safeWindow = Number.isFinite(Number(windowSize))
        ? Math.max(1, Math.min(MAX_RANGE_BYTES, Math.floor(Number(windowSize))))
        : 512 * 1024;
    const safePosition = Number.isFinite(Number(position))
        ? Math.max(0, Math.floor(Number(position)))
        : 0;
    return { start: safeStart, end: safeStart + safeWindow - 1, position: safePosition };
};

const readFileRange = async (url, start, end) => {
    const filePath = fileURLToPath(url);
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        const length = Math.max(0, Math.min(end - start + 1, stat.size - start));
        const bytes = Buffer.alloc(length);
        if (length > 0) await handle.read(bytes, 0, length, start);
        return {
            bytes,
            total: stat.size,
            status: 206,
            contentType: '',
        };
    } finally {
        await handle.close();
    }
};

const readHttpRange = async (url, start, end) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            headers: {
                Range: `bytes=${start}-${end}`,
                Accept: 'audio/*,application/octet-stream,*/*;q=0.5',
            },
            redirect: 'follow',
            signal: controller.signal,
        });
        if (!response.ok && response.status !== 206) {
            return { error: `http-${response.status}` };
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
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                const remaining = MAX_RANGE_BYTES - received;
                if (remaining <= 0) {
                    await reader.cancel().catch(() => undefined);
                    break;
                }
                const chunk = Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, remaining));
                chunks.push(chunk);
                received += chunk.length;
            }
        }

        return {
            bytes: Buffer.concat(chunks, received),
            total: Number.isFinite(total) ? total : null,
            status: response.status,
            contentType: response.headers.get('content-type') || '',
        };
    } catch (error) {
        return { error: controller.signal.aborted ? 'timeout' : String(error?.message || error) };
    } finally {
        clearTimeout(timeout);
    }
};

const validateUrl = (value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
        throw new Error('audio-source-url-invalid');
    }
    const parsed = new URL(value);
    if (!['file:', 'http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('audio-source-protocol-unsupported');
    }
    return parsed.href;
};

/**
 * The renderer can read blob: and Folia's internal protocols. This Node half handles
 * ordinary files and HTTP(S) sources without renderer CORS restrictions.
 */
module.exports = (api) => {
    api.rpc.handle('read-audio-range', async (request) => {
        try {
            const url = validateUrl(request?.url);
            const { start, end, position } = clampRange(request?.windowSize, request?.position, request?.start);
            const parsed = new URL(url);
            const result = parsed.protocol === 'file:'
                ? await readFileRange(parsed, start, end)
                : await readHttpRange(parsed.href, start, end);
            if (result.error) return result;
            return {
                ok: true,
                start,
                position,
                status: result.status,
                contentType: result.contentType,
                total: result.total,
                base64: result.bytes.toString('base64'),
            };
        } catch (error) {
            return { ok: false, error: String(error?.message || error) };
        }
    });

    api.log.info(`audio source reader ready (${path.basename(process.resourcesPath)})`);
};
