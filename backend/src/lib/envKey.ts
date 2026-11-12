// A deployment key read from the environment. backend/.env.example ships
// placeholders such as OPENAI_API_KEY=your-openai-key, and a copied example
// file must not make a provider look configured: Spectre would then start
// chats on a model whose key is a placeholder and fail every request.

/** The `your-…` placeholders .env.example uses for secrets. */
const PLACEHOLDER = /^your[-_]/i;

/** The trimmed value of `name`, or null when it is unset, blank or a placeholder. */
export function environmentKey(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[name]?.trim();
  return value && !PLACEHOLDER.test(value) ? value : null;
}
