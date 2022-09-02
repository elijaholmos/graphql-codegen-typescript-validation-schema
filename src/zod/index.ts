import { isInput, isNonNullType, isListType, isNamedType, ObjectTypeDefinitionBuilder } from './../graphql';
import { ValidationSchemaPluginConfig } from '../config';
import {
  InputValueDefinitionNode,
  NameNode,
  TypeNode,
  GraphQLSchema,
  InputObjectTypeDefinitionNode,
  ObjectTypeDefinitionNode,
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
} from 'graphql';
import { DeclarationBlock, indent } from '@graphql-codegen/visitor-plugin-common';
import { TsVisitor } from '@graphql-codegen/typescript';
import { buildApi, formatDirectiveConfig } from '../directive';

const importZod = `import { z } from 'zod'`;
const anySchema = `definedNonNullAnySchema`;

export const ZodSchemaVisitor = (schema: GraphQLSchema, config: ValidationSchemaPluginConfig) => {
  const tsVisitor = new TsVisitor(schema, config);

  const importTypes: string[] = [];

  return {
    buildImports: (): string[] => {
      if (config.importFrom && importTypes.length > 0) {
        return [importZod, `import { ${importTypes.join(', ')} } from '${config.importFrom}'`];
      }
      return [importZod];
    },
    initialEmit: (): string =>
      '\n' +
      [
        new DeclarationBlock({})
          .asKind('type')
          .withName('Properties<T>')
          .withContent(['Required<{', '  [K in keyof T]: z.ZodType<T[K], any, T[K]>;', '}>'].join('\n')).string,
        // Unfortunately, zod doesn’t provide non-null defined any schema.
        // This is a temporary hack until it is fixed.
        // see: https://github.com/colinhacks/zod/issues/884
        new DeclarationBlock({}).asKind('type').withName('definedNonNullAny').withContent('{}').string,
        new DeclarationBlock({})
          .export()
          .asKind('const')
          .withName(`isDefinedNonNullAny`)
          .withContent(`(v: any): v is definedNonNullAny => v !== undefined && v !== null`).string,
        new DeclarationBlock({})
          .export()
          .asKind('const')
          .withName(`${anySchema}`)
          .withContent(`z.any().refine((v) => isDefinedNonNullAny(v))`).string,
      ].join('\n'),
    EnumTypeDefinition: (node: EnumTypeDefinitionNode) => {
      const enumname = tsVisitor.convertName(node.name.value);
      importTypes.push(enumname);

      if (config.enumsAsTypes) {
        return new DeclarationBlock({})
          .export()
          .asKind('const')
          .withName(`${enumname}Schema`)
          .withContent(`z.enum([${node.values?.map(enumOption => `'${enumOption.name.value}'`).join(', ')}])`).string;
      }

      return new DeclarationBlock({})
        .export()
        .asKind('const')
        .withName(`${enumname}Schema`)
        .withContent(`z.nativeEnum(${enumname})`).string;
    },
    InputObjectTypeDefinition: (node: InputObjectTypeDefinitionNode) => {
      const name = tsVisitor.convertName(node.name.value);
      importTypes.push(name);

      const shape = node.fields?.map(field => generateFieldZodSchema(config, tsVisitor, schema, field, 2)).join(',\n');

      switch (config.validationSchemaExportType) {
        case 'const':
          return new DeclarationBlock({})
            .export()
            .asKind('const')
            .withName(`${name}Schema: z.ZodObject<Properties<${name}>>`)
            .withContent(['z.object({', shape, '})'].join('\n')).string;

        case 'function':
        default:
          return new DeclarationBlock({})
            .export()
            .asKind('function')
            .withName(`${name}Schema(): z.ZodObject<Properties<${name}>>`)
            .withBlock([indent(`return z.object({`), shape, indent('})')].join('\n')).string;
      }
    },
    ObjectTypeDefinition: ObjectTypeDefinitionBuilder(config.withObjectType, (node: ObjectTypeDefinitionNode) => {
      const name = tsVisitor.convertName(node.name.value);
      importTypes.push(name);

      const shape = node.fields?.map(field => generateFieldZodSchema(config, tsVisitor, schema, field, 2)).join(',\n');

      switch (config.validationSchemaExportType) {
        case 'const':
          return new DeclarationBlock({})
            .export()
            .asKind('const')
            .withName(`${name}Schema: z.ZodObject<Properties<${name}>>`)
            .withContent(
              [`z.object({`, indent(`__typename: z.literal('${node.name.value}').optional(),`, 2), shape, '})'].join(
                '\n'
              )
            ).string;

        case 'function':
        default:
          return new DeclarationBlock({})
            .export()
            .asKind('function')
            .withName(`${name}Schema(): z.ZodObject<Properties<${name}>>`)
            .withBlock(
              [
                indent(`return z.object({`),
                indent(`__typename: z.literal('${node.name.value}').optional(),`, 2),
                shape,
                indent('})'),
              ].join('\n')
            ).string;
      }
    }),
  };
};

