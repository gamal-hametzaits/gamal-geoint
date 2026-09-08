// גיאואינט — image geolocation. Worker: vision ensemble (Workers AI Moondream) +
// clue-to-region consistency validation + sun-shadow verification + geocoding proxy.
// Iron rule: never invent a location. Pins come only from EXIF GPS or validated textual evidence.
const MODEL = '@cf/moondream/moondream3.1-9B-A2B';

const QUERIES = [
  { key: 'caption', task: 'caption', caption_length: 'long' },
  { key: 'text', task: 'query', question: 'Transcribe ALL visible text in the image: street signs, storefronts, license plates, stickers, road markings, billboards. For each item state the language/script it is written in. If there is no readable text, answer exactly: NONE.' },
  { key: 'road', task: 'query', question: 'Describe road and vehicle clues: which side vehicles drive on, road sign shapes and colors, license plate colors and format, lane marking colors (especially the center line color), guardrails, utility poles, vehicle models. Only describe what is actually visible; if a category is not visible, say so.' },
  { key: 'environment', task: 'query', question: 'Describe the environment precisely: vegetation types, terrain, architecture style and building materials, climate indicators, sky, anything that hints at a world region. Only what is visible.' },
  { key: 'shadow', task: 'query', question: 'Look at shadows and light: which direction do shadows fall relative to the camera, and are they long, medium, or short? If there are no visible shadows, answer exactly: NONE.' },
  { key: 'lighting', task: 'query', question: 'Classify the scene lighting and sky. Answer in this exact format on the first line: LIGHT: DAY|OVERCAST|DUSK|NIGHT SKY: CLEAR|PARTLY|OVERCAST. Then one short sentence of justification.' },
  { key: 'signs', task: 'query', question: 'Count the man-made location clues visible: how many street signs, billboards with text, and license plates can you see? Answer STRICTLY as compact JSON: {"street_signs":N,"billboards":N,"license_plates":N}. Numbers only as values.' },
  { key: 'region', task: 'query', question: 'As a cautious geolocation analyst: based ONLY on visible evidence, which countries or regions are plausible for this photo? Answer STRICTLY as compact JSON and nothing else: {"guesses":[{"place":"specific place or region or country","confidence":"low|medium|high","evidence":"what in the image supports it"}]}. If the evidence is insufficient, answer {"guesses":[]}. Never claim precision the image does not support.' },
  // ensemble pass 2: different framing, to cross-check pass 1
  { key: 'region2', task: 'query', question: 'You are verifying a geolocation. Look only at hard evidence in this image (readable text, sign standards, plate formats, driving side, vegetation zones). List the two most plausible countries. STRICT compact JSON only: {"countries":[{"country":"name","evidence":"visible clue"}]}. If there is no hard evidence, answer {"countries":[]}.' },
];

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
        if (j.chunk) {
          if (j.chunk.answer) answer = j.chunk.answer;
          if (j.chunk.caption) caption = j.chunk.caption;
          if (j.chunk.reasoning && j.chunk.reasoning.text) reasoning = j.chunk.reasoning.text;
        }
        if (Array.isArray(j.output)) {
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
  return { answer: res.answer || null, caption: res.caption || res.description || null, reasoning: null, neurons: 0 };
}

