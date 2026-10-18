// Local stand-in for the Supabase HTTP APIs the site uses (Auth, PostgREST, Storage),
// backed by a real local Postgres with the checked-in migrations applied. Every data
// request runs as the anon or authenticated role with the caller's user ID, so Row Level
// Security, grants and triggers are exercised for real. Test-only; never deployed.
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";

const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function startGateway({ database, host, port: pgPort, user = "postgres" }) {
  const pool = new pg.Pool({ database, host, port: pgPort, user, max: 6 });
  const passwords = new Map();
  const objects = new Map();
  const options = { requireEmailConfirmation: true, failUploads: null };

  function token(userRow) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return b64({ alg: "HS256", typ: "JWT" }) + "." +
      b64({ sub: userRow.id, role: "authenticated", aud: "authenticated", email: userRow.email, exp, session_id: randomUUID() }) + ".test";
  }
  function subject(req) {
    const auth = String(req.headers.authorization || "");
    const jwt = auth.replace(/^Bearer\s+/i, "");
    try { const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()); return claims.sub || null; }
    catch { return null; }
  }
  const userJson = row => ({
    id: row.id, aud: "authenticated", role: "authenticated", email: row.email,
    email_confirmed_at: row.email_confirmed_at, confirmed_at: row.email_confirmed_at,
    user_metadata: row.raw_user_meta_data || {}, app_metadata: { provider: "email" },
    created_at: row.created_at, updated_at: row.created_at, identities: []
  });
  const session = row => ({
    access_token: token(row), token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "refresh-" + row.id, user: userJson(row)
  });

  async function asRole(sub, fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sub ? "set local role authenticated" : "set local role anon");
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [sub || ""]);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  function pgError(res, error, sub) {
    const status = error.code === "42501" ? (sub ? 403 : 401) : error.code === "PGRST202" ? 404 : 400;
    send(res, status, { code: error.code, message: error.message, details: error.detail || null, hint: error.hint || null });
  }
  function send(res, status, body, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }
  const readBody = req => new Promise(resolve => {
    const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks)));
  });
  function filters(url) {
    const where = [], values = [];
    for (const [key, raw] of url.searchParams) {
      if (["select", "limit", "order", "offset"].includes(key)) continue;
      if (!IDENT.test(key)) throw Object.assign(new Error("bad filter"), { code: "PGRST100" });
      const [op, ...rest] = raw.split("."); const value = rest.join(".");
      if (op === "eq") { values.push(value); where.push(`${key} = $${values.length}`); }
      else if (op === "is" && value === "null") where.push(`${key} is null`);
      else throw Object.assign(new Error("unsupported filter " + raw), { code: "PGRST100" });
    }
    return { where: where.length ? " where " + where.join(" and ") : "", values };
  }
  const columns = url => {
    const select = url.searchParams.get("select") || "*";
    if (select === "*") return "*";
    const cols = select.split(",").map(c => c.trim());
    if (!cols.every(c => IDENT.test(c))) throw Object.assign(new Error("bad select"), { code: "PGRST100" });
    return cols.join(", ");
  };
  function respondRows(req, res, rows, status = 200) {
    if (String(req.headers.accept || "").includes("vnd.pgrst.object")) {
      if (rows.length !== 1) return send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows` });
      return send(res, status, rows[0]);
    }
    send(res, status, rows);
  }

  async function rest(req, res, url, sub) {
    const parts = url.pathname.replace(/^\/rest\/v1\//, "").split("/");
    const body = (await readBody(req)).toString();
    if (parts[0] === "rpc") {
      const fn = parts[1];
      if (!IDENT.test(fn)) return send(res, 404, { code: "PGRST202", message: "Could not find the function" });
      const meta = await pool.query(
        `select p.proretset, t.typname, t.typtype from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         join pg_type t on t.oid = p.prorettype where n.nspname = 'public' and p.proname = $1 limit 1`, [fn]);
      if (!meta.rows.length) return send(res, 404, { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` });
      const args = body ? JSON.parse(body) : {};
      const names = Object.keys(args);
      if (!names.every(n => IDENT.test(n))) return send(res, 400, { code: "PGRST100", message: "bad args" });
      const call = `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`;
      const { proretset, typname, typtype } = meta.rows[0];
      try {
        const rows = await asRole(sub, client => client.query(
          proretset || typtype === "c" ? `select * from ${call}` : `select ${call} as value`, names.map(n => args[n])).then(r => r.rows));
        if (proretset || typtype === "c") return send(res, 200, rows);
        if (typname === "void") return send(res, 204);
        return send(res, 200, rows[0].value);
      } catch (error) { return pgError(res, error, sub); }
    }
    const table = parts[0];
    if (!IDENT.test(table)) return send(res, 404, { message: "not found" });
    try {
      if (req.method === "GET") {
        const { where, values } = filters(url);
        const limit = Number(url.searchParams.get("limit")) || null;
        const rows = await asRole(sub, c => c.query(`select ${columns(url)} from public.${table}${where}${limit ? " limit " + limit : ""}`, values).then(r => r.rows));
        return respondRows(req, res, rows);
      }
      const wantRows = /return=representation/.test(String(req.headers.prefer || ""));
      const returning = wantRows ? " returning " + columns(url) : "";
      if (req.method === "POST") {
        const payload = JSON.parse(body); const list = Array.isArray(payload) ? payload : [payload];
        const out = [];
        await asRole(sub, async c => {
          for (const row of list) {
            const keys = Object.keys(row); if (!keys.every(k => IDENT.test(k))) throw new Error("bad column");
            const r = await c.query(`insert into public.${table} (${keys.join(", ")}) values (${keys.map((_, i) => "$" + (i + 1)).join(", ")})${returning}`, keys.map(k => row[k]));
            out.push(...r.rows);
          }
        });
        return wantRows ? respondRows(req, res, out, 201) : send(res, 201);
      }
      if (req.method === "PATCH") {
        const payload = JSON.parse(body); const keys = Object.keys(payload);
        if (!keys.every(k => IDENT.test(k))) throw new Error("bad column");
        const { where, values } = filters(url);
        const shifted = where.replace(/\$(\d+)/g, (_, n) => "$" + (Number(n) + keys.length));
        const rows = await asRole(sub, c => c.query(`update public.${table} set ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")}${shifted}${returning}`, [...keys.map(k => payload[k]), ...values]).then(r => r.rows));
        return wantRows ? respondRows(req, res, rows) : send(res, 204);
      }
    } catch (error) { return pgError(res, error, sub); }
    send(res, 405, { message: "method not allowed" });
  }

  async function storage(req, res, url, sub) {
    const path = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\//, ""));
    const raw = await readBody(req);
    if (req.method === "GET" && path.startsWith("object/sign/")) {
      const key = path.replace(/^object\/sign\//, "");
      const file = objects.get(key);
      if (!file) return send(res, 404, { error: "not_found" });
      res.writeHead(200, { "content-type": file.type }); return res.end(file.bytes);
    }
    if (req.method === "POST" && path.startsWith("object/sign/")) {
      const rest = path.replace(/^object\/sign\//, "");
      const [bucket, ...nameParts] = rest.split("/");
      const body = raw.length ? JSON.parse(raw.toString()) : {};
      const names = nameParts.length ? [nameParts.join("/")] : (body.paths || []);
      const visible = await asRole(sub, c => c.query("select name from storage.objects where bucket_id = $1 and name = any($2)", [bucket, names]).then(r => new Set(r.rows.map(x => x.name))));
      const sign = name => `/object/sign/${bucket}/${name}?token=test`;
      if (nameParts.length) {
        return visible.has(names[0]) ? send(res, 200, { signedURL: sign(names[0]) }) : send(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
      }
      return send(res, 200, names.map(name => visible.has(name) ? { path: name, signedURL: sign(name), error: null } : { path: name, signedURL: null, error: "Either the object does not exist or you do not have access to it" }));
    }
    if (req.method === "POST" && path.startsWith("object/")) {
      if (options.failUploads) { const [status, body] = options.failUploads; return send(res, status, body); }
      const [bucket, ...nameParts] = path.replace(/^object\//, "").split("/");
      const name = nameParts.join("/");
      let type = String(req.headers["content-type"] || "");
      let bytes = raw;
      const boundary = /multipart\/form-data;\s*boundary=(.+)$/i.exec(type);
      if (boundary) {
        // Mirror Storage: the file part's own Content-Type decides the object's MIME type.
        const sections = raw.toString("latin1").split("--" + boundary[1]);
        const filePart = sections.find(part => /content-disposition:[^\r\n]*name=""/i.test(part));
        const head = filePart ? filePart.slice(0, filePart.indexOf("\r\n\r\n")) : "";
        type = (/content-type:\s*([^\r\n]+)/i.exec(head) || [, "application/octet-stream"])[1].trim();
        bytes = filePart ? Buffer.from(filePart.slice(head.length + 4, -2), "latin1") : Buffer.alloc(0);
      }
      try {
        const limits = (await pool.query("select file_size_limit, allowed_mime_types from storage.buckets where id = $1", [bucket])).rows[0];
        if (!limits) return send(res, 400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
        if (limits.allowed_mime_types && !limits.allowed_mime_types.includes(type)) return send(res, 400, { statusCode: "415", error: "invalid_mime_type", message: `mime type ${type} is not supported` });
        if (limits.file_size_limit && bytes.length > Number(limits.file_size_limit)) return send(res, 413, { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" });
        await asRole(sub, c => c.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [bucket, name, sub]));
      } catch (error) {
        return send(res, 400, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
      }
      objects.set(`${bucket}/${name}`, { bytes, type });
      return send(res, 200, { Key: `${bucket}/${name}`, Id: randomUUID() });
    }
    if (req.method === "DELETE" && path.startsWith("object/")) {
      const bucket = path.replace(/^object\//, "");
      const { prefixes = [] } = JSON.parse(raw.toString() || "{}");
      const removed = await asRole(sub, c => c.query("delete from storage.objects where bucket_id = $1 and name = any($2) returning name", [bucket, prefixes]).then(r => r.rows));
      removed.forEach(r => objects.delete(`${bucket}/${r.name}`));
      return send(res, 200, removed.map(r => ({ name: r.name })));
    }
    send(res, 404, { message: "not found" });
  }

  async function auth(req, res, url, sub) {
    const route = url.pathname.replace(/^\/auth\/v1\//, "");
    const raw = (await readBody(req)).toString();
    const body = raw ? JSON.parse(raw) : {};
    const authError = (status, code, msg) => send(res, status, { code: status, error_code: code, msg });
    if (route === "signup" && req.method === "POST") {
      const email = String(body.email || "").toLowerCase();
      const exists = await pool.query("select 1 from auth.users where email = $1", [email]);
      if (exists.rows.length) return authError(422, "user_already_exists", "User already registered");
      const row = (await pool.query(
        "insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, $2, $3) returning *",
        [email, options.requireEmailConfirmation ? null : new Date(), body.data || {}])).rows[0];
      passwords.set(email, body.password);
      return send(res, 200, options.requireEmailConfirmation ? userJson(row) : session(row));
    }
    if (route === "token" && url.searchParams.get("grant_type") === "password") {
      const email = String(body.email || "").toLowerCase();
      const row = (await pool.query("select * from auth.users where email = $1", [email])).rows[0];
      if (!row || passwords.get(email) !== body.password) return authError(400, "invalid_credentials", "Invalid login credentials");
      if (!row.email_confirmed_at) return authError(400, "email_not_confirmed", "Email not confirmed");
      return send(res, 200, session(row));
    }
    if (route === "token" && url.searchParams.get("grant_type") === "refresh_token") {
      const id = String(body.refresh_token || "").replace(/^refresh-/, "");
      const row = (await pool.query("select * from auth.users where id::text = $1", [id])).rows[0];
      return row ? send(res, 200, session(row)) : authError(400, "refresh_token_not_found", "Invalid Refresh Token");
    }
    if (route === "user" && req.method === "GET") {
      const row = sub && (await pool.query("select * from auth.users where id = $1", [sub])).rows[0];
      return row ? send(res, 200, userJson(row)) : authError(401, "bad_jwt", "invalid JWT");
    }
    if (route === "logout") return send(res, 204);
    if (route === "resend" || route === "recover") return send(res, 200, {});
    authError(404, "not_found", "unsupported in test gateway");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://gateway");
    const sub = subject(req);
    try {
      if (url.pathname.startsWith("/rest/v1/")) return await rest(req, res, url, sub);
      if (url.pathname.startsWith("/storage/v1/")) return await storage(req, res, url, sub);
      if (url.pathname.startsWith("/auth/v1/")) return await auth(req, res, url, sub);
      send(res, 404, { message: "not found" });
    } catch (error) {
      send(res, 500, { message: String(error && error.message) });
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    pool, passwords, options,
    async close() { await new Promise(r => server.close(r)); await pool.end(); }
  };
}
