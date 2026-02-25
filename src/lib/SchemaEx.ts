import { Schema, SchemaGetter, Struct } from "effect";

/**
 * Extract a single field from a struct schema, returning the unwrapped value.
 *
 * refs/effect4/packages/effect/SCHEMA.md:7262
 */
const pluck =
  <P extends PropertyKey>(key: P) =>
  <S extends Schema.Top>(
    schema: Schema.Struct<Record<P, S>>,
  ): Schema.decodeTo<Schema.toType<S>, Schema.Struct<Record<P, S>>> =>
    schema.mapFields(Struct.pick([key])).pipe(
      Schema.decodeTo(Schema.toType(schema.fields[key]), {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        decode: SchemaGetter.transform((whole: any) => whole[key]),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
        encode: SchemaGetter.transform((value) => ({ [key]: value }) as any),
      }),
    );

/**
 * Schema for D1 rows shaped `{ data: string }` (e.g. from `json_group_array`/`json_object` queries).
 * Extracts the `data` column, parses the JSON string, and validates against `DataSchema`.
 */
export const DataFromResult = <A>(DataSchema: Schema.Schema<A>) =>
  Schema.Struct({ data: Schema.String }).pipe(
    pluck("data"),
    Schema.decodeTo(Schema.fromJsonString(DataSchema)),
  );
