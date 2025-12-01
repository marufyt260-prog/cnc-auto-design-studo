import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env first, then .env.local (override to ensure local selection takes effect)
dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.resolve(__dirname, 'dist');

// Provider selection: explicit env wins; else prefer Gemini if key available; else Stability; else Gemini
const PROVIDER = (
  process.env.PROVIDER ||
  (process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.VITE_GEMINI_API_KEY
    ? 'gemini'
    : (process.env.STABILITY_API_KEY ? 'stability' : 'gemini'))
).toLowerCase();
const FALLBACK_PROVIDER = (process.env.FALLBACK_PROVIDER || '').toLowerCase();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.VITE_GEMINI_API_KEY;
const MODEL_ID = process.env.MODEL_ID || 'gemini-2.5-flash-image';
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const STABILITY_ENGINE = (process.env.STABILITY_ENGINE || 'v1-6').toLowerCase(); // 'sdxl' or 'v1-6'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let inFlight = false;

app.get('/api/health', (req, res) => {
  return res.json({ ok: true });
});

// Debug route to verify active provider and env wiring
app.get('/api/provider', (_req, res) => {
  res.json({
    provider: PROVIDER,
    fallback: FALLBACK_PROVIDER || null,
    hasStabilityKey: !!process.env.STABILITY_API_KEY,
    hasGeminiKey: !!GEMINI_API_KEY,
    modelId: MODEL_ID,
    stabilityEngine: STABILITY_ENGINE
  });
});

app.post('/api/edit-image', async (req, res) => {
  try {
    const { base64ImageData, mimeType, prompt, width: reqW, height: reqH } = req.body || {};
    if (!base64ImageData || !mimeType || !prompt) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (inFlight) {
      return res.status(429).json({ error: 'Server is busy, please try again shortly.' });
    }
    inFlight = true;

    const attemptByProvider = async (providerName) => {
      if (providerName === 'gemini') {
        if (!ai) {
          const msg = 'GEMINI_API_KEY is not set';
          const err = new Error(msg);
          err.status = 500;
          throw err;
        }
        return await ai.models.generateContent({
          model: MODEL_ID,
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { data: base64ImageData, mimeType } },
                { text: prompt }
              ]
            }
          ],
          config: { responseModalities: ['image'] }
        });
      }
      if (providerName === 'stability') {
        const key = process.env.STABILITY_API_KEY;
        if (!key) {
          const err = new Error('STABILITY_API_KEY is not set');
          err.status = 500;
          throw err;
        }
        // Choose engine based on env (default v1-6 for maximum compatibility)
        const endpoint = STABILITY_ENGINE === 'sdxl'
          ? 'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image'
          : 'https://api.stability.ai/v1/generation/stable-diffusion-v1-6/image-to-image';
        const blob = new Blob([Buffer.from(base64ImageData, 'base64')], { type: mimeType || 'image/png' });
        const form = new FormData();
        form.append('init_image', blob, 'input');
        // Sanitize and clamp prompt to avoid 400 (length 1..2000)
        let clean = String(prompt || '').replace(/\s+/g, ' ').trim();
        if (!clean) clean = 'Enhance and clean the image for CNC-ready output on light gray background.';
        const clamped = clean.slice(0, 1800);
        form.append('text_prompts[0][text]', clamped);
        form.append('cfg_scale', STABILITY_ENGINE === 'sdxl' ? '7' : '9');
        form.append('steps', STABILITY_ENGINE === 'sdxl' ? '30' : '30');
        form.append('samples', '1');
        form.append('image_strength', '0.35');
        form.append('sampler', 'K_EULER_ANCESTRAL');
        // Let API infer target size from the init image
        form.append('init_image_mode', 'IMAGE_STRENGTH');
        // For SDXL image-to-image, Stability API requires output size to match init_image,
        // and rejects explicit width/height params. So we do NOT append width/height here.
        console.log(`[stability] engine=${STABILITY_ENGINE} endpoint=${endpoint}`);
        let resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json'
          },
          body: form
        });
        if (!resp.ok) {
          // Clone the response before consuming the body to avoid 'Body is unusable'
          let details;
          try {
            const clone = resp.clone();
            try { details = await clone.json(); }
            catch { details = await clone.text(); }
          } catch {
            details = `HTTP ${resp.status}`;
          }
          const e = new Error(`Stability request failed with ${resp.status} (${endpoint})`);
          e.status = resp.status;
          e.error = details;
          throw e;
        }
        const out = await resp.json();
        const art = (out && out.artifacts && out.artifacts[0]) || null;
        if (!art || !art.base64) {
          const e = new Error('Invalid response from Stability');
          e.status = 502;
          e.error = out;
          throw e;
        }
        const outMime = 'image/png';
        const data = art.base64;
        return {
          candidates: [
            { content: { parts: [ { inlineData: { mimeType: outMime, data } } ] } }
          ]
        };
      }
      const e = new Error(`Provider not implemented: ${providerName}`);
      e.status = 501;
      throw e;
    };

    let response;
    let tries = 0;
    let delayMs = 1000;
    while (true) {
      try {
        response = await attemptByProvider(PROVIDER);
        break;
      } catch (e) {
        const status = e?.status || e?.code;
        const isQuota = status === 429 || e?.name === 'ApiError' || String(e?.message || '').includes('RESOURCE_EXHAUSTED');
        if (!isQuota || tries >= 2) {
          if (isQuota && FALLBACK_PROVIDER && FALLBACK_PROVIDER !== PROVIDER) {
            try {
              response = await attemptByProvider(FALLBACK_PROVIDER);
              break;
            } catch (fbErr) {
              throw fbErr;
            }
          }
          throw e;
        }
        // Try to parse RetryInfo from error details
        let retryFromApi = 0;
        try {
          const details = e?.error?.details || e?.details || [];
          const retryInfo = Array.isArray(details) ? details.find(d => d['@type'] && String(d['@type']).includes('RetryInfo')) : null;
          if (retryInfo?.retryDelay) {
            // retryDelay like '40s', '1.5s'
            const m = String(retryInfo.retryDelay).match(/([0-9.]+)s/);
            if (m) retryFromApi = Math.ceil(parseFloat(m[1]) * 1000);
          }
        } catch {}
        await sleep(retryFromApi || delayMs);
        delayMs *= 2; // exponential backoff
        tries += 1;
      }
    }

    for (const part of response?.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        const newMimeType = part.inlineData.mimeType;
        const newBase64Data = part.inlineData.data;
        return res.json({ image: `data:${newMimeType};base64,${newBase64Data}` });
      }
    }

    const textResponse = typeof response?.text === 'function' ? response.text() : response?.text;
    return res.status(422).json({ error: 'No image in response', details: textResponse });
  } catch (e) {
    // Try to extract known API error structure
    const status = e?.status || e?.code || 500;
    const message = e?.message || e?.error?.message || 'Unknown error';
    const details = e?.error || e;
    console.error('AI provider error:', details);
    return res.status(Number(status) || 500).json({ error: message, details });
  } finally {
    inFlight = false;
  }
});

app.use(express.static(staticDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(staticDir, 'index.html'));
});

const PORT = process.env.PORT || 5174;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  try {
    console.log(`AI provider: ${PROVIDER}${FALLBACK_PROVIDER ? ` (fallback: ${FALLBACK_PROVIDER})` : ''}`);
  } catch {}
});