function parseJsonFrom(s) {
  if (!s) return null;
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

function parseGuesses(s) {
  const j = parseJsonFrom(s);
  const g = j && Array.isArray(j.guesses) ? j.guesses : [];
  return g.filter(x => x && x.place && ['low', 'medium', 'high'].includes(x.confidence))
    .map(x => ({ place: String(x.place).slice(0, 120), confidence: x.confidence, evidence: String(x.evidence || '').slice(0, 300) }));
}
function parseCountries(s) {
  const j = parseJsonFrom(s);
  const c = j && Array.isArray(j.countries) ? j.countries : [];
  return c.filter(x => x && x.country).map(x => ({ country: String(x.country).slice(0, 80), evidence: String(x.evidence || '').slice(0, 200) }));
}

// ---------------- deterministic clue extraction ----------------
const SCRIPT_COUNTRIES = {
  hebrew: ['israel'],
  arabic: ['israel','egypt','jordan','lebanon','syria','iraq','saudi','emirates','uae','qatar','kuwait','bahrain','oman','yemen','morocco','algeria','tunisia','libya','palestin'],
  cyrillic: ['russia','ukraine','belarus','bulgaria','serbia','montenegro','macedonia','kazakhstan','kyrgyzstan','mongolia'],
  greek: ['greece','cyprus'],
  thai: ['thailand'],
  georgian: ['georgia'],
  armenian: ['armenia'],
  devanagari: ['india','nepal'],
  bengali: ['bangladesh','india'],
  chinese: ['china','taiwan','hong kong','singapore'],
  japanese: ['japan'],
  korean: ['korea'],
  latin: ['europe','united states','usa','uk','france','germany','italy','spain','latin america','australia','canada','turkey','israel'],
};
const LEFT_TRAFFIC = ['uk','united kingdom','britain','japan','australia','india','thailand','south africa','cyprus','malta','ireland','indonesia','malaysia','singapore','hong kong','new zealand','kenya','bangladesh','pakistan','sri lanka'];

function extractSignals(vision) {
  const sig = [];
  const t = (vision.text || '') + ' ';
  const r = (vision.road || '') + ' ';
  for (const [script, countries] of Object.entries(SCRIPT_COUNTRIES)) {
    if (new RegExp('\\b' + script + '\\b', 'i').test(t)) sig.push({ type: 'script', value: script, countries, label: 'כתב ' + script });
  }
  if (/drive[s]? on the left|left[- ]hand (traffic|drive|side)/i.test(r)) sig.push({ type: 'driving', value: 'left', label: 'נהיגה בשמאל' });
  else if (/drive[s]? on the right|right[- ]hand (traffic|drive|side)/i.test(r)) sig.push({ type: 'driving', value: 'right', label: 'נהיגה בימין' });
  const plateM = r.match(/(yellow|white|blue|green|black)[ -](?:colored? )?(license )?plate/i);
  if (plateM) sig.push({ type: 'plate', value: plateM[1].toLowerCase(), label: 'לוחית ' + plateM[1] });
  // plate format database (color -> countries where this is standard)
  const PLATE_DB = {
    yellow: ['israel','netherlands','united kingdom','uk','luxembourg','japan','colombia'],
    blue: ['israel','europe','france','germany','italy','spain','poland'], // eu band / old IL
  };
  if (plateM && PLATE_DB[plateM[1].toLowerCase()]) sig.push({ type: 'platedb', value: plateM[1].toLowerCase(), countries: PLATE_DB[plateM[1].toLowerCase()], label: 'פורמט לוחית ' + plateM[1] });
  if (/yellow (center|centre|centerline|middle)[ -]?line|double yellow/i.test(r)) sig.push({ type: 'centerline', value: 'yellow', label: 'קו אמצע צהוב' });
  return sig;
}

function countryMatches(place, countryKey) {
  return place.toLowerCase().includes(countryKey);
}

// consistency: returns {supports:[], contradicts:[]} for a candidate place
function validateCandidate(place, signals) {
  const out = { supports: [], contradicts: [] };
  const p = place.toLowerCase();
  for (const s of signals) {
    if (s.type === 'script') {
      const match = s.countries.some(c => countryMatches(p, c));
      if (match) out.supports.push(s.label + ' תואם');
      else if (s.value !== 'latin') out.contradicts.push(s.label + ' לא אופייני למקום הזה');
    }
    if (s.type === 'platedb') {
      const match = s.countries.some(c => countryMatches(p, c));
      if (match) out.supports.push(s.label + ' תואם למאגר הפורמטים');
      else out.contradicts.push(s.label + ' לא תקנית במקום הזה לפי מאגר הפורמטים');
    }
    if (s.type === 'driving') {
      const isLeft = LEFT_TRAFFIC.some(c => countryMatches(p, c));
      if (s.value === 'left' && isLeft) out.supports.push(s.label + ' תואם');
      else if (s.value === 'left' && !isLeft) out.contradicts.push(s.label + ' אבל במקום הזה נוהגים בימין');
      else if (s.value === 'right' && isLeft) out.contradicts.push(s.label + ' אבל במקום הזה נוהגים בשמאל');
      else if (s.value === 'right' && !isLeft) out.supports.push(s.label + ' תואם');
    }
  }
  return out;
}

// ---------------- sun math (server side, for verification) ----------------
function sunPos(ms, lat, lon) {
  const r = Math.PI / 180, d = ms / 864e5 - .5 + 2440588 - 2451545;
  const M = r * (357.5291 + .98560028 * d), C = r * (1.9148 * Math.sin(M) + .02 * Math.sin(2 * M) + .0003 * Math.sin(3 * M)), P = r * 102.9372, L = M + C + P + Math.PI;
  const dec = Math.asin(Math.sin(L) * Math.sin(r * 23.4397)), ra = Math.atan2(Math.sin(L) * Math.cos(r * 23.4397), Math.cos(L));
  const H = r * (280.16 + 360.9856235 * d) - lon * r - ra;
  const alt = Math.asin(Math.sin(lat * r) * Math.sin(dec) + Math.cos(lat * r) * Math.cos(dec) * Math.cos(H));
  return { alt: alt / r };
}
function parseExifTs(s) {
  const m = String(s || '').match(/(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], se: +m[6] };
}
// Verify lighting claim vs sun position at candidate place+time (tz guessed from longitude).
function shadowCheck(alt, shadowLength) {
  if (alt == null || !shadowLength) return null;
  // expected sun elevation ranges for shadow lengths
  const exp = { short: [50, 90], medium: [22, 55], long: [0, 25] };
  const r = exp[shadowLength];
  if (!r) return null;
  if (alt >= r[0] && alt <= r[1]) return { ok: true, msg: 'אורך הצללים (' + shadowLength + ') תואם גובה שמש מחושב ' + alt.toFixed(0) + '°' };
  if (alt < 0) return null; // night handled elsewhere
  return { ok: false, msg: 'סתירת צללים: בתמונה צללים ' + shadowLength + ' (מצופה ' + r[0] + '-' + r[1] + '°) אבל הגובה המחושב ' + alt.toFixed(0) + '°' };
}

function sunCheck(tsParts, lat, lon, lightingClass) {
  if (!tsParts || !lightingClass) return null;
  const tzGuess = Math.round(lon / 15);
  const utcMs = Date.UTC(tsParts.y, tsParts.mo - 1, tsParts.d, tsParts.h - tzGuess, tsParts.mi, tsParts.se);
  const alt = sunPos(utcMs, lat, lon).alt;
  const L = lightingClass.toUpperCase();
  if (alt < -8 && (L === 'DAY' || L === 'OVERCAST')) return { ok: false, alt: +alt.toFixed(1), msg: 'סתירה: לפי חותמת הזמן במקום הזה היה חושך (שמש ' + alt.toFixed(0) + '° מתחת לאופק), אבל התמונה צולמה באור יום' };
  if (alt > 5 && L === 'NIGHT') return { ok: false, alt: +alt.toFixed(1), msg: 'סתירה: לפי חותמת הזמן השמש הייתה ' + alt.toFixed(0) + '° מעל האופק, אבל התמונה נראית כצילום לילה' };
  return { ok: true, alt: +alt.toFixed(1), msg: 'תואם: גובה שמש מחושב ' + alt.toFixed(0) + '° מול סוג התאורה בתמונה' };
}

async function weatherCheck(tsParts, lat, lon, sky) {
  if (!tsParts || !sky) return null;
  const pad = n => String(n).padStart(2, '0');
  const date = tsParts.y + '-' + pad(tsParts.mo) + '-' + pad(tsParts.d);
  // archive lags ~5 days; skip if too recent
  const ageDays = (Date.now() - Date.UTC(tsParts.y, tsParts.mo - 1, tsParts.d)) / 864e5;
  if (ageDays < 6) return { skipped: true, msg: 'ארכיון מזג האוויר מתעדכן בהפרש של ~5 ימים — אין נתונים לתאריך הזה עדיין' };
  if (ageDays > 365 * 30) return { skipped: true, msg: 'תאריך מחוץ לטווח הארכיון' };
  try {
    const r = await fetch('https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon + '&start_date=' + date + '&end_date=' + date + '&hourly=cloud_cover,precipitation&timezone=auto', { headers: { 'User-Agent': 'gamal-geoint/1.0' } });
    const j = await r.json();
    const cc = j.hourly && j.hourly.cloud_cover, pr = j.hourly && j.hourly.precipitation;
    if (!cc) return null;
    const hour = Math.min(23, tsParts.h);
    const cloud = cc[hour], rain = pr && pr[hour] > 0;
    let ok = null, msg;
    if (sky === 'CLEAR') { ok = cloud <= 45; msg = 'שמיים: התמונה מראה בהיר, הארכיון אומר ' + cloud + '% עננות'; }
    else if (sky === 'OVERCAST') { ok = cloud >= 70; msg = 'שמיים: התמונה מראה מעונן, הארכיון אומר ' + cloud + '% עננות'; }
    else { ok = cloud > 20 && cloud < 85; msg = 'שמיים: התמונה מראה מעונן חלקית, הארכיון אומר ' + cloud + '% עננות'; }
    return { ok, cloud, rain, msg: msg + (rain ? ' + משקעים' : ''), source: 'open-meteo archive' };
  } catch (e) { return null; }
}

async function elevCheck(lat, lon, exifAlt) {
  try {
    const r = await fetch('https://api.open-meteo.com/v1/elevation?latitude=' + lat + '&longitude=' + lon, { headers: { 'User-Agent': 'gamal-geoint/1.0' }, signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const t = j.elevation && j.elevation[0];
    if (typeof t !== 'number') return null;
    const diff = Math.abs(exifAlt - t);
    if (diff <= 60) return { ok: true, msg: "גובה GPS (" + Math.round(exifAlt) + "מ') תואם גובה שטח (" + Math.round(t) + "מ')", diff: Math.round(diff) };
    return { ok: false, msg: "גובה GPS (" + Math.round(exifAlt) + "מ') רחוק " + Math.round(diff) + "מ' מגובה השטח (" + Math.round(t) + "מ') — ייתכן זיוף או קלט GPS רועש", diff: Math.round(diff) };
  } catch (e) { return null; }
}

// deterministic per-section analysis summaries (Hebrew): what was checked, what was detected, why (in)sufficient
function buildSummaries(V, signals, ens, exifTs, skyClass, lightClass) {
  const S = {};
  const none = v => !v || /^\s*NONE\.?\s*$/i.test(String(v));
  const scripts = signals.filter(s => s.type === 'script');
  if (none(V.text)) S.text = 'נבדקו שלטי רחוב, שמות חנויות, לוחיות רישוי, מדבקות ושלטי חוצות. לא זוהה טקסט קריא — בלי טקסט אי אפשר לזהות שפה או תקן שילוט, ולכן הקטגוריה לא תורמת לקביעה.';
  else {
    const nonLatin = scripts.filter(s => s.value !== 'latin');
    S.text = 'זוהה טקסט קריא בתמונה. ' + (scripts.length ? 'כתבים שזוהו: ' + scripts.map(s => s.value).join(', ') + '. ' : '') +
      (nonLatin.length ? 'כתב לא-לטיני מצמצם אזור חזק — ההשלכות נבדקות מול כל מועמד בפאנל האימותים.' : 'כתב לטיני בלבד נפוץ בעשרות מדינות — מצמצם מעט.');
  }
  const rs = signals.filter(s => ['driving', 'plate', 'platedb', 'centerline'].includes(s.type));
  if (none(V.road)) S.road = 'נבדקו צד נהיגה, תקן תמרורים, צבע ופורמט לוחיות וקווי דרך. לא זוהה כביש או רכבים ברורים — אין בסיס לרמזי תנועה.';
  else S.road = 'נבדקו צד נהיגה, תקן תמרורים, צבע/פורמט לוחיות וקווי דרך. ' + (rs.length ? 'חולצו רמזים קשיחים: ' + rs.map(s => s.label).join(' · ') + ' — נשקלים מול כל מועמד בפאנל האימותים.' : 'לא חולץ רמז קשיח (צד נהיגה / צבע לוחית / קו אמצע) — התוכן תורם הקשר בלבד.');
  S.environment = none(V.environment) ? 'נבדקו צמחייה, תוואי שטח, אדריכלות ואקלים. לא זוהו סממנים ייחודיים.' : 'נבדקו צמחייה, תוואי שטח, חומרי בנייה ואקלים. רמזים סביבתיים הם איכותניים: תומכים או מחלישים אזור, אבל לבד אינם קובעים מיקום.';
  const lp = [];
  if (lightClass) lp.push('תאורה סווגה ' + lightClass);
  if (skyClass) lp.push('שמיים ' + skyClass);
  S.shadow = (lp.length ? lp.join(' · ') + '. ' : (none(V.shadow) ? 'לא זוהו צללים או שמיים ברורים. ' : '')) + (exifTs ? 'הסיווג שולב באימות האסטרונומי ובבדיקת מזג האוויר בפאנל האימותים.' : 'בלי חותמת זמן ב-EXIF אי אפשר להפוך את זה לאימות אסטרונומי — נשאר רמז איכותי בלבד.');
  S.caption = 'תיאור סצנה כללי להקשר בלבד — אינו ראיית מיקום כשלעצמו ואינו משפיע על הקביעה.';
  if (ens && (ens.pass1 || ens.pass2)) S.guesses = 'מעבר 1 העלה ' + ens.pass1 + ' הערכות, מעבר האימות העלה ' + ens.pass2 + ' מדינות, ' + ens.agreements + ' בחפיפה. הערכה לא מאומתת לא מסומנת על המפה.';
  else S.guesses = 'המודל לא העלה אף הערכת אזור — הראיות חלשות מדי. זו תשובה לגיטימית, לא תקלה.';
  return S;
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
        // optional client-supplied EXIF facts for server-side verification (client stays source of truth for display)
        const exifTs = parseExifTs(u.searchParams.get('ts'));
        const gpsLat = parseFloat(u.searchParams.get('lat')), gpsLon = parseFloat(u.searchParams.get('lon'));
        const hasGps = isFinite(gpsLat) && isFinite(gpsLon);
        const gpsAlt = parseFloat(u.searchParams.get('alt'));
        const hasAlt = isFinite(gpsAlt);

        let bin = ''; const CH = 8192;
        for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
        const mime = req.headers.get('content-type') || 'image/jpeg';
        const uri = 'data:' + (mime.startsWith('image/') ? mime : 'image/jpeg') + ';base64,' + btoa(bin);

        const out = { ok: true, model: MODEL, vision: {}, neurons: 0, errors: {} };
        // EXIF sanity / provenance flags (deterministic)
        const exifSanity = [];
        const mk = u.searchParams.get('make') || '', md = u.searchParams.get('model') || '', sw = u.searchParams.get('sw') || '';
        if (sw && /photoshop|lightroom|snapseed|gimp|pixlr|canva|afterlight|vsco/i.test(sw)) exifSanity.push({ ok: false, msg: 'שדה התוכנה מראה עריכה: ' + sw });
        if (!exifTs && hasGps) exifSanity.push({ ok: false, msg: 'יש GPS אבל אין חותמת זמן — חריג' });
        if (exifTs && !hasGps) exifSanity.push({ ok: true, msg: 'חותמת זמן בלי GPS — דפוס נפוץ ולגיטימי' });
        if (mk && md) {
          const a = md.toLowerCase(), b = mk.toLowerCase();
          if (a.startsWith(b) || a.includes(b) || b.startsWith(a)) exifSanity.push({ ok: true, msg: 'יצרן/דגם עקביים: ' + mk + ' / ' + md });
          else exifSanity.push({ ok: true, msg: 'יצרן/דגם: ' + mk + ' / ' + md + ' (קיימים, בדיקת עקביות לא חלה)' });
        }
        if (!mk && !md) exifSanity.push({ ok: false, msg: 'אין פרטי מצלמה בכלל — אופייני לצילום מסך או תמונה שעברה עריכה/שידוך' });
        out.exifSanity = exifSanity;
        for (const spec of QUERIES) {
          try {
            const r = await runAI(env, uri, spec);
            out.neurons += r.neurons || 0;
            if (spec.key === 'region') out.vision.region = { raw: r.answer, guesses: parseGuesses(r.answer) };
            else if (spec.key === 'region2') out.vision.region2 = { raw: r.answer, countries: parseCountries(r.answer) };
            else {
              out.vision[spec.key] = r.answer || r.caption || null;
              if (spec.key === 'caption') out.vision.caption_reasoning = r.reasoning;
            }
          } catch (e) { out.errors[spec.key] = String(e).slice(0, 200); }
        }

        // lighting class
        const lm = (out.vision.lighting || '').match(/\b(DAY|OVERCAST|DUSK|NIGHT)\b/i);
        const lighting = lm ? lm[1].toUpperCase() : null;
        out.lighting = lighting;
        const sm = (out.vision.lighting || '').match(/SKY:\s*(CLEAR|PARTLY|OVERCAST)/i);
        out.sky = sm ? sm[1].toUpperCase() : null;
        const sj = parseJsonFrom(out.vision.signs);
        out.signCounts = sj && typeof sj === 'object' ? { street_signs: +sj.street_signs || 0, billboards: +sj.billboards || 0, license_plates: +sj.license_plates || 0 } : null;
        const shM = (out.vision.shadow || '').match(/\b(very short|short|medium|long)\b/i);
        out.shadowLength = shM ? shM[1].toLowerCase().replace('very ', '') : null;

        // deterministic clue extraction + ensemble merge
        const signals = extractSignals(out.vision);
        out.signals = signals;
        const guesses = (out.vision.region ? out.vision.region.guesses : []);
        const countries2 = (out.vision.region2 ? out.vision.region2.countries : []);
        // ensemble agreement: boost guesses corroborated by pass 2
        for (const g of guesses) {
          const p = g.place.toLowerCase();
          g.corroborated = countries2.some(c => p.includes(c.country.toLowerCase()) || c.country.toLowerCase().includes(p));
        }
        out.ensemble = { pass1: guesses.length, pass2: countries2.length, agreements: guesses.filter(g => g.corroborated).length, pass2Countries: countries2 };
        out.summaries = buildSummaries(out.vision, signals, out.ensemble, exifTs, out.sky, lighting);

        // geocode candidates (medium+ only)
        out.geocoded = [];
        for (const g of guesses) {
          if (g.confidence === 'low') continue;
          try {
            const j = await nominatim('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(g.place));
            if (j && j[0]) out.geocoded.push({ place: g.place, confidence: g.confidence, evidence: g.evidence, corroborated: !!g.corroborated, lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name });
          } catch (e) { /* geocode optional */ }
        }

        // consistency validation per geocoded candidate + EXIF GPS itself
        const candidates = out.geocoded.map(g => ({ name: g.place, lat: g.lat, lon: g.lon, ref: g }));
        if (hasGps) candidates.push({ name: 'EXIF GPS', lat: gpsLat, lon: gpsLon, isGps: true });
        out.consistency = [];
        for (const c of candidates) {
          const v = validateCandidate(c.name === 'EXIF GPS' ? '' : c.name, signals); // GPS has no place-name string; sun check still applies
          const sun = exifTs ? sunCheck(exifTs, c.lat, c.lon, lighting) : null;
          let shadow = null, weather = null, altitude = null;
          if (c.isGps && hasAlt) altitude = await elevCheck(c.lat, c.lon, gpsAlt);
          if (exifTs) {
            const tzGuess = Math.round(c.lon / 15);
            const alt = sunPos(Date.UTC(exifTs.y, exifTs.mo - 1, exifTs.d, exifTs.h - tzGuess, exifTs.mi, exifTs.se), c.lat, c.lon).alt;
            shadow = shadowCheck(alt, out.shadowLength);
            weather = await weatherCheck(exifTs, c.lat, c.lon, out.sky);
          }
          out.consistency.push({ name: c.name, isGps: !!c.isGps, supports: v.supports, contradicts: v.contradicts, sun, shadow, weather, altitude });
          if (c.ref) { c.ref.supports = v.supports; c.ref.contradicts = v.contradicts; c.ref.sun = sun; c.ref.shadow = shadow; c.ref.weather = weather; c.ref.altitude = altitude; }
        }

        // verdict ladder: confirmed / strong / weak / none
        let verdict = 'none';
        if (hasGps) verdict = 'confirmed';
        else {
          const strong = out.geocoded.find(g =>
            (g.confidence === 'high' || (g.confidence === 'medium' && (g.corroborated || (g.supports && g.supports.length))) )
            && !(g.contradicts && g.contradicts.length)
            && !(g.sun && g.sun.ok === false) && !(g.shadow && g.shadow.ok === false) && !(g.weather && g.weather.ok === false));
          if (strong) verdict = 'strong';
          else if (out.geocoded.length || guesses.length || countries2.length) verdict = 'weak';
        }
        out.verdict = verdict;
        // pins only for confirmed/strong
        out.pinsAllowed = (verdict === 'confirmed' || verdict === 'strong');
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

      if (u.pathname === '/api/poi') {
        const lat = parseFloat(u.searchParams.get('lat')), lon = parseFloat(u.searchParams.get('lon'));
        if (!isFinite(lat) || !isFinite(lon)) return Response.json({ ok: false, error: 'missing' }, { status: 400 });
        try {
          const q = '[out:json][timeout:8];(node(around:250,' + lat + ',' + lon + ')[name];way(around:250,' + lat + ',' + lon + ')[name];);out center tags 12;';
          let j = null, lastErr = '';
          for (const method of ['GET', 'POST']) {
            try {
              const url = 'https://overpass-api.de/api/interpreter' + (method === 'GET' ? '?data=' + encodeURIComponent(q) : '');
              const r = await fetch(url, method === 'POST'
                ? { method, headers: { 'User-Agent': 'gamal-geoint/1.0 (geolocation demo; contact: ozoz76747@gmail.com)', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(9000) }
                : { headers: { 'User-Agent': 'gamal-geoint/1.0 (geolocation demo; contact: ozoz76747@gmail.com)' }, signal: AbortSignal.timeout(9000) });
              const t = await r.text();
              j = JSON.parse(t);
              if (j && Array.isArray(j.elements)) break; else { j = null; lastErr = 'no elements'; }
            } catch (e) { j = null; lastErr = String(e).slice(0, 120); }
          }
          if (!j) {
            // fallback: fine-grained reverse geocode names the place at the pin
            const names = [];
            for (const z of [18, 17]) {
              try {
                const rv = await nominatim('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=' + z + '&lat=' + lat + '&lon=' + lon);
                const nm = rv && rv.name;
                if (nm && !names.includes(nm)) names.push(nm);
              } catch (e) { /* optional */ }
            }
            return Response.json({ ok: true, pois: names.map(n => ({ name: n, dist: 0 })), via: 'nominatim-reverse', note: 'overpass unavailable: ' + lastErr });
          }
          const R = 6371000, p = Math.PI / 180;
          const hav = (a, b, c, d) => { const x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
          const seen = new Set();
          const pois = (j.elements || []).map(e => {
            const la = e.lat != null ? e.lat : (e.center && e.center.lat), lo = e.lon != null ? e.lon : (e.center && e.center.lon);
            const name = e.tags && (e.tags['name:he'] || e.tags.name);
            return { name, dist: (la != null && lo != null) ? Math.round(hav(lat, lon, la, lo)) : null };
          }).filter(x => x.name && !seen.has(x.name) && seen.add(x.name)).sort((a, b) => (a.dist == null ? 1e9 : a.dist) - (b.dist == null ? 1e9 : b.dist)).slice(0, 8);
          return Response.json({ ok: true, pois });
        } catch (e) { return Response.json({ ok: false, error: String(e).slice(0, 200) }, { status: 502 }); }
      }

      return env.ASSETS.fetch(req);
    } catch (e) {
      return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
    }
  }
};
