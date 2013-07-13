// http://traceur-compiler.googlecode.com/svn/trunk/presentation/index.html
// https://github.com/jdiamond/harmonizr


"use strict";

//const esprima = require("./esprima_harmony").parse;
const esprima = require(
		process.argv.some(function(arg){ return arg === "--harmony" })
		? "./esprima_harmony" // Local copy of esprima harmony branch // FIXME
		: "esprima"
	).parse;
const assert = require("assert");
const is = require("simple-is");
const fmt = require("simple-fmt");
const stringmap = require("stringmap");
const stringset = require("stringset");
const alter = require("alter");
const traverse = require("./traverse");
const Scope = require("./scope");
const error = require("./error");
const options = require("./options");
const Stats = require("./stats");
const jshint_vars = require("./jshint_globals/vars.js");


function getline(node) {
    return node.loc.start.line;
}

function isConstLet(kind) {
    return is.someof(kind, ["const", "let"]);
}

function isVarConstLet(kind) {
    return is.someof(kind, ["var", "const", "let"]);
}

function isNonFunctionBlock(node) {
    return node.type === "BlockStatement" && is.noneof(node.$parent.type, ["FunctionDeclaration", "FunctionExpression"]);
}

function isForWithConstLet(node) {
    return node.type === "ForStatement" && node.init && node.init.type === "VariableDeclaration" && isConstLet(node.init.kind);
}

function isForInWithConstLet(node) {
    return node.type === "ForInStatement" && node.left.type === "VariableDeclaration" && isConstLet(node.left.kind);
}

function isFunction(node) {
    return is.someof(node.type, ["FunctionDeclaration", "FunctionExpression"]);
}

function isLoop(node) {
    return is.someof(node.type, ["ForStatement", "ForInStatement", "WhileStatement", "DoWhileStatement"]);
}

function isReference(node) {
    const parent = node.$parent;
    return node.$refToScope ||
        node.type === "Identifier" &&
        !(parent.type === "VariableDeclarator" && parent.id === node) && // var|let|const $
        !(parent.type === "MemberExpression" && parent.computed === false && parent.property === node) && // obj.$
        !(parent.type === "Property" && parent.key === node) && // {$: ...}
        !(parent.type === "LabeledStatement" && parent.label === node) && // $: ...
        !(parent.type === "CatchClause" && parent.param === node) && // catch($)
        !(isFunction(parent) && parent.id === node) && // function $(..
        !(isFunction(parent) && is.someof(node, parent.params)) && // function f($)..
        true;
}

function isLvalue(node) {
    return isReference(node) &&
        ((node.$parent.type === "AssignmentExpression" && node.$parent.left === node) ||
            (node.$parent.type === "UpdateExpression" && node.$parent.argument === node));
}

function isObjectPattern(node) {
    return node && node.type == 'ObjectPattern';
}

function isArrayPattern(node) {
    return node && node.type == 'ArrayPattern';
}

function createScopes(node, parent) {
    assert(!node.$scope);

    node.$parent = parent;
    node.$scope = node.$parent ? node.$parent.$scope : null; // may be overridden

    if (node.type === "Program") {
        // Top-level program is a scope
        // There's no block-scope under it
        node.$scope = new Scope({
            kind: "hoist",
            node: node,
            parent: null
        });

    /* Due classBodyReplace is separate process, we do not really need this check
    } else if (node.type === "ClassDeclaration") {
		assert(node.id.type === "Identifier");

		node.$parent.$scope.add(node.id.name, "fun", node.id, null);
	*/
    } else if (isFunction(node)) {
        // Function is a scope, with params in it
        // There's no block-scope under it
        // Function name goes in parent scope
        if (node.id) {
//            if (node.type === "FunctionExpression") {
//                console.dir(node.id);
//            }
//            assert(node.type === "FunctionDeclaration"); // no support for named function expressions yet

            assert(node.id.type === "Identifier");
            node.$parent.$scope.add(node.id.name, "fun", node.id, null);
        }

        node.$scope = new Scope({
            kind: "hoist",
            node: node,
            parent: node.$parent.$scope
        });

        node.params.forEach(function addParamToScope(param) {
			if( isObjectPattern(param) ) {
				param.properties.forEach(addParamToScope);
			}
			else if( param.type === "Property" ) {
				addParamToScope(param.value);
			}
			else if( isArrayPattern(param) ) {
				param.elements.forEach(addParamToScope);
			}
			else {
				node.$scope.add(param.name, "param", param, null);
			}
        });

    } else if (node.type === "VariableDeclaration") {
        // Variable declarations names goes in current scope
        assert(isVarConstLet(node.kind));
        node.declarations.forEach(function(declarator) {
            assert(declarator.type === "VariableDeclarator");
            const name = declarator.id.name;
            if (options.disallowVars && node.kind === "var") {
                error(getline(declarator), "var {0} is not allowed (use let or const)", name);
            }
            node.$scope.add(name, node.kind, declarator.id, declarator.range[1], declarator);
        });

    } else if (isForWithConstLet(node) || isForInWithConstLet(node)) {
        // For(In) loop with const|let declaration is a scope, with declaration in it
        // There may be a block-scope under it
        node.$scope = new Scope({
            kind: "block",
            node: node,
            parent: node.$parent.$scope
        });

    } else if (isNonFunctionBlock(node)) {
        // A block node is a scope unless parent is a function
        node.$scope = new Scope({
            kind: "block",
            node: node,
            parent: node.$parent.$scope
        });

    } else if (node.type === "CatchClause") {
        const identifier = node.param;

        node.$scope = new Scope({
            kind: "catch-block",
            node: node,
            parent: node.$parent.$scope
        });
        node.$scope.add(identifier.name, "caught", identifier, null);

        // All hoist-scope keeps track of which variables that are propagated through,
        // i.e. an reference inside the scope points to a declaration outside the scope.
        // This is used to mark "taint" the name since adding a new variable in the scope,
        // with a propagated name, would change the meaning of the existing references.
        //
        // catch(e) is special because even though e is a variable in its own scope,
        // we want to make sure that catch(e){let e} is never transformed to
        // catch(e){var e} (but rather var e$0). For that reason we taint the use of e
        // in the closest hoist-scope, i.e. where var e$0 belongs.
        node.$scope.closestHoistScope().markPropagates(identifier.name);
    }
}

