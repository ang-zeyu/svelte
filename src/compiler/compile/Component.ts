import { walk } from 'estree-walker';
import { getLocator } from 'locate-character';
import Stats from '../Stats';
import { globals, reserved, is_valid } from '../utils/names';
import { namespaces, valid_namespaces } from '../utils/namespaces';
import create_module from './create_module';
import {
	create_scopes,
	extract_names,
	Scope,
	extract_identifiers,
} from './utils/scope';
import Stylesheet from './css/Stylesheet';
import { test } from '../config';
import Fragment from './nodes/Fragment';
import internal_exports from './internal_exports';
import { Ast, CompileOptions, Var, Warning, CssResult } from '../interfaces';
import error from '../utils/error';
import get_code_frame from '../utils/get_code_frame';
import flatten_reference from './utils/flatten_reference';
import is_used_as_reference from './utils/is_used_as_reference';
import is_reference from 'is-reference';
import TemplateScope from './nodes/shared/TemplateScope';
import fuzzymatch from '../utils/fuzzymatch';
import get_object from './utils/get_object';
import Slot from './nodes/Slot';
import { Node, ImportDeclaration, Identifier, Program, ExpressionStatement, AssignmentExpression, Literal } from 'estree';
import add_to_set from './utils/add_to_set';
import check_graph_for_cycles from './utils/check_graph_for_cycles';
import { print, x, b } from 'code-red';

interface ComponentOptions {
	namespace?: string;
	tag?: string;
	immutable?: boolean;
	accessors?: boolean;
	preserveWhitespace?: boolean;
}

// The center piece
export default class Component {
	stats: Stats;
	warnings: Warning[];
	ignores: Set<string>;
	ignore_stack: Array<Set<string>> = [];

	ast: Ast;
	original_ast: Ast;
	source: string;
	name: Identifier;
	compile_options: CompileOptions;
	fragment: Fragment;
	module_scope: Scope;
	// of the instance <script>, directly from the periscopic analyze
	instance_scope: Scope;
	instance_scope_map: WeakMap<Node, Scope>;

	component_options: ComponentOptions;
	namespace: string;
	tag: string;
	accessors: boolean;

	// Contains both module and instance variables!
	vars: Var[] = [];
	var_lookup: Map<string, Var> = new Map();

	// Just nodes of type 'ImportDeclaration'
	imports: ImportDeclaration[] = [];

	hoistable_nodes: Set<Node> = new Set();
	// Instance <script> name : node map for declarations
	node_for_declaration: Map<string, Node> = new Map();
	partly_hoisted: Array<(Node | Node[])> = [];
	fully_hoisted: Array<(Node | Node[])> = [];
	reactive_declarations: Array<{
		assignees: Set<string>;
		dependencies: Set<string>;
		node: Node;
		declaration: Node;
	}> = [];
	reactive_declaration_nodes: Set<Node> = new Set();
	has_reactive_assignments = false;
	// Instance script left expression names
	injected_reactive_declaration_vars: Set<string> = new Set();
	helpers: Map<string, Identifier> = new Map();
	globals: Map<string, Identifier> = new Map();

	indirect_dependencies: Map<string, Set<string>> = new Map();

	file: string;
	locate: (c: number) => { line: number; column: number };

	stylesheet: Stylesheet;

	aliases: Map<string, Identifier> = new Map();
	// ?
	used_names: Set<string> = new Set();
	globally_used_names: Set<string> = new Set();

	slots: Map<string, Slot> = new Map();
	slot_outlets: Set<string> = new Set();

	constructor(
		ast: Ast,
		source: string,
		name: string,
		compile_options: CompileOptions,
		stats: Stats,
		warnings: Warning[]
	) {
		// estree
		this.name = { type: 'Identifier', name };

		this.stats = stats;
		this.warnings = warnings;
		this.ast = ast;
		this.source = source;
		this.compile_options = compile_options;

		// the instance JS gets mutated, so we park
		// a copy here for later. TODO this feels gross
		this.original_ast = {
			html: ast.html,
			css: ast.css,
			instance: ast.instance && JSON.parse(JSON.stringify(ast.instance)),
			module: ast.module
		};

		this.file =
			compile_options.filename &&
			(typeof process !== 'undefined'
				? compile_options.filename
					.replace(process.cwd(), '')
					.replace(/^[/\\]/, '')
				: compile_options.filename);
		// locate-chracter package
		this.locate = getLocator(this.source, { offsetLine: 1 });

		// styles
		this.stylesheet = new Stylesheet(
			source,
			ast,
			compile_options.filename,
			compile_options.dev
		);
		this.stylesheet.validate(this);

		// Simple, just processes global options and overrides with <svelte:options>
		this.component_options = process_component_options(
			this,
			this.ast.html.children
		);
		// Why? Isn't this.component_options.namespace sufficient?
		this.namespace =
			namespaces[this.component_options.namespace] ||
			this.component_options.namespace;

		if (compile_options.customElement) {
			// no tag in both global and yada
			if (
				this.component_options.tag === undefined &&
				compile_options.tag === undefined
			) {
				const svelteOptions = ast.html.children.find(
					child => child.name === 'svelte:options'
				) || { start: 0, end: 0 };
				this.warn(svelteOptions, {
					code: 'custom-element-no-tag',
					message: `No custom element 'tag' option was specified. To automatically register a custom element, specify a name with a hyphen in it, e.g. <svelte:options tag="my-thing"/>. To hide this warning, use <svelte:options tag={null}/>`,
				});
			}
			this.tag = this.component_options.tag || compile_options.tag;
		} else {
			this.tag = this.name.name;
		}

		// The magic happens here
		this.walk_module_js();
		this.walk_instance_js_pre_template();

		// Construction of the nodes
		this.fragment = new Fragment(this, ast.html);
		this.name = this.get_unique_name(name);

		this.walk_instance_js_post_template();

		if (!compile_options.customElement) this.stylesheet.reify();

		this.stylesheet.warn_on_unused_selectors(this);
	}

