# גיאואינט v6

Free image evidence workspace, Hebrew RTL. Image selection is local and does not start AI automatically.

## New tools
- Tesseract.js 6.0.1 local OCR, Hebrew+English or Arabic+English, crop, rotation and contrast. Transcription is unverified; OCR confidence is not location confidence.
- Local metadata/forensics mode, explicit server analysis and JSON evidence export.
- EXIF GPS is editable metadata, not confirmed location. Contradictions hide its pin. Same-model agreement never authorizes a location pin. Candidate geocoding is explicitly labelled as unverified. City/region/country candidates use red bounding-box areas from OSM, not fake exact photo pins. Concrete named places use labelled candidate pins; uncertainty is unknown.
- First-time OCR downloads Apache-2.0 libraries from jsDelivr and projectnaptha and language models. No image upload for OCR. Models may be slow on phones; blurry/small text may fail.

## Sources and licenses
- https://github.com/naptha/tesseract.js/ - Apache 2.0
- https://github.com/naptha/tesseract.js-core - Apache 2.0
- https://github.com/tesseract-ocr/tessdata_fast - Apache 2.0
- Tesseract package distributions retain Apache-2.0 notices. CDN dependencies are pinned to Tesseract 6.0.1 / core 6.0.0.
- Existing exifr and Leaflet licenses remain unchanged.

## Privacy and limits
Server analysis sends a resized image and available GPS/time/camera fields to Cloudflare. No image persistence is implemented in this app, but provider policies also apply. Local-only analysis makes no analysis/reverse API requests; a GPS map downloads OpenStreetMap tiles. Image upload cap is 25MB in the UI, resized server input cap 8MB.

Cloudflare AI free allowance: 10,000 neurons/day shared across the account, not a fixed number of analyses. Stop on quota exhaustion; no automatic client retry. Usage reported by the provider may be incomplete. https://developers.cloudflare.com/workers-ai/platform/pricing/

No face identification. No reverse-image-search API. ELA/JPEG Ghost are compression visualizations, not authentication tests. Sun/weather checks depend on editable timestamps and an approximate timezone. https://operations.osmfoundation.org/policies/nominatim/ defines the public geocoder's 1 request/s application-wide ceiling. Candidate geocoding is capped at two evidence-bearing guesses. Calls queue at least 1.1s apart within one Worker isolate; this is not an account-wide distributed rate limiter, so the public endpoint is suitable only for this low-traffic personal tool. Automatic POI lookups are disabled.

Existing GitHub Actions deploy workflow and Cloudflare free Workers/AI bindings. No new paid service, credential or account required.
