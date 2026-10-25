/** The optional native dependency may be omitted even in a source installation. */
declare module "node-pty" {
  export function spawn(executable: string, args: string[] | string,
    options: Parameters<import("./terminal.js").AgentPtyFactory>[2]): import("./terminal.js").AgentPty;
}
