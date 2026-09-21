// POST /api/agent/setup-db — Supabase schema bootstrap / health check (spec §4).
// Two layers:
//  1. REST verification (always available): tables + RPCs via PostgREST.
//  2. Direct Postgres DDL (best-effort): idempotent DDL through the pooler
//     matrix when a pooler resolves — Supabase's pooler hostnames evolve,
//     so the REST layer is the source of truth for "is the schema live".
// The agent's runtime traffic (inserts + recall) is 100% PostgREST/HTTPS —
// direct Postgres is only needed to CREATE schema that is missing.

import { NextRequest, NextResponse } from 'next/server';
import { SECRETS } from '@/lib/agent/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const REF = (process.env.SUPABASE_URL || '').replace(/^https:\/\//, '').split('.')[0];
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const DDL = `
create extension if not exists vector;

create table if not exists agent_episodes (
  ts timestamptz default now(),
  text text not null,
  goal_id text,
  tool text,
  ok boolean,
  detail jsonb,
  embedding vector(1024)
);
create table if not exists agent_insights (
  ts timestamptz default now(),
  text text not null,
  embedding vector(1024)
);
create table if not exists agent_messages (
  chat_id text not null,
  ts timestamptz default now(),
  who text not null,
  text text not null,
  embedding vector(1024)
);

create index if not exists idx_episodes_ts on agent_episodes (ts desc);
create index if not exists idx_insights_ts on agent_insights (ts desc);
create index if not exists idx_messages_chat_ts on agent_messages (chat_id, ts desc);
create index if not exists idx_episodes_emb on agent_episodes using hnsw (embedding vector_cosine_ops);
create index if not exists idx_insights_emb on agent_insights using hnsw (embedding vector_cosine_ops);
create index if not exists idx_messages_emb on agent_messages using hnsw (embedding vector_cosine_ops);

create or replace function match_agent_messages(query_embedding vector(1024), match_count int, filter_chat text default null)
returns table (id bigint, chat_id text, ts timestamptz, who text, text text, similarity float)
language sql stable as $$
  select m.id, m.chat_id, m.ts, m.who, m.text,
         1 - (m.embedding <=> query_embedding) as similarity
  from agent_messages m
  where m.embedding is not null
    and (filter_chat is null or m.chat_id = filter_chat)
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function match_agent_insights(query_embedding vector(1024), match_count int)
returns table (id bigint, ts timestamptz, text text, similarity float)
language sql stable as $$
  select i.id, i.ts, i.text,
         1 - (i.embedding <=> query_embedding) as similarity
  from agent_insights i
  where i.embedding is not null
  order by i.embedding <=> query_embedding
  limit match_count;
$$;
`;

async function restCheck() {
  const tables: Record<string, string> = {};
  let allOk = true;
  for (const t of ['agent_episodes', 'agent_insights', 'agent_messages']) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/${t}?select=ts&limit=1`, {
        headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      tables[t] = r.ok ? 'ok' : `HTTP ${r.status}`;
      if (!r.ok) allOk = false;
    } catch (e: unknown) {
      tables[t] = `unreachable: ${String((e as Error)?.message || e).slice(0, 60)}`;
      allOk = false;
    }
  }
  // RPC probe — zero vector, match_count 0 (cheap, distinguishes missing fn)
  let rpc = 'unknown';
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/match_agent_insights`, {
      method: 'POST',
      headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query_embedding: new Array(1024).fill(0), match_count: 0 }),
      signal: AbortSignal.timeout(10_000),
    });
    rpc = r.ok ? 'ok' : `HTTP ${r.status}`;
    if (!r.ok) allOk = false;
  } catch (e: unknown) {
    rpc = `unreachable: ${String((e as Error)?.message || e).slice(0, 60)}`;
    allOk = false;
  }
  return { tables, rpc, allOk };
}

async function ddlAttempt() {
  const password = process.env.SUPABASE_DB_PASSWORD || '';
  if (!REF || !password) return { attempted: false, reason: 'missing SUPABASE_DB_PASSWORD', probes: {}, ddl: 'skipped' };
  // Pooler matrix — Supabase pooler hostnames have changed across generations;
  // probe several shapes + the (IPv6-capable) direct host.
  const hosts = [
    `aws-0-eu-west-2-pooler.supabase.com:6543`,
    `aws-1-eu-west-2-pooler.supabase.com:6543`,
    `aws-0-eu-west-1-pooler.supabase.com:6543`,
    `${REF}.pooler.supabase.com:6543`,
    `db.${REF}.supabase.co:5432`,
  ];
  const probes: Record<string, string> = {};
  const { Pool } = await import('pg');
  for (const host of hosts) {
    const cs = `postgresql://postgres.${REF}:${encodeURIComponent(password)}@${host}/postgres?sslmode=require&connect_timeout=6`;
    const pool = new Pool({ connectionString: cs, max: 1, connectionTimeoutMillis: 6000 });
    try {
      const r = await pool.query('select 1 as ok');
      if (r?.rows?.[0]?.ok === 1) {
        probes[host] = 'reachable';
        try {
          await pool.query(DDL);
          pool.end().catch(() => null);
          return { attempted: true, probes, ddl: 'ddl applied (idempotent)' };
        } catch (e: unknown) {
          probes[host] = `ddl error: ${String((e as Error)?.message || e).slice(0, 120)}`;
        }
      }
    } catch (e: unknown) {
      probes[host] = `unreachable: ${String((e as Error)?.message || e).slice(0, 70)}`;
    } finally {
      pool.end().catch(() => null);
    }
  }
  return { attempted: true, probes, ddl: 'no direct-Postgres route (pooler matrix exhausted — REST layer is authoritative)' };
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-agent-secret') || req.nextUrl.searchParams.get('key') || '';
  if (!SECRETS.tickSecret || secret !== SECRETS.tickSecret) {
    return NextResponse.json({ ok: false, error: 'bad-secret' }, { status: 401 });
  }
  if (!SB_URL || !SB_KEY) {
    return NextResponse.json({ ok: false, error: 'missing SUPABASE_URL or SUPABASE_SERVICE_KEY' });
  }
  const rest = await restCheck();
  const ddl = await ddlAttempt();
  return NextResponse.json({
    ok: rest.allOk,
    ref: REF,
    schema: rest.allOk ? 'verified via PostgREST (tables + RPC live)' : 'INCOMPLETE — run the DDL from the Supabase SQL editor',
    rest,
    directPostgres: ddl,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
