import read_context from '../read/context';
import read_expression from '../read/expression';
import { closing_tag_omitted } from '../utils/html';
import { whitespace } from '../../utils/patterns';
import { trim_start, trim_end } from '../../utils/trim';
import { Parser } from '../index';
import { TemplateNode } from '../../interfaces';

// More accurately, trims its starting and ending children recursively
function trim_whitespace(block: TemplateNode, trim_before: boolean, trim_after: boolean) {
	if (!block.children || block.children.length === 0) return; // AwaitBlock

	const first_child = block.children[0];
	const last_child = block.children[block.children.length - 1];

	if (first_child.type === 'Text' && trim_before) {
		first_child.data = trim_start(first_child.data);
		if (!first_child.data) block.children.shift();
	}

	if (last_child.type === 'Text' && trim_after) {
		last_child.data = trim_end(last_child.data);
		if (!last_child.data) block.children.pop();
	}

	if (block.else) {
		trim_whitespace(block.else, trim_before, trim_after);
	}

	if (first_child.elseif) {
		trim_whitespace(first_child, trim_before, trim_after);
	}
}

// NOTE, that html tags inside the blocks would already have been popped have the stack
// only closing_tag_omitted tags may not have been so
export default function mustache(parser: Parser) {
	// before '{'
	const start = parser.index;
	parser.index += 1;

	parser.allow_whitespace();

	// {/if}, {/each} or {/await}
	if (parser.eat('/')) {
		let block = parser.current();
		let expected;

		// Can don't be closed.
		if (closing_tag_omitted(block.name)) {
			block.end = start;
			parser.stack.pop();
			block = parser.current();
		}

		// waddis for?
		if (block.type === 'ElseBlock' || block.type === 'PendingBlock' || block.type === 'ThenBlock' || block.type === 'CatchBlock') {
			block.end = start;
			parser.stack.pop();
			block = parser.current();

			expected = 'await';
		}

		if (block.type === 'IfBlock') {
			expected = 'if';
		} else if (block.type === 'EachBlock') {
			expected = 'each';
		} else if (block.type === 'AwaitBlock') {
			expected = 'await';
		} else {
			parser.error({
				code: `unexpected-block-close`,
				message: `Unexpected block closing tag`
			});
		}

		parser.eat(expected, true);
		parser.allow_whitespace();
		parser.eat('}', true);

		while (block.elseif) {
			block.end = parser.index;
			parser.stack.pop();
			block = parser.current();

			if (block.else) {
				block.else.end = start;
			}
		}

		// strip leading/trailing whitespace as necessary
		const char_before = parser.template[block.start - 1];
		const char_after = parser.template[parser.index];
		const trim_before = !char_before || whitespace.test(char_before);
		const trim_after = !char_after || whitespace.test(char_after);

		trim_whitespace(block, trim_before, trim_after);

		block.end = parser.index;
		parser.stack.pop();

	// else, else if, and else following each's
	} else if (parser.eat(':else')) {
		// syntax
		if (parser.eat('if')) {
			parser.error({
				code: 'invalid-elseif',
				message: `'elseif' should be 'else if'`
			});
		}

		parser.allow_whitespace();

		// :else if
		if (parser.eat('if')) {
			const block = parser.current();
			if (block.type !== 'IfBlock')
				parser.error({
					code: `invalid-elseif-placement`,
					message: 'Cannot have an {:else if ...} block outside an {#if ...} block'
				});

			parser.require_whitespace();

			const expression = read_expression(parser);

			parser.allow_whitespace();
			parser.eat('}', true);

			// IfBlock has an else property
			block.else = {
				start: parser.index,
				end: null,
				type: 'ElseBlock',
				children: [
					{
						start: parser.index,
						end: null,
						type: 'IfBlock',
						elseif: true,
						expression,
						children: [],
					},
				],
			};

			parser.stack.push(block.else.children[0]);
		}

		// :else
		else {
			const block = parser.current();
			if (block.type !== 'IfBlock' && block.type !== 'EachBlock') {
				parser.error({
					code: `invalid-else-placement`,
					message: 'Cannot have an {:else} block outside an {#if ...} or {#each ...} block'
				});
			}

			parser.allow_whitespace();
			parser.eat('}', true);

			// If or each block has else property
			block.else = {
				start: parser.index,
				end: null,
				type: 'ElseBlock',
				children: [],
			};

			parser.stack.push(block.else);
		}
	} else if (parser.match(':then') || parser.match(':catch')) {
		// NOTE there is AwaitBlock, PendingBlock, ThenBlock, CatchBlocks...
		const block = parser.current();
		// NOTE the !. Explicit.
		const is_then = parser.eat(':then') || !parser.eat(':catch');

		if (is_then) {
			if (block.type !== 'PendingBlock') {
				parser.error({
					code: `invalid-then-placement`,
					message: 'Cannot have an {:then} block outside an {#await ...} block'
				});
			}
		} else {
			if (block.type !== 'ThenBlock' && block.type !== 'PendingBlock') {
				parser.error({
					code: `invalid-catch-placement`,
					message: 'Cannot have an {:catch} block outside an {#await ...} block'
				});
			}
		}

		block.end = start;
		parser.stack.pop();
		const await_block = parser.current();

		// read the identifier to the right
		// 'value' property of await is the original promise's resolved value's identifier
		if (!parser.eat('}')) {
			parser.require_whitespace();
			await_block[is_then ? 'value': 'error'] = parser.read_identifier();
			parser.allow_whitespace();

			if (await_block.once && parser.eat(',')) {
				parser.allow_whitespace();
				block.onceValue = parser.read_identifier();
				parser.allow_whitespace();
			}

			parser.eat('}', true);
		}

		const new_block: TemplateNode = {
			start,
			end: null,
			type: is_then ? 'ThenBlock': 'CatchBlock',
			children: [],
			skip: false
		};

		// todo confirm await block has pending, then and catch properties!
		await_block[is_then ? 'then' : 'catch'] = new_block;
		parser.stack.push(new_block);
	} else if (parser.eat('#')) {
		// {#if foo}, {#each foo} or {#await foo}
		let type;

		// ok, straight forward.
		if (parser.eat('if')) {
			type = 'IfBlock';
		} else if (parser.eat('each')) {
			type = 'EachBlock';
		} else if (parser.eat('await')) {
			type = 'AwaitBlock';
		} else {
			parser.error({
				code: `expected-block-type`,
				message: `Expected if, each or await`
			});
		}

		parser.require_whitespace();

		const once = type === 'AwaitBlock' && parser.eat('once');
		if (once) {
			parser.require_whitespace();
		}

		const expression = read_expression(parser);

		// expressions stores the original promise
		const block: TemplateNode = type === 'AwaitBlock' ?
			{
				start,
				end: null,
				type,
				expression,
				value: null,
				once,
				onceValue: null,
				hasLoaded: false,
				error: null,
				pending: {
					start: null,
					end: null,
					type: 'PendingBlock',
					children: [],
					skip: true
				},
				then: {
					start: null,
					end: null,
					type: 'ThenBlock',
					children: [],
					skip: true
				},
				catch: {
					start: null,
					end: null,
					type: 'CatchBlock',
					children: [],
					skip: true
				},
			} :
			{
				start,
				end: null,
				type,
				expression,
				children: [],
			};

		parser.allow_whitespace();

		// thus they also have a context, index and key property
		// {#each} blocks must declare a context – {#each list as item}
		if (type === 'EachBlock') {
			parser.eat('as', true);
			parser.require_whitespace();

			// ok, very in house parser for each block contexts
			block.context = read_context(parser);

			parser.allow_whitespace();

			// dah index identifier
			if (parser.eat(',')) {
				parser.allow_whitespace();
				block.index = parser.read_identifier();
				if (!block.index) parser.error({
					code: `expected-name`,
					message: `Expected name`
				});

				parser.allow_whitespace();
			}

			// dah key
			if (parser.eat('(')) {
				parser.allow_whitespace();

				block.key = read_expression(parser);
				parser.allow_whitespace();
				parser.eat(')', true);
				parser.allow_whitespace();
			}
		}

		// thus await blocks' value property are still the resolved value
		const await_block_shorthand = type === 'AwaitBlock' && parser.eat('then');
		if (await_block_shorthand) {
			parser.require_whitespace();
			block.value = parser.read_identifier();
			parser.allow_whitespace();

			if (once && parser.eat(',')) {
				parser.allow_whitespace();
				block.onceValue = parser.read_identifier();
				parser.allow_whitespace();
			}
		}

		parser.eat('}', true);

		// note they can be children as well!
		parser.current().children.push(block);
		parser.stack.push(block);

		// .skips
		if (type === 'AwaitBlock') {
			let child_block;
			if (await_block_shorthand) {
				block.then.skip = false;
				child_block = block.then;
			} else {
				block.pending.skip = false;
				child_block = block.pending;
			}

			child_block.start = parser.index;
			parser.stack.push(child_block);
		}
	} else if (parser.eat('@html')) {
		// {@html content} tag
		parser.require_whitespace();

		const expression = read_expression(parser);

		parser.allow_whitespace();
		parser.eat('}', true);

		parser.current().children.push({
			start,
			end: parser.index,
			type: 'RawMustacheTag',
			expression,
		});
	} else if (parser.eat('@debug')) {
		let identifiers;

		// Implies {@debug} which indicates "debug all"
		if (parser.read(/\s*}/)) {
			identifiers = [];
		} else {
			const expression = read_expression(parser);

			identifiers = expression.type === 'SequenceExpression'
				? expression.expressions
				: [expression];

			identifiers.forEach(node => {
				if (node.type !== 'Identifier') {
					parser.error({
						code: 'invalid-debug-args',
						message: '{@debug ...} arguments must be identifiers, not arbitrary expressions'
					}, node.start);
				}
			});

			parser.allow_whitespace();
			parser.eat('}', true);
		}

		parser.current().children.push({
			start,
			end: parser.index,
			type: 'DebugTag',
			identifiers
		});
	} else {
		const expression = read_expression(parser);

		parser.allow_whitespace();
		parser.eat('}', true);

		parser.current().children.push({
			start,
			end: parser.index,
			type: 'MustacheTag',
			expression,
		});
	}
}
