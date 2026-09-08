// גיאואינט — image geolocation. Worker: vision battery (Workers AI Moondream) + geocoding proxy.
// Iron rule: never invent a location. Pins come only from EXIF GPS (client-side) or an explicit,
// geocoded place name found by the model with at least medium confidence.
const MODEL = '@cf/moondream/moondream3.1-9B-A2B';

const QUERIES = [
  { key: 'caption', task: 'caption', caption_length: 'long' },
  { key: 'text', task: 'query', question: 'Transcribe ALL visible text in the image: street signs, storefronts, license plates, stickers, road markings, billboards. For each item state the language/script it is written in. If there is no readable text, answer exactly: NONE.' },
  { key: 'road', task: 'query', question: 'Describe road and vehicle clues: which side vehicles drive on, road sign shapes and colors, license plate colors and format, lane marking colors, guardrails, utility poles, vehicle models. Only describe what is actually visible; if a category is not visible, say so.' },
  { key: 'environment', task: 'query', question: 'Describe the environment precisely: vegetation types, terrain, architecture style and building materials, climate indicators, sky, anything that hints at a world region. Only what is visible.' },
  { key: 'shadow', task: 'query', question: 'Look at shadows and light: which direction do shadows fall relative to the camera, and are they long or short? Estimate the sun position if possible. If there are no visible shadows, answer exactly: NONE.' },
  { key: 'region', task: 'query', question: 'As a cautious geolocation analyst: based ONLY on visible evidence, which countries or regions are plausible for this photo? Answer STRICTLY as compact JSON and nothing else: {"guesses":[{"place":"specific place or region or country","confidence":"low|medium|high","evidence":"what in the image supports it"}]}. If the evidence is insufficient, answer {"guesses":[]}. Never claim precision the image does not support.' },
];

// Assemble Moondream SSE stream into final {answer|caption} + usage
async function runAI(env, uri, spec) {
  const input = { task: spec.task, image: uri };
  if (spec.question) input.question = spec.question;
  if (spec.caption_length) input.caption_length = spec.caption_length;
  const res = await env.AI.run(MODEL, input);
  if (res && typeof res.getReader === 'function') {
    const text = await new Response(res).text();
    let answer = null, caption = null, reasoning = null, neurons = 0;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.usage && j.usage.neurons) neurons = j.usage.neurons;
        if (j.chunk) { // streaming token chunk (cumulative)
          if (j.chunk.answer) answer = j.chunk.answer;
          if (j.chunk.caption) caption = j.chunk.caption;
          if (j.chunk.reasoning && j.chunk.reasoning.text) reasoning = j.chunk.reasoning.text;
        }
        if (Array.isArray(j.output)) { // final event: full cumulative chunks; last is complete
          const c = j.output[j.output.length - 1];
          if (c) {
            if (c.answer) answer = c.answer;
            if (c.caption) caption = c.caption;
            if (c.reasoning && c.reasoning.text) reasoning = c.reasoning.text;
          }
        }
      } catch (e) { /* partial line */ }
    }
    return { answer, caption, reasoning, neurons };
  }
  // non-streaming fallback
  return { answer: res.answer || null, caption: res.caption || res.description || null, reasoning: null, neurons: 0 };
}

function parseGuesses(s) {
  if (!s) return [];
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]);
    const g = Array.isArray(j.guesses) ? j.guesses : [];
    return g.filter(x => x && x.place && ['low', 'medium', 'high'].includes(x.confidence))
      .map(x => ({ place: String(x.place).slice(0, 120), confidence: x.confidence, evidence: String(x.evidence || '').slice(0, 300) }));
  } catch (e) { return []; }
}

async function nominatim(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'gamal-geoint/1.0 (geolocation demo; contact: ozoz76747@gmail.com)', 'Accept-Language': 'he,en' } });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  return r.json();
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    try {
      if (u.pathname === '/api/analyze' && req.method === 'POST') {
        const buf = new Uint8Array(await req.arrayBuffer());
        if (buf.length < 2000) return Response.json({ ok: false, error: 'empty_image' }, { status: 400 });
        if (buf.length > 8_000_000) return Response.json({ ok: false, error: 'too_large' }, { status: 413 });
        let bin = ''; const CH = 8192;
        for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
        const mime = req.headers.get('content-type') || 'image/jpeg';
        const uri = 'data:' + (mime.startsWith('image/') ? mime : 'image/jpeg') + ';base64,' + btoa(bin);

        const out = { ok: true, model: MODEL, vision: {}, neurons: 0, errors: {} };
        for (const spec of QUERIES) {
          try {
            const r = await runAI(env, uri, spec);
            out.neurons += r.neurons || 0;
            if (spec.key === 'region') {
              out.vision.region = { raw: r.answer, guesses: parseGuesses(r.answer) };
            } else {
              out.vision[spec.key] = r.answer || r.caption || null;
              if (spec.key === 'caption') out.vision.caption_reasoning = r.reasoning;
            }
          } catch (e) {
            out.errors[spec.key] = String(e).slice(0, 200);
          }
        }

        // Geocode only concrete place guesses with medium+ confidence (indication pins, never verdicts)
        out.geocoded = [];
        for (const g of (out.vision.region ? out.vision.region.guesses : [])) {
          if (g.confidence === 'low') continue;
          try {
            const j = await nominatim('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(g.place));
            if (j && j[0]) out.geocoded.push({ place: g.place, confidence: g.confidence, evidence: g.evidence, lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name });
          } catch (e) { /* geocode optional */ }
        }
        return Response.json(out);
      }

      if (u.pathname === '/api/reverse') {
        const lat = u.searchParams.get('lat'), lon = u.searchParams.get('lon');
        if (!lat || !lon) return Response.json({ ok: false, error: 'missing' }, { status: 400 });
        try {
          const j = await nominatim(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
          return Response.json({ ok: true, label: j.display_name || null });
        } catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 502 }); }
      }

      return env.ASSETS.fetch(req);
    } catch (e) {
      return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
    }
  }
};
