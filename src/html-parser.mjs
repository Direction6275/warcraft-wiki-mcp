import { parse as parseHTML } from 'node-html-parser';

const PAGE_KINDS = ['api', 'event', 'enum', 'widget', 'technical', 'unknown'];
const STRUCTURED_SECTION_NAMES = new Set(['arguments', 'returns', 'payload', 'fields', 'members', 'values']);
const LOOSE_TYPE_LABELS = new Set([
	'string',
	'number',
	'boolean',
	'table',
	'function',
	'userdata',
	'frame',
	'texture',
	'fontstring',
	'region',
	'widget',
	'object',
	'mixed',
	'any',
	'same',
	'unknown',
	'none',
	'n/a',
]);
const TECHNICAL_TITLES = new Set([
	'World_of_Warcraft_API',
	'Lua_functions',
	'FrameXML_functions',
	'Widget_API',
	'Widget_script_handlers',
	'XML_schema',
	'Events',
	'Console_variables',
	'API_change_summaries',
]);

export { PAGE_KINDS };

export function parseWikiPage(html, pageTitle, categories = []) {
	const root = parseHTML(html);
	const container = root.querySelector('.mw-parser-output') || root;
	const normalizedCategories = normalizeCategories(categories);
	const deprecatedBanner = extractDeprecatedBanner(container);

	for (const el of container.querySelectorAll('.mw-editsection, #toc, .toc')) {
		el.remove();
	}

	for (const child of [...container.childNodes]) {
		if (child.tagName === 'H2') break;
		if (child.tagName === 'TABLE') child.remove();
		if (child.tagName === 'DIV') {
			const cls = child.classNames || '';
			const style = child.getAttribute('style') || '';
			if (
				cls.includes('nomobile') ||
				cls.includes('ext-bigtable-wrapper') ||
				cls.includes('bigtable') ||
				style.includes('float')
			) {
				child.remove();
			}
		}
	}

	for (const p of container.querySelectorAll('p')) {
		if (p.text.trim().startsWith('↑')) p.remove();
	}

	const sections = {};
	const sectionData = {};
	let currentName = '_description';
	let currentNodes = [];

	for (const child of container.childNodes) {
		if (child.tagName === 'H2') {
			flushCurrentSection();
			const headline = child.querySelector('.mw-headline');
			currentName = headline ? normalizeSectionName(headline.text.trim()) : 'unknown';
			currentNodes = [];
		} else {
			currentNodes.push(child);
		}
	}
	flushCurrentSection();

	const description = sections._description || '';
	delete sections._description;

	const legacySections = splitLegacyDescriptionSections(description);
	for (const [sectionName, sectionText] of Object.entries(legacySections.sections)) {
		if (!sectionText || sections[sectionName]) continue;
		sections[sectionName] = sectionText;
		if (STRUCTURED_SECTION_NAMES.has(sectionName) && !sectionData[sectionName]) {
			sectionData[sectionName] = looseTextToDocSection(sectionText, sectionName);
		}
	}

	const deprecationInfo = buildDeprecationInfo({
		deprecatedBanner,
		categories: normalizedCategories,
		patchChanges: sections.patch_changes || '',
	});

	return {
		title: cleanTitle(pageTitle),
		pageKind: classifyPageTitle(pageTitle, normalizedCategories),
		description: legacySections.description,
		deprecated: deprecationInfo.note,
		deprecationInfo,
		sections,
		sectionData,
		url: wikiPageUrl(pageTitle),
		categories: normalizedCategories,
	};

	function flushCurrentSection() {
		if (currentNodes.length === 0) return;
		const parsedSection = parseSectionNodes(currentNodes, currentName);
		if (parsedSection.text) sections[currentName] = parsedSection.text;
		if (parsedSection.data) sectionData[currentName] = parsedSection.data;
	}
}

export function cleanTitle(title) {
	const raw = String(title || '').trim();
	let clean = raw.replace(/^API[_ ]/, '').replace(/^(C) /, 'C_');

	if (/^[A-Z][A-Z0-9 ]+$/.test(clean)) {
		clean = clean.replace(/ /g, '_');
	}

	clean = clean.replace(/^Enum /, 'Enum.');
	clean = normalizeWidgetMethodTitle(clean, raw);
	return clean;
}

export function wikiPageUrl(title) {
	return `https://warcraft.wiki.gg/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`;
}

export function normalizeCategories(categories = []) {
	return categories
		.map(category => {
			if (typeof category === 'string') return category.replace(/^Category:/, '').replace(/ /g, '_');
			if (category?.title) return String(category.title).replace(/^Category:/, '').replace(/ /g, '_');
			if (category?.['*']) return String(category['*']).replace(/^Category:/, '').replace(/ /g, '_');
			return null;
		})
		.filter(Boolean);
}

