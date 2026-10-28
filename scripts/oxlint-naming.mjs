/**
 * The naming conventions of this package, which oxlint has no built-in rule
 * for: an interface is named I plus PascalCase (IAbsintheTransport), a type
 * parameter T plus PascalCase (TSocket).
 */

/**
 * @typedef {{ type: string; parent?: INode | null }} INode
 * @typedef {{ name: string }} IIdentifier
 * @typedef {INode & { id: IIdentifier }} IInterfaceNode
 * @typedef {{ name: IIdentifier }} ITypeParameterNode
 * @typedef {{ report: (descriptor: { node: object; message: string }) => void }} IRuleContext
 */

const interfaceName = /^I[A-Z][A-Za-z0-9]*$/u;
const typeParameterName = /^T[A-Z][A-Za-z0-9]*$/u;

/**
 * True inside `declare module`, where an interface augments a library's own
 * interface and has to keep its name (vitest's ProvidedContext).
 * @param {INode} node any node
 * @returns {boolean} whether a module declaration encloses the node
 */
function isAugmentation(node) {
  for (let current = node.parent; current; current = current.parent)
    if (current.type === "TSModuleDeclaration") return true;
  return false;
}

const namingConvention = {
  meta: {
    type: "suggestion",
    docs: { description: "Interfaces start with I, type parameters with T." },
    schema: [],
  },
  /** @param {IRuleContext} context the context the rule reports through */
  create(context) {
    return {
      /** @param {IInterfaceNode} node an interface declaration */
      TSInterfaceDeclaration(node) {
        if (!interfaceName.test(node.id.name) && !isAugmentation(node))
          context.report({
            node,
            message: `An interface name is I plus PascalCase, such as IAbsintheTransport. Found ${node.id.name}.`,
          });
      },
      /** @param {ITypeParameterNode} node a type parameter */
      TSTypeParameter(node) {
        if (!typeParameterName.test(node.name.name))
          context.report({
            node,
            message: `A type parameter name is T plus PascalCase, such as TSocket. Found ${node.name.name}.`,
          });
      },
    };
  },
};

const plugin = {
  meta: { name: "apollo-link-absinthe" },
  rules: { "naming-convention": namingConvention },
};

export default plugin;
