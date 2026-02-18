import type { OrganizationAgent } from "@/organization-agent";
import { invariant } from "@epic-web/invariant";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useHydrated,
  useNavigate,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useAgent } from "agents/react";
import * as React from "react";
import * as z from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const searchSchema = z.object({
  google: z.enum(["connected", "denied", "error"]).optional(),
});

interface GoogleStatusData {
  connected: boolean;
  scopes: string;
  accessTokenExpiresAt: number | null;
}

interface SpreadsheetData {
  spreadsheetId: string;
  name: string;
  modifiedTime: string | null;
  webViewLink: string | null;
  lastSeenAt: number;
}

interface SelectedSpreadsheetData {
  defaultSpreadsheetId: string | null;
  defaultSheetName: string | null;
}

const beginGoogleConnect = createServerFn({ method: "POST" })
  .handler(async ({ context: { session, env } }) => {
    invariant(session, "Missing session");
    const organizationId = session.session.activeOrganizationId;
    invariant(organizationId, "Missing active organization");
    invariant(env.GOOGLE_OAUTH_CLIENT_ID, "Missing GOOGLE_OAUTH_CLIENT_ID");
    invariant(
      env.GOOGLE_OAUTH_REDIRECT_URI,
      "Missing GOOGLE_OAUTH_REDIRECT_URI",
    );
    const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = env.ORGANIZATION_AGENT.get(id);

    const stateBytes = crypto.getRandomValues(new Uint8Array(32));
    const verifierBytes = crypto.getRandomValues(new Uint8Array(48));
    const state = toBase64Url(stateBytes);
    const codeVerifier = toBase64Url(verifierBytes);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(codeVerifier),
    );
    const codeChallenge = toBase64Url(new Uint8Array(digest));

    await stub.beginGoogleOAuth({
      state,
      codeVerifier,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID);
    url.searchParams.set("redirect_uri", env.GOOGLE_OAUTH_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set(
      "scope",
      [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/documents",
      ].join(" "),
    );
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString() };
  });