export function classifyPageTitle(title, categories = []) {
	const raw = String(title || '').trim();
	const clean = cleanTitle(raw);
	const normalizedCategories = normalizeCategories(categories).map(category => category.toLowerCase());

	if (normalizedCategories.some(category => category === 'api_functions' || category.startsWith('api_functions/'))) {
		return 'api';
	}
	if (normalizedCategories.some(category => category === 'api_events' || category.startsWith('api_events/'))) {
		return 'event';
	}
	if (
		normalizedCategories.some(category =>
			category.includes('widget') ||
			category.includes('uiobject') ||
			category.includes('script_handler')
		)
	) {
		return 'widget';
	}
	if (normalizedCategories.some(category => category.startsWith('api_systems/'))) {
		return /^API[_ ]/i.test(raw) ? 'api' : 'technical';
	}

	if (/^API[_ ]/i.test(raw)) return 'api';
	if (/^[A-Z][A-Z0-9_]*_[A-Z0-9_]+$/.test(clean)) return 'event';
	if (/^Enum[._ ]/i.test(clean)) return 'enum';
	if (
		/^UIOBJECT_/i.test(clean) ||
		/^ScriptObject/i.test(clean) ||
		/^Widget[_ ]/i.test(clean) ||
		clean.includes(':')
	) {
		return 'widget';
	}
	if (TECHNICAL_TITLES.has(clean)) return 'technical';
	return 'unknown';
}

export function isInScopePageKind(pageKind) {
	return pageKind !== 'unknown';
}

export function stripHtmlTags(text) {
	return String(text || '')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#?\w+;/g, '');
}

function normalizeWidgetMethodTitle(clean, rawTitle) {
	if (!/^API[_ ]/i.test(rawTitle)) return clean;
	if (clean.includes('.') || clean.includes(':') || clean.includes('_')) return clean;

	const parts = clean.split(/\s+/);
	if (parts.length < 2) return clean;

	const [objectName, ...methodParts] = parts;
	if (!/^[A-Z][A-Za-z0-9]+$/.test(objectName)) return clean;
	if (!/^[A-Z][A-Za-z0-9_]+$/.test(methodParts[0])) return clean;

	return `${objectName}:${methodParts.join(' ')}`;
}

function extractDeprecatedBanner(container) {
	const ambox = container.querySelector('.ambox-yellow');
	if (!ambox) return null;

	const note = normalizeText(stripHtmlTags(ambox.querySelector('.ambox-text')?.innerHTML || ambox.innerHTML));
	ambox.remove();
	return note || null;
}

function buildDeprecationInfo({ deprecatedBanner, categories, patchChanges }) {
	const bannerDeprecatedIn = extractPatchVersion(deprecatedBanner, 'deprecated in patch');
	const bannerRemovedIn = extractPatchVersion(deprecatedBanner, 'removed in patch');
	const patchDeprecatedIn = extractPatchHistoryVersion(patchChanges, 'deprecated') || extractPatchVersion(patchChanges, 'deprecated');
	const patchRemovedIn = extractPatchHistoryVersion(patchChanges, 'removed') || extractPatchVersion(patchChanges, 'removed');
	const replacementApis = extractReplacementApis(patchChanges);
	const conflicts = [];

	const info = {
		isDeprecated: false,
		note: null,
		deprecatedIn: null,
		removedIn: null,
		replacementApis,
		source: null,
		hasConflict: false,
		conflictDetails: [],
		recommendedState: 'active',
	};

	if (deprecatedBanner) {
		info.isDeprecated = true;
		info.note = deprecatedBanner;
		info.deprecatedIn = bannerDeprecatedIn;
		info.removedIn = bannerRemovedIn;
		info.source = 'ambox';
	}

	if (!info.isDeprecated && categories.some(category => /^API_functions\/deprecated$/i.test(category))) {
		info.isDeprecated = true;
		info.source = 'category';
	}

	if (!info.deprecatedIn) {
		info.deprecatedIn = patchDeprecatedIn || patchRemovedIn;
	}
	if (!info.removedIn) {
		info.removedIn = patchRemovedIn;
	}

	if (bannerRemovedIn && patchRemovedIn && bannerRemovedIn !== patchRemovedIn) {
		conflicts.push(`Deprecated banner says removed in patch ${bannerRemovedIn}, but patch history says removed in patch ${patchRemovedIn}.`);
	}
	if (bannerDeprecatedIn && patchDeprecatedIn && bannerDeprecatedIn !== patchDeprecatedIn) {
		conflicts.push(`Deprecated banner says deprecated in patch ${bannerDeprecatedIn}, but patch history says deprecated in patch ${patchDeprecatedIn}.`);
	}
	if (bannerRemovedIn && patchRemovedIn && comparePatchVersions(patchRemovedIn, bannerRemovedIn) < 0) {
		conflicts.push(`Patch history indicates an earlier removal (${patchRemovedIn}) than the deprecated banner (${bannerRemovedIn}).`);
	}

	if (!info.isDeprecated && (info.deprecatedIn || info.removedIn || replacementApis.length > 0)) {
		info.isDeprecated = true;
		info.source = 'patch_changes';
	}

	if (patchRemovedIn) {
		info.removedIn = patchRemovedIn;
		info.recommendedState = 'removed';
	} else if (info.isDeprecated || info.deprecatedIn || replacementApis.length > 0) {
		info.recommendedState = 'deprecated';
	}

	if (!info.note && info.isDeprecated) {
		const noteParts = [];
		if (info.deprecatedIn) noteParts.push(`Deprecated in patch ${info.deprecatedIn}.`);
		if (info.removedIn) noteParts.push(`Removed in patch ${info.removedIn}.`);
		if (info.replacementApis.length > 0) noteParts.push(`Replaced by ${info.replacementApis.join(', ')}.`);
		info.note = noteParts.join(' ').trim() || 'This page is deprecated.';
	}

	info.hasConflict = conflicts.length > 0;
	info.conflictDetails = conflicts;

	return info;
}

