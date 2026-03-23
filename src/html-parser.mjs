import { parse as parseHTML } from 'node-html-parser';

/**
 * Parse a wiki page's HTML into structured sections.
 *
 * @param {string} html - The parse.text["*"] HTML from the MediaWiki API
 * @param {string} pageTitle - The page title (for URL generation)
 * @returns {{ title: string, description: string, deprecated: string|null, sections: Object<string, string>, url: string }}
 */
export function parseWikiPage(html, pageTitle) {
	const root = parseHTML(html);
	const container = root.querySelector('.mw-parser-output') || root;

	// Remove noise: edit links, TOC
	for (const el of container.querySelectorAll('.mw-editsection, #toc, .toc')) {
		el.remove();
	}
	// Remove info boxes/navigation that appear before the first <h2>.
	// These are always sidebar navs (div.nomobile), API info tables (table.bigtable),
	// or event info boxes (div with float:right). Content is always after <h2>.
	for (const child of [...container.childNodes]) {
		if (child.tagName === 'H2') break;
		if (child.tagName === 'TABLE') child.remove();
		if (child.tagName === 'DIV') {
			const cls = child.classNames || '';
			const style = child.getAttribute('style') || '';
			if (cls.includes('nomobile') || style.includes('float')) {
				child.remove();
			}
		}
	}
	// Remove "↑ World of Warcraft API" back-navigation paragraphs
	for (const p of container.querySelectorAll('p')) {
		if (p.text.trim().startsWith('↑')) p.remove();
	}

	// Extract deprecation notice before section splitting
	let deprecated = null;
	const ambox = container.querySelector('.ambox-yellow');
	if (ambox) {
		deprecated = nodeToText(ambox.querySelector('.ambox-text') || ambox).trim();
		ambox.remove();
	}

	// Split content at <h2> boundaries
	const sections = {};
	let currentName = '_description';
	let currentNodes = [];

	for (const child of container.childNodes) {
		if (child.tagName === 'H2') {
			// Flush previous section
			if (currentNodes.length > 0) {
				const text = nodesToText(currentNodes).trim();
				if (text) sections[currentName] = text;
			}
			// Start new section
			const headline = child.querySelector('.mw-headline');
			currentName = headline ? normalizeSectionName(headline.text.trim()) : 'unknown';
			currentNodes = [];
		} else {
			currentNodes.push(child);
		}
	}
	// Flush last section
	if (currentNodes.length > 0) {
		const text = nodesToText(currentNodes).trim();
		if (text) sections[currentName] = text;
	}

	const description = sections._description || '';
	delete sections._description;

	return {
		title: cleanTitle(pageTitle),
		description,
		deprecated,
		sections,
		url: `https://warcraft.wiki.gg/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
	};
}

/**
 * Clean a wiki page title for display: strip "API " prefix, restore C_ and event underscores.
 * Wiki API returns spaces in titles: "API C Spell.GetSpellCooldown", "SPELL UPDATE COOLDOWN".
 */
export function cleanTitle(title) {
	let clean = title.replace(/^API[_ ]/, '').replace(/^(C) /, 'C_');
	if (/^[A-Z][A-Z0-9 ]+$/.test(clean)) {
		clean = clean.replace(/ /g, '_');
	}
	return clean;
}

/**
 * Strip HTML tags and decode common HTML entities.
 */
export function stripHtmlTags(text) {
	return text
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#?\w+;/g, '');
}

/**
 * Normalize section header names to consistent keys.
 */
function normalizeSectionName(name) {
	const lower = name.toLowerCase().replace(/\s+/g, '_');
	const map = {
		arguments: 'arguments',
		params: 'arguments',
		parameters: 'arguments',
		returns: 'returns',
		return_values: 'returns',
		return_value: 'returns',
		details: 'details',
		notes: 'details',
		usage: 'details',
		example: 'example',
		examples: 'example',
		patch_changes: 'patch_changes',
		patch_history: 'patch_changes',
		see_also: 'see_also',
		related_events: 'related_events',
		members: 'members',
		fields: 'fields',
		values: 'values',
	};
	return map[lower] || lower;
}

/**
 * Convert an array of DOM nodes into clean text.
 */
function nodesToText(nodes) {
	const parts = [];
	for (const node of nodes) {
		const text = nodeToText(node);
		if (text) parts.push(text);
	}
	return parts.join('\n');
}

/**
 * Recursively convert a DOM node to clean text.
 */
function nodeToText(node) {
	if (!node) return '';

	// Text node
	if (node.nodeType === 3) {
		return node.text;
	}

	// Element node
	const tag = node.tagName;

	// Skip images entirely
	if (tag === 'IMG') return '';

	// Skip style/script
	if (tag === 'STYLE' || tag === 'SCRIPT') return '';

	// Code blocks: mw-highlight wrapping <pre>
	// node-html-parser treats <pre> content as raw text, so .text includes HTML tags.
	// Use innerHTML + tag stripping to get clean code text.
	if (tag === 'DIV' && node.classNames?.includes('mw-highlight')) {
		const pre = node.querySelector('pre');
		const raw = pre ? pre.innerHTML : node.innerHTML;
		const code = stripHtmlTags(raw).trim();
		return '\n```lua\n' + code + '\n```\n';
	}

	// Preformatted
	if (tag === 'PRE') {
		const code = stripHtmlTags(node.innerHTML).trim();
		return '\n```\n' + code + '\n```\n';
	}

	// Inline code
	if (tag === 'CODE') {
		return '`' + node.text.trim() + '`';
	}

	// Paragraphs
	if (tag === 'P') {
		const inner = childrenToText(node).trim();
		return inner ? inner + '\n' : '';
	}

	// Headings (h3, h4 — subsections within an h2 section)
	if (tag === 'H3') {
		const headline = node.querySelector('.mw-headline');
		const text = headline ? headline.text.trim() : node.text.trim();
		return '\n### ' + text + '\n';
	}
	if (tag === 'H4') {
		const headline = node.querySelector('.mw-headline');
		const text = headline ? headline.text.trim() : node.text.trim();
		return '\n#### ' + text + '\n';
	}

	// Unordered lists
	if (tag === 'UL') {
		return listToText(node, '- ', 0);
	}

	// Ordered lists
	if (tag === 'OL') {
		return orderedListToText(node, 0);
	}

	// Definition lists (used for arguments/returns)
	if (tag === 'DL') {
		return dlToText(node, 0);
	}

	// Tables (non-ambox)
	if (tag === 'TABLE') {
		return tableToText(node);
	}

	// Line break
	if (tag === 'BR') {
		return '\n';
	}

	// Links — just the text
	if (tag === 'A') {
		return node.text;
	}

	// Spans, divs, etc. — recurse into children
	return childrenToText(node);
}

/**
 * Convert all children of a node to text.
 */
function childrenToText(node) {
	const parts = [];
	for (const child of node.childNodes) {
		parts.push(nodeToText(child));
	}
	return parts.join('');
}

/**
 * Convert a <ul> to bulleted text.
 */
function listToText(ul, prefix, depth) {
	const indent = '  '.repeat(depth);
	const lines = [];
	for (const li of ul.querySelectorAll(':scope > li')) {
		// Get direct text (not nested lists)
		const textParts = [];
		const nestedLists = [];
		for (const child of li.childNodes) {
			if (child.tagName === 'UL' || child.tagName === 'OL' || child.tagName === 'DL') {
				nestedLists.push(child);
			} else {
				textParts.push(nodeToText(child));
			}
		}
		const text = textParts.join('').trim();
		if (text) lines.push(indent + prefix + text);

		for (const nested of nestedLists) {
			if (nested.tagName === 'UL') {
				lines.push(listToText(nested, '- ', depth + 1));
			} else if (nested.tagName === 'OL') {
				lines.push(orderedListToText(nested, depth + 1));
			} else if (nested.tagName === 'DL') {
				lines.push(dlToText(nested, depth + 1));
			}
		}
	}
	return lines.join('\n');
}

/**
 * Convert an <ol> to numbered text.
 */
function orderedListToText(ol, depth) {
	const indent = '  '.repeat(depth);
	const lines = [];
	let i = 1;
	for (const li of ol.querySelectorAll(':scope > li')) {
		const text = childrenToText(li).trim();
		lines.push(indent + i + '. ' + text);
		i++;
	}
	return lines.join('\n');
}

/**
 * Convert a <dl> definition list to text.
 * Used for argument/return value documentation.
 */
function dlToText(dl, depth) {
	const indent = '  '.repeat(depth);
	const lines = [];

	for (const child of dl.childNodes) {
		if (child.tagName === 'DT') {
			// Term (parameter/field name)
			const text = childrenToText(child).trim();
			if (text) lines.push(indent + text);
		} else if (child.tagName === 'DD') {
			// Definition — may contain nested <dl> for struct fields
			const nestedDl = child.querySelector(':scope > dl');
			if (nestedDl) {
				// Get any text before the nested dl
				const preDlText = [];
				for (const c of child.childNodes) {
					if (c === nestedDl) break;
					preDlText.push(nodeToText(c));
				}
				const preText = preDlText.join('').trim();
				if (preText) lines.push(indent + '  ' + preText);
				lines.push(dlToText(nestedDl, depth + 1));
			} else {
				const text = childrenToText(child).trim();
				if (text) lines.push(indent + '  ' + text);
			}
		}
	}
	return lines.join('\n');
}

/**
 * Convert a <table> to text format.
 */
function tableToText(table) {
	const rows = table.querySelectorAll('tr');
	if (rows.length === 0) return '';

	const lines = [];
	for (const row of rows) {
		const cells = row.querySelectorAll('th, td');
		const cellTexts = [];
		for (const cell of cells) {
			cellTexts.push(childrenToText(cell).trim());
		}
		if (cellTexts.length > 0) {
			lines.push(cellTexts.join(' | '));
		}
	}
	return lines.join('\n');
}
