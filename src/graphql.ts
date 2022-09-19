import { ListTypeNode, NonNullTypeNode, NamedTypeNode, TypeNode, ObjectTypeDefinitionNode } from 'graphql';

export const isListType = (typ?: TypeNode): typ is ListTypeNode => typ?.kind === 'ListType';
export const isNonNullType = (typ?: TypeNode): typ is NonNullTypeNode => typ?.kind === 'NonNullType';
export const isNamedType = (typ?: TypeNode): typ is NamedTypeNode => typ?.kind === 'NamedType';

export const isInput = (kind: string) => kind.includes('Input');

type ObjectTypeDefinitionFn = (node: ObjectTypeDefinitionNode) => any;

export const ObjectTypeDefinitionBuilder = (
  useObjectTypes: boolean | undefined,
  callback: ObjectTypeDefinitionFn
): ObjectTypeDefinitionFn | undefined => {
  if (!useObjectTypes) return undefined;
  return node => {
    if (/^(Query|Mutation|Subscription)$/.test(node.name.value)) {
      return;
    }
    return callback(node);
  };
};