function extractPatchVersion(text, keyword) {
	const pattern = new RegExp(`${escapeRegExp(keyword)}\\s+([0-9]+(?:\\.[0-9]+)*)`, 'i');
	return pattern.exec(String(text || ''))?.[1] || null;
}

function extractPatchHistoryVersion(text, keyword) {
	const pattern = new RegExp(`Patch\\s+([0-9]+(?:\\.[0-9]+)*)[^\\n]*\\b${escapeRegExp(keyword)}\\b`, 'i');
	return pattern.exec(String(text || ''))?.[1] || null;
}

function comparePatchVersions(left, right) {
	const leftParts = String(left || '').split('.').map(part => Number(part) || 0);
	const rightParts = String(right || '').split('.').map(part => Number(part) || 0);
	const maxLength = Math.max(leftParts.length, rightParts.length);

	for (let index = 0; index < maxLength; index++) {
		const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
		if (delta !== 0) return delta;
	}

	return 0;
}

function extractReplacementApis(text) {
	const source = String(text || '');
	const replacements = new Set();
	const matches = source.matchAll(/replaced by ([^\n]+)/gi);

	for (const match of matches) {
		const segment = match[1];
		const apiMatches = segment.match(/[A-Z][A-Za-z0-9_]*(?::[A-Z][A-Za-z0-9_]+|\.[A-Z][A-Za-z0-9_]+)+|[A-Z][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]+/g) || [];
		for (const api of apiMatches) replacements.add(api.trim());
	}

	return [...replacements];
}

function normalizeSectionName(name) {
	const lower = name.toLowerCase().replace(/\s+/g, '_');
	const map = {
		arguments: 'arguments',
		params: 'arguments',
		parameters: 'arguments',
		payload: 'payload',
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

function splitLegacyDescriptionSections(text) {
	const source = String(text || '').trim();
	if (!source) return { description: '', sections: {} };

	const lines = source.split('\n');
	const sections = {};
	const descriptionLines = [];
	let currentSection = null;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			if (currentSection) {
				sections[currentSection].push('');
			} else {
				descriptionLines.push('');
			}
			continue;
		}

		const headingMatch = line.match(/^(?:###\s+)?(Arguments|Returns|Payload|Details|Notes|Usage|Example|Examples|Patch changes|Patch history|See also|Related events|Fields|Members|Values)\b(.*)$/i);
		if (headingMatch) {
			currentSection = normalizeSectionName(headingMatch[1]);
			if (!sections[currentSection]) sections[currentSection] = [];
			const inlineRemainder = normalizeText(headingMatch[2]);
			if (inlineRemainder) sections[currentSection].push(inlineRemainder);
			continue;
		}

		if (currentSection) {
			sections[currentSection].push(rawLine);
		} else {
			descriptionLines.push(rawLine);
		}
	}

	return {
		description: cleanSectionText(descriptionLines.join('\n'), '_description'),
		sections: Object.fromEntries(
			Object.entries(sections)
				.map(([name, valueLines]) => [name, cleanSectionText(valueLines.join('\n'), name)])
				.filter(([, value]) => value)
		),
	};
}

function looseTextToDocSection(text, sectionName) {
	const lines = String(text || '')
		.split('\n')
		.map(line => normalizeText(line))
		.filter(Boolean);

	if (lines.length === 0) return null;

	if (sectionName === 'arguments' || sectionName === 'returns') {
		const legacySection = parseLegacySignatureSection(lines, sectionName);
		if (legacySection) return legacySection;
		if (sectionName === 'returns') return null;
	}

	const section = createDocSection();
	for (const line of lines) {
		const item = parseLooseTextItem(line, sectionName);
		if (item) {
			section.items.push(item);
			section.blocks.push({ kind: 'item', item });
			continue;
		}

		section.blocks.push({ kind: 'text', text: line });
	}

	cleanDocSection(section);
	return section.blocks.length > 0 || section.items.length > 0 ? section : null;
}

function parseLooseTextItem(line, sectionName) {
	const normalized = normalizeText(line);
	if (!normalized) return null;

	if (sectionName === 'returns' && /^returns?\s+/i.test(normalized)) {
		return null;
	}

	if (/^(unknown|none|n\/a)$/i.test(normalized)) {
		if (sectionName === 'returns') return null;
		const item = createDocItem('value');
		item.description = normalized;
		return cleanDocItem(item);
	}

	const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_:.?/-]*)(?:\s+([^:-][^-]*?))?(?:\s+-\s+(.+))?$/);
	if (!match) return null;

	const [, name, descriptorHead = '', descriptorTail = ''] = match;
	if (!name || name.length > 80) return null;
	if (isUnsafeLooseItemName(name, sectionName)) return null;

	const item = createDocItem(name);
	const descriptorText = [descriptorHead, descriptorTail].filter(Boolean).join(' - ');
	if (descriptorText) {
		mergeDescriptorIntoItem(item, parseDescriptorText(descriptorText));
	}

	return cleanDocItem(item);
}

