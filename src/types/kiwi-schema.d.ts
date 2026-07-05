declare module 'kiwi-schema' {
  export interface Field {
    name: string;
    line: number;
    column: number;
    type: string | null;
    isArray: boolean;
    isDeprecated: boolean;
    value: number;
  }

  export interface Definition {
    name: string;
    line: number;
    column: number;
    kind: 'ENUM' | 'STRUCT' | 'MESSAGE';
    fields: Field[];
  }

  export interface Schema {
    package: string | null;
    definitions: Definition[];
  }

  /** Compiled schema: exposes decode<Name>/encode<Name> per definition. */
  export interface CompiledSchema {
    [fn: string]: (data: Uint8Array | Record<string, unknown>) => any;
  }

  export function decodeBinarySchema(buffer: Uint8Array): Schema;
  export function encodeBinarySchema(schema: Schema): Uint8Array;
  export function compileSchema(schema: Schema): CompiledSchema;
  export function parseSchema(text: string): Schema;

  const kiwi: {
    decodeBinarySchema: typeof decodeBinarySchema;
    encodeBinarySchema: typeof encodeBinarySchema;
    compileSchema: typeof compileSchema;
    parseSchema: typeof parseSchema;
  };
  export default kiwi;
}
