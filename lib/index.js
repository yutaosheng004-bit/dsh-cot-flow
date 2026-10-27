/**
 * Host half of dsh-cot-flow.
 *
 * The whole contribution lives in the browser (`./client`): it replaces the
 * `conversation.chat.reasoning.body` slot to render expanded reasoning text in
 * incrementally memoized paragraphs. There is nothing to register on the host,
 * so this module only exists so the loader can treat the package as a plugin.
 */

export const name = "dsh-cot-flow";

export function apply() {
  // Intentionally empty: see ./client.js for the rendering contribution.
}