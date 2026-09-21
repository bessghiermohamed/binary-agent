// ─── GitHub = the agent's database, notebook and workshop ────────────────────
// Thin Contents API client with optimistic concurrency. Every write needs the
// current file `sha`, so concurrent writers get 409/422 — we retry once with a
// fresh GET. This also powers the distributed tick lock (see memory.ts).

const API = 'https://api.github.com';

function headers(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': 'murad-agent',
  };
}

export async function gh(
  token: string,
  path: string,
  init: any = {},
  timeoutMs = 15000
): Promise<{ status: number; json: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      ...init,
      headers: { ...headers(token), ...(init.headers || {}) },
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ─── single file read/write on the memory repo ───────────────────────────────

export interface RawFile {
  sha: string | null;
  content: string;
  exists: boolean;
}

export async function readFile(
  token: string,
  repo: string,
  path: string,
  ref = 'main'
): Promise<RawFile> {
  const { status, json } = await gh(
    token,
    `/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${ref}`
  );
  if (status === 404) return { sha: null, content: '', exists: false };
  if (status !== 200 || !json?.content) return { sha: null, content: '', exists: false };
  const content = Buffer.from(json.content, 'base64').toString('utf8');
  return { sha: json.sha, content, exists: true };
}

/** Write (or create) one file. Retries once on sha conflict. */
export async function writeFile(
  token: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  opts: { sha?: string | null; branch?: string; tries?: number } = {}
): Promise<{ ok: boolean; sha: string | null; error?: string }> {
  const branch = opts.branch || 'main';
  let sha = opts.sha;
  for (let i = 0; i < (opts.tries ?? 2); i++) {
    if (sha === undefined) {
      const cur = await readFile(token, repo, path, branch);
      sha = cur.sha;
    }
    const body: any = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch };
    if (sha) body.sha = sha;
    const { status, json } = await gh(token, `/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (status === 200 || status === 201) return { ok: true, sha: json?.content?.sha || null };
    // sha conflict or race -> refresh and retry once
    const cur = await readFile(token, repo, path, branch);
    if (cur.sha) {
      sha = cur.sha;
      continue;
    }
    return { ok: false, sha: null, error: `github PUT ${path} -> ${status} ${JSON.stringify(json).slice(0, 160)}` };
  }
  return { ok: false, sha: null, error: `github PUT ${path} -> sha conflict` };
}

// ─── workflow dispatch (fast-follow ticks), gists, issues ────────────────────

export async function dispatchWorkflow(
  token: string,
  repo: string,
  workflowFile: string,
  inputs: Record<string, string> = {},
  ref = 'main'
): Promise<{ ok: boolean; error?: string }> {
  const { status } = await gh(token, `/repos/${repo}/actions/workflows/${workflowFile}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  });
  // 204 = accepted; 404 may mean the workflow file doesn't exist yet
  if (status === 204 || status === 200) return { ok: true };
  return { ok: false, error: `dispatch -> ${status}` };
}

export async function createGist(
  token: string,
  files: Record<string, string>,
  description: string,
  isPublic = false
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const { status, json } = await gh(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({ files, description: description.slice(0, 300), public: isPublic }),
  });
  if (status === 201) return { ok: true, url: json?.html_url };
  return { ok: false, error: `gist -> ${status}` };
}

export async function createIssue(
  token: string,
  repo: string,
  title: string,
  body: string
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const { status, json } = await gh(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: title.slice(0, 200), body: body.slice(0, 6000) }),
  });
  if (status === 201) return { ok: true, url: json?.html_url };
  return { ok: false, error: `issue -> ${status}` };
}
