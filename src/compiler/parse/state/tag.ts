import read_expression from '../read/expression';
import read_script from '../read/script';
import read_style from '../read/style';
import { decode_character_references, closing_tag_omitted } from '../utils/html';
import { is_void } from '../../utils/names';
import { Parser } from '../index';
import { Directive, DirectiveType, TemplateNode, Text } from '../../interfaces';
import fuzzymatch from '../../utils/fuzzymatch';
import list from '../../utils/list';

// One or more alphas, followed by ':' optionally, followed by 0 or more alphanumerics with '-' optionally
// eslint-disable-next-line no-useless-escape
const valid_tag_name = /^\!?[a-zA-Z]{1,}:?[a-zA-Z0-9\-]*/;

const meta_tags = new Map([
	['svelte:head', 'Head'],
	['svelte:options', 'Options'],
	['svelte:window', 'Window'],
	['svelte:body', 'Body']
]);

// all dem metas
const valid_meta_tags = Array.from(meta_tags.keys()).concat('svelte:self', 'svelte:component');

const specials = new Map([
	[
		'script',
		{
			read: read_script,
			property: 'js',
		},
	],
	[
		'style',
		{
			read: read_style,
			property: 'css',
		},
	],
]);

const SELF = /^svelte:self(?=[\s/>])/;
const COMPONENT = /^svelte:component(?=[\s/>])/;

// As it says.
function parent_is_head(stack) {
	let i = stack.length;
	while (i--) {
		const { type } = stack[i];
		if (type === 'Head') return true;
		if (type === 'Element' || type === 'InlineComponent') return false;
	}
	return false;
}

// does not return another ParserState! delegates to fragment
export default function tag(parser: Parser) {
	const start = parser.index++;

	let parent = parser.current();

	// For comments
	if (parser.eat('!--')) {
		const data = parser.read_until(/-->/);
		parser.eat('-->', true, 'comment was left open, expected -->');

		parser.current().children.push({
			start,
			end: parser.index,
			type: 'Comment',
			data,
		});

		return;
	}

	// Oof.
	const is_closing_tag = parser.eat('/');

	const name = read_tag_name(parser);

	// Handles meta tags
	// Checks for error cases that are self documenting below
	if (meta_tags.has(name)) {
		const slug = meta_tags.get(name).toLowerCase();
		if (is_closing_tag) {
			if (
				(name === 'svelte:window' || name === 'svelte:body') &&
				parser.current().children.length
			) {
				parser.error({
					code: `invalid-${slug}-content`,
					message: `<${name}> cannot have children`
				}, parser.current().children[0].start);
			}
		} else {
			if (name in parser.meta_tags) {
				parser.error({
					code: `duplicate-${slug}`,
					message: `A component can only have one <${name}> tag`
				}, start);
			}

			if (parser.stack.length > 1) {
				parser.error({
					code: `invalid-${slug}-placement`,
					message: `<${name}> tags cannot be inside elements or blocks`
				}, start);
			}

			parser.meta_tags[name] = true;
		}
	}

	const type = meta_tags.has(name)
		? meta_tags.get(name)
		// If first letter is capital, type = true
		: (/[A-Z]/.test(name[0]) || name === 'svelte:self' || name === 'svelte:component')
			? 'InlineComponent'
			// it may be a title tag not in a head, in which case its just a regular element
			: name === 'title' && parent_is_head(parser.stack)
				? 'Title'
				// if custom element then we treat slots as regular elements - for compatibility
				: name === 'slot' && !parser.customElement
					? 'Slot' : 'Element';

	// Construct the node to be pushed into the stack
	const element: TemplateNode = {
		start,
		end: null, // filled in later
		type,
		name,
		attributes: [],
		children: [],
	};

	parser.allow_whitespace();

	// We do some special processing for closing tags...
	if (is_closing_tag) {
		if (is_void(name)) {
			parser.error({
				code: `invalid-void-content`,
				message: `<${name}> is a void element and cannot have children, or a closing tag`
			}, start);
		}

		// nom nom nom, required by spec.
		parser.eat('>', true);

		// close any elements that don't have their own closing tags, e.g. <div><p><p><p></div>
		// should it even be allowed? yes, under whatwg spec
		// pops till opening tag is found, meanwhile doing the above ( all p's will have end assigned to < )
		while (parent.name !== name) {
			// What about slots? - we dont push them into the stack in the first place... todo probably
			if (parent.type !== 'Element')
				parser.error({
					code: `invalid-closing-tag`,
					message: `</${name}> attempted to close an element that was not open`
				}, start);

			// b2cause white spaces have been
			parent.end = start;
			parser.stack.pop();

			parent = parser.current();
		}

		// the opening tag. see above
		parent.end = parser.index;
		parser.stack.pop();

		// TODO HIGHLIGHT THIS. Beyond here all are opening tags.
		return;
	} else if (closing_tag_omitted(parent.name, name)) {
		// not a closing tag but can potentially close its parent... whatwg quirks
		parent.end = start;
		parser.stack.pop();
	}

	const unique_names: Set<string> = new Set();

	let attribute = read_attribute(parser, unique_names);
	while (attribute) {
		element.attributes.push(attribute);
		parser.allow_whitespace();
		attribute = read_attribute(parser, unique_names);
	}

	// Another special case
	if (name === 'svelte:component') {
		const index = element.attributes.findIndex(attr => attr.type === 'Attribute' && attr.name === 'this');
		if (!~index) {
			parser.error({
				code: `missing-component-definition`,
				message: `<svelte:component> must have a 'this' attribute`
			}, start);
		}

		const definition = element.attributes.splice(index, 1)[0];
		if (definition.value === true || definition.value.length !== 1 || definition.value[0].type === 'Text') {
			parser.error({
				code: `invalid-component-definition`,
				message: `invalid component definition`
			}, definition.start);
		}

		element.expression = definition.value[0].expression;
	}

	// special cases – top-level <script> and <style>
	if (specials.has(name) && parser.stack.length === 1) {
		const special = specials.get(name);

		parser.eat('>', true);
		const content = special.read(parser, start, element.attributes);
		if (content) parser[special.property].push(content);
		return;
	}

	// ITS ENDING, we push to current().children first
	parser.current().children.push(element);

	const self_closing = parser.eat('/') || is_void(name);

	parser.eat('>', true);

	if (self_closing) {
		// don't push self-closing elements onto the stack
		element.end = parser.index;
	} else if (name === 'textarea') {
		// special case
		element.children = read_sequence(
			parser,
			() =>
				parser.template.slice(parser.index, parser.index + 11) === '</textarea>'
		);
		parser.read(/<\/textarea>/);
		element.end = parser.index;
	} else if (name === 'script') {
		// special case
		const start = parser.index;
		const data = parser.read_until(/<\/script>/);
		const end = parser.index;
		element.children.push({ start, end, type: 'Text', data });
		parser.eat('</script>', true);
		element.end = parser.index;
	} else if (name === 'style') {
		// special case
		const start = parser.index;
		const data = parser.read_until(/<\/style>/);
		const end = parser.index;
		element.children.push({ start, end, type: 'Text', data });
		parser.eat('</style>', true);
	} else {
		// NOTE WE PUSH TO STACK, not current().children
		parser.stack.push(element);
	}
}

