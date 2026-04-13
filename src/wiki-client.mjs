const BASE_URL = 'https://warcraft.wiki.gg/api.php';
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
const FETCH_TIMEOUT = 10_000; // 10 seconds
const METADATA_BATCH_SIZE = 10;
const MAX_FETCH_RETRIES = 4;
const MIN_REQUEST_INTERVAL_MS = 700;

export class WikiClient {
	constructor() {
		this._cache = new Map();
		this._pending = new Map();
		this._nextRequestAt = 0;
	}

	_getCached(key) {
		const entry = this._cache.get(key);
		if (!entry) return null;
		if (Date.now() - entry.timestamp > CACHE_TTL) {
			this._cache.delete(key);
			return null;
		}
		return entry.data;
	}

	_setCache(key, data) {
		this._cache.set(key, { data, timestamp: Date.now() });
	}

	async _loadCached(key, loader) {
		const cached = this._getCached(key);
		if (cached) return cached;

		const pending = this._pending.get(key);
		if (pending) return pending;

		const promise = (async () => {
			try {
				const data = await loader();
				this._setCache(key, data);
				return data;
			} finally {
				this._pending.delete(key);
			}
		})();

		this._pending.set(key, promise);
		return promise;
	}

	async _fetch(params) {
		const url = new URL(BASE_URL);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}

		for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
			await this._throttle();
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

			try {
				const response = await fetch(url.toString(), { signal: controller.signal });
				if (response.ok) {
					return await response.json();
				}

				if (attempt < MAX_FETCH_RETRIES && (response.status === 429 || response.status >= 500)) {
					await sleep(retryDelayMs(response, attempt));
					continue;
				}

				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			} finally {
				clearTimeout(timer);
			}
		}
	}

	async _throttle() {
		const now = Date.now();
		const delay = Math.max(0, this._nextRequestAt - now);
		this._nextRequestAt = Math.max(now, this._nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
		if (delay > 0) {
			await sleep(delay);
		}
	}

	async fetchPage(title) {
		const cacheKey = `page:${title}`;
		return this._loadCached(cacheKey, () => this._fetch({
			action: 'parse',
			page: title,
			format: 'json',
			prop: 'text|sections|categories',
		}));
	}

	async searchPages(query, limit = 10) {
		const cacheKey = `search:${query}:${limit}`;
		return this._loadCached(cacheKey, async () => {
			const data = await this._fetch({
			action: 'query',
			list: 'search',
			srsearch: query,
			srlimit: String(Math.min(limit, 50)),
			format: 'json',
			});

			return data?.query?.search || [];
		});
	}

	async fetchPageMetadataBatch(titles) {
		const uniqueTitles = [...new Set((titles || []).map(title => String(title || '').trim()).filter(Boolean))];
		const result = {};
		const uncachedTitles = [];

		for (const title of uniqueTitles) {
			const cached = this._getCached(`meta:${title}`);
			if (cached) {
				result[title] = cached;
			} else {
				uncachedTitles.push(title);
			}
		}

		for (let index = 0; index < uncachedTitles.length; index += METADATA_BATCH_SIZE) {
			const batch = uncachedTitles.slice(index, index + METADATA_BATCH_SIZE);
			const data = await this._fetch({
				action: 'query',
				prop: 'categories',
				titles: batch.join('|'),
				cllimit: '50',
				redirects: '1',
				format: 'json',
			});

			const pages = Object.values(data?.query?.pages || {});
			const normalizedBatch = {};
			const redirectMap = new Map();

			for (const redirect of data?.query?.redirects || []) {
				redirectMap.set(redirect.from, redirect.to);
			}

			for (const page of pages) {
				if (page.missing) continue;
				const metadata = {
					title: page.title,
					categories: page.categories || [],
				};
				normalizedBatch[page.title] = metadata;
				this._setCache(`meta:${page.title}`, metadata);
			}

			for (const requestedTitle of batch) {
				const redirectedTitle = redirectMap.get(requestedTitle);
				const metadata = normalizedBatch[requestedTitle] || (redirectedTitle ? normalizedBatch[redirectedTitle] : null) || {
					title: requestedTitle,
					categories: [],
				};
				result[requestedTitle] = metadata;
				this._setCache(`meta:${requestedTitle}`, metadata);
			}
		}

		return result;
	}

	async listByPrefix(prefix) {
		const cacheKey = `prefix:${prefix}`;
		return this._loadCached(cacheKey, async () => {
			const allPages = [];
			let apcontinue;
			let pages = 0;

			while (pages < 2) {
				const params = {
					action: 'query',
					list: 'allpages',
					apprefix: prefix,
					aplimit: '500',
					format: 'json',
				};
				if (apcontinue) params.apcontinue = apcontinue;

				const data = await this._fetch(params);
				allPages.push(...(data?.query?.allpages || []));

				apcontinue = data?.continue?.apcontinue;
				if (!apcontinue) break;
				pages++;
			}

			return allPages;
		});
	}
}

function retryDelayMs(response, attempt) {
	const retryAfter = Number(response.headers.get('retry-after'));
	if (Number.isFinite(retryAfter) && retryAfter > 0) {
		return retryAfter * 1000;
	}
	if (response.status === 429) {
		return 4000 * (attempt + 1);
	}
	return 900 * (attempt + 1);
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}