	// adds to vars and var_lookup
	add_var(variable: Var) {
		this.vars.push(variable);
		this.var_lookup.set(variable.name, variable);
	}

	// Flags a variable as referenced
	// For $$props, adds an entirely new variable
	// For reactive, also adds entirely new variable, but also mutates the one without '$'
	// Otherwise, adds to used_names
	add_reference(name: string) {
		const variable = this.var_lookup.get(name);

		if (variable) {
			variable.referenced = true;
		} else if (name === '$$props') {
			this.add_var({
				name,
				injected: true,
				referenced: true,
			});
		} else if (name[0] === '$') {
			this.add_var({
				name,
				injected: true,
				referenced: true,
				mutated: true,
				writable: true,
			});

			const subscribable_name = name.slice(1);

			const variable = this.var_lookup.get(subscribable_name);
			if (variable) {
				variable.referenced   = true;
				variable.subscribable = true;
			}
		} else {
			this.used_names.add(name);
		}
	}

	//get unique name for the alias, or the existing one
	alias(name: string) {
		if (!this.aliases.has(name)) {
			this.aliases.set(name, this.get_unique_name(name));
		}

		return this.aliases.get(name);
	}

	// Adds alias to globals
	// generates unique alias, or uses the existing one
	global(name: string) {
		const alias = this.alias(name);
		this.globals.set(name, alias);
		return alias;
	}

	// Takes output from render_dom, and then
	generate(result?: { js: Node[]; css: CssResult }) {
		let js = null;
		let css = null;

		if (result) {
			const { compile_options, name } = this;
			const { format = 'esm' } = compile_options;

			const banner = `${this.file ? `${this.file} ` : ``}generated by Svelte v${'__VERSION__'}`;

			const program: any = { type: 'Program', body: result.js };

			// walk through the result
			walk(program, {
				enter: (node, parent, key) => {
					if (node.type === 'Identifier') {
						if (node.name[0] === '@') {
							if (node.name[1] === '_') {
								// Identifier and name is @_something
								// Add to globals and aliasses and update node's name
								const alias = this.global(node.name.slice(2));
								node.name = alias.name;
							} else {
								// Identifier and name is @something
								let name = node.name.slice(1);

								if (compile_options.dev) {
									if (internal_exports.has(`${name}_dev`)) {
										name += '_dev';
									} else if (internal_exports.has(`${name}Dev`)) {
										name += 'Dev';
									}
								}

								// but not globals
								const alias = this.alias(name);
								this.helpers.set(name, alias);
								node.name = alias.name;
							}
						}

						else if (node.name[0] !== '#' && !is_valid(node.name)) {
							// this hack allows x`foo.${bar}` where bar could be invalid
							const literal: Literal = { type: 'Literal', value: node.name };

							if (parent.type === 'Property' && key === 'key') {
								parent.key = literal;
							}

							else if (parent.type === 'MemberExpression' && key === 'property') {
								parent.property = literal;
								parent.computed = true;
							}
						}
					}
				}
			});

			const referenced_globals = Array.from(
				this.globals,
				([name, alias]) => name !== alias.name && { name, alias }
			).filter(Boolean);
			if (referenced_globals.length) {
				this.helpers.set('globals', this.alias('globals'));
			}
			const imported_helpers = Array.from(this.helpers, ([name, alias]) => ({
				name,
				alias,
			}));

			create_module(
				program,
				format,
				name,
				banner,
				compile_options.sveltePath,
				imported_helpers,
				referenced_globals,
				this.imports,
				this.vars
					.filter(variable => variable.module && variable.export_name)
					.map(variable => ({
						name: variable.name,
						as: variable.export_name,
					}))
			);

			css = compile_options.customElement
				? { code: null, map: null }
				: result.css;

			js = print(program, {
				sourceMapSource: compile_options.filename
			});

			js.map.sources = [
				compile_options.filename ? get_relative_path(compile_options.outputFilename || '', compile_options.filename) : null
			];

			js.map.sourcesContent = [
				this.source
			];
		}

		return {
			js,
			css,
			ast: this.original_ast,
			warnings: this.warnings,
			vars: this.vars
				.filter(v => !v.global && !v.internal)
				.map(v => ({
					name: v.name,
					export_name: v.export_name || null,
					injected: v.injected || false,
					module: v.module || false,
					mutated: v.mutated || false,
					reassigned: v.reassigned || false,
					referenced: v.referenced || false,
					writable: v.writable || false,
					referenced_from_script: v.referenced_from_script || false,
				})),
			stats: this.stats.render(),
		};
	}

