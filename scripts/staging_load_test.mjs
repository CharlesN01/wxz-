#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const target = process.argv[2] || 'http://127.0.0.1:18001';
const tokenFile = process.argv[3] || '/tmp/staging-load-tokens.json';
const stages = (process.env.STAGING_LOAD_STAGES || '10,50,100,250,500,1000,2000,3000')
  .split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);

const fixture = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
const tokens = fixture.tokens;
const questionId = encodeURIComponent(fixture.questionId);

async function request(path, options = {}) {
  const started = performance.now();
  try {
    const response = await fetch(`${target}${path}`, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
    const raw = await response.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    return { status: response.status, body, ms: performance.now() - started };
  } catch (error) {
    return { status: 0, ms: performance.now() - started, error: String(error) };
  }
}

async function virtualUser(index) {
  const token = tokens[index];
  const auth = { Authorization: `Bearer ${token}` };
  const results = [];
  results.push(await request('/api/student/v1/categories/'));
  results.push(await request('/api/student/v1/articles/'));
  results.push(await request('/api/student/v1/questions/?source=literature&categoryId=pre-qin'));
  results.push(await request(`/api/student/v1/questions/${questionId}/`, { headers: auth }));
  results.push(await request('/api/student/v1/me/statistics/', { headers: auth }));
  results.push(await request('/api/student/v1/me/resume/', { headers: auth }));
  const current = await request(`/api/student/v1/me/questions/${questionId}/state/`, { headers: auth });
  results.push(current);
  const key = `loadtest-${index}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  results.push(await request(`/api/student/v1/me/questions/${questionId}/state/`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ mastered: !current.body?.mastered, baseVersion: current.body?.version ?? 0 }),
  }));
  return results;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

for (const count of stages) {
  const started = performance.now();
  const batches = [];
  for (let index = 0; index < count; index += 1) batches.push(virtualUser(index));
  const rows = (await Promise.all(batches)).flat();
  const durations = rows.map((row) => row.ms);
  const errors = rows.filter((row) => row.status < 200 || row.status >= 300);
  const summary = {
    virtualUsers: count,
    requests: rows.length,
    durationSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(1)),
    p99Ms: Number(percentile(durations, 0.99).toFixed(1)),
    errorRate: Number((errors.length / Math.max(1, rows.length)).toFixed(5)),
    errors: errors.slice(0, 5),
  };
  console.log(JSON.stringify(summary));
}