// Does what it says it does, returns the tag name
// Does some error handling along the way.
function read_tag_name(parser: Parser) {
	const start = parser.index;

	// Handles <svelte:self />'s
	if (parser.read(SELF)) {
		// check we're inside a block, otherwise this
		// will cause infinite recursion
		let i = parser.stack.length;
		let legal = false;

		while (i--) {
			const fragment = parser.stack[i];
			if (fragment.type === 'IfBlock' || fragment.type === 'EachBlock') {
				legal = true;
				break;
			}
		}

		if (!legal) {
			parser.error({
				code: `invalid-self-placement`,
				message: `<svelte:self> components can only exist inside if-blocks or each-blocks`
			}, start);
		}

		return 'svelte:self';
	}

	if (parser.read(COMPONENT)) return 'svelte:component';

	const name = parser.read_until(/(\s|\/|>)/);

	if (meta_tags.has(name)) return name;

	// Nice, uses edit distance to output error
	if (name.startsWith('svelte:')) {
		const match = fuzzymatch(name.slice(7), valid_meta_tags);

		let message = `Valid <svelte:...> tag names are ${list(valid_meta_tags)}`;
		if (match) message += ` (did you mean '${match}'?)`;

		parser.error({
			code: 'invalid-tag-name',
			message
		}, start);
	}

	// The usual.
	if (!valid_tag_name.test(name)) {
		parser.error({
			code: `invalid-tag-name`,
			message: `Expected valid tag name`
		}, start);
	}

	return name;
}