	// Gets a unique name...
	// returns estree identifier
	get_unique_name(name: string, scope?: Scope): Identifier {
		// test env
		if (test) name = `${name}$`;
		let alias = name;
		for (
			let i = 1;
			reserved.has(alias) ||
			this.var_lookup.has(alias) ||
			this.used_names.has(alias) ||
			// i.e. the local_used_names from get_unique_name_maker below
			this.globally_used_names.has(alias) ||
			(scope && scope.has(alias));
			alias = `${name}_${i++}`
		);
		this.used_names.add(alias);
		return { type: 'Identifier', name: alias };
	}

	// Same as above... except we maintain a local_used_names set and check against that
	// We check against used_names and local_used_names only
	// but local_used_names has reserved ( which is constant anyway )
	// and also has var_lookup ( but is not constant ) ( so this is the purpose <-- )
	// and internal_exports ( which is constant )
	// We update local_used_names and globally_used_names ( for get_unique_name ) after generating the unique name
	get_unique_name_maker() {
		const local_used_names = new Set();

		function add(name: string) {
			local_used_names.add(name);
		}

		reserved.forEach(add);
		internal_exports.forEach(add);
		this.var_lookup.forEach((_value, key) => add(key));

		return (name: string): Identifier => {
			if (test) name = `${name}$`;
			let alias = name;
			for (
				let i = 1;
				this.used_names.has(alias) || local_used_names.has(alias);
				alias = `${name}_${i++}`
			);
			local_used_names.add(alias);
			this.globally_used_names.add(alias);

			return {
				type: 'Identifier',
				name: alias
			};
		};
	}

	error(
		pos: {
			start: number;
			end: number;
		},
		e: {
			code: string;
			message: string;
		}
	) {
		error(e.message, {
			name: 'ValidationError',
			code: e.code,
			source: this.source,
			start: pos.start,
			end: pos.end,
			filename: this.compile_options.filename,
		});
	}

	warn(
		pos: {
			start: number;
			end: number;
		},
		warning: {
			code: string;
			message: string;
		}
	) {
		if (this.ignores && this.ignores.has(warning.code)) {
			return;
		}

		const start = this.locate(pos.start);
		const end = this.locate(pos.end);

		const frame = get_code_frame(this.source, start.line - 1, start.column);

		this.warnings.push({
			code: warning.code,
			message: warning.message,
			frame,
			start,
			end,
			pos: pos.start,
			filename: this.compile_options.filename,
			toString: () =>
				`${warning.message} (${start.line}:${start.column})\n${frame}`,
		});
	}

	// just push the node
	extract_imports(node) {
		this.imports.push(node);
	}

	// Called with ^Export!
	extract_exports(node) {
		// Error handling, ok
		if (node.type === 'ExportDefaultDeclaration') {
			this.error(node, {
				code: `default-export`,
				message: `A component cannot have a default export`,
			});
		}

		// Export { xxx }
		if (node.type === 'ExportNamedDeclaration') {
			// ok
			if (node.source) {
				this.error(node, {
					code: `not-implemented`,
					message: `A component currently cannot have an export ... from`,
				});
			}
			// Node declarative exports!
			if (node.declaration) {
				if (node.declaration.type === 'VariableDeclaration') {
					// declarator
					node.declaration.declarations.forEach(declarator => {
						// periscopic function, get the declaration name
						extract_names(declarator.id).forEach(name => {
							// lookup internal variable name, then tie export name to it
							const variable = this.var_lookup.get(name);
							variable.export_name = name;
							// ok, if not referenced, warn of useless export for 'let' and 'var'
							if (variable.writable && !(variable.referenced || variable.referenced_from_script || variable.subscribable)) {
								this.warn(declarator, {
									code: `unused-export-let`,
									message: `${this.name.name} has unused export property '${name}'. If it is for external reference only, please consider using \`export const ${name}\``
								});
							}
						});
					});
				} else {
					const { name } = node.declaration.id;

					// same as above
					// lookup internal variable name, then tie export name to it
					const variable = this.var_lookup.get(name);
					variable.export_name = name;
				}

				return node.declaration;
			} else {
				// Same as above, but with non-declarative exports
				node.specifiers.forEach(specifier => {
					const variable = this.var_lookup.get(specifier.local.name);

					// Might not be in there
					if (variable) {
						variable.export_name = specifier.exported.name;

						// ok, if not referenced, warn of useless export for 'let' and 'var'
						if (variable.writable && !(variable.referenced || variable.referenced_from_script || variable.subscribable)) {
							this.warn(specifier, {
								code: `unused-export-let`,
								message: `${this.name.name} has unused export property '${specifier.exported.name}'. If it is for external reference only, please consider using \`export const ${specifier.exported.name}\``
							});
						}
					}
				});

				return null;
			}
		}
	}

	extract_javascript(script) {
		if (!script) return null;

		return script.content.body.filter(node => {
			if (!node) return false;
			if (this.hoistable_nodes.has(node)) return false;
			if (this.reactive_declaration_nodes.has(node)) return false;
			if (node.type === 'ImportDeclaration') return false;
			if (node.type === 'ExportDeclaration' && node.specifiers.length > 0)
				return false;
			return true;
		});
	}

