import { deriveCodingNotes, deriveRelatedEvents, parseWikiPage } from '../src/html-parser.mjs';

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function assertNoNullTableCells(section, label) {
	for (const block of section.blocks) {
		if (block.kind !== 'table') continue;
		for (const row of block.rows || []) {
			for (const cell of row) {
				assert(typeof cell === 'string', `${label} table cells must be strings`);
			}
		}
	}
}

const html = `
<div class="mw-parser-output">
	<p>Returns cooldown information for a spell.</p>
	<h2><span class="mw-headline">Returns</span></h2>
	<dl>
		<dt>spellCooldownInfo</dt>
		<dd>SpellCooldownInfo? - Returns nil if spell is not found</dd>
	</dl>
	<table>
		<tr><th>Field</th><th>Type</th><th>Description</th></tr>
		<tr><td>startTime</td><td>number</td><td></td></tr>
		<tr><td>isOnGCD</td><td>boolean? NeverSecret</td><td>Do not trust this field unless responding to a SPELL_UPDATE_COOLDOWN event.</td></tr>
	</table>
	<h2><span class="mw-headline">Details</span></h2>
	<table>
		<tr><th>Related Events</th><td>SPELL_UPDATE_COOLDOWN</td></tr>
	</table>
	<ul>
		<li>Values returned by this function are not updated immediately when UNIT_SPELLCAST_SUCCEEDED is raised.</li>
	</ul>
</div>`;

const parsed = parseWikiPage(html, 'API_C_Spell.GetSpellCooldown', [{ title: 'Category:API_functions' }]);

assert(parsed.sectionData.returns, 'Expected structured returns data');
assertNoNullTableCells(parsed.sectionData.returns, 'returnsData');

const relatedEvents = deriveRelatedEvents(parsed);
assert(relatedEvents.includes('SPELL_UPDATE_COOLDOWN'), 'Expected related event from details table');

const codingNotes = deriveCodingNotes(parsed, relatedEvents);
assert(
	codingNotes.some(note => note.topic === 'event_timing' && note.text.includes('Do not trust this field')),
	'Expected do-not-trust event timing warning'
);
assert(
	codingNotes.some(note => note.topic === 'event_timing' && note.relatedEvents.includes('UNIT_SPELLCAST_SUCCEEDED')),
	'Expected event names to be attached to timing warnings'
);
assert(
	codingNotes.some(note => note.topic === 'nil_result' && note.text.includes('Returns nil')),
	'Expected nil return info note'
);

console.log('Parser tests passed.');
