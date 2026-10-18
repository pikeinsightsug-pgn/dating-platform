// Runs the real supabase/functions/admin-members/index.ts under Node for tests: a minimal
// Deno shim (env + serve) and a loader that maps the esm.sh import to the installed
// supabase-js package. The function code itself is used unchanged.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const supabaseEntry = import.meta.resolve("@supabase/supabase-js");
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("https://esm.sh/@supabase/supabase-js")) return { url: ${JSON.stringify(supabaseEntry)}, shortCircuit: true };
  return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(hooks), pathToFileURL("./"));

export async function loadAdminFunction(env) {
  let handler = null;
  globalThis.Deno = {
    env: { get: name => env[name] },
    serve: fn => { handler = fn; }
  };
  const file = new URL("../../supabase/functions/admin-members/index.ts", import.meta.url);
  await import(file.href + "?t=" + Date.now());
  if (!handler) throw new Error("admin-members did not register a handler");
  return handler;
}