	// <script context="module">, called in constructor
	walk_module_js() {
		const component = this;
		const script = this.ast.module;
		if (!script) return;

		// estree-walk
		// warn if it has reactive statements
		walk(script.content, {
			enter(node) {
				if (node.type === 'LabeledStatement' && node.label.name === '$') {
					component.warn(node as any, {
						code: 'module-script-reactive-declaration',
						message: '$: has no effect in a module script',
					});
				}
			},
		});

		// 'periscopic' analyze, also returns map - a weakmap of <Nodes that define scopes, scopes>
		// note globals is Map<String, Nodes> for variables referenced but not declared in scope!
		const { scope, globals } = create_scopes(script.content);
		// top level scope
		this.module_scope = scope;

		// declarations = map of <String, Node that defines the variable>
		// also has initialised declarations
		scope.declarations.forEach((node, name) => {
			if (name[0] === '$') {
				this.error(node as any, {
					code: 'illegal-declaration',
					message: `The $ prefix is reserved, and cannot be used for variable and import names`,
				});
			}

			const writable = node.type === 'VariableDeclaration' && (node.kind === 'var' || node.kind === 'let');

			this.add_var({
				name,
				module: true,
				hoistable: true,
				writable
			});
		});

		globals.forEach((node, name) => {
			if (name[0] === '$') {
				this.error(node as any, {
					code: 'illegal-subscription',
					message: `Cannot reference store value inside <script context="module">`,
				});
			} else {
				this.add_var({
					name,
					global: true,
					hoistable: true
				});
			}
		});

		// Special import export handling
		const { body } = script.content;
		let i = body.length;
		while (--i >= 0) {
			const node = body[i];
			// Ok, just extract into this.imports
			if (node.type === 'ImportDeclaration') {
				this.extract_imports(node);
				body.splice(i, 1);
			}

			// 4 types - export { xxx }, export { xxx as ... }, export * from ..., export default
			// NOTE: no from ... !s
			if (/^Export/.test(node.type)) {
				const replacement = this.extract_exports(node);
				if (replacement) {
					body[i] = replacement;
				} else {
					body.splice(i, 1);
				}
			}
		}
	}

	walk_instance_js_pre_template() {
		const script = this.ast.instance;
		if (!script) return;

		// inject vars for reactive declarations
		script.content.body.forEach(node => {
			if (node.type !== 'LabeledStatement') return;
			if (node.body.type !== 'ExpressionStatement') return;

			const { expression } = node.body;
			if (expression.type !== 'AssignmentExpression') return;
			if (expression.left.type === 'MemberExpression') return;

			// Ok, left names
			extract_names(expression.left).forEach(name => {
				if (!this.var_lookup.has(name) && name[0] !== '$') {
					this.injected_reactive_declaration_vars.add(name);
				}
			});
		});

		const { scope: instance_scope, map, globals } = create_scopes(
			script.content
		);
		this.instance_scope = instance_scope;
		this.instance_scope_map = map;

		// Add declarations to this.variables
		instance_scope.declarations.forEach((node, name) => {
			// Error checking, reserved for stores
			if (name[0] === '$') {
				this.error(node as any, {
					code: 'illegal-declaration',
					message: `The $ prefix is reserved, and cannot be used for variable and import names`,
				});
			}

			// TODO NOTE the importance of writable
			const writable = node.type === 'VariableDeclaration' && (node.kind === 'var' || node.kind === 'let');

			this.add_var({
				name,
				initialised: instance_scope.initialised_declarations.has(name),
				// hoistable means can be hoisted 'outside of the component'
				hoistable: /^Import/.test(node.type),
				writable
			});

			this.node_for_declaration.set(name, node);
		});

		globals.forEach((node, name) => {
			if (this.var_lookup.has(name)) return;

			if (this.injected_reactive_declaration_vars.has(name)) {
				// add injected var
				this.add_var({
					name,
					injected: true,
					writable: true,
					reassigned: true,
					initialised: true,
				});
			} else if (name === '$$props') {
				// All props
				this.add_var({
					name,
					injected: true,
				});
			} else if (name[0] === '$') {
				// NOTE Store values
				// $$ is reserved, $ is simply an illegal name
				if (name === '$' || name[1] === '$') {
					this.error(node as any, {
						code: 'illegal-global',
						message: `${name} is an illegal variable name`
					});
				}

				// Add injected var again, because its reactive
				this.add_var({
					name,
					injected: true,
					mutated: true,
					writable: true,
				});

				// Note
				this.add_reference(name.slice(1));

				const variable = this.var_lookup.get(name.slice(1));
				if (variable) {
					variable.subscribable = true;
					variable.referenced_from_script = true;
				}
			} else {
				this.add_var({
					name,
					global: true,
					// hoistable = out of the component
					hoistable: true
				});
			}
		});

		this.track_references_and_mutations();
	}

	// Post construction of node
	walk_instance_js_post_template() {
		const script = this.ast.instance;
		if (!script) return;

		// protect loops
		this.post_template_walk();

		// As it says
		this.hoist_instance_declarations();
		// As it says
		this.extract_reactive_declarations();
	}

