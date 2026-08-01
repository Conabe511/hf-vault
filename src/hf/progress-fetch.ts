/**
 * @huggingface/hub attaches a `progressHint` to every upload fetch call
 * (per-part for multipart uploads), but its built-in handler only works in
 * browsers: it requires XMLHttpRequest, so in Node it silently degrades to
 * plain fetch and no granular progress is ever reported — the bar freezes
 * during the actual transfer. This module is the Node replacement: a fetch
 * that honors progressHint by counting the request body's bytes as undici
 * streams them out.
 */

interface ProgressHint {
    part?: number;
    numParts?: number;
    progressCallback: (progress: number) => void;
}

// One multipart upload shares a single progressCallback across all its
// parts, which upload in parallel — aggregate them into one 0..1 fraction
// (same scheme as the library's browser implementation)
const multipartTracking = new WeakMap<
    ProgressHint["progressCallback"],
    { numParts: number; partsProgress: Record<number, number> }
>();

function toBlob(body: unknown): Blob | undefined {
    if (body instanceof Blob) return body; // includes the hub's FileBlob/WebBlob slices
    if (typeof body === "string") return new Blob([body]);
    if (body instanceof ArrayBuffer) return new Blob([body]);
    if (ArrayBuffer.isView(body)) return new Blob([body as BlobPart]);
    return undefined;
}

// Granularity of progress reporting. In-memory blobs surface their whole
// content as ONE stream chunk, which would mean one progress event per
// 64MB xorb — so the stream is re-sliced into small pieces handed out
// on demand (pull), letting socket backpressure pace the events.
const PIECE_SIZE = 64 * 1024;

// A Blob stand-in whose stream() counts bytes as they are consumed.
// Keeping `size` intact matters: undici derives Content-Length from it,
// and S3 presigned upload URLs reject chunked transfer encoding.
function countingBlobLike(blob: Blob, onBytes: (loaded: number) => void) {
    return {
        size: blob.size,
        type: blob.type,
        [Symbol.toStringTag]: "Blob" as const,
        stream(): ReadableStream<Uint8Array> {
            const reader = blob.stream().getReader();
            let buffered: Uint8Array | null = null;
            let offset = 0;
            let loaded = 0;

            return new ReadableStream<Uint8Array>({
                async pull(controller) {
                    if (!buffered || offset >= buffered.byteLength) {
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                            return;
                        }
                        buffered = value;
                        offset = 0;
                    }

                    const piece = buffered.subarray(offset, Math.min(offset + PIECE_SIZE, buffered.byteLength));
                    offset += piece.byteLength;
                    loaded += piece.byteLength;
                    controller.enqueue(piece);
                    onBytes(loaded);
                },
                cancel(reason) {
                    return reader.cancel(reason);
                },
            });
        },
        arrayBuffer: () => blob.arrayBuffer(),
        slice: (start?: number, end?: number, type?: string) => blob.slice(start, end, type),
        text: () => blob.text(),
    };
}

// Typed as a plain function rather than `typeof fetch`: Bun augments the
// global fetch with a static `preconnect` method that a plain async
// function can't structurally satisfy. Callers that need a `typeof fetch`
// (e.g. commitIter's `fetch` option) cast at the call site — this
// function is never invoked as fetch.preconnect(), so it's a type-only gap.
export const progressFetch = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1]
): Promise<Response> => {
    const hint = (init as { progressHint?: ProgressHint } | undefined)?.progressHint;

    if (!init || !hint || (init.method !== "PUT" && init.method !== "POST")) {
        return fetch(input, init);
    }

    const blob = toBlob(init.body);
    if (!blob || blob.size === 0) {
        return fetch(input, init);
    }

    const report = (loaded: number) => {
        const fraction = Math.min(loaded / blob.size, 1);

        if (hint.part !== undefined && hint.numParts !== undefined) {
            let tracking = multipartTracking.get(hint.progressCallback);
            if (!tracking) {
                tracking = { numParts: hint.numParts, partsProgress: {} };
                multipartTracking.set(hint.progressCallback, tracking);
            }

            tracking.partsProgress[hint.part] = fraction;

            let total = 0;
            for (const partProgress of Object.values(tracking.partsProgress)) {
                total += partProgress;
            }

            // never report a full 1.0 from here — the library emits the
            // final progress:1 event itself once the upload is confirmed
            hint.progressCallback(Math.min(total / tracking.numParts, 0.9999999999));
        }
        else {
            hint.progressCallback(Math.min(fraction, 0.9999999999));
        }
    };

    return fetch(input, {
        ...init,
        body: countingBlobLike(blob, report) as unknown as BodyInit,
    });
};