function parseLegacySignatureSection(lines, sectionName) {
	const section = createDocSection();
	let itemCount = 0;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const nextLine = index + 1 < lines.length ? lines[index + 1] : null;

		if (looksLikeSignatureLine(line)) {
			section.blocks.push({ kind: 'text', text: line });
			continue;
		}

		if (sectionName === 'returns' && /^(unknown|none|n\/a)$/i.test(line)) {
			section.blocks.push({ kind: 'text', text: line });
			continue;
		}

		if (isLikelyLegacyNameLine(line, sectionName) && looksLikeLegacyDescriptor(nextLine, sectionName)) {
			const item = createDocItem(line);
			applyLegacyDescriptorToItem(item, nextLine, sectionName);
			const cleaned = cleanDocItem(item);
			if (cleaned && hasMeaningfulDocItemDetails(cleaned)) {
				section.items.push(cleaned);
				section.blocks.push({ kind: 'item', item: cleaned });
				itemCount++;
				index++;
				continue;
			}
		}

		const inlineItem = parseLooseTextItem(line, sectionName);
		if (inlineItem && hasMeaningfulDocItemDetails(inlineItem)) {
			section.items.push(inlineItem);
			section.blocks.push({ kind: 'item', item: inlineItem });
			itemCount++;
			continue;
		}

		section.blocks.push({ kind: 'text', text: line });
	}

	cleanDocSection(section);
	if (itemCount === 0) return null;
	return section;
}

function looksLikeSignatureLine(line) {
	const normalized = normalizeText(line);
	return !!normalized && (
		normalized.startsWith('(') ||
		/^[A-Za-z0-9_:.]+\([^)]*\)$/.test(normalized) ||
		/^\[[^\]]+\]$/.test(normalized)
	);
}

function isLikelyLegacyNameLine(line, sectionName) {
	const normalized = normalizeText(line);
	if (!normalized) return false;
	if (isUnsafeLooseItemName(normalized, sectionName)) return false;
	if (normalized.length > 60) return false;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) return false;
	return true;
}

function looksLikeLegacyDescriptor(line, sectionName) {
	const normalized = normalizeText(line);
	if (!normalized) return false;
	if (/^(unknown|none|n\/a)$/i.test(normalized)) return sectionName === 'returns';
	if (/^same as\b/i.test(normalized)) return true;
	if (normalized.includes(' - ')) return true;
	if (/^(?:[A-Za-z][A-Za-z0-9_?[\]|/ ]*)(?:\s*-\s*.+)?$/.test(normalized) && startsWithTypeLabel(normalized)) return true;
	return false;
}

function applyLegacyDescriptorToItem(item, line, sectionName) {
	const normalized = normalizeText(line);
	if (!normalized) return;

	if (sectionName === 'returns' && /^(unknown|none|n\/a)$/i.test(normalized)) {
		item.description = normalized;
		return;
	}

	if (/^same as\b/i.test(normalized)) {
		item.description = normalized;
		return;
	}

	mergeDescriptorIntoItem(item, parseDescriptorText(normalized));
}

function isUnsafeLooseItemName(name, sectionName) {
	const normalized = normalizeText(name).toLowerCase();
	if (!normalized) return true;
	if (LOOSE_TYPE_LABELS.has(normalized)) return true;
	if (/^(?:returns?|arguments?|details|notes|usage|example|examples|fields|members|values)$/i.test(normalized)) return true;
	if (/^(?:same|nil|null)$/i.test(normalized)) return true;
	if ((sectionName === 'arguments' || sectionName === 'returns') && normalized.includes(' ')) return true;
	return false;
}