const generateFieldZodSchema = (
  config: ValidationSchemaPluginConfig,
  tsVisitor: TsVisitor,
  schema: GraphQLSchema,
  field: InputValueDefinitionNode | FieldDefinitionNode,
  indentCount: number
): string => {
  const gen = generateFieldTypeZodSchema(config, tsVisitor, schema, field, field.type);
  return indent(`${field.name.value}: ${maybeLazy(field.type, gen)}`, indentCount);
};

const generateFieldTypeZodSchema = (
  config: ValidationSchemaPluginConfig,
  tsVisitor: TsVisitor,
  schema: GraphQLSchema,
  field: InputValueDefinitionNode | FieldDefinitionNode,
  type: TypeNode,
  parentType?: TypeNode
): string => {
  if (isListType(type)) {
    const gen = generateFieldTypeZodSchema(config, tsVisitor, schema, field, type.type, type);
    if (!isNonNullType(parentType)) {
      const arrayGen = `z.array(${maybeLazy(type.type, gen)})`;
      const maybeLazyGen = applyDirectives(config, field, arrayGen);
      return `${maybeLazyGen}.nullish()`;
    }
    return `z.array(${maybeLazy(type.type, gen)})`;
  }
  if (isNonNullType(type)) {
    const gen = generateFieldTypeZodSchema(config, tsVisitor, schema, field, type.type, type);
    return maybeLazy(type.type, gen);
  }
  if (isNamedType(type)) {
    const gen = generateNameNodeZodSchema(config, tsVisitor, schema, type.name);
    if (isListType(parentType)) {
      return `${gen}.nullable()`;
    }
    const appliedDirectivesGen = applyDirectives(config, field, gen);
    if (isNonNullType(parentType)) {
      if (config.notAllowEmptyString === true) {
        const tsType = tsVisitor.scalars[type.name.value];
        if (tsType === 'string') return `${appliedDirectivesGen}.min(1)`;
      }
      return appliedDirectivesGen;
    }
    if (isListType(parentType)) {
      return `${appliedDirectivesGen}.nullable()`;
    }
    return `${appliedDirectivesGen}.nullish()`;
  }
  console.warn('unhandled type:', type);
  return '';
};

const applyDirectives = (
  config: ValidationSchemaPluginConfig,
  field: InputValueDefinitionNode | FieldDefinitionNode,
  gen: string
): string => {
  if (config.directives && field.directives) {
    const formatted = formatDirectiveConfig(config.directives);
    return gen + buildApi(formatted, field.directives);
  }
  return gen;
};

const generateNameNodeZodSchema = (
  config: ValidationSchemaPluginConfig,
  tsVisitor: TsVisitor,
  schema: GraphQLSchema,
  node: NameNode
): string => {
  const typ = schema.getType(node.value);
  const enumName = tsVisitor.convertName(typ?.astNode?.name?.value ?? '');

  switch (typ?.astNode?.kind) {
    case 'EnumTypeDefinition':
      return `${enumName}Schema`;
    case 'InputObjectTypeDefinition':
    case 'ObjectTypeDefinition':
      // using switch-case rather than if-else to allow for future expansion
      switch (config.validationSchemaExportType) {
        case 'const':
          return `${enumName}Schema`;
        case 'function':
        default:
          return `${enumName}Schema()`;
      }
    default:
      return zod4Scalar(config, tsVisitor, node.value);
  }
};

const maybeLazy = (type: TypeNode, schema: string): string => {
  if (isNamedType(type) && isInput(type.name.value)) {
    return `z.lazy(() => ${schema})`;
  }
  return schema;
};

const zod4Scalar = (config: ValidationSchemaPluginConfig, tsVisitor: TsVisitor, scalarName: string): string => {
  if (config.scalarSchemas?.[scalarName]) {
    return config.scalarSchemas[scalarName];
  }
  const tsType = tsVisitor.scalars[scalarName];
  switch (tsType) {
    case 'string':
      return `z.string()`;
    case 'number':
      return `z.number()`;
    case 'boolean':
      return `z.boolean()`;
  }
  console.warn('unhandled scalar name:', scalarName);
  return anySchema;
};