	// In summary, protects loops
	// Extracts imports for the instance level stuff
	// Extracts exports for the instance level stuff - for props too?
	post_template_walk() {
		const script = this.ast.instance;
		if (!script) return;

		const component = this;
		const { content } = script;
		const { instance_scope, instance_scope_map: map } = this;

		let scope = instance_scope;

		const to_remove = [];
		const remove = (parent, prop, index) => {
			to_remove.unshift([parent, prop, index]);
		};
		let scope_updated = false;

		walk(content, {
			enter(node, parent, prop, index) {
				if (map.has(node)) {
					scope = map.get(node);
				}

				if (node.type === 'ImportDeclaration') {
					component.extract_imports(node);
					// TODO: to use actual remove
					remove(parent, prop, index);
					// prevents children from being processed and leave() from being called
					return this.skip();
				}

				if (/^Export/.test(node.type)) {
					const replacement = component.extract_exports(node);
					if (replacement) {
						// estree-walker replace with node.declaration
						this.replace(replacement);
					} else {
						// TODO: to use actual remove
						remove(parent, prop, index);
					}
					return this.skip();
				}

				component.warn_on_undefined_store_value_references(node, parent, scope);
			},

			leave(node) {
				// Ok, just wrap loops with magic to prevent too long loops
				// do it on leave, to prevent infinite loop
				if (component.compile_options.dev && component.compile_options.loopGuardTimeout > 0) {
					const to_replace_for_loop_protect = component.loop_protect(node, scope, component.compile_options.loopGuardTimeout);
					if (to_replace_for_loop_protect) {
						this.replace(to_replace_for_loop_protect);
						scope_updated = true;
					}
				}

				if (map.has(node)) {
					scope = scope.parent;
				}
			},
		});

		// Why to_remove instead of estree remove?
		// Because we want to... hmmm.....
		for (const [parent, prop, index] of to_remove) {
			if (parent) {
				if (index !== null) {
					parent[prop].splice(index, 1);
				} else {
					delete parent[prop];
				}
			}
		}

		// recreate since if we wrapped loops
		if (scope_updated) {
			const { scope, map } = create_scopes(script.content);
			this.instance_scope = scope;
			this.instance_scope_map = map;
		}
	}