function createTopScope(programScope, environments, globals) {
    function inject(obj) {
        for (let name in obj) {
            const writeable = obj[name];
            const kind = (writeable ? "var" : "const");
            if (topScope.hasOwn(name)) {
                topScope.remove(name);
            }
            topScope.add(name, kind, {loc: {start: {line: -1}}}, -1);
        }
    }

    const topScope = new Scope({
        kind: "hoist",
        node: {},
        parent: null
    });

    const complementary = {
        undefined: false,
        Infinity: false,
        console: false
    };

    inject(complementary);
    inject(jshint_vars.reservedVars);
    inject(jshint_vars.ecmaIdentifiers);
    if (environments) {
        environments.forEach(function(env) {
            if (!jshint_vars[env]) {
                error(-1, 'environment "{0}" not found', env);
            } else {
                inject(jshint_vars[env]);
            }
        });
    }
    if (globals) {
        inject(globals);
    }

    // link it in
    programScope.parent = topScope;
    topScope.children.push(programScope);

    return topScope;
}

function setupReferences(ast, allIdentifiers) {
    function visit(node) {
        if (!isReference(node)) {
            return;
        }
        allIdentifiers.add(node.name);

        const scope = node.$scope.lookup(node.name);
        if (!scope && options.disallowUnknownReferences) {
            error(getline(node), "reference to unknown global variable {0}", node.name);
        }
        // check const and let for referenced-before-declaration
        if (scope && is.someof(scope.getKind(node.name), ["const", "let"])) {
            const allowedFromPos = scope.getFromPos(node.name);
            const referencedAtPos = node.range[0];
            assert(is.finitenumber(allowedFromPos));
            assert(is.finitenumber(referencedAtPos));
            if (referencedAtPos < allowedFromPos) {
                if (!node.$scope.hasFunctionScopeBetween(scope)) {
                    error(getline(node), "{0} is referenced before its declaration", node.name);
                }
            }
        }
        node.$refToScope = scope;
    }

    traverse(ast, {pre: visit});
}

function PropertyToString(node) {
	assert(node.type === "Literal" || node.type === "Identifier");

	var result;
	if( node.type === "Literal" ) {
		result = "[" + node.raw + "]";
	}
	else {
		result = "." + node.name;
	}

	return result
}

