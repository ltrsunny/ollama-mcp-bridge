import * as cheerio from 'cheerio';

const LIBRARY_URL = 'https://ollama.com/library';
const USER_AGENT =
  'ollama-mcp-bridge/0.1 (+https://github.com/ollama-mcp-bridge)';

export interface CatalogModel {
  name: string;
  url: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pullCount: string;
  tagCount: number;
  updatedText: string;
  updatedAt: string | null;
}

export interface FetchCatalogOptions {
  limit?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class CatalogFetchError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CatalogFetchError';
  }
}

export async function fetchCatalog(
  options: FetchCatalogOptions = {},
): Promise<CatalogModel[]> {
  const { limit, signal, fetchImpl = fetch } = options;

  let response: Response;
  try {
    response = await fetchImpl(LIBRARY_URL, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
      },
      signal,
    });
  } catch (err) {
    throw new CatalogFetchError(
      `Failed to fetch ${LIBRARY_URL}: ${(err as Error).message}`,
      err,
    );
  }

  if (!response.ok) {
    throw new CatalogFetchError(
      `Unexpected status ${response.status} ${response.statusText} from ${LIBRARY_URL}`,
    );
  }

  const html = await response.text();
  return parseCatalog(html, limit);
}

export function parseCatalog(html: string, limit?: number): CatalogModel[] {
  const $ = cheerio.load(html);
  const models: CatalogModel[] = [];

  $('li[x-test-model]').each((_, el) => {
    const $el = $(el);

    const anchor = $el.find('a[href^="/library/"]').first();
    const href = anchor.attr('href') ?? '';
    const name =
      $el.find('[x-test-model-title]').attr('title')?.trim() ??
      href.replace(/^\/library\//, '');
    if (!name) return;

    const description = $el.find('[x-test-model-title] p').first().text().trim();

    const capabilities: string[] = [];
    $el.find('[x-test-capability]').each((_i, cap) => {
      const txt = $(cap).text().trim();
      if (txt) capabilities.push(txt);
    });

    const sizes: string[] = [];
    $el.find('[x-test-size]').each((_i, sz) => {
      const txt = $(sz).text().trim();
      if (txt) sizes.push(txt);
    });

    const pullCount = $el.find('[x-test-pull-count]').first().text().trim();
    const tagCountRaw = $el.find('[x-test-tag-count]').first().text().trim();
    const tagCount = Number.parseInt(tagCountRaw, 10);

    const updatedText = $el.find('[x-test-updated]').first().text().trim();
    const updatedAt =
      $el
        .find('[x-test-updated]')
        .first()
        .closest('[title]')
        .attr('title')
        ?.trim() ?? null;

    models.push({
      name,
      url: href ? new URL(href, LIBRARY_URL).toString() : '',
      description,
      capabilities,
      sizes,
      pullCount,
      tagCount: Number.isFinite(tagCount) ? tagCount : 0,
      updatedText,
      updatedAt,
    });
  });

  return typeof limit === 'number' ? models.slice(0, limit) : models;
}
