// NOLA Archive — WordPress publishing client (Stage 5).
//
// Creates posts on noladmc.com through the WordPress REST API using an
// application password over HTTPS Basic auth.
//
// CREDENTIAL HANDLING:
// WP_USER and WP_APP_PASSWORD are read from .env at runtime and are NEVER
// logged, printed, or written anywhere. .env is gitignored. The Authorization
// header is built inside request() and never leaves this file. If you add
// debug logging here, do NOT log headers.
//
// Application passwords are issued in wp-admin → Users → Profile → Application
// Passwords. They carry the full capabilities of the user they belong to, so
// treat one exactly like the account password.
//
// Usage:
//   import { createPost, getCategories, whoAmI } from './wp-publish.js';
//   const post = await createPost({ title, slug, html, status: 'private' });

import 'dotenv/config';

const need = (k) => {
  if (!process.env[k]) { console.error(`Missing env var ${k} — see .env`); process.exit(1); }
  return process.env[k];
};

// Trailing slashes here produce '//wp-json' paths that some hosts 301 into a
// GET, silently turning a POST into a no-op. Strip it once, up front.
const BASE = need('WP_BASE_URL').replace(/\/+$/, '');
const API = `${BASE}/wp-json/wp/v2`;

// WP prints application passwords in space-separated groups purely for
// legibility. The spaces are part of the password as far as Basic auth is
// concerned, so they are preserved verbatim — do not strip them.
function authHeader() {
  const user = need('WP_USER');
  const pass = need('WP_APP_PASSWORD');
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; }
  catch { json = null; }

  if (!res.ok) {
    // WP error bodies look like { code, message, data: { status } }. Surface
    // the message; never echo the request headers.
    const detail = json?.message ? `${json.code}: ${json.message}` : text.slice(0, 300);
    throw new Error(`WP ${method} ${path} → HTTP ${res.status}. ${detail}`);
  }
  return json;
}

/** Confirm the credential works and report which account it belongs to. */
export async function whoAmI() {
  return request('/users/me?context=edit');
}

/** All categories, id + name + slug + post count. */
export async function getCategories() {
  return request('/categories?per_page=100&_fields=id,name,slug,count,parent');
}

/**
 * Create a post.
 *
 * @param {object}  page
 * @param {string}  page.title            post title (required)
 * @param {string}  page.html             post body as HTML (required)
 * @param {string} [page.slug]            URL slug; WP derives one from the title if omitted
 * @param {string} [page.status='draft']  'private' | 'draft' | 'publish' | 'future' | 'pending'
 * @param {string} [page.date]            ISO 8601; required by WP when status='future'
 * @param {number} [page.categoryId]      category to file under; omit for the site default
 * @param {string} [page.metaDescription] excerpt, which most SEO plugins fall back to
 *
 * NO-FALLBACKS on status: an unrecognized value is rejected here rather than
 * being quietly coerced, because the failure mode is publishing something
 * publicly that was meant to be private.
 */
export async function createPost({
  title,
  slug,
  html,
  status = 'draft',
  date,
  categoryId,
  metaDescription,
} = {}) {
  if (!title || typeof title !== 'string') throw new Error('createPost: title is required');
  if (!html || typeof html !== 'string') throw new Error('createPost: html is required');

  const ALLOWED = ['draft', 'private', 'publish', 'pending', 'future'];
  if (!ALLOWED.includes(status)) {
    throw new Error(`createPost: status must be one of ${ALLOWED.join(', ')} (got '${status}')`);
  }
  if (status === 'future' && !date) {
    throw new Error("createPost: status 'future' requires a date");
  }

  const body = {
    title,
    content: html,
    status,
    ...(slug ? { slug } : {}),
    ...(date ? { date } : {}),
    ...(categoryId ? { categories: [categoryId] } : {}),
    ...(metaDescription ? { excerpt: metaDescription } : {}),
  };

  return request('/posts', { method: 'POST', body });
}

/** Fetch a single post (context=edit so private posts are visible). */
export async function getPost(id) {
  return request(`/posts/${id}?context=edit`);
}

/**
 * Delete a post. force=false sends it to trash (recoverable from wp-admin);
 * force=true removes it permanently.
 */
export async function deletePost(id, { force = false } = {}) {
  return request(`/posts/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' });
}
