// POST /api/agent/setup-db — one-click Supabase schema bootstrap (spec §4).
// Idempotent DDL: enables pgvector, creates agent_episodes / agent_insights /
// agent_messages with vector(1024) columns, HNSW indexes, and the
// match_agent_* RPCs. Probes the pooler region matrix (aws-0 → aws-1).

import { NextRequest, NextResponse } from 'next/server';
import { SECRETS } from '@/lib/agent/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const REF = (process.env.SUPABASE_URL || '').replace(/^https:\/\//, '').split('.')[0];

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

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-agent-secret') || req.nextUrl.searchParams.get('key') || '';
  if (!SECRETS.tickSecret || secret !== SECRETS.tickSecret) {
    return NextResponse.json({ ok: false, error: 'bad-secret' }, { status: 401 });
  }
  const password = process.env.SUPABASE_DB_PASSWORD || '';
  if (!REF || !password) {
    return NextResponse.json({ ok: false, error: 'missing SUPABASE_URL or SUPABASE_DB_PASSWORD' });
  }

  const hosts = [
    `aws-0-eu-west-2-pooler.supabase.com:6543`,
    `aws-1-eu-west-2-pooler.supabase.com:6543`,
    `db.${REF}.supabase.co:5432`,
  ];
  const probes: Record<string, string> = {};
  let ddlOutcome = 'no connection';

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
          ddlOutcome = 'ddl applied (idempotent)';
        } catch (e: any) {
          ddlOutcome = `ddl error: ${String(e?.message || e).slice(0, 200)}`;
        }
        pool.end().catch(() => null);
        break;
      }
    } catch (e: any) {
      probes[host] = `unreachable: ${String(e?.message || e).slice(0, 80)}`;
    } finally {
      pool.end().catch(() => null);
    }
  }

  return NextResponse.json({ ok: ddlOutcome.startsWith('ddl applied'), ref: REF, probes, ddl: ddlOutcome });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
