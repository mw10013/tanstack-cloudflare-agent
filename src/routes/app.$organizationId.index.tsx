import type {
  PromptInputMessage,
  PromptInputSubmitProps,
} from "@/components/ai-elements/prompt-input";
import type { UIMessage } from "ai";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { invariant } from "@epic-web/invariant";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useHydrated,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useAgent } from "agents/react";
import * as z from "zod";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { UserAgent } from "@/user-agent";

const organizationIdSchema = z.object({ organizationId: z.string() });

const invitationIdSchema = z.object({ invitationId: z.string() });

export const Route = createFileRoute("/app/$organizationId/")({
  loader: ({ params: data }) => getLoaderData({ data }),
  component: RouteComponent,
});

const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator(organizationIdSchema)
  .handler(
    async ({
      data: { organizationId },
      context: { authService, repository },
    }) => {
      const request = getRequest();
      const session = await authService.api.getSession({
        headers: request.headers,
      });
      invariant(session, "Missing session");
      const dashboardData = await repository.getAppDashboardData({
        userEmail: session.user.email,
        organizationId,
      });
      return dashboardData;
    },
  );

const acceptInvitation = createServerFn({ method: "POST" })
  .inputValidator(invitationIdSchema)
  .handler(async ({ data: { invitationId }, context: { authService } }) => {
    const request = getRequest();
    await authService.api.acceptInvitation({
      headers: request.headers,
      body: { invitationId },
    });
  });

const rejectInvitation = createServerFn({ method: "POST" })
  .inputValidator(invitationIdSchema)
  .handler(async ({ data: { invitationId }, context: { authService } }) => {
    const request = getRequest();
    await authService.api.rejectInvitation({
      headers: request.headers,
      body: { invitationId },
    });
  });

function RouteComponent() {
  const { userInvitations, memberCount, pendingInvitationCount } =
    Route.useLoaderData();
  const { organizationId } = useParams({ from: "/app/$organizationId/" });
  const isHydrated = useHydrated();
  const agent = useAgent<UserAgent, unknown>({
    agent: "user-agent",
    name: organizationId,
  });
  const {
    messages: rawMessages,
    sendMessage,
    status,
  } = useAgentChat({
    agent,
    getInitialMessages: () => Promise.resolve([]),
  });
  const safeChatMessages = rawMessages as UIMessage[];
  const safeSendMessage = sendMessage as unknown as (
    message: UIMessage,
  ) => Promise<unknown>;
  const safeStatus = status as PromptInputSubmitProps["status"];

  const feeFiMutation = useMutation<string>({
    mutationFn: () => agent.stub.feeFi(),
  });
  const feeFi1Mutation = useMutation<string>({
    mutationFn: () => agent.stub.feeFi1(),
  });
  const feeFi2Mutation = useMutation<string>({
    mutationFn: () => agent.stub.feeFi2(),
  });
  const bangMutation = useMutation<string>({
    mutationFn: () => agent.stub.bang(),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      {userInvitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Invitations</CardTitle>
            <CardDescription>
              Invitations awaiting your response.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div>
              {userInvitations.map((invitation) => (
                <InvitationItem key={invitation.id} invitation={invitation} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>
              Total members in this organization
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="member-count">
              {memberCount}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pending Invitations</CardTitle>
            <CardDescription>Invitations awaiting response</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pendingInvitationCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agent RPC</CardTitle>
            <CardDescription>User agent RPC methods</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-muted-foreground text-sm">
              {feeFiMutation.data ?? "No response yet"}
            </div>
            <div className="text-muted-foreground text-sm">
              {feeFi1Mutation.data ?? "No response yet"}
            </div>
            <div className="text-muted-foreground text-sm">
              {feeFi2Mutation.data ?? "No response yet"}
            </div>
            <div className="text-muted-foreground text-sm">
              {bangMutation.data ?? "No response yet"}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!isHydrated || feeFiMutation.isPending}
                onClick={() => {
                  feeFiMutation.mutate();
                }}
              >
                FeeFi
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!isHydrated || feeFi1Mutation.isPending}
                onClick={() => {
                  feeFi1Mutation.mutate();
                }}
              >
                FeeFi1
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!isHydrated || feeFi2Mutation.isPending}
                onClick={() => {
                  feeFi2Mutation.mutate();
                }}
              >
                FeeFi2
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!isHydrated || bangMutation.isPending}
                onClick={() => {
                  bangMutation.mutate();
                }}
              >
                Bang
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agent Chat</CardTitle>
          <CardDescription>Chat with your user agent</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="h-96 rounded-md border">
            <Conversation className="h-full">
              <ConversationContent>
                {safeChatMessages.map((message) => (
                  <Message from={message.role} key={message.id}>
                    <MessageContent>
                      {message.parts.map((part, index) =>
                        part.type === "text" ? (
                          <MessageResponse
                            key={`${message.id}-${String(index)}`}
                          >
                            {part.text}
                          </MessageResponse>
                        ) : null,
                      )}
                    </MessageContent>
                  </Message>
                ))}

                {safeChatMessages.length === 0 && (
                  <ConversationEmptyState
                    description="Send a message to start the conversation."
                    title="No messages"
                  />
                )}
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>
          </div>
          <PromptInput
            onSubmit={async ({ text }: PromptInputMessage) => {
              if (!text.trim()) {
                return;
              }
              await safeSendMessage({
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text }],
              });
            }}
          >
            <PromptInputBody>
              <PromptInputTextarea placeholder="Ask your agent..." />
            </PromptInputBody>
            <PromptInputFooter className="justify-end">
              <PromptInputSubmit status={safeStatus} />
            </PromptInputFooter>
          </PromptInput>
        </CardContent>
      </Card>
    </div>
  );
}

function InvitationItem({
  invitation,
}: {
  invitation: (typeof Route)["types"]["loaderData"]["userInvitations"][number];
}) {
  const router = useRouter();
  const isHydrated = useHydrated();
  const acceptInvitationServerFn = useServerFn(acceptInvitation);
  const rejectInvitationServerFn = useServerFn(rejectInvitation);

  const acceptInvitationMutation = useMutation({
    mutationFn: () =>
      acceptInvitationServerFn({
        data: { invitationId: invitation.id },
      }),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  const rejectInvitationMutation = useMutation({
    mutationFn: () =>
      rejectInvitationServerFn({
        data: { invitationId: invitation.id },
      }),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  const disabled =
    !isHydrated ||
    acceptInvitationMutation.isPending ||
    rejectInvitationMutation.isPending;

  return (
    <Item size="sm" className="gap-4 px-0">
      <ItemContent>
        <ItemTitle>{invitation.inviter.email}</ItemTitle>
        <ItemDescription>
          Role: {invitation.role}
          <br />
          Organization: {invitation.organization.name}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          type="button"
          name="intent"
          value="accept"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`Accept invitation from ${invitation.inviter.email}`}
          onClick={() => {
            acceptInvitationMutation.mutate();
          }}
        >
          Accept
        </Button>
        <Button
          type="button"
          name="intent"
          value="reject"
          variant="destructive"
          size="sm"
          disabled={disabled}
          aria-label={`Reject invitation from ${invitation.inviter.email}`}
          onClick={() => {
            rejectInvitationMutation.mutate();
          }}
        >
          Reject
        </Button>
      </ItemActions>
    </Item>
  );
}
