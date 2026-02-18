import * as z from "zod";

const GoogleApiError = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
    status: z.string().optional(),
  }),
});

const DriveListResponse = z.object({
  files: z.array(z.object({
    id: z.string(),
    name: z.string(),
    modifiedTime: z.string().optional(),
    webViewLink: z.string().optional(),
  })).optional(),
});

const SheetsValuesResponse = z.object({
  range: z.string().optional(),
  majorDimension: z.string().optional(),
  values: z.array(z.array(z.unknown())).optional(),
}).loose();

const SheetsAppendResponse = z.object({
  spreadsheetId: z.string().optional(),
  tableRange: z.string().optional(),
  updates: z.object({
    spreadsheetId: z.string().optional(),
    updatedRange: z.string().optional(),
    updatedRows: z.number().optional(),
    updatedColumns: z.number().optional(),
    updatedCells: z.number().optional(),
  }).optional(),
}).loose();

interface GoogleRequestInput<T> {
  url: URL | string;
  accessToken: string;
  method?: "GET" | "POST";
  body?: string;
  schema: z.ZodType<T>;
}

const fetchGoogle = async <T>(
  { url, accessToken, method = "GET", body, schema }: GoogleRequestInput<T>,
) => {
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
    const parsed = GoogleApiError.safeParse(json);
    throw new Error(
      parsed.success
        ? `Google API ${String(parsed.data.error.code)}: ${parsed.data.error.message}`
        : `Google API request failed: ${String(response.status)}`,
    );
  }
  return schema.parse(await response.json());
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
