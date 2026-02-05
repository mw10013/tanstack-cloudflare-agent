import type { Plugin } from "@opencode-ai/plugin";

export const InjectEnvPlugin: Plugin = async ({ directory }) => {
  // Bun shell doesn't implement `source` builtin, so parse manually
  const envContent = await Bun.file(`${directory}/.env`).text();
  const port = envContent.match(/^PORT=(\d+)/m)?.[1];

  if (!port) {
    throw new Error(`PORT not found in .env at ${directory}/.env`);
  }

  return {
    "shell.env": async (_input, output) => {
      output.env.PORT = port;
    },
  };
};
