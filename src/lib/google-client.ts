import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const GoogleApiError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
    status: Schema.optionalKey(Schema.String),
  }),
});

const DriveListResponse = Schema.Struct({
  files: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        modifiedTime: Schema.optionalKey(Schema.String),
        webViewLink: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const SheetsValuesResponse = Schema.Struct({
  range: Schema.optionalKey(Schema.String),
  majorDimension: Schema.optionalKey(Schema.String),
  values: Schema.optionalKey(Schema.Array(Schema.Array(Schema.Unknown))),
});

const SheetsAppendResponse = Schema.Struct({
  spreadsheetId: Schema.optionalKey(Schema.String),
  tableRange: Schema.optionalKey(Schema.String),
  updates: Schema.optionalKey(
    Schema.Struct({
      spreadsheetId: Schema.optionalKey(Schema.String),
      updatedRange: Schema.optionalKey(Schema.String),
      updatedRows: Schema.optionalKey(Schema.Number),
      updatedColumns: Schema.optionalKey(Schema.Number),
      updatedCells: Schema.optionalKey(Schema.Number),
    }),
  ),
});

interface GoogleRequestInput<
  S extends Schema.Top & { readonly DecodingServices: never },
> {
  url: URL | string;
  accessToken: string;
  method?: "GET" | "POST";
  body?: string;
  schema: S;
}

const fetchGoogle = async <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  { url, accessToken, method = "GET", body, schema }: GoogleRequestInput<S>,
): Promise<S["Type"]> => {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body,
  });
  if (!response.ok) {
    const json = await response.json().catch(() => null);
    const parsed = Schema.decodeUnknownExit(GoogleApiError)(json);
    throw new Error(
      Exit.isSuccess(parsed)
        ? `Google API ${String(parsed.value.error.code)}: ${parsed.value.error.message}`
        : `Google API request failed: ${String(response.status)}`,
    );
  }
  return Schema.decodeUnknownSync(schema)(await response.json());
};

export const listDriveSpreadsheetsRequest = (
  accessToken: string,
  pageSize = 100,
) => {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
  );
  url.searchParams.set("fields", "files(id,name,modifiedTime,webViewLink)");
  url.searchParams.set("pageSize", String(pageSize));
  return fetchGoogle({ url, accessToken, schema: DriveListResponse });
};

export const getSpreadsheetValuesRequest = (
  accessToken: string,
  spreadsheetId: string,
  range: string,
) =>
  fetchGoogle({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    accessToken,
    schema: SheetsValuesResponse,
  });

export const appendSpreadsheetValuesRequest = (
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: string[],
) =>
  fetchGoogle({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
    accessToken,
    method: "POST",
    body: JSON.stringify({ values: [values] }),
    schema: SheetsAppendResponse,
  });