	// Uses es-tree walk
	track_references_and_mutations() {
		const script = this.ast.instance;
		if (!script) return;

		const component = this;
		const { content } = script;
		const { instance_scope, instance_scope_map: map } = this;

		let scope = instance_scope;

		walk(content, {
			enter(node, parent) {
				// Change the current scope to the inner one for the subsequent enters
				if (map.has(node)) {
					scope = map.get(node);
				}

				// Should not be true if the previous is in the same enter, not that it matters
				//
				if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
					// Just get the assignee only
					const assignee = node.type === 'AssignmentExpression' ? node.left : node.argument;
					const names = extract_names(assignee);

					const deep = assignee.type === 'MemberExpression';

					names.forEach(name => {
						// If it belongs to the instance level scope,
						if (scope.find_owner(name) === instance_scope) {
							const variable = component.var_lookup.get(name);
							// If { x y z }, then flag as mutated, else, reassigned
							variable[deep ? 'mutated' : 'reassigned'] = true;
						}
					});
				}

				// If it is referenced, and it belongs to instance scope
				// flag referenced_from_script
				if (is_used_as_reference(node, parent)) {
					const object = get_object(node);
					if (scope.find_owner(object.name) === instance_scope) {
						const variable = component.var_lookup.get(object.name);
						variable.referenced_from_script = true;
					}
				}
			},

			leave(node) {
				// Opposite of above
				if (map.has(node)) {
					scope = scope.parent;
				}
			},
		});
	}

	warn_on_undefined_store_value_references(node, parent, scope) {
		if (
			node.type === 'LabeledStatement' &&
			node.label.name === '$' &&
			parent.type !== 'Program'
		) {
			this.warn(node as any, {
				code: 'non-top-level-reactive-declaration',
				message: '$: has no effect outside of the top-level',
			});
		}

		if (is_reference(node as Node, parent as Node)) {
			const object = get_object(node);
			const { name } = object;

			if (name[0] === '$' && !scope.has(name)) {
				this.warn_if_undefined(name, object, null);
			}
		}
	}

	// wraps loops with a @loop_guard(${timeout})
	loop_protect(node, scope: Scope, timeout: number): Node | null {
		if (node.type === 'WhileStatement' ||
			node.type === 'ForStatement' ||
			node.type === 'DoWhileStatement') {
			const guard = this.get_unique_name('guard', scope);
			this.used_names.add(guard.name);

			const before = b`const ${guard} = @loop_guard(${timeout})`;
			const inside = b`${guard}();`;

			// wrap expression statement with BlockStatement
			if (node.body.type !== 'BlockStatement') {
				node.body = {
					type: 'BlockStatement',
					body: [node.body],
				};
			}
			node.body.body.push(inside[0]);

			return {
				type: 'BlockStatement',
				body: [
					before[0],
					node,
				],
			};
		}
		return null;
	}

	rewrite_props(get_insert: (variable: Var) => Node[]) {
		if (!this.ast.instance) return;

		const component = this;
		const { instance_scope, instance_scope_map: map } = this;
		let scope = instance_scope;

		walk(this.ast.instance.content, {
			enter(node, parent, key, index) {
				if (/Function/.test(node.type)) {
					return this.skip();
				}

				if (map.has(node)) {
					scope = map.get(node);
				}

				if (node.type === 'VariableDeclaration') {
					if (node.kind === 'var' || scope === instance_scope) {
						node.declarations.forEach(declarator => {
							if (declarator.id.type !== 'Identifier') {
								const inserts = [];

								extract_names(declarator.id).forEach(name => {
									const variable = component.var_lookup.get(name);

									if (variable.export_name) {
										// TODO is this still true post-#3539?
										component.error(declarator as any, {
											code: 'destructured-prop',
											message: `Cannot declare props in destructured declaration`,
										});
									}

									if (variable.subscribable) {
										inserts.push(get_insert(variable));
									}
								});

								if (inserts.length) {
									parent[key].splice(index + 1, 0, ...inserts);
								}

								return;
							}

							const { name } = declarator.id;
							const variable = component.var_lookup.get(name);

							if (variable.export_name && variable.writable) {
								const insert = variable.subscribable
									? get_insert(variable)
									: null;

								parent[key].splice(index + 1, 0, insert);

								declarator.id = {
									type: 'ObjectPattern',
									properties: [{
										type: 'Property',
										method: false,
										shorthand: false,
										computed: false,
										kind: 'init',
										key: { type: 'Identifier', name: variable.export_name },
										value: declarator.init
											? {
												type: 'AssignmentPattern',
												left: declarator.id,
												right: declarator.init
											}
											: declarator.id
									}]
								};

								declarator.init = x`$$props`;
							} else if (variable.subscribable) {
								const insert = get_insert(variable);
								parent[key].splice(index + 1, 0, ...insert);
							}
						});
					}
				}
			},

			leave(node, parent, _key, index) {
				if (map.has(node)) {
					scope = scope.parent;
				}

				if (node.type === 'ExportNamedDeclaration' && node.declaration) {
					(parent as Program).body[index] = node.declaration;
				}
			},
		});
	}

	hoist_instance_declarations() {
		// we can safely hoist variable declarations that are
		// initialised to literals, and functions that don't
		// reference instance variables other than other
		// hoistable functions. TODO others?

		const {
			hoistable_nodes,
			var_lookup,
			injected_reactive_declaration_vars,
		} = this;

		const top_level_function_declarations = new Map();

		const { body } = this.ast.instance.content;

		for (let i = 0; i < body.length; i += 1) {
			const node = body[i];

			// Handles variable declarations initialised to literals
			if (node.type === 'VariableDeclaration') {
				const all_hoistable = node.declarations.every(d => {
					// Check the initialised presence and type
					if (!d.init) return false;
					if (d.init.type !== 'Literal') return false;

					// For dev tools
					// everything except const values can be changed by e.g. svelte devtools
					// which means we can't hoist it
					if (node.kind !== 'const' && this.compile_options.dev) return false;

					const { name } = d.id as Identifier;

					// Can't hoist exported ones or ones that will be updated
					const v = this.var_lookup.get(name);
					if (v.reassigned) return false;
					if (v.export_name) return false;

					if (this.var_lookup.get(name).reassigned) return false;
					// can't hoist module ones
					if (
						this.vars.find(
							variable => variable.name === name && variable.module
						)
					)
						return false;

					return true;
				});

				if (all_hoistable) {
					// Mark as hoistable
					node.declarations.forEach(d => {
						const variable = this.var_lookup.get((d.id as Identifier).name);
						variable.hoistable = true;
					});

					// Add to instance field the hoistable node
					hoistable_nodes.add(node);

					// delete from main body, add to fully_hoisted
					body.splice(i--, 1);
					this.fully_hoisted.push(node);
				}
			}

			if (
				node.type === 'ExportNamedDeclaration' &&
				node.declaration &&
				node.declaration.type === 'FunctionDeclaration'
			) {
				top_level_function_declarations.set(node.declaration.id.name, node);
			}

			if (node.type === 'FunctionDeclaration') {
				top_level_function_declarations.set(node.id.name, node);
			}
		}

		const checked = new Set();
		const walking = new Set();

		// for functions that don't reference instance variables other than hoisted functions
		const is_hoistable = fn_declaration => {
			if (fn_declaration.type === 'ExportNamedDeclaration') {
				fn_declaration = fn_declaration.declaration;
			}

			const instance_scope = this.instance_scope;
			let scope = this.instance_scope;
			const map = this.instance_scope_map;

			let hoistable = true;

			// handle cycles
			walking.add(fn_declaration);

			walk(fn_declaration, {
				enter(node, parent) {
					if (!hoistable) return this.skip();

					if (map.has(node)) {
						scope = map.get(node);
					}

					if (is_reference(node as Node, parent as Node)) {
						const { name } = flatten_reference(node);
						const owner = scope.find_owner(name);

						if (injected_reactive_declaration_vars.has(name)) {
							hoistable = false;
						} else if (name[0] === '$' && !owner) {
							hoistable = false;
						} else if (owner === instance_scope) {
							const variable = var_lookup.get(name);

							if (variable.reassigned || variable.mutated) hoistable = false;

							if (name === fn_declaration.id.name) return;

							if (variable.hoistable) return;

							if (top_level_function_declarations.has(name)) {
								const other_declaration = top_level_function_declarations.get(
									name
								);

								if (walking.has(other_declaration)) {
									hoistable = false;
								} else if (
									other_declaration.type === 'ExportNamedDeclaration' &&
									walking.has(other_declaration.declaration)
								) {
									hoistable = false;
								} else if (!is_hoistable(other_declaration)) {
									hoistable = false;
								}
							} else {
								hoistable = false;
							}
						}

						this.skip();
					}
				},

				leave(node) {
					if (map.has(node)) {
						scope = scope.parent;
					}
				},
			});

			checked.add(fn_declaration);
			walking.delete(fn_declaration);

			return hoistable;
		};

		for (const [name, node] of top_level_function_declarations) {
			if (is_hoistable(node)) {
				const variable = this.var_lookup.get(name);
				variable.hoistable = true;
				hoistable_nodes.add(node);

				const i = body.indexOf(node);
				body.splice(i, 1);
				this.fully_hoisted.push(node);
			}
		}
	}

	extract_reactive_declarations() {
		const component = this;

		const unsorted_reactive_declarations = [];

		// populate unsorted_reactive_declarations with { assignees, dependencies, declarations, node }
		this.ast.instance.content.body.forEach(node => {
			if (node.type === 'LabeledStatement' && node.label.name === '$') {
				this.reactive_declaration_nodes.add(node);

				const assignees = new Set();
				const assignee_nodes = new Set();
				const dependencies = new Set();

				let scope = this.instance_scope;
				const map = this.instance_scope_map;

				walk(node.body, {
					enter(node, parent) {
						if (map.has(node)) {
							scope = map.get(node);
						}

						if (node.type === 'AssignmentExpression') {
							const left = get_object(node.left);

							extract_identifiers(left).forEach(node => {
								assignee_nodes.add(node);
								assignees.add(node.name);
							});

							if (node.operator !== '=') {
								dependencies.add(left.name);
							}
						} else if (node.type === 'UpdateExpression') {
							const identifier = get_object(node.argument);
							assignees.add(identifier.name);
						} else if (is_reference(node as Node, parent as Node)) {
							const identifier = get_object(node);
							if (!assignee_nodes.has(identifier)) {
								const { name } = identifier;
								const owner = scope.find_owner(name);
								const variable = component.var_lookup.get(name);
								if (variable) variable.is_reactive_dependency = true;
								const is_writable_or_mutated =
									variable && (variable.writable || variable.mutated);
								if (
									(!owner || owner === component.instance_scope) &&
									(name[0] === '$' || is_writable_or_mutated)
								) {
									dependencies.add(name);
								}
							}

							this.skip();
						}
					},

					leave(node) {
						if (map.has(node)) {
							scope = scope.parent;
						}
					},
				});

				const { expression } = node.body as ExpressionStatement;
				const declaration = expression && (expression as AssignmentExpression).left;

				unsorted_reactive_declarations.push({
					// for assignments and updates only
					assignees,
					// assignments and references
					dependencies,
					node,
					// if any?
					declaration,
				});
			}
		});

		// Map of assignees -> declaration
		const lookup = new Map();
		let seen;

		unsorted_reactive_declarations.forEach(declaration => {
			// NOTE not that declaration; The unsorted reactive declaration
			declaration.assignees.forEach(name => {
				if (!lookup.has(name)) {
					lookup.set(name, []);
				}

				// TODO warn or error if a name is assigned to in
				// multiple reactive declarations?
				lookup.get(name).push(declaration);
			});
		});

		const cycle = check_graph_for_cycles(unsorted_reactive_declarations.reduce((acc, declaration) => {
			// ok, accumulate all [ assignee, dependency ] pairs
			declaration.assignees.forEach(v => {
				declaration.dependencies.forEach(w => {
					if (!declaration.assignees.has(w)) {
						acc.push([v, w]);
					}
				});
			});
			return acc;
		}, []));

		// Nice, cyclic reference error checking
		if (cycle && cycle.length) {
			const declarationList = lookup.get(cycle[0]);
			const declaration = declarationList[0];
			this.error(declaration.node, {
				code: 'cyclical-reactive-declaration',
				message: `Cyclical dependency detected: ${cycle.join(' → ')}`
			});
		}

		const add_declaration = declaration => {
			if (this.reactive_declarations.indexOf(declaration) !== -1) {
				return;
			}

			seen.add(declaration);

			declaration.dependencies.forEach(name => {
				// Don't recurse if dependency is also an assignee
				if (declaration.assignees.has(name)) return;
				// Recurse on the assignee's declarations
				const earlier_declarations = lookup.get(name);
				if (earlier_declarations)
					earlier_declarations.forEach(declaration => {
						add_declaration(declaration);
					});
			});

			this.reactive_declarations.push(declaration);
		};

		unsorted_reactive_declarations.forEach(declaration => {
			seen = new Set();
			add_declaration(declaration);
		});
	}

	warn_if_undefined(name: string, node, template_scope: TemplateScope) {
		if (name[0] === '$') {
			if (name === '$' || name[1] === '$' && name !== '$$props') {
				this.error(node, {
					code: 'illegal-global',
					message: `${name} is an illegal variable name`
				});
			}

			this.has_reactive_assignments = true; // TODO does this belong here?

			if (name === '$$props') return;

			name = name.slice(1);
		}

		if (this.var_lookup.has(name) && !this.var_lookup.get(name).global) return;
		if (template_scope && template_scope.names.has(name)) return;
		if (globals.has(name) && node.type !== 'InlineComponent') return;

		let message = `'${name}' is not defined`;
		if (!this.ast.instance)
			message += `. Consider adding a <script> block with 'export let ${name}' to declare a prop`;

		this.warn(node, {
			code: 'missing-declaration',
			message,
		});
	}

	push_ignores(ignores) {
		this.ignores = new Set(this.ignores || []);
		add_to_set(this.ignores, ignores);
		this.ignore_stack.push(this.ignores);
	}

	pop_ignores() {
		this.ignore_stack.pop();
		this.ignores = this.ignore_stack[this.ignore_stack.length - 1];
	}
}