function replaceClasses(ast, src) {
	const changes = [];
	let currentClassName, currentClassMethodsStatic;

	function unwrapSuperCall(node, calleeNode, isStatic, property, isConstructor) {
		let changeStr = "_super" + (isStatic ? "" : ".prototype");
		let callArguments = node.arguments;
		let hasSpreadElement = !isStatic && callArguments.some(function(node){ return node.type === "SpreadElement" });

		let changesEnd;
		if( (!isStatic || isConstructor) && !hasSpreadElement ) {
			changeStr += (property ? "." + property.name : "");

			if( !callArguments.length ) {
				changeStr += ".call(this)";
				changesEnd = node.range[1];
			}
			else {
				changeStr += ".call(this, ";
				changesEnd = callArguments[0].range[0];
			}
		}
		else {
			changesEnd = calleeNode.range[1];
		}

		// text change 'super(<some>)' => '_super(<some>)' (if <some> contains SpreadElement) or '_super.call(this, <some>)'
		changes.push({
			start: calleeNode.range[0],
			end: changesEnd,
			str: changeStr
		});
	}

	function replaceClassConstructorSuper(node) {
		if( node.type === "CallExpression" ) {
			let calleeNode = node.callee;

			if( calleeNode && calleeNode.type === "Identifier" && calleeNode.name === "super" ) {
				unwrapSuperCall(node, calleeNode, true, null, true);
			}
		}
	}

	function replaceClassMethods(node) {
		if( node.type === "MethodDefinition" && node.key.name !== "constructor" ) {
			currentClassMethodsStatic = node.static;
			if( currentClassMethodsStatic === true ) {
				// text change 'method(<something>)' => 'ClassName.method(<something>)'
				changes.push({
					start: node.range[0],
					end: node.key.range[0],
					str: currentClassName + "."
				});
			}
			else {
				// text change 'method(<something>)' => 'ClassName.prototype.method(<something>)'
				changes.push({
					start: node.range[0],
					end: node.key.range[0],
					str: currentClassName + ".prototype."
				});
			}

			// text change 'method(<something>)' => 'method = function(<something>)'
			changes.push({
				start: node.key.range[1],
				end: node.key.range[1],
				str: " = function"
			});

			traverse(node.value, {pre: replaceClassMethodSuper})
		}
		currentClassMethodsStatic = null;
	}
	function replaceClassMethodSuper(node) {
		if( node.type === "CallExpression" ) {
			assert(typeof currentClassMethodsStatic === "boolean");

			let calleeNode = node.callee;

			if( calleeNode && calleeNode.type === "MemberExpression" ) {
				let objectNode = calleeNode.object;
				if( objectNode && objectNode.type === "Identifier" && objectNode.name === "super" ) {
					// text change 'super.method(<some>)' => '_super(<some>)' (if <some> contains SpreadElement) or '_super.call(this, <some>)'
					unwrapSuperCall(node, objectNode, currentClassMethodsStatic, calleeNode.property);
				}
			}
		}
	}

	function replaceClassBody(node) {
		if( node.type === "ClassDeclaration" ) {
			let nodeId = node.id
				, superClass = node.superClass
				, classStr
				, classBodyNodes = node.body.body
				, classConstructor
				, indent = classBodyNodes[0] ? src.substring(node.body.range[0] + 1, classBodyNodes[0].range[0]) : "\t"
				, classBodyNodesCount = classBodyNodes.length
				, extendedClassConstructorPostfix
			;

			assert(nodeId && nodeId.type === "Identifier");

			currentClassName = nodeId.name;
			classStr = "var " + currentClassName + " = (function(";

			if( superClass ) {
				classStr += "_super";
				superClass = src.substring(superClass.range[0], superClass.range[1]);
				extendedClassConstructorPostfix = indent +
					"Object.assign(" + currentClassName + ", _super);" +
						currentClassName + ".prototype = Object.create(_super.prototype);" +
						currentClassName + ".prototype.constructor = " + currentClassName + ";"
				;
			}

			classStr += ")";

			// replace class definition
			// text change 'class A[ extends B]' => ''
			changes.push({
				start: node.range[0],
				end: node.body.range[0],
				str: classStr
			});

			classStr = "";


			for( let i = 0 ; i < classBodyNodesCount && !classConstructor ; i++ ) {
				classConstructor = classBodyNodes[i];
				if( classConstructor.type !== "MethodDefinition" ) {
					classConstructor = null;
				}
				else if( classConstructor.key.name !== "constructor" ) {
					classConstructor = null;
				}
			}

			if( classConstructor ) {
				classBodyNodesCount--;

				changes.push({
					start: classConstructor.key.range[0],
					end: classConstructor.key.range[1],
					str: "function " + currentClassName
				});
				if( extendedClassConstructorPostfix ) {
					changes.push({
						start: classConstructor.range[1],
						end: classConstructor.range[1],
						str: extendedClassConstructorPostfix
					});
				}
				traverse(classConstructor, {pre: replaceClassConstructorSuper});
			}
			else {
				changes.push({
					start: node.body.range[0] + 1,
					end: (classBodyNodesCount ? node.body.body[0].range[0] : node.body.range[1]) - 1,
					str: indent + "function " + currentClassName + "() {" + (superClass ? "_super.apply(this, arguments)" : "") + "}" + (extendedClassConstructorPostfix || "") + "\n"
				});
			}


			if( classBodyNodesCount ) {
				traverse(node.body, {pre: replaceClassMethods})
			}


			changes.push({
				start: node.range[1] - 1,
				end: node.range[1] - 1,
				str: indent + "return " + currentClassName + ";\n"
			});

			changes.push({
				start: node.range[1],
				end: node.range[1],
				str: ")(" + (superClass || "") + ");"
			});

			currentClassName = null;
			return false;
		}
		currentClassName = null;
	}

	traverse(ast, {pre: replaceClassBody});

	//console.log(changes)

	return changes;
}

