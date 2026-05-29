/**
 * Local text embeddings via transformers.js (all-MiniLM-L6-v2, 384-dim).
 *
 * Fully local: the model (~23 MB) downloads once to the cache dir, then runs
 * offline on CPU. No API keys, no network after first use, no per-call cost.
 *
 * Design rule — embeddings are an ENHANCEMENT, never a hard dependency. If the
 * model can't load (offline first run, unsupported platform, disabled by env),
 * every method returns null/empty and the caller falls back to lexical-only
 * search. The server must never be *worse* than a pure FTS5 store.
 */

const MODEL_ID = process.env.DURANDAL_EMBED_MODEL || 'Xenova/all-MiniLM-L6-v2';
const EMBED_DIM = 384; // all-MiniLM-L6-v2 output dimension — must match the model

class Embedder {
    constructor({ cacheDir = null } = {}) {
        this.cacheDir = cacheDir;
        // DURANDAL_EMBEDDINGS=false forces the lexical-only floor (e.g. for CI).
        this.enabled = process.env.DURANDAL_EMBEDDINGS !== 'false';
        this.dim = EMBED_DIM;
        this.model = MODEL_ID;
        this._pipe = null;
        this._loadPromise = null;
        this._failed = false;
    }

    // True only once a load has succeeded. Before first use it's optimistic
    // (enabled && not yet failed); callers always null-check embed() anyway.
    get available() {
        return this.enabled && !this._failed;
    }

    get loaded() {
        return this._pipe !== null;
    }

    // Lazily load the feature-extraction pipeline exactly once. Returns null
    // and disables future attempts if loading fails.
    async _pipeline() {
        if (!this.enabled || this._failed) return null;
        if (this._pipe) return this._pipe;
        if (!this._loadPromise) {
            this._loadPromise = (async () => {
                try {
                    // transformers.js v4 is ESM-only — load via dynamic import from CJS.
                    const { pipeline, env } = await import('@huggingface/transformers');
                    if (this.cacheDir) env.cacheDir = this.cacheDir;
                    env.logLevel = 50;            // NONE — never write to stdout (MCP wire is stdout)
                    env.allowRemoteModels = true; // permit the one-time model download
                    const pipe = await pipeline('feature-extraction', this.model);
                    process.stderr.write(`[EMBED] model ready: ${this.model} (${this.dim}d)\n`);
                    return pipe;
                } catch (e) {
                    this._failed = true;
                    process.stderr.write(`[EMBED] disabled, falling back to lexical-only search: ${e.message}\n`);
                    return null;
                }
            })();
        }
        this._pipe = await this._loadPromise;
        return this._pipe;
    }

    // Embed one string -> Float32Array(dim), or null if embeddings unavailable.
    async embed(text) {
        const pipe = await this._pipeline();
        if (!pipe) return null;
        try {
            const out = await pipe(String(text), { pooling: 'mean', normalize: true });
            return Float32Array.from(out.data);
        } catch (e) {
            process.stderr.write(`[EMBED] embed failed: ${e.message}\n`);
            return null;
        }
    }

    // Embed many strings -> (Float32Array|null)[] aligned to input order.
    // Returns all-null (never throws) if embeddings are unavailable.
    async embedBatch(texts) {
        const pipe = await this._pipeline();
        if (!pipe) return texts.map(() => null);
        try {
            const out = await pipe(texts.map(String), { pooling: 'mean', normalize: true });
            const [n, dim] = out.dims;
            const result = [];
            for (let i = 0; i < n; i++) {
                result.push(Float32Array.from(out.data.subarray(i * dim, (i + 1) * dim)));
            }
            return result;
        } catch (e) {
            process.stderr.write(`[EMBED] batch embed failed: ${e.message}\n`);
            return texts.map(() => null);
        }
    }

    // Kick off model loading in the background so the first real embed is fast.
    // Fire-and-forget; failures are swallowed (we degrade gracefully).
    warmup() {
        if (this.enabled && !this._failed) this._pipeline().catch(() => {});
    }
}

module.exports = { Embedder, EMBED_DIM, MODEL_ID };