function startsWithTypeLabel(text) {
	const firstToken = normalizeText(text).split(/\s+/)[0]?.toLowerCase() || '';
	if (LOOSE_TYPE_LABELS.has(firstToken)) return true;
	return /^[A-Z][A-Za-z0-9_?[\]|/]*$/.test(firstToken);
}

function hasMeaningfulDocItemDetails(item) {
	return !!(item?.type || item?.value || item?.description || (item?.children && item.children.length > 0));
}

function parseSectionNodes(nodes, sectionName) {
	const data = STRUCTURED_SECTION_NAMES.has(sectionName) ? createDocSection() : null;

	if (data) {
		for (const node of nodes) {
			appendStructuredNode(node, data, sectionName);
		}
		cleanDocSection(data);
	}

	let text = data && (data.blocks.length > 0 || data.items.length > 0)
		? docSectionToText(data)
		: nodesToText(nodes);

	text = cleanSectionText(text, sectionName);

	if (data && data.blocks.length === 0 && data.items.length === 0) {
		return { text, data: null };
	}

	return { text, data };
}

function createDocSection() {
	return { blocks: [], items: [] };
}

function createDocItem(name) {
	return {
		name: normalizeText(name),
		type: null,
		value: null,
		description: null,
		annotations: [],
		children: [],
	};
}

function appendStructuredNode(node, section, sectionName) {
	if (!node) return;

	if (node.nodeType === 3) {
		const text = normalizeText(node.text);
		if (text) section.blocks.push({ kind: 'text', text });
		return;
	}

	const tag = node.tagName;
	if (!tag || tag === 'IMG' || tag === 'STYLE' || tag === 'SCRIPT') return;
	if (isNoiseNode(node)) return;

	if (tag === 'H3' || tag === 'H4') {
		const headline = node.querySelector('.mw-headline');
		const text = normalizeText(headline ? headline.text : node.text);
		if (text) section.blocks.push({ kind: 'heading', text });
		return;
	}

	if (tag === 'DIV' && node.classNames?.includes('mw-highlight')) {
		const code = codeBlockToText(node);
		if (code) section.blocks.push({ kind: 'text', text: code });
		return;
	}

	if (tag === 'PRE') {
		const code = normalizeText(stripHtmlTags(node.innerHTML));
		if (code) section.blocks.push({ kind: 'text', text: `\`\`\`\n${code}\n\`\`\`` });
		return;
	}

	if (tag === 'P') {
		const text = normalizeText(childrenToText(node));
		if (text) section.blocks.push({ kind: 'text', text });
		return;
	}

	if (tag === 'DL') {
		const items = parseDlItems(node, sectionName);
		for (const item of items) {
			section.items.push(item);
			section.blocks.push({ kind: 'item', item });
		}
		return;
	}

	if (tag === 'TABLE') {
		appendStructuredTable(node, section, sectionName);
		return;
	}

	if (tag === 'UL' || tag === 'OL') {
		const text = normalizeText(tag === 'UL' ? listToText(node, '- ', 0) : orderedListToText(node, 0));
		if (text) section.blocks.push({ kind: 'text', text });
		return;
	}

	for (const child of node.childNodes) {
		appendStructuredNode(child, section, sectionName);
	}
}

function appendStructuredTable(table, section, sectionName) {
	if (looksLikeWrapperTable(table)) {
		const wrapperSection = parseWrapperTable(table, sectionName);
		mergeDocSection(section, wrapperSection);
		return;
	}

	const { headers, rows } = tableToRows(table);
	if (rows.length === 0 && headers.length === 0) return;

	const parsedItems = parseTableItems(headers, rows, sectionName);
	if (parsedItems.length > 0) {
		section.items.push(...parsedItems);
	}

	section.blocks.push({
		kind: 'table',
		headers,
		rows,
	});
}

function parseWrapperTable(table, sectionName) {
	const section = createDocSection();

	for (const row of table.querySelectorAll(':scope > tbody > tr, :scope > tr')) {
		for (const cell of row.childNodes.filter(node => node.tagName === 'TH' || node.tagName === 'TD')) {
			const inlineText = normalizeText(childrenToTextSkippingBlocks(cell));
			if (inlineText) {
				section.blocks.push({
					kind: cell.tagName === 'TH' ? 'heading' : 'text',
					text: inlineText,
				});
			}

			for (const child of cell.childNodes) {
				if (child.tagName === 'DL' || child.tagName === 'TABLE' || child.tagName === 'UL' || child.tagName === 'OL') {
					appendStructuredNode(child, section, sectionName);
				}
			}
		}
	}

	return section;
}

