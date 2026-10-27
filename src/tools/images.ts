export const IMAGE_SIZE_PX = { thumb: 400, standard: 800, full: 1600 } as const;
export type ImageSize = keyof typeof IMAGE_SIZE_PX;

const FETCH_BATCH_SIZE = 5;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// Where each marketplace serves listing photos. A photo URL comes out of the
// listing's own data, so without this a crafted one could have the server, or
// the client rendering the markdown, request any address at all.
const IMAGE_HOSTS = [
  'fbcdn.net', // Facebook
  'ebayimg.com', // eBay
  'depop.com', // Depop (media-photos.depop.com)
  'di2ponv0v5otw.cloudfront.net', // Poshmark
];

/** The URL in canonical form when it is an https photo on a marketplace CDN. */
export function trustedImageUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const { protocol, hostname } = parsed;
  if (protocol !== 'https:') return undefined;
  if (!IMAGE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return undefined;
  // Parentheses would end a markdown image link early.
  return parsed.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// A real browser UA + Referer — eBay's CDN serves placeholder responses to
// bare server-side fetches, which is why inline base64 came back blank.
const IMAGE_FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface FetchedImage {
  url: string;
  ok: boolean;
  data?: string;
  mimeType?: string;
}

/** Magic-byte sniff so we never base64 an HTML error page or 1x1 placeholder as an image. */
export function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true; // WEBP (RIFF....WEBP)
  return false;
}

/** Fetches in batches, in listing order; a failed photo keeps its slot and url as `ok: false`. */
export async function fetchImages(urls: string[]): Promise<FetchedImage[]> {
  const fetched: FetchedImage[] = [];
  for (let i = 0; i < urls.length; i += FETCH_BATCH_SIZE) {
    const batch = urls.slice(i, i + FETCH_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(fetchImage));
    settled.forEach((s, j) => fetched.push(s.status === 'fulfilled' ? s.value : { url: batch[j], ok: false }));
  }
  return fetched;
}

async function fetchImage(url: string): Promise<FetchedImage> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res: Response | undefined;
  // Redirects are followed by hand so every hop is held to the same hosts.
  for (let hop: string | undefined = trustedImageUrl(url), redirects = 0; hop; redirects++) {
    res = await fetch(hop, {
      headers: {
        'User-Agent': IMAGE_FETCH_UA,
        Referer: 'https://www.ebay.com/',
        Accept: 'image/avif,image/webp,image/png,image/*,*/*',
      },
      redirect: 'manual',
      signal,
    });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) break;
    hop = redirects < MAX_REDIRECTS ? trustedImageUrl(new URL(location, hop).href) : undefined;
    res = undefined;
  }
  if (!res?.ok) return { url, ok: false };
  const mimeType = res.headers.get('content-type') || '';
  const buffer = await readCapped(res, MAX_IMAGE_BYTES);
  if (!buffer || !mimeType.startsWith('image/') || !looksLikeImage(buffer)) return { url, ok: false };
  return { url, ok: true, data: buffer.toString('base64'), mimeType };
}

/** The body, or undefined once it runs past `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer | undefined> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