// TODO for loops init and body props are parallel to each other but init scope is outer that of body
// TODO is this a problem?

function varify(ast, stats, allIdentifiers, src) {
    const changes = [];

    function unique(name, newVariable, additionalFilter) {
		assert(newVariable || allIdentifiers.has(name));

        for( let cnt = 0 ; ; cnt++ ) {
            const genName = name + "$" + cnt;
            if( !allIdentifiers.has(genName) && (!additionalFilter || !additionalFilter.has(genName))) {
                return genName;
            }
        }
    }
    
    function functionDestructuringAndDefaultsAndRest(node) {
        if ( isFunction(node) ) {
            const defaults = node.defaults;
            const params = node.params;
			let paramsCount = params.length;
			const initialParamsCount = paramsCount;
            const fnBodyRange = node.body.body.length ?
				node.body.body[0].range
				:
				[//empty function body. example: function r(){}
					node.body.range[0] + 1
					, node.body.range[1] - 1
				]
			;
            const indentStr = "" + src.substring(node.body.range[0] + 1, fnBodyRange[0]);
			const defaultsCount = defaults.length;
			const lastParam = params[paramsCount - 1];
			const lastDflt = defaults[defaults.length - 1];
			let hoistScope;

			paramsCount -= defaultsCount;

			if( paramsCount ) {
				for(let i = 0 ; i < paramsCount ; i++) {
					const param = params[i];
					const prevParam = params[i - 1];

					if( isObjectPattern(param) || isArrayPattern(param) ) {
						let paramStr, newVariables = [], newDefinitions = [], postFix = "";
						paramStr = "";//"\n" + indentStr;
						unwrapDestructuring(param
							, {type: "Identifier", name: "arguments[" + i + "]"}
							, newVariables, newDefinitions);

						hoistScope = node.$scope.closestHoistScope();
						newVariables.forEach(function(newVariable, index){
							hoistScope.add(newVariable.name, newVariable.kind, param);
							allIdentifiers.add(newVariable.name);

							paramStr += (
								(index === 0 ? "var " : "")//always VAR !!! not a newVariable.type
									+ newVariable.name
									+ " = "
									+ newVariable.value
								);

							if( newVariable.needsToCleanUp ) {
								postFix += (newVariable.name + " = null;");
							}
						});
						paramStr += (";" + indentStr);

						newDefinitions.forEach(function(definition, index) {
							var definitionId = definition.id;
							assert(definitionId.type === "Identifier");

							paramStr += (
								(index === 0 ? "var " : ", ")//always VAR !!!
									+ definitionId.name
									+ " = "
									+ definition["init"]["object"].name
									+ PropertyToString(definition["init"]["property"])
								)
						});
						paramStr += (";" + indentStr + postFix + indentStr);

						param.$replaced = true;

						// add default set
						changes.push({
							start: fnBodyRange[0],
							end: fnBodyRange[0],
							str: paramStr,
							type: 2// ??
						});

						// cleanup default definition
						// text change 'param = value' => ''
						changes.push({
							start: (prevParam ? prevParam.range[1] + 1 : param.range[0]) - (prevParam ? 1 : 0),
							end: param.range[1],
							str: ""
						});
					}
				}
			}

            if( defaultsCount ) {
                for(let i = 0 ; i < defaultsCount ; i++) {
                    const paramIndex = initialParamsCount - defaultsCount + i;
                    const param = params[paramIndex];
                    const prevDflt = defaults[i - 1];
                    const prevParam = params[paramIndex - 1];
                    const dflt = defaults[i];

                    if (dflt.type === "Identifier" && dflt.name === param.name) {
                        error(getline(node), "function parameter '{0}' defined with default value refered to scope variable with the same name '{0}'", param.name);
                    }

                    let defaultStr;
					if( isObjectPattern(param) || isArrayPattern(param) ) {
						//dflt.$type = dflt.type;
						//dflt.type = "";//TODO:: check it

						let newVariables = [], newDefinitions = [], postFix = "";
						defaultStr = "";
						unwrapDestructuring(param
							, {type: "Identifier", name: "arguments[" + paramIndex + "] !== void 0 ? arguments[" + paramIndex + "] : " + src.substring(dflt.range[0], dflt.range[1])}
							, newVariables, newDefinitions);

						hoistScope = node.$scope.closestHoistScope();
						newVariables.forEach(function(newVariable, index){
							hoistScope.add(newVariable.name, newVariable.kind, dflt);
							allIdentifiers.add(newVariable.name);

							defaultStr += (
								(index === 0 ? "var " : ", ")//always VAR !!! not a newVariable.type
									+ newVariable.name
									+ " = "
									+ newVariable.value
							);

							if( newVariable.needsToCleanUp ) {
								postFix += (newVariable.name + " = null;");
							}
						});
						defaultStr += (";" + indentStr);

						newDefinitions.forEach(function(definition, index) {
							var definitionId = definition.id;
							//if(definitionId.type !== "Identifier")console.log(definitionId.properties)
							assert(definitionId.type === "Identifier");

							defaultStr += (
								(index === 0 ? "var " : ", ")//always VAR !!!
									+ definitionId.name
									+ " = "
									+ definition["init"]["object"].name
									+ PropertyToString(definition["init"]["property"])
							)
						});
						defaultStr += (";" + indentStr + postFix + indentStr);
					}
                    else {
						defaultStr = "var " + param.name + " = arguments[" + paramIndex + "];if(" + param.name + " === void 0)" + param.name + " = " + src.substring(dflt.range[0], dflt.range[1]) + ";" + indentStr;
					}

					param.$replaced = true;

                    // add default set
                    changes.push({
                        start: fnBodyRange[0],
                        end: fnBodyRange[0],
                        str: defaultStr,
                        type: 2// ??
                    });

                    // cleanup default definition
                    // text change 'param = value' => ''
                    changes.push({
                        start: ((prevDflt || prevParam) ? ((prevDflt || prevParam).range[1] + 1) : param.range[0]) - (prevParam ? 1 : 0),
                        end: dflt.range[1],
                        str: ""
                    });
                }
            }

            const rest = node.rest;
            if( rest ) {
                const restStr = "var " + rest.name + " = [].slice.call(arguments, " + initialParamsCount + ");" + indentStr;
				if( !hoistScope ) {
					hoistScope = node.$scope.closestHoistScope();
				}

                hoistScope.add(rest.name, "var", rest, -1);

                // add rest
                changes.push({
                    start: fnBodyRange[0],
                    end: fnBodyRange[0],
                    str: restStr
                });

                // cleanup rest definition
                changes.push({
                    start: ((lastDflt || lastParam) ? ((lastDflt || lastParam).range[1] + 1) : rest.range[0]) - (lastParam ? 1 : 3),
                    end: rest.range[1],
                    str: ""
                });
            }
        }
    }

	function replaceDestructuringVariableDeclaration(node) {
		if( node.type === "VariableDeclaration" && isVarConstLet(node.kind) ) {
			let declarations = node.declarations;

			let afterVariableDeclaration = "";

			declarations.forEach(function renameDeclaration(declarator, declaratorIndex) {
				var declaratorId = declarator.id;

				if( isObjectPattern(declaratorId) || isArrayPattern(declaratorId) ) {
					let declaratorInit = declarator.init;
					assert(typeof declaratorInit === "object");

					let newVariables = [], newDefinitions = [], declarationString = "";

					unwrapDestructuring(declaratorId, declaratorInit, newVariables, newDefinitions);

					let hoistScope = node.$scope.closestHoistScope();
					newVariables.forEach(function(newVariable, index){
						hoistScope.add(newVariable.name, newVariable.kind, declaratorInit);
						allIdentifiers.add(newVariable.name);

						declarationString += (
							(declaratorIndex === 0 && index === 0 ? "" : ", ")
								+ newVariable.name
								+ " = "
								+ newVariable.value
							);

						if( newVariable.needsToCleanUp ) {
							afterVariableDeclaration += (newVariable.name + " = null;");
						}
					});

					newDefinitions.forEach(function(definition, index) {
						assert(definition.type === "VariableDeclarator");
						var definitionId = definition.id;

						declarationString += (
							(declaratorIndex === 0 && index === 0 && newVariables.length === 0 ? "" : ", ")
								+ definitionId.name
								+ " = "
								+ definition["init"]["object"].name
								+ PropertyToString(definition["init"]["property"])
							)
					});

					// replace destructuring with simple variable declaration
					changes.push({
						start: declarator.range[0],
						end: declarator.range[1],
						str: declarationString
					});
				}
			});

			if( afterVariableDeclaration ) {
				// add temporary variables cleanup
				changes.push({
					start: node.range[1],
					end: node.range[1],
					str: afterVariableDeclaration
				});
			}
		}
	}

    function renameDeclarations(node) {
        if( node.type === "VariableDeclaration" && isConstLet(node.kind) ) {
            const hoistScope = node.$scope.closestHoistScope();
            const origScope = node.$scope;

            // text change const|let => var
            changes.push({
                start: node.range[0],
                end: node.range[0] + node.kind.length,
                str: "var"
            });

            let declarations = node.declarations;

            declarations.forEach(function renameDeclaration(declarator) {
				var declaratorId =
					isObjectPattern(declarator) || isArrayPattern(declarator) ? declarator :
					declarator.type === "Property" ? declarator.value :
					declarator.id
				;

				//console.log(declarator.type, declarator.$parent.$type)
                assert(
					declarator.type === "VariableDeclarator" || declarator.$type === "VariableDeclarator"
					/*|| (
						( isObjectPattern(declarator.id) || isArrayPattern(declarator.id) )
						&& ( declarator.$parent.type === "VariableDeclarator" || declarator.$parent.$type === "VariableDeclarator" )
					)*/
				);

				if( isObjectPattern(declaratorId) ) {
					for (let properties = declaratorId.properties, k = 0, l = properties.length ; k < l ; k++) {
						const property = properties[k];
						if (property) {
							//property.id = property;//TODO:: check if it really necessary
							property.$type = "VariableDeclarator";
							property.$parentType = "ObjectPattern";
							renameDeclaration(property);
						}
					}
					return;
				}
				else if (isArrayPattern(declaratorId)) {
					for (let elements = declaratorId.elements, k = 0, l = elements.length ; k < l ; k++) {
						const element = elements[k];
						if (element) {
							//element.id = element;//TODO:: check if it really necessary
							element.$type = "VariableDeclarator";
							element.$parentType = "ArrayPattern";
							renameDeclaration(element);
						}
					}
					return;
				}

                let name, prefix = "", needSrcChanges = true;

                if (declarator.$parentType === "ObjectPattern") {
					declaratorId = declarator;
					name = declarator.value.name;
                    prefix = declarator.key.name + " :";

					needSrcChanges = false;//src text-replace in replaceDestructuringVariableDeclaration function
                }
				else if (declarator.$parentType === "ArrayPattern") {
					declaratorId = declarator;
					name = declarator.name;

					needSrcChanges = false;//src text-replace in replaceDestructuringVariableDeclaration function
				}
                else {
					declaratorId = declarator.id;
                    name = declaratorId.name;
                }

                stats.declarator(node.kind);//FIXME:: comment

                // rename if
                // 1) name already exists in hoistScope, or
                // 2) name is already propagated (passed) through hoistScope or manually tainted
                const rename = (origScope !== hoistScope &&
                    (hoistScope.hasOwn(name) || hoistScope.doesPropagate(name)));

                const newName = (rename ? unique(name) : name);

                origScope.remove(name);
                hoistScope.add(newName, "var", declaratorId, declarator.range[1]);

                origScope.moves = origScope.moves || stringmap();
                origScope.moves.set(name, {
                    name: newName,
                    scope: hoistScope
                });

                allIdentifiers.add(newName);

                if (newName !== name) {
                    stats.rename(name, newName, getline(declarator));

					declaratorId.originalName = name;//TODO:: in other parts of this file replace it to ObjectPattern/ArrayPattern check

					if (declarator.$parentType === "ObjectPattern") {
						declarator.value.name = newName;
						declarator.originalName = name;
					}
					else if (declarator.$parentType === "ArrayPattern") {
						declarator.name = newName;
					}
					else {
						declaratorId.name = newName;
					}

					if( needSrcChanges ) {
						// textchange var x => var x$1
						changes.push({
							start: declaratorId.range[0],
							end: declaratorId.range[1],
							str: prefix + newName
						});
					}
                }

				//node.kind = "var";
            });
        }
    }

    function renameReferences(node) {
        if (!node.$refToScope) {
            return;
        }
        const move = node.$refToScope.moves && node.$refToScope.moves.get(node.name);
        if (!move) {
            return;
        }
        node.$refToScope = move.scope;

        if (node.name !== move.name
            && (//not a destructuring
                node.$parentType !== "ObjectPattern"
                && node.$parentType !== "ArrayPattern"
            )
        ) {
            node.originalName = node.name;
            node.name = move.name;

            changes.push({
                start: node.range[0],
                end: node.range[1],
                str: move.name
            });
        }
    }

    function replaceLoopClosuresPre(node) {
        if (outermostLoop === null && isLoop(node)) {
            outermostLoop = node;
        }
        if (!outermostLoop) {
            // not inside loop
            return;
        }

        // collect function-chain (as long as we're inside a loop)
        if (isFunction(node)) {
            functions.push(node);
        }
        if (functions.length === 0) {
            // not inside function
            return;
        }

        if (isReference(node) && isConstLet(node.$refToScope.getKind(node.name))) {
            let n = node.$refToScope.node;

            // node is an identifier
            // scope refers to the scope where the variable is defined
            // loop ..-> function ..-> node

            let ok = true;
            while (n) {
//            n.print();
//            console.log("--");
                if (n === functions[functions.length - 1]) {
                    // we're ok (function-local)
                    break;
                }
                if (n === outermostLoop) {
                    // not ok (between loop and function)
                    ok = false;
                    break;
                }
//            console.log("# " + scope.node.type);
                n = n.$parent;
//            console.log("# " + scope.node);
            }
            if (ok) {
//            console.log("ok loop + closure: " + node.name);
            } else {

                changes.push({
                    start: outermostLoop.body.range[0],
                    end: outermostLoop.body.range[0],
                    str: "(function(" + node.name + "){"
                });

                changes.push({
                    start: outermostLoop.body.range[1],
                    end: outermostLoop.body.range[1],
                    str: "})(" + node.name + ")"
                });
            }


            /*
             walk the scopes, starting from innermostFunction, ending at outermostLoop
             if the referenced scope is somewhere in-between, then we have an issue
             if the referenced scope is inside innermostFunction, then no problem (function-local const|let)
             if the referenced scope is outside outermostLoop, then no problem (const|let external to the loop)

             */
        }
    }

	function unwrapDestructuring(definitionNode, valueNode, newVariables, newDefinitions, temporaryVariables) {
		assert(typeof valueNode === "object");
		assert(isObjectPattern(definitionNode) || isArrayPattern(definitionNode));
		assert(Array.isArray(newVariables));
		assert(Array.isArray(newDefinitions));

		if(!temporaryVariables)temporaryVariables = stringset();

		let needsNewVariable = false, valueIdentifierName, valueIdentifierDefinition;
		if( valueNode.type === "Identifier" ) {
			valueIdentifierName = valueNode.name;

			if( valueIdentifierName.indexOf("[") !== -1 || valueIdentifierName.indexOf(".") !== -1 ) {
				needsNewVariable = true;
				valueIdentifierDefinition = valueIdentifierName;
			}
		}
		else {
			needsNewVariable = true;
			valueIdentifierDefinition = src.substring(valueNode.range[0], valueNode.range[1]);
		}

		if( needsNewVariable ) {
			valueIdentifierName = unique("$D", true, temporaryVariables);

			temporaryVariables.add(valueIdentifierName);

			newVariables.push({
				name: valueIdentifierName
				, kind: "var"
				, value: valueIdentifierDefinition
				, needsToCleanUp: true
			});
		}

		if( isObjectPattern(definitionNode) ) {
			for (let properties = definitionNode.properties, k = 0, l = properties.length ; k < l ; k++) {
				const property = properties[k];
				if (property) {
					//console.log("    property:: key = ", property.key.name, " / value = ", property.value.name, " | type =  ", definitionNode.$parent.type);

					if( isObjectPattern(property.value) || isArrayPattern(property.value) ) {
						unwrapDestructuring(property.value, {type: "Identifier", name: valueIdentifierName + PropertyToString(property.key)}, newVariables, newDefinitions, temporaryVariables);
					}
					else {
						newDefinitions.push({
							"type": "VariableDeclarator",
							"id": property.value,
							"init": {
								"type": "MemberExpression",
								"computed": false,
								"object": {
									"type": "Identifier",
									"name": valueIdentifierName
								},
								"property": property.key
							}
						});
					}
				}
			}
		}
		else {
			for (let elements = definitionNode.elements, k = 0, l = elements.length ; k < l ; k++) {
				const element = elements[k];
				if (element) {
					//console.log("    element = ", element.name, " | type =  ", definitionNode.$parent.type);

					if( isObjectPattern(element) || isArrayPattern(element) ) {
						unwrapDestructuring(element, {type: "Identifier", name: valueIdentifierName + "[" + k + "]"}, newVariables, newDefinitions, temporaryVariables);
					}
					else {
						newDefinitions.push({
							"type": "VariableDeclarator",
							"id": element,
							"init": {
								"type": "MemberExpression",
								"computed": true,
								"object": {
									"type": "Identifier",
									"name": valueIdentifierName
								},
								"property": {
									"type": "Literal",
									"value": k,
									"raw": k + ""
								}
							}
						});
					}
				}
			}
		}
	}

    //traverse(ast, {pre: replaceLoopClosuresPre});//TODO::
    traverse(ast, {pre: renameDeclarations});
    traverse(ast, {pre: renameReferences});
    traverse(ast, {pre: functionDestructuringAndDefaultsAndRest});
	traverse(ast, {pre: replaceDestructuringVariableDeclaration});

	/*traverse(ast, {pre: function (node) {
		if( isObjectPattern(node) ) {
			console.log("   ObjectPattern:");

			for (let properties = node.properties, k = 0, l = properties.length ; k < l ; k++) {
				const property = properties[k];
				if (property) {
					console.log("    property:: key = ", property.key.name, " / value = ", property.value.name, " | type =  ", node.$parent.type);
				}
			}
		}
		else if( isArrayPattern(node) ) {
			console.log("   ArrayPattern:");

			for (let elements = node.elements, k = 0, l = elements.length ; k < l ; k++) {
				const element = elements[k];
				if (element) {
					console.log("    element = ", element.name, " | type =  ", node.$parent.type);
				}
			}
		}
	}});*/

    ast.$scope.traverse({pre: function(scope) {
        delete scope.moves;
    }});

    return changes;
}


