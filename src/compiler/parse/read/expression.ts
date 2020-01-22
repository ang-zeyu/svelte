import { parse_expression_at } from '../acorn';
import { Parser } from '../index';
import { Identifier, Node, SimpleLiteral } from 'estree';
import { whitespace } from '../../utils/patterns';

const literals = new Map([['true', true], ['false', false], ['null', null]]);

// Ok so... just returns es-tree node types - SimpleLiteral, Identifier or Node (acorn)
export default function read_expression(parser: Parser): Node {
	const start = parser.index;

	// more like /\s+/
	const name = parser.read_until(/\s*}/);
	// alphabets only
	if (name && /^[a-z]+$/.test(name)) {
		const end = start + name.length;

		// ok, note SimpleLiteral from estree which extends BaseNode from estree
		if (literals.has(name)) {
			return {
				type: 'Literal',
				start,
				end,
				value: literals.get(name),
				raw: name,
			} as SimpleLiteral;
		}

		// since alphabets only
		return {
			type: 'Identifier',
			start,
			end: start + name.length,
			name,
		} as Identifier;
	}

	// reset since read_until was called.
	parser.index = start;

	try {
		// ACORN - expressions only
		const node = parse_expression_at(parser.template, parser.index);

		// we handle parentheses ourselves since we parse_expression only for acorn
		let num_parens = 0;

		for (let i = parser.index; i < node.start; i += 1) {
			if (parser.template[i] === '(') num_parens += 1;
		}

		let index = node.end;
		while (num_parens > 0) {
			const char = parser.template[index];

			if (char === ')') {
				num_parens -= 1;
			} else if (!whitespace.test(char)) {
				parser.error({
					code: 'unexpected-token',
					message: 'Expected )'
				}, index);
			}

			index += 1;
		}

		parser.index = index;

		// as es-tree node =3
		return node as Node;
	} catch (err) {
		parser.acorn_error(err);
	}
}
