// ─── GitHub Contents API + workflow dispatch ────────────────────────────────
// GitHub is the canonical durable mind (spec §7): plain files, optimistic
// concurrency via sha (which doubles as the distributed tick lock), and the
// workflow_dispatch call that powers fast-follow chains.

import { SECRETS } from './config';

const API = 'https://api.github.com';

function gh(path: string, init?: RequestInit): Promise<any> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${SECRETS.ghToken}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'binary-agent/2',
      ...(init?.headers || {}),
    },
  }).then(async (r) => {
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).slice(0, 200);
      throw new Error(`github ${path.split('?')[0]}: HTTP ${r.status} ${body}`);
    }
    return r.status === 204 ? null : r.json();
  });
}

export async function readFile(repo: string, path: string): Promise<{ content: string; sha: string } | null> {
  try {
    const meta = await gh(`/repos/${repo}/contents/${encodePath(path)}`);
    if (meta?.encoding !== 'base64' || meta?.content == null) return null;
    const content = Buffer.from(meta.content, 'base64').toString('utf8');
    return { content, sha: meta.sha };
  } catch (e: any) {
    if (String(e?.message || '').includes('HTTP 404')) return null;
    throw e;
  }
}

export async function writeFile(
  repo: string,
  path: string,
  content: string,
  message: string,
  sha?: string | null,
): Promise<{ ok: boolean; sha?: string; error?: string }> {
  try {
    const res = await gh(`/repos/${repo}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });
    return { ok: true, sha: res?.content?.sha };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** Read-modify-write with optimistic concurrency + retry on CAS conflict. */
export async function rmwFile(
  repo: string,
  path: string,
  message: string,
  mutate: (current: string | null) => string | null,
  attempts = 3,
): Promise<{ ok: boolean; error?: string }> {
  for (let i = 0; i < attempts; i++) {
    const cur = await readFile(repo, path);
    const next = mutate(cur ? cur.content : null);
    if (next === null) return { ok: true }; // no change requested
    if (next === cur?.content) return { ok: true }; // unchanged
    const w = await writeFile(repo, path, next, message, cur?.sha);
    if (w.ok) return { ok: true };
    if (String(w.error || '').includes('HTTP 409') || String(w.error || '').includes('conflict')) {
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 400)); // jitter
      continue;
    }
    return { ok: false, error: w.error };
  }
  return { ok: false, error: 'cas-conflict (3 attempts)' };
}

export async function appendJsonl(
  repo: string,
  path: string,
  line: Record<string, unknown>,
  message: string,
  cap?: number,
): Promise<{ ok: boolean; error?: string }> {
  return rmwFile(repo, path, message, (cur) => {
    const lines = (cur || '').split('\n').filter(Boolean);
    lines.push(JSON.stringify(line));
    const trimmed = cap && lines.length > cap ? lines.slice(-cap) : lines;
    return trimmed.join('\n') + '\n';
  });
}

export async function dispatchWorkflow(
  repo: string,
  workflowFileName: string,
  inputs: Record<string, string> = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    await gh(`/repos/${repo}/actions/workflows/${workflowFileName}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs }),
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}
