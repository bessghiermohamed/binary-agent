// One-time DB bootstrap for the Supabase agent project.
// POST (or GET) with header `x-agent-secret: <AGENT_TICK_SECRET>`.
//
// Modes:
//   ?probe=1   — probe connectivity only (direct host + pooler regions), no DDL
//   (default)  — probe, then apply idempotent DDL (pgvector + tables + RPC matchers)
//
// Connection order: DATABASE_URL env first, then direct db.<ref>.supabase.co,
// then pooler hosts across common Supabase regions (first one that connects wins).
// The route response reports the winning host so DATABASE_URL can be pinned.

import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { AGENT_CONFIG } from '@/lib/agent/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DDL: string[] = [
  `create extension if not exists vector`,
  `create table if not exists agent_episodes (
     id bigserial primary key,
     ts timestamptz not null default now(),
     text text,
     goal_id text,
     tool text,
     ok boolean,
     detail jsonb,
     embedding vector(1024)
   )`,
  `create table if not exists agent_insights (
     id bigserial primary key,
     ts timestamptz not null default now(),
     text text,
     embedding vector(1024)
   )`,
  `create table if not exists agent_messages (
     id bigserial primary key,
     chat_id text not null,
     ts timestamptz not null default now(),
     who text,
     text text,
     embedding vector(1024)
   )`,
  `create index if not exists agent_messages_hnsw on agent_messages using hnsw (embedding vector_cosine_ops)`,
  `create index if not exists agent_insights_hnsw on agent_insights using hnsw (embedding vector_cosine_ops)`,
  `create index if not exists agent_episodes_hnsw on agent_episodes using hnsw (embedding vector_cosine_ops)`,
  `create index if not exists agent_messages_chat_ts on agent_messages (chat_id, ts desc)`,
  `create or replace function match_agent_messages(
     query_embedding vector(1024),
     match_count int default 4,
     filter_chat text default null
   )
   returns table (id bigint, chat_id text, ts timestamptz, who text, text text, similarity double precision)
   language sql stable security invoker as $fn$
     select id, chat_id, ts, who, text, 1 - (embedding <=> query_embedding) as similarity
     from agent_messages
     where embedding is not null and (filter_chat is null or chat_id = filter_chat)
     order by embedding <=> query_embedding
     limit least(greatest(match_count, 1), 20)
   $fn$`,
  `create or replace function match_agent_insights(
     query_embedding vector(1024),
     match_count int default 3
   )
   returns table (id bigint, ts timestamptz, text text, similarity double precision)
   language sql stable security invoker as $fn$
     select id, ts, text, 1 - (embedding <=> query_embedding) as similarity
     from agent_insights
     where embedding is not null
     order by embedding <=> query_embedding
     limit least(greatest(match_count, 1), 10)
   $fn$`,
];

const POOLER_REGIONS = [
  'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-2', 'eu-north-1',
  'eu-south-1', 'eu-south-2', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'us-west-3',
  'ca-central-1', 'ca-west-1', 'sa-east-1', 'me-south-1', 'me-central-1', 'il-central-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1', 'ap-south-2', 'ap-east-1', 'ap-east-2', 'af-south-1',
];

const POOLER_CLUSTERS = ['aws-1', 'aws-0']; // new projects live on aws-1

function supabaseRef(): string {
  const url = process.env.SUPABASE_URL || '';
  const m = /https:\/\/([a-z0-9]{16,24})\.supabase\.co/.exec(url);
  return m ? m[1] : '';
}

async function tryConnect(url: string, timeoutMs = 5000): Promise<{ ok: boolean; err?: string }> {
  const c = new Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    ssl: url.includes('pooler.supabase.com') ? { rejectUnauthorized: false } : undefined,
    statement_timeout: 15000,
  });
  try {
    await c.connect();
    await c.query('select 1');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, err: String(e?.message || e).slice(0, 140) };
  } finally {
    try {
      await c.end();
    } catch {}
  }
}

async function probe(): Promise<{ host: string | null; urls: Record<string, string>; attempts: any[] }> {
  const ref = supabaseRef();
  const pw = process.env.SUPABASE_DB_PASSWORD || '';
  const urls: Record<string, string> = {};
  const attempts: any[] = [];
  if (process.env.DATABASE_URL) urls.database_url = process.env.DATABASE_URL;
  if (ref && pw) {
    urls[`direct`] = `postgresql://postgres:${encodeURIComponent(pw)}@db.${ref}.supabase.co:5432/postgres`;
    for (const cluster of POOLER_CLUSTERS) {
      for (const r of POOLER_REGIONS) {
        urls[`${cluster}-${r}`] = `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@${cluster}-${r}.pooler.supabase.com:6543/postgres`;
      }
    }
  }
  for (const [name, u] of Object.entries(urls)) {
    const r = await tryConnect(u, name.startsWith('pooler') || name.startsWith('aws-') ? 3000 : 6000);
    attempts.push({ name, ok: r.ok, err: r.err });
    if (r.ok) return { host: name, urls, attempts };
  }
  return { host: null, urls, attempts };
}

async function run(req: Request) {
  const key = req.headers.get('x-agent-secret') || new URL(req.url).searchParams.get('key') || '';
  if (!AGENT_CONFIG.tickSecret || key !== AGENT_CONFIG.tickSecret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const url = new URL(req.url);
  const probeOnly = url.searchParams.get('probe') === '1';
  try {
    const p = await probe();
    if (probeOnly || !p.host) {
      return NextResponse.json({ ok: !!p.host, host: p.host, attempts: p.attempts, probeOnly });
    }
    const c = new Client({
      connectionString: p.urls[p.host],
      connectionTimeoutMillis: 6000,
      ssl: p.urls[p.host].includes('pooler.supabase.com') ? { rejectUnauthorized: false } : undefined,
      statement_timeout: 20000,
    });
    await c.connect();
    const results: any[] = [];
    for (const stmt of DDL) {
      try {
        await c.query(stmt);
        results.push({ ok: true, stmt: stmt.slice(0, 60) });
      } catch (e: any) {
        results.push({ ok: false, stmt: stmt.slice(0, 60), err: String(e?.message || e).slice(0, 160) });
      }
    }
    const tables = await c.query(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`
    );
    await c.end();
    return NextResponse.json({
      ok: results.every((r) => r.ok),
      host: p.host,
      results,
      tables: tables.rows.map((r: any) => r.table_name),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