function parseDlItems(dl, sectionName) {
	const directTags = dl.childNodes.filter(node => node.tagName);
	const directTerms = directTags.filter(node => node.tagName === 'DT');
	if (directTerms.length === 0) {
		const nestedItems = [];
		for (const child of directTags) {
			if (child.tagName === 'DD' || child.tagName === 'DL') {
				nestedItems.push(...parseDlItems(child, sectionName));
			} else if (child.tagName === 'TABLE') {
				const { headers, rows } = tableToRows(child);
				nestedItems.push(...parseTableItems(headers, rows, sectionName));
			}
		}
		return nestedItems;
	}

	const items = [];
	let currentItem = null;

	for (const child of directTags) {
		if (child.tagName === 'DT') {
			if (currentItem) items.push(currentItem);
			currentItem = createDocItem(childrenToText(child));
		} else if (child.tagName === 'DD' && currentItem) {
			applyDdToItem(currentItem, child, sectionName);
		}
	}

	if (currentItem) items.push(currentItem);
	return items.map(cleanDocItem).filter(Boolean);
}

function applyDdToItem(item, dd, sectionName) {
	const inlineParts = [];

	for (const child of dd.childNodes) {
		if (!child.tagName) {
			inlineParts.push(nodeToText(child));
			continue;
		}

		if (child.tagName === 'DL') {
			item.children.push(...parseDlItems(child, sectionName));
			continue;
		}

		if (child.tagName === 'TABLE') {
			const { headers, rows } = tableToRows(child);
			item.children.push(...parseTableItems(headers, rows, sectionName));
			continue;
		}

		if (child.tagName === 'UL' || child.tagName === 'OL') {
			inlineParts.push(child.tagName === 'UL' ? listToText(child, '- ', 0) : orderedListToText(child, 0));
			continue;
		}

		inlineParts.push(nodeToText(child));
	}

	const descriptor = parseDescriptorText(inlineParts.join(' '));
	mergeDescriptorIntoItem(item, descriptor);
}

function parseTableItems(headers, rows, sectionName) {
	if (rows.length === 0) return [];

	const normalizedHeaders = headers.map(header => normalizeTableHeader(header));
	if (normalizedHeaders.length === 0) return [];

	const itemType = detectItemTableType(normalizedHeaders, sectionName);
	if (!itemType) return [];

	return rows
		.map(row => row.map(cell => normalizeText(cell)))
		.filter(row => row.some(Boolean))
		.map(row => rowToDocItem(row, itemType))
		.filter(Boolean);
}

function rowToDocItem(row, itemType) {
	const item = createDocItem(row[0] || '');
	if (!item.name) return null;

	if (itemType === 'type_description') {
		const descriptor = parseDescriptorText([row[1], row.slice(2).join(' | ')].filter(Boolean).join(' - '));
		mergeDescriptorIntoItem(item, descriptor);
		return item;
	}

	if (itemType === 'value_description') {
		item.value = row[1] || null;
		item.description = row.slice(2).join(' | ') || null;
		return cleanDocItem(item);
	}

	if (itemType === 'description_only') {
		item.description = row.slice(1).join(' | ') || null;
		return cleanDocItem(item);
	}

	return null;
}

function detectItemTableType(headers, sectionName) {
	const [first, second] = headers;
	if (!first) return null;

	if (first === 'field' || first === 'name' || first === 'member' || first === 'parameter') {
		if (second === 'type') return 'type_description';
		if (second === 'value') return 'value_description';
		if (second === 'description') return 'description_only';
	}

	if (first === 'constant' || first === 'filter' || first === 'value') {
		if (second === 'value') return 'value_description';
		if (second === 'description') return 'description_only';
	}

	if (sectionName === 'values' && second === 'description') return 'description_only';
	return null;
}

function parseDescriptorText(text) {
	const normalized = normalizeText(text);
	if (!normalized) {
		return { type: null, value: null, description: null, annotations: [] };
	}

	let head = normalized;
	let description = null;
	const hyphenIndex = normalized.indexOf(' - ');
	if (hyphenIndex !== -1) {
		head = normalized.slice(0, hyphenIndex).trim();
		description = normalized.slice(hyphenIndex + 3).trim() || null;
	}

	let type = head || null;
	const annotations = [];

	const aliasMatch = type?.match(/^([^:]+?)\s*:\s*(.+)$/);
	if (aliasMatch) {
		const alias = normalizeText(aliasMatch[1]);
		type = normalizeText(aliasMatch[2]);
		if (alias) annotations.push(alias);
	}

	const split = splitTypeAnnotations(type);
	type = split.type;
	annotations.push(...split.annotations);

	return {
		type,
		value: null,
		description,
		annotations: [...new Set(annotations)].filter(Boolean),
	};
}

function splitTypeAnnotations(typeText) {
	const text = normalizeText(typeText);
	if (!text) return { type: null, annotations: [] };

	const tokens = text.split(/\s+/);
	const annotations = [];

	while (tokens.length > 1 && looksLikeAnnotation(tokens[tokens.length - 1])) {
		annotations.unshift(tokens.pop());
	}

	return {
		type: tokens.join(' ').trim() || null,
		annotations,
	};
}

function looksLikeAnnotation(token) {
	return /^[A-Z][A-Za-z0-9_]+$/.test(token);
}

