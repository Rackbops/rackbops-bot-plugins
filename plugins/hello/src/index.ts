import type { HostApi, Plugin } from "../../../packages/api/contract.js";

// Throwaway plugin used only to prove the publish pipeline (npm OIDC -> plugins.json -> release)
// end to end. Deleted once the test is done. No env, no side effects.
export function createPlugin(host: HostApi): Plugin {
  return {
    commands: [
      {
        name: "hello",
        build: (builder) => builder.setDescription("Say hello (publish-pipeline test plugin)"),
        handle: async (interaction) => {
          await interaction.reply(`Hello from @rackbops/plugin-hello, running on ${host.name}.`);
        },
      },
    ],
  };
}