// Called in constructor, takes this and its root html's children
function process_component_options(component: Component, nodes) {
	// transfer some global options over first, then override them
	const component_options: ComponentOptions = {
		immutable: component.compile_options.immutable || false,
		accessors:
			'accessors' in component.compile_options
				? component.compile_options.accessors
				: !!component.compile_options.customElement,
		preserveWhitespace: !!component.compile_options.preserveWhitespace,
	};

	// houses immutable, accessors, namespace, tag, preserveWhitespace component-level options
	const node = nodes.find(node => node.name === 'svelte:options');

	// Retrieve the value as parsed in read attributes
	// returns true if there is no value ( correct behaviour )
	// displays error code and message if it has more than one chunk, or is not a literal
	function get_value(attribute, code, message) {
		const { value } = attribute;
		const chunk = value[0];

		if (!chunk) return true;

		if (value.length > 1) {
			component.error(attribute, { code, message });
		}

		if (chunk.type === 'Text') return chunk.data;

		if (chunk.expression.type !== 'Literal') {
			component.error(attribute, { code, message });
		}

		return chunk.expression.value;
	}

	// Special processing for svelte:options' attributes
	if (node) {
		node.attributes.forEach(attribute => {
			if (attribute.type === 'Attribute') {
				const { name } = attribute;

				switch (name) {
					// just self documenting error handling
					case 'tag': {
						const code = 'invalid-tag-attribute';
						const message = `'tag' must be a string literal`;
						const tag = get_value(attribute, code, message);

						if (typeof tag !== 'string' && tag !== null)
							component.error(attribute, { code, message });

						if (tag && !/^[a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9-]+$/.test(tag)) {
							component.error(attribute, {
								code: `invalid-tag-property`,
								message: `tag name must be two or more words joined by the '-' character`,
							});
						}

						if (tag && !component.compile_options.customElement) {
							component.warn(attribute, {
								code: 'missing-custom-element-compile-options',
								message: `The 'tag' option is used when generating a custom element. Did you forget the 'customElement: true' compile option?`
							});
						}

						component_options.tag = tag;
						break;
					}

					// just self documenting error handling
					case 'namespace': {
						const code = 'invalid-namespace-attribute';
						const message = `The 'namespace' attribute must be a string literal representing a valid namespace`;
						const ns = get_value(attribute, code, message);

						if (typeof ns !== 'string')
							component.error(attribute, { code, message });

						if (valid_namespaces.indexOf(ns) === -1) {
							const match = fuzzymatch(ns, valid_namespaces);
							if (match) {
								component.error(attribute, {
									code: `invalid-namespace-property`,
									message: `Invalid namespace '${ns}' (did you mean '${match}'?)`,
								});
							} else {
								component.error(attribute, {
									code: `invalid-namespace-property`,
									message: `Invalid namespace '${ns}'`,
								});
							}
						}

						component_options.namespace = ns;
						break;
					}

					case 'accessors':
					case 'immutable':
					case 'preserveWhitespace': {
						const code = `invalid-${name}-value`;
						const message = `${name} attribute must be true or false`;
						const value = get_value(attribute, code, message);

						if (typeof value !== 'boolean')
							component.error(attribute, { code, message });

						component_options[name] = value;
						break;
					}

					default:
						component.error(attribute, {
							code: `invalid-options-attribute`,
							message: `<svelte:options> unknown attribute`,
						});
				}
			} else {
				component.error(attribute, {
					code: `invalid-options-attribute`,
					message: `<svelte:options> can only have static 'tag', 'namespace', 'accessors', 'immutable' and 'preserveWhitespace' attributes`,
				});
			}
		});
	}

	return component_options;
}

function get_relative_path(from: string, to: string) {
	const from_parts = from.split(/[/\\]/);
	const to_parts = to.split(/[/\\]/);

	from_parts.pop(); // get dirname

	while (from_parts[0] === to_parts[0]) {
		from_parts.shift();
		to_parts.shift();
	}

	if (from_parts.length) {
		let i = from_parts.length;
		while (i--) from_parts[i] = '..';
	}

	return from_parts.concat(to_parts).join('/');
}