function mergeDescriptorIntoItem(item, descriptor) {
	if (descriptor.type) item.type = descriptor.type;
	if (descriptor.value) item.value = descriptor.value;
	if (descriptor.description) {
		item.description = item.description
			? `${item.description}\n${descriptor.description}`
			: descriptor.description;
	}
	if (descriptor.annotations?.length) {
		item.annotations.push(...descriptor.annotations);
		item.annotations = [...new Set(item.annotations)];
	}
}

function cleanDocSection(section) {
	section.items = section.items.map(cleanDocItem).filter(Boolean);
	section.blocks = section.blocks
		.map(block => cleanDocBlock(block))
		.filter(Boolean);
}

function cleanDocItem(item) {
	if (!item) return null;

	const cleaned = {
		name: normalizeText(item.name),
		type: normalizeText(item.type),
		value: normalizeText(item.value),
		description: normalizeText(item.description),
		annotations: [...new Set((item.annotations || []).map(normalizeText).filter(Boolean))],
		children: (item.children || []).map(cleanDocItem).filter(Boolean),
	};

	if (!cleaned.name) return null;
	return cleaned;
}

function cleanDocBlock(block) {
	if (!block) return null;
	if (block.kind === 'item') {
		const item = cleanDocItem(block.item);
		return item ? { kind: 'item', item } : null;
	}

	if (block.kind === 'heading' || block.kind === 'text') {
		const text = normalizeText(block.text);
		return text ? { kind: block.kind, text } : null;
	}

	if (block.kind === 'table') {
		const headers = (block.headers || []).map(normalizeText).filter(Boolean);
		const rows = (block.rows || []).map(row => row.map(normalizeText));
		if (headers.length === 0 && rows.length === 0) return null;
		return { kind: 'table', headers, rows };
	}

	return null;
}

function mergeDocSection(target, source) {
	target.blocks.push(...source.blocks);
	target.items.push(...source.items);
}

function docSectionToText(section) {
	const parts = [];

	for (const block of section.blocks) {
		if (block.kind === 'heading') {
			parts.push(`### ${block.text}`);
		} else if (block.kind === 'text') {
			parts.push(block.text);
		} else if (block.kind === 'item') {
			parts.push(docItemToText(block.item, 0));
		} else if (block.kind === 'table') {
			if (block.headers?.length) parts.push(block.headers.join(' | '));
			for (const row of block.rows || []) parts.push(row.join(' | '));
		}
	}

	return parts.join('\n\n');
}

function docItemToText(item, depth) {
	const indent = '  '.repeat(depth);
	const lines = [`${indent}${item.name}`];
	const detailParts = [];

	if (item.type) detailParts.push(item.type);
	if (item.value) detailParts.push(item.value);
	if (item.annotations.length > 0) detailParts.push(item.annotations.join(' '));

	let detail = detailParts.join(' ');
	if (item.description) detail = detail ? `${detail} - ${item.description}` : item.description;
	if (detail) lines.push(`${indent}${detail}`);

	for (const child of item.children) {
		lines.push(docItemToText(child, depth + 1));
	}

	return lines.join('\n');
}

function nodesToText(nodes) {
	const parts = [];
	for (const node of nodes) {
		const text = nodeToText(node);
		if (text) parts.push(text);
	}
	return parts.join('\n');
}

function nodeToText(node) {
	if (!node) return '';
	if (node.nodeType === 3) return node.text;

	const tag = node.tagName;
	if (!tag || tag === 'IMG' || tag === 'STYLE' || tag === 'SCRIPT') return '';
	if (isNoiseNode(node)) return '';

	if (tag === 'DIV' && node.classNames?.includes('mw-highlight')) {
		return codeBlockToText(node);
	}

	if (tag === 'PRE') {
		const code = normalizeText(stripHtmlTags(node.innerHTML));
		return code ? `\n\`\`\`\n${code}\n\`\`\`\n` : '';
	}

	if (tag === 'CODE') return `\`${node.text.trim()}\``;
	if (tag === 'P') return normalizeText(childrenToText(node));
	if (tag === 'H3' || tag === 'H4') {
		const headline = node.querySelector('.mw-headline');
		const text = normalizeText(headline ? headline.text : node.text);
		return text ? `\n### ${text}\n` : '';
	}
	if (tag === 'UL') return listToText(node, '- ', 0);
	if (tag === 'OL') return orderedListToText(node, 0);
	if (tag === 'DL') return dlToText(node, 0);
	if (tag === 'TABLE') return tableToText(node);
	if (tag === 'BR') return '\n';
	if (tag === 'A') return node.text;

	return childrenToText(node);
}

function codeBlockToText(node) {
	const pre = node.querySelector('pre');
	const raw = pre ? pre.innerHTML : node.innerHTML;
	const code = normalizeText(stripHtmlTags(raw));
	return code ? `\`\`\`lua\n${code}\n\`\`\`` : '';
}