export const Route = createFileRoute("/app/$organizationId/google")({
  validateSearch: searchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const search = Route.useSearch();
  const isHydrated = useHydrated();
  const navigate = useNavigate();
  const [status, setStatus] = React.useState<GoogleStatusData>({
    connected: false,
    scopes: "",
    accessTokenExpiresAt: null,
  });
  const [spreadsheets, setSpreadsheets] = React.useState<SpreadsheetData[]>([]);
  const [selected, setSelected] = React.useState<SelectedSpreadsheetData>({
    defaultSpreadsheetId: null,
    defaultSheetName: null,
  });
  const [rowInput, setRowInput] = React.useState(
    `${new Date().toISOString()},poc,ok`,
  );
  const [readRange, setReadRange] = React.useState("");
  const agent = useAgent<OrganizationAgent, unknown>({
    agent: "organization-agent",
    name: organizationId,
  });
  const beginGoogleConnectServerFn = useServerFn(beginGoogleConnect);

  const refreshMutation = useMutation<{
    status: GoogleStatusData;
    spreadsheets: SpreadsheetData[];
    selected: SelectedSpreadsheetData;
  }>({
    mutationFn: async () => {
      const [statusResult, spreadsheetsResult, selectedResult] = await Promise.all([
        agent.stub.getGoogleConnectionStatus(),
        agent.stub.getCachedDriveSpreadsheets(),
        agent.stub.getDefaultSpreadsheet(),
      ]);
      return {
        status: sanitize(statusResult),
        spreadsheets: sanitize(spreadsheetsResult),
        selected: sanitize(selectedResult),
      };
    },
    onSuccess: (data) => {
      setStatus(data.status);
      setSpreadsheets(data.spreadsheets);
      setSelected(data.selected);
    },
  });
  const { mutate: refreshData } = refreshMutation;

  const connectMutation = useMutation({
    mutationFn: () => beginGoogleConnectServerFn(),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });
  const refreshListMutation = useMutation({
    mutationFn: () => agent.stub.listDriveSpreadsheets(),
    onSuccess: () => {
      refreshData();
    },
  });
  const selectMutation = useMutation({
    mutationFn: (spreadsheetId: string) =>
      agent.stub.setDefaultSpreadsheet({ spreadsheetId, sheetName: "Sheet1" }),
    onSuccess: () => {
      refreshData();
    },
  });
  const appendMutation = useMutation({
    mutationFn: () => agent.stub.appendDefaultRow(splitValues(rowInput)),
  });
  const readMutation = useMutation({
    mutationFn: () =>
      agent.stub.readDefaultRange(readRange.trim().length > 0 ? readRange : undefined),
  });
  const disconnectMutation = useMutation({
    mutationFn: () => agent.stub.disconnectGoogle(),
    onSuccess: () => {
      refreshData();
    },
  });

  const disabled = !isHydrated;

  React.useEffect(() => {
    if (!isHydrated) {
      return;
    }
    refreshData();
  }, [isHydrated, refreshData]);

  React.useEffect(() => {
    if (!search.google) {
      return;
    }
    void navigate({
      to: "/app/$organizationId/google",
      params: { organizationId },
      search: {},
      replace: true,
    });
  }, [search.google, navigate, organizationId]);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Google</h1>
        <p className="text-muted-foreground">
          Connect Google for this organization, list spreadsheets, and run read/write checks.
        </p>
      </div>

      {search.google === "connected" && (
        <Alert>
          <AlertTitle>Connected</AlertTitle>
          <AlertDescription>Google OAuth completed successfully.</AlertDescription>
        </Alert>
      )}
      {search.google === "denied" && (
        <Alert variant="destructive">
          <AlertTitle>Access Denied</AlertTitle>
          <AlertDescription>Google consent was denied.</AlertDescription>
        </Alert>
      )}
      {search.google === "error" && (
        <Alert variant="destructive">
          <AlertTitle>OAuth Error</AlertTitle>
          <AlertDescription>Google callback failed. Retry connect.</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Connected: {status.connected ? "yes" : "no"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button
            type="button"
            disabled={disabled || connectMutation.isPending}
            onClick={() => {
              connectMutation.mutate();
            }}
          >
            {connectMutation.isPending ? "Redirecting..." : "Connect Google"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || disconnectMutation.isPending}
            onClick={() => {
              disconnectMutation.mutate();
            }}
          >
            {disconnectMutation.isPending ? "Disconnecting..." : "Disconnect"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || refreshListMutation.isPending || !status.connected}
            onClick={() => {
              refreshListMutation.mutate();
            }}
          >
            {refreshListMutation.isPending ? "Refreshing..." : "Refresh List"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Spreadsheets</CardTitle>
          <CardDescription>
            {spreadsheets.length} cached spreadsheet{spreadsheets.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {spreadsheets.length === 0 && (
            <p className="text-muted-foreground text-sm">No spreadsheets cached yet.</p>
          )}
          {spreadsheets.map((spreadsheet) => (
            <div key={spreadsheet.spreadsheetId} className="flex items-center justify-between gap-2 rounded border p-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{spreadsheet.name}</p>
                <p className="text-muted-foreground truncate text-xs">{spreadsheet.spreadsheetId}</p>
              </div>
              <Button
                type="button"
                variant={selected.defaultSpreadsheetId === spreadsheet.spreadsheetId ? "default" : "outline"}
                size="sm"
                disabled={disabled || selectMutation.isPending}
                onClick={() => {
                  selectMutation.mutate(spreadsheet.spreadsheetId);
                }}
              >
                {selected.defaultSpreadsheetId === spreadsheet.spreadsheetId ? "Selected" : "Select"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Read / Write Smoke Test</CardTitle>
          <CardDescription>
            Selected spreadsheet: {selected.defaultSpreadsheetId ?? "none"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            value={rowInput}
            onChange={(event) => {
              setRowInput(event.target.value);
            }}
            placeholder="comma,separated,values"
            disabled={disabled}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={disabled || appendMutation.isPending || !selected.defaultSpreadsheetId}
              onClick={() => {
                appendMutation.mutate();
              }}
            >
              {appendMutation.isPending ? "Appending..." : "Append Row"}
            </Button>
            <Input
              value={readRange}
              onChange={(event) => {
                setReadRange(event.target.value);
              }}
              placeholder="optional range (Sheet1!A1:C20)"
              disabled={disabled}
            />
            <Button
              type="button"
              variant="outline"
              disabled={disabled || readMutation.isPending || !selected.defaultSpreadsheetId}
              onClick={() => {
                readMutation.mutate();
              }}
            >
              {readMutation.isPending ? "Reading..." : "Read Range"}
            </Button>
          </div>
          {appendMutation.error && (
            <Alert variant="destructive">
              <AlertTitle>Append Failed</AlertTitle>
              <AlertDescription>{appendMutation.error.message}</AlertDescription>
            </Alert>
          )}
          {readMutation.error && (
            <Alert variant="destructive">
              <AlertTitle>Read Failed</AlertTitle>
              <AlertDescription>{readMutation.error.message}</AlertDescription>
            </Alert>
          )}
          {appendMutation.data !== undefined && (
            <pre className="bg-muted overflow-auto rounded p-3 text-xs">
              {JSON.stringify(appendMutation.data, null, 2)}
            </pre>
          )}
          {readMutation.data !== undefined && (
            <pre className="bg-muted overflow-auto rounded p-3 text-xs">
              {JSON.stringify(readMutation.data, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function toBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function splitValues(input: string) {
  return input.split(",").map((part) => part.trim());
}

function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