// Handles all the special attribute stuff.
// unique_names for guarding against duplicate attributes.
// Remember here we have not eaten '>', only the name
// NOTE: Asserts allow_whitespace() is called before each call to this
function read_attribute(parser: Parser, unique_names: Set<string>) {
	const start = parser.index;

	// Open mustache handler
	if (parser.eat('{')) {
		parser.allow_whitespace();

		// spread operator ( spreads the attributes! )
		if (parser.eat('...')) {
			const expression = read_expression(parser);
			// ok, we got the node back, time to search for mustache end

			parser.allow_whitespace();
			parser.eat('}', true);

			// return the estree node wrapped in start end
			return {
				start,
				end: parser.index,
				type: 'Spread',
				expression
			};
		} else {
			// todo prefer guard clause?
			const value_start = parser.index;

			// Simple destructuring, without spread op
			const name = parser.read_identifier();
			parser.allow_whitespace();
			parser.eat('}', true);

			return {
				start,
				end: parser.index,
				type: 'Attribute',
				name,
				value: [{
					start: value_start,
					end: value_start + name.length,
					type: 'AttributeShorthand',
					expression: {
						start: value_start,
						end: value_start + name.length,
						type: 'Identifier',
						name
					}
				}]
			};
		}
	}

	// reads until but excluding \s = / > " '
	// why not just = ?
	// Because we want to be robust
	// eslint-disable-next-line no-useless-escape
	const name = parser.read_until(/[\s=\/>"']/);
	if (!name) return null;

	let end = parser.index;

	parser.allow_whitespace();

	// ok, get directive type, if any
	const colon_index = name.indexOf(':');
	const type = colon_index !== -1 && get_directive_type(name.slice(0, colon_index));

	if (unique_names.has(name)) {
		parser.error({
			code: `duplicate-attribute`,
			message: 'Attributes need to be unique'
		}, start);
	}

	// you can have multiple event handlers for a single event
	if (type !== "EventHandler") {
		unique_names.add(name);
	}

	let value: any[] | true = true;
	if (parser.eat('=')) {
		parser.allow_whitespace();
		// magic for reading value is here.
		// array of TemplateNode[] returned.
		value = read_attribute_value(parser);
		end = parser.index;
	} else if (parser.match_regex(/["']/)) {
		parser.error({
			code: `unexpected-token`,
			message: `Expected =`
		}, parser.index);
	}

	// directive handling
	if (type) {
		const [directive_name, ...modifiers] = name.slice(colon_index + 1).split('|');

		// deprecation
		if (type === 'Ref') {
			parser.error({
				code: `invalid-ref-directive`,
				message: `The ref directive is no longer supported — use \`bind:this={${directive_name}}\` instead`
			}, start);
		}

		// first one must be mustache
		if (value[0]) {
			if ((value as any[]).length > 1 || value[0].type === 'Text') {
				parser.error({
					code: `invalid-directive-value`,
					message: `Directive value must be a JavaScript expression enclosed in curly braces`
				}, value[0].start);
			}
		}

		const directive: Directive = {
			start,
			end,
			type,
			name: directive_name,
			modifiers,
			expression: (value[0] && value[0].expression) || null
		};

		if (type === 'Transition') {
			const direction = name.slice(0, colon_index);
			directive.intro = direction === 'in' || direction === 'transition';
			directive.outro = direction === 'out' || direction === 'transition';
		}

		// for bind:shorthand and class:shorthand
		if (!directive.expression && (type === 'Binding' || type === 'Class')) {
			directive.expression = {
				start: directive.start + colon_index + 1,
				end: directive.end,
				type: 'Identifier',
				name: directive.name
			} as any;
		}

		return directive;
	}

	return {
		start,
		end,
		type: 'Attribute',
		name,
		value,
	};
}

// as it says
function get_directive_type(name: string): DirectiveType {
	if (name === 'use') return 'Action';
	if (name === 'animate') return 'Animation';
	if (name === 'bind') return 'Binding';
	if (name === 'class') return 'Class';
	if (name === 'on') return 'EventHandler';
	if (name === 'let') return 'Let';
	if (name === 'ref') return 'Ref';
	if (name === 'in' || name === 'out' || name === 'transition') return 'Transition';
}

// Just calls read_sequence, really
function read_attribute_value(parser: Parser) {
	const quote_mark = parser.eat(`'`) ? `'` : parser.eat(`"`) ? `"` : null;

	const regex = (
		quote_mark === `'` ? /'/ :
			quote_mark === `"` ? /"/ :
				// Any of the following in order: /> \s " ' = < > `
				/(\/>|[\s"'=<>`])/
	);

	const value = read_sequence(parser, () => !!parser.match_regex(regex));

	if (quote_mark) parser.index += 1;
	return value;
}

// First use case is for reading attribute value, in which
// the callback is to match " or ' or terminating things
// parser is in front of the starting " or ' before doing so already
// Second is for text area
// done callback is to signal when it should stop reading
// returns chunks, a TemplateNode[]
function read_sequence(parser: Parser, done: () => boolean): TemplateNode[] {
	let current_chunk: Text = {
		start: parser.index,
		end: null,
		type: 'Text',
		raw: '',
		data: null
	};

	// decodes and pushes the chunk onto the array
	function flush() {
		if (current_chunk.raw) {
			current_chunk.data = decode_character_references(current_chunk.raw);
			current_chunk.end = parser.index;
			chunks.push(current_chunk);
		}
	}

	// chunks being separated into {}'s and Text's
	const chunks: TemplateNode[] = [];

	while (parser.index < parser.template.length) {
		const index = parser.index;

		if (done()) {
			flush();
			return chunks;
		} else if (parser.eat('{')) {
			flush();

			parser.allow_whitespace();
			const expression = read_expression(parser);
			parser.allow_whitespace();
			parser.eat('}', true);

			// same as above
			chunks.push({
				start: index,
				end: parser.index,
				type: 'MustacheTag',
				expression,
			});

			current_chunk = {
				start: parser.index,
				end: null,
				type: 'Text',
				raw: '',
				data: null
			};
		} else {
			current_chunk.raw += parser.template[parser.index++];
		}
	}

	parser.error({
		code: `unexpected-eof`,
		message: `Unexpected end of input`
	});
}