function isNoiseNode(node) {
	if (node.tagName !== 'DIV') return false;
	const cls = node.classNames || '';
	const style = node.getAttribute('style') || '';
	return (
		cls.includes('nomobile') ||
		cls.includes('ext-bigtable-wrapper') ||
		cls.includes('bigtable') ||
		style.includes('float')
	);
}

function childrenToText(node) {
	const parts = [];
	for (const child of node.childNodes) {
		parts.push(nodeToText(child));
	}
	return parts.join('');
}

function childrenToTextSkippingBlocks(node) {
	const parts = [];
	for (const child of node.childNodes) {
		if (child.tagName === 'DL' || child.tagName === 'UL' || child.tagName === 'OL' || child.tagName === 'TABLE') continue;
		parts.push(nodeToText(child));
	}
	return parts.join('');
}

function listToText(ul, prefix, depth) {
	const indent = '  '.repeat(depth);
	const lines = [];
	for (const li of ul.querySelectorAll(':scope > li')) {
		const textParts = [];
		const nestedLists = [];
		for (const child of li.childNodes) {
			if (child.tagName === 'UL' || child.tagName === 'OL' || child.tagName === 'DL') {
				nestedLists.push(child);
			} else {
				textParts.push(nodeToText(child));
			}
		}
		const text = normalizeText(textParts.join(' '));
		if (text) lines.push(`${indent}${prefix}${text}`);

		for (const nested of nestedLists) {
			if (nested.tagName === 'UL') lines.push(listToText(nested, '- ', depth + 1));
			if (nested.tagName === 'OL') lines.push(orderedListToText(nested, depth + 1));
			if (nested.tagName === 'DL') lines.push(dlToText(nested, depth + 1));
		}
	}
	return lines.join('\n');
}

function orderedListToText(ol, depth) {
	const indent = '  '.repeat(depth);
	const lines = [];
	let index = 1;
	for (const li of ol.querySelectorAll(':scope > li')) {
		const text = normalizeText(childrenToText(li));
		if (text) lines.push(`${indent}${index}. ${text}`);
		index++;
	}
	return lines.join('\n');
}

function dlToText(dl, depth) {
	const items = parseDlItems(dl, 'generic');
	return items.map(item => docItemToText(item, depth)).join('\n');
}

function tableToText(table) {
	if (looksLikeWrapperTable(table)) {
		return docSectionToText(parseWrapperTable(table, 'generic'));
	}

	const { headers, rows } = tableToRows(table);
	const lines = [];
	if (headers.length > 0) lines.push(headers.join(' | '));
	for (const row of rows) {
		lines.push(row.join(' | '));
	}
	return lines.join('\n');
}

function looksLikeWrapperTable(table) {
	for (const cell of table.querySelectorAll('td, th')) {
		if (cell.querySelector('dl, ul, ol, table')) return true;
	}
	return false;
}

function tableToRows(table) {
	const rows = [];
	let headers = [];

	for (const row of table.querySelectorAll('tr')) {
		const headerCells = row.querySelectorAll(':scope > th');
		const cells = row.querySelectorAll(':scope > th, :scope > td');
		if (cells.length === 0) continue;

		const values = [...cells].map(cell => normalizeText(childrenToText(cell)));
		if (headerCells.length > 0 && headers.length === 0) {
			headers = values;
			continue;
		}
		rows.push(values);
	}

	return { headers, rows };
}

function normalizeTableHeader(header) {
	return normalizeText(header).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function cleanSectionText(text, sectionName) {
	const lines = String(text || '')
		.replace(/\r/g, '')
		.split('\n')
		.map(line => line.trimEnd());

	const cleaned = [];
	let lastNonEmpty = null;
	let blankCount = 0;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			if (blankCount === 0 && cleaned.length > 0) cleaned.push('');
			blankCount++;
			continue;
		}

		blankCount = 0;
		if (trimmed === lastNonEmpty) continue;

		cleaned.push(trimmed);
		lastNonEmpty = trimmed;
	}

	const joined = cleaned.join('\n').trim();
	if (!joined) return '';

	if (sectionName === '_description') {
		return joined
			.split('\n')
			.filter(line => !looksLikeMetadataRow(line))
			.join('\n')
			.trim();
	}

	return joined;
}

function looksLikeMetadataRow(line) {
	const trimmed = line.trim();
	return (
		trimmed.startsWith('| `') ||
		trimmed.includes('AllowedWhen') ||
		trimmed.includes('SecretWhen') ||
		/^(\+|-)\s+\d/.test(trimmed)
	);
}

function normalizeText(text) {
	return String(text || '')
		.replace(/\s+/g, ' ')
		.replace(/\s+([?!,.;:)])/g, '$1')
		.replace(/([(])\s+/g, '$1')
		.trim() || null;
}

function escapeRegExp(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