let outermostLoop = null;
let functions = [];
function detectLoopClosuresPre(node) {
    if (outermostLoop === null && isLoop(node)) {
        outermostLoop = node;
    }
    if (!outermostLoop) {
        // not inside loop
        return;
    }

    // collect function-chain (as long as we're inside a loop)
    if (isFunction(node)) {
        functions.push(node);
    }
    if (functions.length === 0) {
        // not inside function
        return;
    }

    if (isReference(node) && isConstLet(node.$refToScope.getKind(node.name))) {
        let n = node.$refToScope.node;

        // node is an identifier
        // scope refers to the scope where the variable is defined
        // loop ..-> function ..-> node

        let ok = true;
        while (n) {
//            n.print();
//            console.log("--");
            if (n === functions[functions.length - 1]) {
                // we're ok (function-local)
                break;
            }
            if (n === outermostLoop) {
                // not ok (between loop and function)
                ok = false;
                break;
            }
//            console.log("# " + scope.node.type);
            n = n.$parent;
//            console.log("# " + scope.node);
        }
        if (ok) {
//            console.log("ok loop + closure: " + node.name);
        } else {
            error(getline(node), "can't transform closure. {0} is defined outside closure, inside loop", node.name);
        }


        /*
        walk the scopes, starting from innermostFunction, ending at outermostLoop
        if the referenced scope is somewhere in-between, then we have an issue
        if the referenced scope is inside innermostFunction, then no problem (function-local const|let)
        if the referenced scope is outside outermostLoop, then no problem (const|let external to the loop)

         */
    }
}

