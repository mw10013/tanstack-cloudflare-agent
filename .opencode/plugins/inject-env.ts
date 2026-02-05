import type { Plugin } from "@opencode-ai/plugin";

export const InjectEnvPlugin: Plugin = async ({ directory }) => {
  const envContent = await Bun.file(`${directory}/.env`).text();
  const portMatch = envContent.match(/^PORT=(.+)$/m);
  const port = portMatch?.[1]?.trim();

  if (!port) {
    throw new Error(`PORT not found in .env at ${directory}/.env`);
  }

  return {
    "shell.env": async (_input, output) => {
      output.env.PORT = port;
    },
  };
};
