const BASE_URL = 'https://warcraft.wiki.gg/api.php';
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
const FETCH_TIMEOUT = 10_000; // 10 seconds

export class WikiClient {
	constructor() {
		this._cache = new Map();
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

	async _fetch(params) {
		const url = new URL(BASE_URL);
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, v);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

		try {
			const res = await fetch(url.toString(), { signal: controller.signal });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: ${res.statusText}`);
			}
			return await res.json();
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Fetch and parse a wiki page by title.
	 * Returns the raw MediaWiki parse API response, or { error } if not found.
	 */
	async fetchPage(title) {
		const cacheKey = `page:${title}`;
		const cached = this._getCached(cacheKey);
		if (cached) return cached;

		const data = await this._fetch({
			action: 'parse',
			page: title,
			format: 'json',
			prop: 'text|sections',
		});

		this._setCache(cacheKey, data);
		return data;
	}

	/**
	 * Search wiki pages by query string.
	 * Returns the query.search array from the MediaWiki API.
	 */
	async searchPages(query, limit = 10) {
		const cacheKey = `search:${query}:${limit}`;
		const cached = this._getCached(cacheKey);
		if (cached) return cached;

		const data = await this._fetch({
			action: 'query',
			list: 'search',
			srsearch: query,
			srlimit: String(Math.min(limit, 20)),
			format: 'json',
		});

		const results = data?.query?.search || [];
		this._setCache(cacheKey, results);
		return results;
	}

	/**
	 * List all wiki pages matching a title prefix.
	 * Handles pagination up to 1000 results.
	 */
	async listByPrefix(prefix) {
		const cacheKey = `prefix:${prefix}`;
		const cached = this._getCached(cacheKey);
		if (cached) return cached;

		const allPages = [];
		let apcontinue;
		let pages = 0;

		while (pages < 2) { // max 2 pages (1000 results)
			const params = {
				action: 'query',
				list: 'allpages',
				apprefix: prefix,
				aplimit: '500',
				format: 'json',
			};
			if (apcontinue) params.apcontinue = apcontinue;

			const data = await this._fetch(params);
			const batch = data?.query?.allpages || [];
			allPages.push(...batch);

			apcontinue = data?.continue?.apcontinue;
			if (!apcontinue) break;
			pages++;
		}

		this._setCache(cacheKey, allPages);
		return allPages;
	}
}