function detectLoopClosuresPost(node) {
    if (outermostLoop === node) {
        outermostLoop = null;
    }
    if (isFunction(node)) {
        functions.pop();
    }
}

function detectConstAssignment(node) {
    if (isLvalue(node)) {
        const scope = node.$scope.lookup(node.name);
        if (scope && scope.getKind(node.name) === "const") {
            error(getline(node), "can't assign to const variable {0}", node.name);
        }
    }
}

function detectConstantLets(ast) {
    traverse(ast, {pre: function(node) {
        if (isLvalue(node)) {
            const scope = node.$scope.lookup(node.name);
            if (scope) {
                scope.markWrite(node.name);
            }
        }
    }});

    ast.$scope.detectUnmodifiedLets();
}

function run(src, config) {
    // alter the options singleton with user configuration
    for (let key in config) {
        options[key] = config[key];
    }

	let ast;
	let changes;


	// First Step: Classes
	ast = esprima(src, {
		loc: true,
		range: true
	});

	error.reset();

	changes = replaceClasses(ast, src);

	if (error.any) {
		error.show();
		return {
			exitcode: -1
		};
	}
	if (options.ast) {
		throw new Error("Currently unsupported");
	}
	else if( changes.length ) {
		src = alter(src, changes);
	}
	/*console.log(src)
	return{
		exitcode: -1
	};*/

	// Second Step: others
	if( changes.length ) {// has changes in classes replacement Step
		ast = esprima(src, {
			loc: true,
			range: true
		});
	}

    // TODO detect unused variables (never read)
    error.reset();

    // setup scopes
    traverse(ast, {pre: createScopes});
    const topScope = createTopScope(ast.$scope, options.environments, options.globals);

    // allIdentifiers contains all declared and referenced vars
    // collect all declaration names (including those in topScope)
    const allIdentifiers = stringset();
    topScope.traverse({pre: function(scope) {
        allIdentifiers.addMany(scope.decls.keys());
    }});

    // setup node.$refToScope, check for errors.
    // also collects all referenced names to allIdentifiers
    setupReferences(ast, allIdentifiers);

    // static analysis passes
    traverse(ast, {pre: detectLoopClosuresPre, post: detectLoopClosuresPost});
    traverse(ast, {pre: detectConstAssignment});
    //detectConstantLets(ast);

    //ast.$scope.print(); process.exit(-1);

    if (error.errors.length >= 1) {
        return {
            exitcode: -1,
            errors: error.errors
        };
    }

    // change constlet declarations to var, renamed if needed
    // varify modifies the scopes and AST accordingly and
    // returns a list of change fragments (to use with alter)
    const stats = new Stats();
    changes = varify(ast, stats, allIdentifiers, src);

    if (error.any) {
        error.show();
        return {
            exitcode: -1
        };
    }

    if (options.ast) {
        // return the modified AST instead of src code
        // get rid of all added $ properties first, such as $parent and $scope
        traverse(ast, {cleanup: true});
        return {
            stats: stats,
            ast: ast
        };
    } else {
        // apply changes produced by varify and return the transformed src
		/* TEST:
		changes.push({
		 start: 125,
		 end: 130,
		 str: "opt1$0__ololo"
		})*/
		//console.log(changes);var transformedSrc = "";try{ transformedSrc = alter(src, changes) } catch(e){ console.error(e+"") };

        const transformedSrc = alter(src, changes);
        return {
            stats: stats,
            src: transformedSrc
        };
    }
}

module.exports = run;
